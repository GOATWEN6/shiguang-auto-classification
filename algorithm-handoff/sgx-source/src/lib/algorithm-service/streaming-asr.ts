import { randomUUID } from 'node:crypto';

import {
  createDoubaoStreamingAsrAdapter,
  createDoubaoWebSocketTransport,
  validatePcm16AudioChunk,
  type DoubaoStreamingAsrAdapter,
  type DoubaoStreamingAsrSession,
  type Pcm16AudioChunk,
} from '../asr-runtime/index.ts';
import type {
  LiveProviderConfig,
  ProviderAttemptAudit,
  ProviderAttemptGate,
} from './live-provider.ts';

const MAX_PCM_BYTES = 60 * 16_000 * 2;
const MAX_STREAM_MS = 75_000;

export interface LiveStreamingAsrResult {
  text: string;
  payloadCount: number;
  audioDurationMs: number;
  firstPartialMs: number | null;
  durationMs: number;
}

export interface LiveStreamingAsrSession {
  send(chunk: Pcm16AudioChunk): Promise<void>;
  /** An explicit EOS audio tail must be sent before finishing. */
  finish(): Promise<LiveStreamingAsrResult>;
  cancel(reason: string): Promise<void>;
}

export interface LiveStreamingAsrOptions {
  signal: AbortSignal;
  requestId: string;
  onPartial?: (text: string) => void;
}

export interface LiveStreamingAsrHooks {
  gate?: Pick<ProviderAttemptGate, 'beforeAttempt'>;
  onAttempt?: (audit: ProviderAttemptAudit) => void;
  /** Trusted injection used by isolated tests; it is never exposed over HTTP. */
  adapterFactory?: () => DoubaoStreamingAsrAdapter;
}

function cancelled(): Error {
  return new DOMException('request_cancelled', 'AbortError');
}

function safeErrorCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  const message = error instanceof Error ? error.message : '';
  const status = /(?:HTTP|status)\D{0,8}(\d{3})/u.exec(message);
  if (status) return `provider_http_${status[1]}`;
  const provider = /Doubao ASR provider returned code (\d+)/u.exec(message);
  if (provider) return `asr_provider_code_${provider[1]}`;
  if (/not a documented streaming ASR resource ID/u.test(message)) return 'asr_resource_configuration_invalid';
  if (/invalid PCM16|audio chunk sequence|explicit EOS|endOfStream audio chunk/u.test(message)) return 'asr_audio_chunk_invalid';
  if (/invalid Doubao ASR WebSocket frame/u.test(message)) return 'asr_protocol_failure';
  if (/asr_final_conflict/u.test(message)) return 'asr_final_conflict';
  if (/asr_no_final/u.test(message)) return 'asr_no_final';
  if (/timeout|timed out/u.test(message)) return 'timeout';
  if (/ASR transport open|failed to create Doubao ASR WebSocket/u.test(message)) return 'asr_transport_open_failure';
  if (/ASR transport send/u.test(message)) return 'asr_transport_send_failure';
  if (/ASR transport end/u.test(message)) return 'asr_transport_end_failure';
  return 'asr_transport_failure';
}

/**
 * Keep one provider connection open while PCM arrives from the caller. Partial
 * text is display-only; only definite utterances after provider EOS become the
 * returned transcript. Mid-stream failures are never silently replayed.
 */
