import { randomUUID } from 'node:crypto';
import OpenAI from 'openai';

import {
  createDoubaoStreamingAsrAdapter,
  createDoubaoWebSocketTransport,
  DOUBAO_BIGMODEL_ASYNC_ENDPOINT,
} from '../asr-runtime/index.ts';
import type { DoubaoTtsConfig } from '../voice/tts/config.ts';
import { synthesizeWithDoubaoTts } from '../voice/tts/doubao-provider.ts';
import { synthesizeDoubaoStreamingTts, TtsStreamingError } from './streaming-tts.ts';

export interface LiveProviderConfig {
  text: { apiKey: string; baseURL: string; model: string; timeoutMs: number };
  asr: { apiKey: string; resourceId: string };
  tts: DoubaoTtsConfig;
}

export interface ProviderAttemptAudit {
  module: string;
  requestId: string;
  attempt: number;
  status: 'success' | 'failed' | 'cancelled';
  durationMs: number;
  errorCode: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  billingState: 'UNKNOWN';
  estimatedTextCostCny: number | null;
  /** Short adapter-redacted diagnostics for ASR only; never raw provider payloads. */
  diagnostic?: string;
}

export interface ProviderAttemptGate {
  beforeAttempt(module: string, requestId: string): void;
  /** Optional trusted test recorder; never part of the public HTTP output or audit. */
  afterJson?(module: string, output: unknown): void;
}

export interface LiveProvider {
  json(system: string, input: unknown, options: {
    signal: AbortSignal; module: string; maxTokens?: number;
  }): Promise<unknown>;
  transcribe(pcm: Uint8Array, options: {
    signal: AbortSignal; requestId: string; onPartial?: (text: string) => void;
  }): Promise<{ text: string; payloadCount: number }>;
  synthesize(text: string, options: {
    /** With onAudio: sample-aligned mono PCM16 at 24 kHz; returned aggregate is for retention only. */
    signal: AbortSignal; onAudio?: (audio: Uint8Array, mimeType: string) => void;
  }): Promise<{ audio: Uint8Array; mimeType: string }>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`missing_configuration:${name}`);
  return value;
}

function tlsURL(value: string, protocol: string, name: string): string {
  const url = new URL(value);
  if (url.protocol !== protocol || url.username || url.password || url.search) {
    throw new Error(`invalid_configuration:${name}`);
  }
  return value;
}

export function readLiveProviderConfig(env: NodeJS.ProcessEnv): LiveProviderConfig {
  const asrEndpoint = env.DOUBAO_ASR_ENDPOINT?.trim() || DOUBAO_BIGMODEL_ASYNC_ENDPOINT;
  if (asrEndpoint !== DOUBAO_BIGMODEL_ASYNC_ENDPOINT) {
    throw new Error('invalid_configuration:DOUBAO_ASR_ENDPOINT');
  }
  if (required(env, 'LLM_MODEL') !== 'doubao-seed-2-0-lite-260428') {
    throw new Error('invalid_configuration:baseline_model_not_frozen');
  }
  return {
    text: {
      apiKey: required(env, 'LLM_API_KEY'),
      baseURL: tlsURL(required(env, 'LLM_BASE_URL'), 'https:', 'LLM_BASE_URL'),
      model: required(env, 'LLM_MODEL'),
      timeoutMs: 30_000,
    },
    asr: {
      apiKey: required(env, 'DOUBAO_ASR_API_KEY'),
      resourceId: required(env, 'DOUBAO_ASR_RESOURCE_ID'),
    },
    tts: {
      provider: 'doubao',
      endpoint: tlsURL(required(env, 'DOUBAO_TTS_ENDPOINT'), 'https:', 'DOUBAO_TTS_ENDPOINT'),
      apiKey: required(env, 'DOUBAO_TTS_API_KEY'),
      resourceId: required(env, 'DOUBAO_TTS_RESOURCE_ID'),
      model: 'seed-tts-2.0',
      voiceId: required(env, 'DOUBAO_TTS_SPEAKER'),
      outputFormat: 'mp3', sampleRate: 24_000,
      speed: 0.95, volume: 1, pitch: 1, synthesisTimeoutMs: 20_000,
    },
  };
}

function aborted(): Error {
  return new DOMException('request_cancelled', 'AbortError');
}

