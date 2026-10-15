import type {
  Pcm16AudioChunk,
  ValidatedPcm16AudioChunk,
} from './contracts.ts';

const EXPECTED_SAMPLE_RATE_HZ = 16_000;
const EXPECTED_BITS_PER_SAMPLE = 16;
const EXPECTED_CHANNELS = 1;
const BYTES_PER_SAMPLE_FRAME = (EXPECTED_BITS_PER_SAMPLE / 8) * EXPECTED_CHANNELS;
const BYTES_PER_MILLISECOND = (
  EXPECTED_SAMPLE_RATE_HZ * BYTES_PER_SAMPLE_FRAME
) / 1_000;

function fail(message: string): never {
  throw new Error(`invalid PCM16 audio chunk: ${message}`);
}

export function validatePcm16AudioChunk(
  chunk: Pcm16AudioChunk,
): ValidatedPcm16AudioChunk {
  if (!chunk || typeof chunk !== 'object') {
    fail('audio chunk must be an object');
  }
  if (!Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0) {
    fail('sequence must be a non-negative integer');
  }
  if (!(chunk.audio instanceof Uint8Array)) {
    fail('audio must be Uint8Array-compatible PCM bytes');
  }
  if (chunk.audio.byteLength === 0) {
    fail('audio must be non-empty');
  }
  if (!chunk.format || typeof chunk.format !== 'object') {
    fail('PCM format is required');
  }
  if (
    chunk.format.codec !== 'pcm16'
    || chunk.format.sampleRateHz !== EXPECTED_SAMPLE_RATE_HZ
    || chunk.format.bitsPerSample !== EXPECTED_BITS_PER_SAMPLE
    || chunk.format.channels !== EXPECTED_CHANNELS
  ) {
    fail('PCM format must be pcm16, 16000Hz, 16-bit, mono');
  }
  if (typeof chunk.endOfStream !== 'boolean') {
    fail('endOfStream must be explicit');
  }

  const byteLength = chunk.audio.byteLength;
  if (byteLength % BYTES_PER_SAMPLE_FRAME !== 0) {
    fail('PCM byte length must align to a complete sample frame');
  }

  const durationMs = byteLength / BYTES_PER_MILLISECOND;
  if (durationMs > 200) {
    fail('chunk duration must be between 100 and 200ms');
  }
  if (!chunk.endOfStream && durationMs < 100) {
    fail('chunk duration must be between 100 and 200ms unless it is an explicit EOS tail');
  }
  if (chunk.endOfStream && durationMs <= 0) {
    fail('EOS tail audio must be non-empty');
  }

  return {
    sequence: chunk.sequence,
    audio: chunk.audio,
    format: { ...chunk.format },
    endOfStream: chunk.endOfStream,
    byteLength,
    durationMs,
  };
}

export const PCM16_BYTES_PER_MILLISECOND = BYTES_PER_MILLISECOND;
