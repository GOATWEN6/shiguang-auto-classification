import { randomUUID } from 'node:crypto';

import type { DoubaoTtsConfig } from '../voice/tts/config.ts';

/** Raw little-endian PCM16, mono, 24 kHz; consumers must queue PCM samples. */
export const STREAMING_TTS_PCM_MIME_TYPE = 'audio/pcm;rate=24000;channels=1' as const;

const MAX_JSON_OBJECT_CHARS = 2 * 1024 * 1024;
const MAX_PREFIX_CHARS = 1024;
const MAX_WIRE_BYTES = 16 * 1024 * 1024;
const MAX_AUDIO_BYTES = 24_000 * 2 * 180;

type TtsStreamCode = 'tts_stream_protocol_failure' | 'tts_stream_limit_exceeded'
  | 'tts_stream_audio_format_invalid' | 'tts_stream_body_missing'
  | 'empty_provider_result' | 'provider_business_failure' | 'timeout';

/** Deliberately contains no provider response text, headers or credentials. */
export class TtsStreamingError extends Error {
  readonly code: TtsStreamCode;
  constructor(code: TtsStreamCode) { super(code); this.code = code; }
}

type JsonObject = Record<string, unknown>;

/** Parse only newly arrived text; retain at most one bounded incomplete object. */
class IncrementalJsonObjects {
  private object = '';
  private prefix = '';
  private depth = 0;
  private objectChars = 0;
  private inString = false;
  private escaped = false;
  private done = false;
  private readonly onObject: (value: JsonObject) => void;

  constructor(onObject: (value: JsonObject) => void) { this.onObject = onObject; }

  private finishPrefix(): void {
    const prefix = this.prefix.trim();
    this.prefix = '';
    if (!prefix || prefix === 'data:') return;
    if (prefix === '[DONE]' || /^data:\s*\[DONE\]$/u.test(prefix)) {
      this.done = true;
      return;
    }
    if (/^(?::|event:|id:|retry:)/u.test(prefix)) return;
    throw new TtsStreamingError('tts_stream_protocol_failure');
  }

  push(text: string): void {
    let segmentStart = this.depth ? 0 : -1;
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (!this.depth) {
        if (char !== '{') {
          if (char === '\n' || char === '\r') this.finishPrefix();
          else {
            this.prefix += char;
            if (this.prefix.length > MAX_PREFIX_CHARS) {
              throw new TtsStreamingError('tts_stream_limit_exceeded');
            }
          }
          continue;
        }
        if (this.done || (this.prefix.trim() && this.prefix.trim() !== 'data:')) {
          throw new TtsStreamingError('tts_stream_protocol_failure');
        }
        this.prefix = '';
        this.depth = 1;
        this.objectChars = 1;
        segmentStart = index;
        continue;
      }

      this.objectChars += 1;
      if (this.objectChars > MAX_JSON_OBJECT_CHARS) {
        throw new TtsStreamingError('tts_stream_limit_exceeded');
      }
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (char === '\\') this.escaped = true;
        else if (char === '"') this.inString = false;
        continue;
      }
      if (char === '"') this.inString = true;
      else if (char === '{') {
        this.depth += 1;
        if (this.depth > 64) throw new TtsStreamingError('tts_stream_limit_exceeded');
      } else if (char === '}') {
        this.depth -= 1;
        if (!this.depth) {
          const raw = this.object + text.slice(segmentStart, index + 1);
          this.object = '';
          segmentStart = -1;
          let value: unknown;
          try { value = JSON.parse(raw); }
          catch { throw new TtsStreamingError('tts_stream_protocol_failure'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new TtsStreamingError('tts_stream_protocol_failure');
          }
          this.onObject(value as JsonObject);
        }
      }
    }
    if (this.depth) this.object += text.slice(segmentStart);
  }

  finish(): void {
    if (this.depth) throw new TtsStreamingError('tts_stream_protocol_failure');
    this.finishPrefix();
  }
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject : undefined;
}

function audioFromChunk(chunk: JsonObject): string | undefined {
  const nested = object(chunk.data);
  const code = chunk.code ?? chunk.status_code ?? nested?.code;
  if (code !== undefined) {
    const normalizedCode = typeof code === 'number' ? code
      : typeof code === 'string' && /^\d+$/u.test(code) ? Number(code) : Number.NaN;
    if (!Number.isFinite(normalizedCode)) throw new TtsStreamingError('tts_stream_protocol_failure');
    if (normalizedCode !== 0 && normalizedCode !== 20_000_000) {
      throw new TtsStreamingError('provider_business_failure');
    }
  }
  const audio = typeof chunk.data === 'string' ? chunk.data
    : nested?.audio ?? chunk.audio ?? object(chunk.payload)?.audio;
  if (audio === undefined || audio === null || audio === '') return undefined;
  if (typeof audio !== 'string') throw new TtsStreamingError('tts_stream_protocol_failure');
  return audio;
}

function decodeBase64(value: string): Buffer {
  const encoded = value.replace(/\s+/gu, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 === 1) {
    throw new TtsStreamingError('tts_stream_audio_format_invalid');
  }
  const audio = Buffer.from(encoded, 'base64');
  if (!audio.length || audio.toString('base64').replace(/=+$/u, '') !== encoded.replace(/=+$/u, '')) {
    throw new TtsStreamingError('tts_stream_audio_format_invalid');
  }
  return audio;
}

function scaleRate(value: number): number {
  const normalized = Number.isFinite(value) ? value : 1;
  return Math.max(-50, Math.min(100, normalized >= 0.5 && normalized <= 2
    ? Math.round((normalized - 1) * 100) : Math.round(normalized)));
}

function abortError(): Error { return new DOMException('request_cancelled', 'AbortError'); }