function safeCode(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'cancelled';
  if (error instanceof TtsStreamingError) return error.code;
  const status = (error as { status?: unknown })?.status;
  if (typeof status === 'number') return `provider_http_${status}`;
  const message = error instanceof Error ? error.message : '';
  if (/failed to create Doubao ASR WebSocket/u.test(message)) return 'asr_transport_construction_failed';
  if (/not a documented streaming ASR resource ID/u.test(message)) return 'asr_resource_configuration_invalid';
  const asrCode = /Doubao ASR provider returned code (\d+)/u.exec(message);
  if (asrCode) return `asr_provider_code_${asrCode[1]}`;
  if (/invalid Doubao ASR WebSocket frame/u.test(message)) return 'asr_protocol_failure';
  if (/invalid PCM16 audio chunk/u.test(message)) return 'asr_audio_chunk_invalid';
  if (/ASR transport (open|send|end|cancel) failed/u.test(message)) {
    const operation = /ASR transport (open|send|end|cancel) failed/u.exec(message)![1];
    if (!/HTTP|timeout|timed out|connection error|fetch failed|socket hang up/iu.test(message)) {
      return `asr_transport_${operation}_failure`;
    }
  }
  if (/asr_no_final/u.test(message)) return 'asr_no_final';
  if (/WebSocket closed before stream final/u.test(message)) return 'asr_closed_before_final';
  if (/^invalid_json$/u.test(message)) return 'invalid_json';
  if (/empty audio|text is empty/iu.test(message)) return 'empty_provider_result';
  if (/provider error/iu.test(message)) return 'provider_business_failure';
  const http = /(?:HTTP|status)\D{0,8}(\d{3})/u.exec(message);
  if (http) return `provider_http_${http[1]}`;
  if (error instanceof SyntaxError) return 'invalid_json';
  if (/timeout|timed out/iu.test(message)) return 'timeout';
  const code = (error as { code?: unknown })?.code
    ?? (error as { cause?: { code?: unknown } })?.cause?.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String(code))
    || /connection error|fetch failed|socket hang up/iu.test(message)) return 'provider_transport_failure';
  return 'provider_result_failure';
}

function retryable(code: string): boolean {
  return code === 'timeout' || code === 'provider_transport_failure'
    || code === 'provider_http_429' || /^provider_http_5\d\d$/u.test(code);
}

