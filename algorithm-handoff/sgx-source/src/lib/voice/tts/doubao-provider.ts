import { randomUUID } from 'node:crypto';
import { mimeTypeForTtsFormat, type DoubaoTtsConfig } from './config.ts';
import type { VoiceTtsAudio } from './types.ts';

type DoubaoTtsChunk = Record<string, any>;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function parseConcatenatedJsonObjects(raw: string): DoubaoTtsChunk[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  try {
    return [JSON.parse(trimmed) as DoubaoTtsChunk];
  } catch {
    // Continue with streaming parsers below.
  }

  const objects: DoubaoTtsChunk[] = [];
  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.startsWith('data:') ? line.slice(5).trim() : line);

  for (const line of lines) {
    if (!line || line === '[DONE]') continue;
    try {
      objects.push(JSON.parse(line) as DoubaoTtsChunk);
    } catch {
      // Some chunked responses concatenate JSON objects without newlines.
    }
  }
  if (objects.length) return objects;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const segment = trimmed.slice(start, index + 1);
        try {
          objects.push(JSON.parse(segment) as DoubaoTtsChunk);
        } catch {
          // Ignore malformed provider chunks and let the empty-audio guard fail.
        }
        start = -1;
      }
    }
  }

  return objects;
}

function getBase64Audio(chunk: DoubaoTtsChunk): string | undefined {
  const direct = chunk?.data;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const nested = chunk?.data?.audio || chunk?.audio || chunk?.payload?.audio;
  if (typeof nested === 'string' && nested.trim()) return nested.trim();
  return undefined;
}

function toDoubaoScaleRate(value: number): number {
  const normalized = Number.isFinite(value) ? value : 1;
  const rate = normalized >= 0.5 && normalized <= 2
    ? Math.round((normalized - 1) * 100)
    : Math.round(normalized);
  return Math.max(-50, Math.min(100, rate));
}

function isSupportedReqModel(model: string): boolean {
  return model === 'seed-tts-2.0-standard' || model === 'seed-tts-2.0-expressive';
}

function throwIfProviderError(chunk: DoubaoTtsChunk): void {
  const code = chunk?.code ?? chunk?.status_code ?? chunk?.data?.code;
  const message = chunk?.message ?? chunk?.status_msg ?? chunk?.data?.message;
  if (typeof code === 'number' && code !== 0 && code !== 20000000) {
    throw new Error(`Doubao TTS provider error: ${message || code}`);
  }
}

function buildHeaders(config: DoubaoTtsConfig, requestId: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Api-Resource-Id': config.resourceId,
    'X-Api-Request-Id': requestId,
  };
  if (config.apiKey) headers['X-Api-Key'] = config.apiKey;
  if (config.appId) headers['X-Api-App-Id'] = config.appId;
  if (config.appKey) headers['X-Api-App-Key'] = config.appKey;
  if (config.accessKey) headers['X-Api-Access-Key'] = config.accessKey;
  return headers;
}

export async function synthesizeWithDoubaoTts(
  config: DoubaoTtsConfig,
  text: string,
  signal?: AbortSignal,
): Promise<VoiceTtsAudio> {
  const normalizedText = normalizeText(text);
  if (!normalizedText) throw new Error('TTS text is empty');

  const requestId = randomUUID();
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), config.synthesisTimeoutMs);
  const reqParams: Record<string, any> = {
    text: normalizedText,
    speaker: config.voiceId,
    audio_params: {
      format: config.outputFormat,
      sample_rate: config.sampleRate,
      speech_rate: toDoubaoScaleRate(config.speed),
      loudness_rate: toDoubaoScaleRate(config.volume),
      pitch_rate: toDoubaoScaleRate(config.pitch),
    },
  };
  if (isSupportedReqModel(config.model)) {
    reqParams.model = config.model;
  }

  try {
    const response = await fetch(config.endpoint, {
      method: 'POST',
      headers: buildHeaders(config, requestId),
      signal: controller.signal,
      body: JSON.stringify({
        user: {
          uid: 'sgx-voice-assistant',
        },
        namespace: 'BidirectionalTTS',
        req_params: reqParams,
      }),
    });

    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Doubao TTS HTTP ${response.status}: ${raw.slice(0, 180)}`);
    }

    const chunks = parseConcatenatedJsonObjects(raw);
    const audioParts: Buffer[] = [];
    for (const chunk of chunks) {
      throwIfProviderError(chunk);
      const audio = getBase64Audio(chunk);
      if (audio) audioParts.push(Buffer.from(audio, 'base64'));
    }

    const audioBuffer = Buffer.concat(audioParts);
    if (!audioBuffer.length) {
      throw new Error('Doubao TTS returned empty audio');
    }

    return {
      base64Audio: audioBuffer.toString('base64'),
      mimeType: mimeTypeForTtsFormat(config.outputFormat),
      provider: 'doubao',
      model: config.resourceId,
      voiceId: config.voiceId,
      receivedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
