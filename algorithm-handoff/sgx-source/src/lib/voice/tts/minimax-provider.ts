import { connectHeaderWebSocket, HeaderWebSocketConnection } from '../realtime/header-websocket';
import { MiniMaxTtsConfig, mimeTypeForTtsFormat } from './config';
import { VoiceTtsAudio } from './types';

type MiniMaxMessage = Record<string, any>;

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function isLikelyHexAudio(value: string): boolean {
  return value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function createMessageQueue(timeoutMs: number) {
  const queue: MiniMaxMessage[] = [];
  const waiters: Array<{
    resolve: (message: MiniMaxMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  let closed = false;

  return {
    push(raw: Buffer) {
      const text = raw.toString('utf8');
      const parsed = JSON.parse(text) as MiniMaxMessage;
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(parsed);
        return;
      }
      queue.push(parsed);
    },
    close() {
      closed = true;
      const error = new Error('MiniMax TTS WebSocket closed before synthesis completed');
      waiters.splice(0).forEach(waiter => waiter.reject(error));
    },
    async next(signal?: AbortSignal): Promise<MiniMaxMessage> {
      if (signal?.aborted) throw new DOMException('TTS synthesis aborted', 'AbortError');
      const existing = queue.shift();
      if (existing) return existing;
      if (closed) throw new Error('MiniMax TTS WebSocket closed before synthesis completed');

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('MiniMax TTS synthesis timed out'));
        }, timeoutMs);
        const abortFromCaller = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          clearTimeout(timer);
          reject(new DOMException('TTS synthesis aborted', 'AbortError'));
        };
        const waiter = {
          resolve: (message: MiniMaxMessage) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortFromCaller);
            resolve(message);
          },
          reject: (error: Error) => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abortFromCaller);
            reject(error);
          },
        };
        waiters.push(waiter);
        signal?.addEventListener('abort', abortFromCaller, { once: true });
      });
    },
  };
}

function sendJson(connection: HeaderWebSocketConnection, payload: MiniMaxMessage): void {
  connection.send(JSON.stringify(payload), 0x1);
}

function getAudioHex(message: MiniMaxMessage): string | undefined {
  const audio = message?.data?.audio;
  return typeof audio === 'string' && audio.trim() ? audio.trim() : undefined;
}

function getStatus(message: MiniMaxMessage): string | undefined {
  const status = message?.event || message?.type || message?.base_resp?.status_msg;
  return typeof status === 'string' ? status : undefined;
}

function throwIfProviderError(message: MiniMaxMessage): void {
  const statusCode = message?.base_resp?.status_code;
  if (typeof statusCode === 'number' && statusCode !== 0) {
    throw new Error(`MiniMax TTS provider error: ${message?.base_resp?.status_msg || statusCode}`);
  }
}

async function waitForTaskStarted(
  queue: ReturnType<typeof createMessageQueue>,
  signal?: AbortSignal,
): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    const message = await queue.next(signal);
    throwIfProviderError(message);
    if (getStatus(message) === 'task_started') return;
  }
  throw new Error('MiniMax TTS task did not start');
}

export async function synthesizeWithMiniMaxTts(
  config: MiniMaxTtsConfig,
  text: string,
  signal?: AbortSignal,
): Promise<VoiceTtsAudio> {
  const normalizedText = normalizeText(text);
  if (!normalizedText) throw new Error('TTS text is empty');

  let connection: HeaderWebSocketConnection | null = null;
  const queue = createMessageQueue(config.synthesisTimeoutMs);
  const audioParts: Buffer[] = [];

  try {
    connection = await connectHeaderWebSocket({
      url: `${config.endpoint}?model=${encodeURIComponent(config.model)}`,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
      timeoutMs: config.connectTimeoutMs,
      signal,
      onMessage: (payload, opcode) => {
        if (opcode !== 0x1) return;
        queue.push(payload);
      },
      onClose: () => queue.close(),
    });

    sendJson(connection, {
      event: 'task_start',
      model: config.model,
      language_boost: 'Chinese',
      voice_setting: {
        voice_id: config.voiceId,
        speed: config.speed,
        vol: config.volume,
        pitch: config.pitch,
      },
      audio_setting: {
        sample_rate: config.sampleRate,
        bitrate: config.bitrate,
        format: config.outputFormat,
        channel: 1,
      },
    });
    await waitForTaskStarted(queue, signal);

    sendJson(connection, {
      event: 'task_continue',
      text: normalizedText,
    });

    while (true) {
      const message = await queue.next(signal);
      throwIfProviderError(message);
      const audioHex = getAudioHex(message);
      if (audioHex) {
        audioParts.push(isLikelyHexAudio(audioHex)
          ? Buffer.from(audioHex, 'hex')
          : Buffer.from(audioHex, 'base64'));
      }
      if (message?.is_final) break;
    }

    sendJson(connection, { event: 'task_finish' });

    const audioBuffer = Buffer.concat(audioParts);
    if (!audioBuffer.length) {
      throw new Error('MiniMax TTS returned empty audio');
    }

    return {
      base64Audio: audioBuffer.toString('base64'),
      mimeType: mimeTypeForTtsFormat(config.outputFormat),
      provider: 'minimax',
      model: config.model,
      voiceId: config.voiceId,
      receivedAt: new Date().toISOString(),
    };
  } finally {
    connection?.close();
  }
}