/** The race also bounds injected/custom streams which do not obey fetch's signal. */
function withAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => { signal.removeEventListener('abort', onAbort); reject(abortError()); };
    if (signal.aborted) { work.catch(() => undefined); reject(abortError()); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

export interface StreamingTtsOptions {
  signal: AbortSignal;
  requestId?: string;
  onAudio(audio: Uint8Array, mimeType: typeof STREAMING_TTS_PCM_MIME_TYPE): void;
}

/**
 * Same Doubao HTTP service and credentials as the complete MP3 path, requesting
 * PCM explicitly so callback fragments are sample-aligned rather than MP3 slices.
 * Retry/reservation policy belongs to LiveProvider; this function makes one call.
 */
export async function synthesizeDoubaoStreamingTts(
  config: DoubaoTtsConfig,
  text: string,
  options: StreamingTtsOptions,
): Promise<{ audio: Uint8Array; mimeType: typeof STREAMING_TTS_PCM_MIME_TYPE }> {
  const normalizedText = text.replace(/\s+/gu, ' ').trim().slice(0, 500);
  if (!normalizedText) throw new Error('TTS text is empty');
  if (options.signal.aborted) throw abortError();

  const controller = new AbortController();
  let timedOut = false;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let bodyFinished = false;
  const cancelReader = () => { void reader?.cancel().catch(() => undefined); };
  controller.signal.addEventListener('abort', cancelReader, { once: true });
  const onCallerAbort = () => controller.abort(options.signal.reason);
  options.signal.addEventListener('abort', onCallerAbort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.synthesisTimeoutMs);
  const checkActive = () => {
    if (options.signal.aborted) throw abortError();
    if (timedOut) throw new TtsStreamingError('timeout');
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json', 'X-Api-Resource-Id': config.resourceId,
    'X-Api-Request-Id': options.requestId ?? randomUUID(),
  };
  if (config.apiKey) headers['X-Api-Key'] = config.apiKey;
  if (config.appId) headers['X-Api-App-Id'] = config.appId;
  if (config.appKey) headers['X-Api-App-Key'] = config.appKey;
  if (config.accessKey) headers['X-Api-Access-Key'] = config.accessKey;
  const reqParams: Record<string, unknown> = {
    text: normalizedText, speaker: config.voiceId,
    audio_params: { format: 'pcm', sample_rate: 24_000,
      speech_rate: scaleRate(config.speed), loudness_rate: scaleRate(config.volume),
      pitch_rate: scaleRate(config.pitch) },
  };
  if (config.model === 'seed-tts-2.0-standard' || config.model === 'seed-tts-2.0-expressive') {
    reqParams.model = config.model;
  }

  try {
    const request = fetch(config.endpoint, { method: 'POST', headers,
      signal: controller.signal, body: JSON.stringify({ user: { uid: 'sgx-voice-assistant' },
        namespace: 'BidirectionalTTS', req_params: reqParams }) });
    // A late response from a custom fetch must not leave its body open after cancellation.
    void request.then(value => {
      if (controller.signal.aborted) void value.body?.cancel().catch(() => undefined);
    }, () => undefined);
    const response = await withAbort(request, controller.signal);
    checkActive();
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Doubao TTS HTTP ${response.status}`);
    }
    if (!response.body) throw new TtsStreamingError('tts_stream_body_missing');
    reader = response.body.getReader();
    const parts: Buffer[] = [];
    let audioBytes = 0;
    let wireBytes = 0;
    let remainingByte: Buffer | undefined;
    const parser = new IncrementalJsonObjects(chunk => {
      checkActive();
      const encoded = audioFromChunk(chunk);
      if (!encoded) return;
      const audio = decodeBase64(encoded);
      audioBytes += audio.length;
      if (audioBytes > MAX_AUDIO_BYTES) throw new TtsStreamingError('tts_stream_limit_exceeded');
      parts.push(audio);
      const aligned = remainingByte ? Buffer.concat([remainingByte, audio]) : audio;
      const completeBytes = aligned.length - aligned.length % 2;
      remainingByte = completeBytes === aligned.length ? undefined : aligned.subarray(completeBytes);
      if (completeBytes) {
        checkActive();
        // A consumer may mutate callback buffers without changing the retained result.
        options.onAudio(new Uint8Array(aligned.subarray(0, completeBytes)), STREAMING_TTS_PCM_MIME_TYPE);
      }
    });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (bytes?: Uint8Array, stream = false): string => {
      try { return decoder.decode(bytes, { stream }); }
      catch { throw new TtsStreamingError('tts_stream_protocol_failure'); }
    };
    while (true) {
      checkActive();
      const chunk = await withAbort(reader.read(), controller.signal);
      checkActive();
      if (chunk.done) { bodyFinished = true; break; }
      wireBytes += chunk.value.byteLength;
      if (wireBytes > MAX_WIRE_BYTES) throw new TtsStreamingError('tts_stream_limit_exceeded');
      parser.push(decode(chunk.value, true));
    }
    parser.push(decode());
    parser.finish();
    if (remainingByte) throw new TtsStreamingError('tts_stream_audio_format_invalid');
    if (!audioBytes) throw new TtsStreamingError('empty_provider_result');
    checkActive();
    return { audio: new Uint8Array(Buffer.concat(parts, audioBytes)), mimeType: STREAMING_TTS_PCM_MIME_TYPE };
  } catch (error) {
    if (options.signal.aborted) throw abortError();
    if (timedOut) throw new TtsStreamingError('timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener('abort', onCallerAbort);
    controller.signal.removeEventListener('abort', cancelReader);
    if (!bodyFinished) cancelReader();
    try { reader?.releaseLock(); } catch { /* Cancellation may still be settling. */ }
  }
}