export function createLiveProvider(
  config: LiveProviderConfig,
  onAttempt?: (audit: ProviderAttemptAudit) => void,
  gate?: ProviderAttemptGate,
): LiveProvider {
  const client = new OpenAI({ ...config.text, timeout: config.text.timeoutMs, maxRetries: 0 });
  async function attempt<T>(module: string, signal: AbortSignal, operation: (requestId: string) => Promise<T>,
    usage?: (value: T) => { inputTokens: number; outputTokens: number },
    canRetry?: () => boolean): Promise<T> {
    for (let index = 1; index <= 3; index += 1) {
      if (signal.aborted) throw aborted();
      const requestId = randomUUID();
      gate?.beforeAttempt(module, requestId);
      const started = performance.now();
      try {
        const value = await operation(requestId);
        if (signal.aborted) throw aborted();
        const tokens = usage?.(value);
        onAttempt?.({ module, requestId, attempt: index, status: 'success',
          durationMs: Math.round(performance.now() - started), errorCode: null,
          inputTokens: tokens?.inputTokens ?? null, outputTokens: tokens?.outputTokens ?? null,
          estimatedTextCostCny: tokens ? (tokens.inputTokens * 1.2 + tokens.outputTokens * 7.2) / 1_000_000 : null,
          billingState: 'UNKNOWN' });
        return value;
      } catch (error) {
        const code = signal.aborted ? 'cancelled' : safeCode(error);
        const tokens = (error as { usage?: { inputTokens: number; outputTokens: number } })?.usage;
        const detail = module === 'asr' && (error as { code?: unknown })?.code === 'asr_transport_error'
          && error instanceof Error ? error.message.slice(0, 240) : undefined;
        onAttempt?.({ module, requestId, attempt: index,
          status: code === 'cancelled' ? 'cancelled' : 'failed',
          durationMs: Math.round(performance.now() - started), errorCode: code,
          inputTokens: tokens?.inputTokens ?? null, outputTokens: tokens?.outputTokens ?? null,
          estimatedTextCostCny: tokens ? (tokens.inputTokens * 1.2 + tokens.outputTokens * 7.2) / 1_000_000 : null,
          ...(detail ? { diagnostic: detail } : {}),
          billingState: 'UNKNOWN' });
        if (code === 'cancelled') throw aborted();
        if (index === 3 || !retryable(code) || (canRetry && !canRetry())) throw new Error(code);
      }
    }
    throw new Error('attempt_limit');
  }

  return {
    async json(system, input, options) {
      const encoded = JSON.stringify(input);
      if (encoded.length + system.length > 20_000) throw new Error('input_context_limit');
      const result = await attempt(options.module, options.signal, async () => {
        const response = await client.chat.completions.create({
        model: config.text.model, temperature: 0.2, max_tokens: options.maxTokens ?? 1_200,
        messages: [{ role: 'system', content: system }, { role: 'user', content: encoded }],
        response_format: { type: 'json_object' },
        ...({ thinking: { type: 'disabled' } } as object),
        }, { signal: options.signal });
        let output: unknown;
        try { output = JSON.parse(response.choices[0]?.message.content ?? ''); }
        catch {
          const error = new Error('invalid_json') as Error & { usage: { inputTokens: number; outputTokens: number } };
          error.usage = { inputTokens: response.usage?.prompt_tokens ?? 0, outputTokens: response.usage?.completion_tokens ?? 0 };
          throw error;
        }
        return { response, output };
      }, value => ({ inputTokens: value.response.usage?.prompt_tokens ?? 0,
        outputTokens: value.response.usage?.completion_tokens ?? 0 }));
      gate?.afterJson?.(options.module, result.output);
      return result.output;
    },
    async synthesize(text, options) {
      const onAudio = options.onAudio;
      if (onAudio) {
        let audioDelivered = false;
        return attempt('tts', options.signal, requestId => synthesizeDoubaoStreamingTts(config.tts, text, {
          signal: options.signal, requestId,
          onAudio(audio, mimeType) {
            if (options.signal.aborted) throw aborted();
            audioDelivered = true;
            onAudio(audio, mimeType);
          },
        }), undefined, () => !audioDelivered);
      }
      const result = await attempt('tts', options.signal,
        () => synthesizeWithDoubaoTts(config.tts, text, options.signal));
      const audio = new Uint8Array(Buffer.from(result.base64Audio, 'base64'));
      return { audio, mimeType: result.mimeType };
    },
    async transcribe(pcm, options) {
      if (!pcm.byteLength || pcm.byteLength % 2 || pcm.byteLength > 1_920_000) {
        throw new Error('invalid_pcm16');
      }
      return attempt('asr', options.signal, async () => {
        const finals = new Map<number, string>();
        let payloadCount = 0;
        const adapter = createDoubaoStreamingAsrAdapter({
          transportFactory: () => createDoubaoWebSocketTransport({ enableNonstream: true }),
        });
        const session = await adapter.open({
          identity: { sessionEpoch: options.requestId, turnId: options.requestId,
            generationId: 1, invocationId: `asr:${randomUUID()}`, evidenceRefs: [] },
          requestId: options.requestId,
          headers: { 'X-Api-Key': config.asr.apiKey,
            'X-Api-Resource-Id': config.asr.resourceId, 'X-Api-Request-Id': options.requestId },
          signal: options.signal,
          onDecodedPayload(payload) {
            payloadCount += 1;
            const envelope = payload as { result?: { text?: string; utterances?: Array<{
              definite?: boolean; text?: string; start_time?: number;
            }> }; payload_msg?: { result?: { text?: string; utterances?: Array<{
              definite?: boolean; text?: string; start_time?: number;
            }> } } };
            const result = envelope.result ?? envelope.payload_msg?.result;
            if (result?.text) options.onPartial?.(result.text);
            for (const utterance of result?.utterances ?? []) {
              if (utterance.definite && utterance.text) finals.set(utterance.start_time ?? 0, utterance.text);
            }
          },
        });
        try {
          const packetBytes = 6_400;
          for (let offset = 0, sequence = 0; offset < pcm.byteLength; offset += packetBytes, sequence += 1) {
            await session.send({ sequence, audio: pcm.subarray(offset, offset + packetBytes),
              format: { codec: 'pcm16', sampleRateHz: 16_000, bitsPerSample: 16, channels: 1 },
              endOfStream: offset + packetBytes >= pcm.byteLength });
          }
          await session.end();
          const text = [...finals].sort(([a], [b]) => a - b).map(([, value]) => value).join('');
          if (!text) throw new Error('asr_no_final');
          return { text, payloadCount };
        } catch (error) {
          await session.cancel('asr_failed').catch(() => undefined);
          throw error;
        }
      });
    },
  };
}