export async function openLiveStreamingAsr(
  config: LiveProviderConfig['asr'],
  options: LiveStreamingAsrOptions,
  hooks: LiveStreamingAsrHooks = {},
): Promise<LiveStreamingAsrSession> {
  if (!options.requestId.trim()) throw new Error('invalid_asr_request_id');
  if (!config.apiKey.trim() || !config.resourceId.trim()) throw new Error('invalid_asr_configuration');
  if (options.signal.aborted) throw cancelled();

  const adapter = hooks.adapterFactory?.() ?? createDoubaoStreamingAsrAdapter({
    transportFactory: () => createDoubaoWebSocketTransport({ enableNonstream: true }),
  });
  // The existing cumulative ledger must reserve before an actual provider open.
  hooks.gate?.beforeAttempt('asr', options.requestId);
  const started = performance.now();
  const lifecycle = new AbortController();
  const finals = new Map<string, { text: string; order: number }>();
  let session: DoubaoStreamingAsrSession | undefined;
  let payloadCount = 0;
  let reservedAudioBytes = 0;
  let firstPartialMs: number | null = null;
  let eosRequested = false;
  let auditWritten = false;
  let terminalError: Error | null = null;
  let finishPromise: Promise<LiveStreamingAsrResult> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const writeAudit = (status: ProviderAttemptAudit['status'], errorCode: string | null): void => {
    if (auditWritten) return;
    auditWritten = true;
    if (timeout) clearTimeout(timeout);
    options.signal.removeEventListener('abort', onExternalAbort);
    hooks.onAttempt?.({ module: 'asr', requestId: options.requestId, attempt: 1,
      status, errorCode, durationMs: Math.round(performance.now() - started),
      inputTokens: null, outputTokens: null, estimatedTextCostCny: null, billingState: 'UNKNOWN' });
  };

  const terminate = (error: unknown): Error => {
    if (terminalError) return terminalError;
    const code = options.signal.aborted ? 'cancelled' : safeErrorCode(error);
    terminalError = code === 'cancelled' ? cancelled() : new Error(code);
    writeAudit(code === 'cancelled' ? 'cancelled' : 'failed', code);
    finals.clear();
    lifecycle.abort(code);
    void session?.cancel(code).catch(() => undefined);
    return terminalError;
  };
  const onExternalAbort = (): void => { terminate(cancelled()); };
  options.signal.addEventListener('abort', onExternalAbort, { once: true });
  timeout = setTimeout(() => { terminate(new Error('asr_stream_timeout')); }, MAX_STREAM_MS);
  if (options.signal.aborted) onExternalAbort();

  try {
    session = await adapter.open({
      identity: { sessionEpoch: options.requestId, turnId: options.requestId, generationId: 1,
        invocationId: `asr:${randomUUID()}`, evidenceRefs: [] },
      requestId: options.requestId,
      headers: { 'X-Api-Key': config.apiKey, 'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': options.requestId },
      signal: lifecycle.signal,
      onDecodedPayload(payload) {
        if (auditWritten || lifecycle.signal.aborted) return;
        payloadCount += 1;
        const envelope = payload as { result?: { text?: string; utterances?: Array<{
          id?: string; index?: number; definite?: boolean; text?: string; start_time?: number;
        }> }; payload_msg?: { result?: { text?: string; utterances?: Array<{
          id?: string; index?: number; definite?: boolean; text?: string; start_time?: number;
        }> } } };
        const result = envelope.result ?? envelope.payload_msg?.result;
        if (typeof result?.text === 'string' && result.text.trim()) {
          firstPartialMs ??= Math.round(performance.now() - started);
          options.onPartial?.(result.text);
        }
        for (const [index, utterance] of (result?.utterances ?? []).entries()) {
          if (utterance.definite !== true || typeof utterance.text !== 'string' || !utterance.text.trim()) continue;
          const key = utterance.id ? `id:${utterance.id}`
            : utterance.start_time !== undefined ? `time:${utterance.start_time}`
              : `index:${utterance.index ?? index}`;
          const prior = finals.get(key);
          if (prior && prior.text !== utterance.text) throw new Error('asr_final_conflict');
          finals.set(key, { text: utterance.text, order: utterance.start_time ?? utterance.index ?? index });
        }
      },
    });
    if (terminalError || lifecycle.signal.aborted) {
      await session.cancel('cancelled_during_open').catch(() => undefined);
      throw terminalError ?? cancelled();
    }
  } catch (error) { throw terminate(error); }

  const connection = session;
  return {
    async send(chunk) {
      if (terminalError) throw terminalError;
      if (finishPromise || auditWritten || eosRequested) throw new Error('asr_stream_closed');
      try {
        const validated = validatePcm16AudioChunk(chunk);
        if (reservedAudioBytes + validated.byteLength > MAX_PCM_BYTES) throw new Error('invalid PCM16 duration');
        reservedAudioBytes += validated.byteLength;
        eosRequested = validated.endOfStream;
        // Retain this packet's bytes while the transport serializes send cadence.
        await connection.send({ ...validated, audio: validated.audio.slice() });
        if (terminalError) throw terminalError;
      } catch (error) { throw terminate(error); }
    },
    finish() {
      if (finishPromise) return finishPromise;
      if (terminalError) return Promise.reject(terminalError);
      finishPromise = (async () => {
        try {
          if (!eosRequested) throw new Error('ASR requires an explicit EOS audio tail');
          await connection.end();
          if (terminalError || lifecycle.signal.aborted) throw terminalError ?? cancelled();
          const text = [...finals.values()].sort((left, right) => left.order - right.order)
            .map(value => value.text).join('');
          if (!text.trim()) throw new Error('asr_no_final');
          const result = { text, payloadCount, audioDurationMs: reservedAudioBytes / 32,
            firstPartialMs, durationMs: Math.round(performance.now() - started) };
          writeAudit('success', null);
          finals.clear();
          return result;
        } catch (error) { throw terminate(error); }
      })();
      return finishPromise;
    },
    async cancel(reason) {
      if (auditWritten && !terminalError) return;
      if (!terminalError) terminate(cancelled());
      await connection.cancel(reason.trim() || 'explicit_cancel').catch(() => undefined);
    },
  };
}
