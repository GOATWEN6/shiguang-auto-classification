import { gunzipSync, gzipSync } from 'node:zlib';

import WebSocket from 'ws';

import { validatePcm16AudioChunk } from './audio-chunk-validator.ts';
import type {
  DoubaoInjectedTransport,
  DoubaoInjectedTransportConnection,
  DoubaoTransportOpenOptions,
  ValidatedPcm16AudioChunk,
} from './contracts.ts';

/**
 * Dedicated ASR endpoint. This module must not be pointed at the legacy
 * `volc.speech.dialog` realtime conversation service.
 */
export const DOUBAO_BIGMODEL_ASYNC_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async' as const;

export const DOUBAO_ASR_RESOURCE_IDS = [
  'volc.seedasr.sauc.duration',
  'volc.seedasr.sauc.concurrent',
  'volc.bigasr.sauc.duration',
  'volc.bigasr.sauc.concurrent',
] as const;

export type DoubaoAsrResourceId = (typeof DOUBAO_ASR_RESOURCE_IDS)[number];

const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const SERVER_ERROR_RESPONSE = 0b1111;
const NO_SEQUENCE = 0b0000;
const HAS_SEQUENCE = 0b0001;
const LAST_WITHOUT_SEQUENCE = 0b0010;
const JSON_SERIALIZATION = 0b0001;
const RAW_SERIALIZATION = 0b0000;
const NO_COMPRESSION = 0b0000;
const GZIP_COMPRESSION = 0b0001;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_RECEIVE_TIMEOUT_MS = 8_000;
const DEFAULT_FINAL_TIMEOUT_MS = 12_000;
const DEFAULT_MIN_PACKET_INTERVAL_MS = 100;
const DEFAULT_MAX_SERVER_FRAME_BYTES = 8 * 1024 * 1024;

export interface DoubaoWebSocketTransportOptions {
  connectTimeoutMs?: number;
  receiveTimeoutMs?: number;
  finalTimeoutMs?: number;
  /** Enforces the provider's documented 100-200ms send cadence. */
  minPacketIntervalMs?: number;
  maxServerFrameBytes?: number;
  enableItn?: boolean;
  enablePunc?: boolean;
  enableDdc?: boolean;
  /**
   * The two-pass mode is enabled by default so final utterances carry the
   * provider's `definite=true` marker required by the Evidence reducer.
   */
  enableNonstream?: boolean;
}

export interface DecodedDoubaoServerFrame {
  payload: Record<string, unknown>;
  final: boolean;
  sequence?: number;
}

export class DoubaoWebSocketProtocolError extends Error {
  readonly code = 'doubao_websocket_protocol_error' as const;

  constructor(message: string) {
    super(`invalid Doubao ASR WebSocket frame: ${message}`);
    this.name = 'DoubaoWebSocketProtocolError';
  }
}

export class DoubaoWebSocketProviderError extends Error {
  readonly code = 'doubao_websocket_provider_error' as const;
  readonly providerCode: number;

  constructor(providerCode: number) {
    // Provider payload text is intentionally excluded: it is untrusted and
    // may echo request data. The numeric code is sufficient for classification.
    super(`Doubao ASR provider returned code ${providerCode}`);
    this.name = 'DoubaoWebSocketProviderError';
    this.providerCode = providerCode;
  }
}

function protocolError(message: string): never {
  throw new DoubaoWebSocketProtocolError(message);
}

function abortError(message = 'Doubao ASR WebSocket transport was cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function safeWebSocketConnectionError(event: unknown): Error {
  const errorEvent = event as { message?: unknown; error?: unknown };
  const candidates = [
    typeof errorEvent.message === 'string' ? errorEvent.message : '',
    errorEvent.error instanceof Error ? errorEvent.error.message : '',
  ];
  for (const candidate of candidates) {
    const match = candidate.match(/(?:status(?: code)?|HTTP)\D{0,8}(\d{3})/iu);
    if (match) return new Error(`Doubao ASR WebSocket connection failed (HTTP ${match[1]})`);
    if (/certificate|TLS|SSL/iu.test(candidate)) {
      return new Error('Doubao ASR WebSocket connection failed (TLS)');
    }
    if (/ENOTFOUND|EAI_AGAIN|DNS/iu.test(candidate)) {
      return new Error('Doubao ASR WebSocket connection failed (DNS)');
    }
    if (/ECONNREFUSED|ECONNRESET|socket/iu.test(candidate)) {
      return new Error('Doubao ASR WebSocket connection failed (network)');
    }
  }
  return new Error('Doubao ASR WebSocket connection failed');
}

function positiveInteger(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return selected;
}

function packetInterval(value: number | undefined): number {
  const selected = value ?? DEFAULT_MIN_PACKET_INTERVAL_MS;
  if (!Number.isSafeInteger(selected) || selected < 100 || selected > 200) {
    throw new Error('minPacketIntervalMs must be an integer between 100 and 200');
  }
  return selected;
}

function frameHeader(messageType: number, flags: number, serialization: number): Uint8Array {
  return Uint8Array.of(
    0x11,
    (messageType << 4) | flags,
    (serialization << 4) | GZIP_COMPRESSION,
    0x00,
  );
}

function appendSizedPayload(header: Uint8Array, payload: Uint8Array): Uint8Array {
  if (payload.byteLength > 0xffff_ffff) protocolError('payload exceeds uint32 length');
  const frame = new Uint8Array(header.byteLength + 4 + payload.byteLength);
  frame.set(header, 0);
  new DataView(frame.buffer).setUint32(header.byteLength, payload.byteLength, false);
  frame.set(payload, header.byteLength + 4);
  return frame;
}

export function encodeDoubaoFullClientRequestFrame(
  payload: Readonly<Record<string, unknown>>,
): Uint8Array {
  let json: string;
  try {
    json = JSON.stringify(payload);
  } catch {
    protocolError('full request payload must be JSON serializable');
  }
  if (json === undefined) protocolError('full request payload must be an object');
  const compressed = gzipSync(new TextEncoder().encode(json));
  return appendSizedPayload(
    frameHeader(FULL_CLIENT_REQUEST, NO_SEQUENCE, JSON_SERIALIZATION),
    compressed,
  );
}

export function encodeDoubaoAudioFrame(
  audio: Uint8Array,
  final: boolean,
): Uint8Array {
  if (!(audio instanceof Uint8Array) || audio.byteLength === 0) {
    protocolError('audio payload must be non-empty bytes');
  }
  const compressed = gzipSync(audio);
  return appendSizedPayload(
    frameHeader(
      AUDIO_ONLY_REQUEST,
      final ? LAST_WITHOUT_SEQUENCE : NO_SEQUENCE,
      RAW_SERIALIZATION,
    ),
    compressed,
  );
}

function readUint32(bytes: Uint8Array, offset: number, field: string): number {
  if (offset + 4 > bytes.byteLength) protocolError(`missing ${field}`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getUint32(offset, false);
}

function readInt32(bytes: Uint8Array, offset: number, field: string): number {
  if (offset + 4 > bytes.byteLength) protocolError(`missing ${field}`);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .getInt32(offset, false);
}

function decodePayload(
  payload: Uint8Array,
  serialization: number,
  compression: number,
  maxOutputBytes: number,
): Record<string, unknown> {
  let decoded: Uint8Array;
  if (compression === GZIP_COMPRESSION) {
    try {
      decoded = gunzipSync(payload, { maxOutputLength: maxOutputBytes });
    } catch {
      protocolError('gzip payload could not be decompressed');
    }
  } else if (compression === NO_COMPRESSION) {
    decoded = payload;
  } else {
    protocolError(`unsupported compression method ${compression}`);
  }
  if (serialization !== JSON_SERIALIZATION) {
    protocolError(`unsupported server serialization method ${serialization}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decoded));
  } catch {
    protocolError('server payload is not valid UTF-8 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    protocolError('server JSON payload must be an object');
  }
  return parsed as Record<string, unknown>;
}

/** Decode one provider binary frame without performing network I/O. */
export function decodeDoubaoServerFrame(
  frame: Uint8Array,
  maxFrameBytes = DEFAULT_MAX_SERVER_FRAME_BYTES,
): DecodedDoubaoServerFrame {
  if (!(frame instanceof Uint8Array)) protocolError('frame must be bytes');
  if (frame.byteLength < 8) protocolError('frame is shorter than the minimum envelope');
  if (frame.byteLength > maxFrameBytes) protocolError('frame exceeds the configured size limit');

  const protocolVersion = frame[0] >> 4;
  const headerWords = frame[0] & 0x0f;
  if (protocolVersion !== 1) protocolError(`unsupported protocol version ${protocolVersion}`);
  if (headerWords < 1) protocolError('header size must be at least four bytes');
  const headerBytes = headerWords * 4;
  if (headerBytes > frame.byteLength) protocolError('declared header exceeds frame length');

  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const serialization = frame[2] >> 4;
  const compression = frame[2] & 0x0f;
  let cursor = headerBytes;

  if (messageType === SERVER_ERROR_RESPONSE) {
    const providerCode = readUint32(frame, cursor, 'provider error code');
    cursor += 4;
    const errorPayloadSize = readUint32(frame, cursor, 'provider error payload size');
    cursor += 4;
    if (errorPayloadSize !== frame.byteLength - cursor) {
      protocolError('provider error payload length does not match its envelope');
    }
    throw new DoubaoWebSocketProviderError(providerCode);
  }
  if (messageType !== FULL_SERVER_RESPONSE) {
    protocolError(`unexpected server message type ${messageType}`);
  }

  let sequence: number | undefined;
  if ((flags & HAS_SEQUENCE) === HAS_SEQUENCE) {
    sequence = readInt32(frame, cursor, 'server sequence');
    cursor += 4;
  }
  const payloadSize = readUint32(frame, cursor, 'payload size');
  cursor += 4;
  if (payloadSize !== frame.byteLength - cursor) {
    protocolError('payload length does not match its envelope');
  }

  const payload = decodePayload(
    frame.subarray(cursor),
    serialization,
    compression,
    maxFrameBytes,
  );
  const final = (flags & LAST_WITHOUT_SEQUENCE) === LAST_WITHOUT_SEQUENCE;
  if (payload.payload_sequence === undefined) {
    // The provider is allowed to omit both the binary sequence flag and a
    // JSON sequence. The connection assigns a stable arrival ordinal below so
    // downstream deduplication still has a packet identity.
    if (sequence !== undefined) payload.payload_sequence = sequence;
  }
  if (final) {
    if (payload.is_last_package === false) {
      protocolError('frame and JSON final markers conflict');
    }
    payload.is_last_package = true;
  }

  const providerCode = payload.code;
  if (
    typeof providerCode === 'number'
    && Number.isSafeInteger(providerCode)
    && providerCode !== 0
    && providerCode !== 20_000_000
  ) {
    throw new DoubaoWebSocketProviderError(providerCode);
  }

  return { payload, final, ...(sequence === undefined ? {} : { sequence }) };
}

function requiredHeader(
  headers: Readonly<Record<string, string>>,
  expectedName: string,
): string {
  let found: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== expectedName.toLowerCase()) continue;
    if (found !== undefined && found !== value) {
      throw new Error(`conflicting ${expectedName} headers`);
    }
    found = value;
  }
  if (found === undefined || found.trim().length === 0) {
    throw new Error(`${expectedName} is required`);
  }
  return found;
}

function optionalHeader(
  headers: Readonly<Record<string, string>>,
  expectedName: string,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === expectedName.toLowerCase()) return value;
  }
  return undefined;
}

function websocketHeaders(options: DoubaoTransportOpenOptions): Record<string, string> {
  const apiKey = requiredHeader(options.headers, 'X-Api-Key');
  const resourceId = requiredHeader(options.headers, 'X-Api-Resource-Id');
  if (!(DOUBAO_ASR_RESOURCE_IDS as readonly string[]).includes(resourceId)) {
    throw new Error('X-Api-Resource-Id is not a documented streaming ASR resource ID');
  }
  const suppliedRequestId = optionalHeader(options.headers, 'X-Api-Request-Id');
  if (suppliedRequestId !== undefined && suppliedRequestId !== options.requestId) {
    throw new Error('X-Api-Request-Id must match requestId');
  }
  return {
    'X-Api-Key': apiKey,
    'X-Api-Resource-Id': resourceId,
    'X-Api-Request-Id': options.requestId,
  };
}

function initialRequest(options: DoubaoWebSocketTransportOptions): Record<string, unknown> {
  return {
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: 16_000,
      bits: 16,
      channel: 1,
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: options.enableItn ?? true,
      enable_punc: options.enablePunc ?? true,
      enable_ddc: options.enableDdc ?? false,
      show_utterances: true,
      enable_nonstream: options.enableNonstream ?? true,
    },
  };
}

async function eventBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  protocolError('WebSocket delivered a non-binary message');
}

function waitFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  if (signal.aborted) {
    return Promise.reject(signal.reason instanceof Error ? signal.reason : abortError());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function openConnection(
  transportOptions: DoubaoWebSocketTransportOptions,
  openOptions: DoubaoTransportOpenOptions,
): Promise<DoubaoInjectedTransportConnection> {
  if (openOptions.signal.aborted) throw abortError();
  const connectTimeoutMs = positiveInteger(
    transportOptions.connectTimeoutMs,
    DEFAULT_CONNECT_TIMEOUT_MS,
    'connectTimeoutMs',
  );
  const receiveTimeoutMs = positiveInteger(
    transportOptions.receiveTimeoutMs,
    DEFAULT_RECEIVE_TIMEOUT_MS,
    'receiveTimeoutMs',
  );
  const finalTimeoutMs = positiveInteger(
    transportOptions.finalTimeoutMs,
    DEFAULT_FINAL_TIMEOUT_MS,
    'finalTimeoutMs',
  );
  const minPacketIntervalMs = packetInterval(transportOptions.minPacketIntervalMs);
  const maxServerFrameBytes = positiveInteger(
    transportOptions.maxServerFrameBytes,
    DEFAULT_MAX_SERVER_FRAME_BYTES,
    'maxServerFrameBytes',
  );
  const headers = websocketHeaders(openOptions);
  const fullRequest = encodeDoubaoFullClientRequestFrame(initialRequest(transportOptions));
  const lifecycle = new AbortController();

  return new Promise<DoubaoInjectedTransportConnection>((resolve, reject) => {
    let socket: WebSocket;
    let opened = false;
    let settledOpen = false;
    let cancelled = false;
    let closingNormally = false;
    let finalReceived = false;
    let lastPackageSent = false;
    let lastSequence: number | undefined;
    let receivedPacketOrdinal = 0;
    let lastSendAt: number | undefined;
    let fatalError: Error | undefined;
    let receiveTimer: ReturnType<typeof setTimeout> | undefined;
    let finalTimer: ReturnType<typeof setTimeout> | undefined;
    let endPromise: Promise<void> | undefined;
    let resolveEnd: (() => void) | undefined;
    let rejectEnd: ((error: Error) => void) | undefined;
    let messageTail = Promise.resolve();

    const clearTimers = (): void => {
      clearTimeout(connectTimer);
      if (receiveTimer) clearTimeout(receiveTimer);
      if (finalTimer) clearTimeout(finalTimer);
    };
    const closeSocket = (reason: string): void => {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        try {
          socket.close(1000, reason);
        } catch {
          // The original failure remains authoritative and is already redacted.
        }
      }
    };
    const fail = (error: Error): void => {
      if (fatalError || cancelled || finalReceived) return;
      fatalError = error;
      clearTimers();
      openOptions.signal.removeEventListener('abort', onExternalAbort);
      lifecycle.abort(error);
      closeSocket('transport_failure');
      if (!settledOpen) {
        settledOpen = true;
        reject(error);
      }
      rejectEnd?.(error);
    };
    const armReceiveTimeout = (): void => {
      if (
        receiveTimer !== undefined
        || lastSequence === undefined
        || lastPackageSent
        || finalReceived
        || cancelled
        || fatalError
      ) return;
      receiveTimer = setTimeout(() => {
        fail(new Error(`Doubao ASR receive timed out after ${receiveTimeoutMs}ms`));
      }, receiveTimeoutMs);
    };
    const armFinalTimeout = (): void => {
      if (finalTimer) clearTimeout(finalTimer);
      if (finalReceived || cancelled || fatalError) return;
      finalTimer = setTimeout(() => {
        fail(new Error(`Doubao ASR final response timed out after ${finalTimeoutMs}ms`));
      }, finalTimeoutMs);
    };
    const finish = (): void => {
      if (finalReceived) return;
      finalReceived = true;
      closingNormally = true;
      clearTimers();
      openOptions.signal.removeEventListener('abort', onExternalAbort);
      resolveEnd?.();
      closeSocket('stream_final');
    };
    const cancel = async (): Promise<void> => {
      if (cancelled || finalReceived) return;
      cancelled = true;
      closingNormally = true;
      clearTimers();
      openOptions.signal.removeEventListener('abort', onExternalAbort);
      const error = abortError();
      lifecycle.abort(error);
      rejectEnd?.(error);
      closeSocket('client_cancelled');
      if (!settledOpen) {
        settledOpen = true;
        reject(error);
      }
    };
    const onExternalAbort = (): void => {
      void cancel();
    };

    try {
      socket = new WebSocket(DOUBAO_BIGMODEL_ASYNC_ENDPOINT, {
        headers,
        // Bound the WebSocket receiver before it buffers a complete message;
        // the binary decoder separately bounds decompressed JSON.
        maxPayload: maxServerFrameBytes,
      });
      socket.binaryType = 'arraybuffer';
    } catch {
      settledOpen = true;
      // Do not expose the platform error: header validation failures may echo
      // the credential value supplied to the WebSocket constructor.
      reject(new Error('failed to create Doubao ASR WebSocket'));
      return;
    }

    const connectTimer = setTimeout(() => {
      fail(new Error(`Doubao ASR WebSocket connect timed out after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);

    socket.once('unexpected-response', (_request, response) => {
      // Drain the rejected upgrade response without reading its untrusted body.
      response.resume();
      fail(new Error(
        `Doubao ASR WebSocket connection failed (HTTP ${response.statusCode ?? 'unknown'})`,
      ));
    });

    openOptions.signal.addEventListener('abort', onExternalAbort, { once: true });

    socket.addEventListener('open', () => {
      if (cancelled || openOptions.signal.aborted) {
        void cancel();
        if (!settledOpen) {
          settledOpen = true;
          reject(abortError());
        }
        return;
      }
      try {
        socket.send(fullRequest);
      } catch {
        fail(new Error('failed to send Doubao ASR full client request'));
        return;
      }
      opened = true;
      clearTimeout(connectTimer);
      if (!settledOpen) {
        settledOpen = true;
        resolve({
          async send(chunk: ValidatedPcm16AudioChunk): Promise<void> {
            if (fatalError) throw fatalError;
            if (cancelled || openOptions.signal.aborted) throw abortError();
            if (!opened || socket.readyState !== WebSocket.OPEN) {
              throw new Error('Doubao ASR WebSocket is not open');
            }
            if (lastPackageSent || finalReceived) {
              throw new Error('cannot send audio after the final ASR packet');
            }

            const validated = validatePcm16AudioChunk(chunk);
            const expectedSequence = lastSequence === undefined
              ? validated.sequence
              : lastSequence + 1;
            if (validated.sequence !== expectedSequence) {
              throw new Error('audio chunk sequence must be contiguous and strictly increasing');
            }

            const elapsed = lastSendAt === undefined ? minPacketIntervalMs : Date.now() - lastSendAt;
            await waitFor(Math.max(0, minPacketIntervalMs - elapsed), lifecycle.signal);
            if (fatalError) throw fatalError;
            if (cancelled || openOptions.signal.aborted) throw abortError();
            if (socket.readyState !== WebSocket.OPEN) {
              throw new Error('Doubao ASR WebSocket closed before audio was sent');
            }

            try {
              socket.send(encodeDoubaoAudioFrame(validated.audio, validated.endOfStream));
            } catch {
              throw new Error('failed to send Doubao ASR audio packet');
            }
            lastSendAt = Date.now();
            lastSequence = validated.sequence;
            lastPackageSent = validated.endOfStream;
            if (lastPackageSent) {
              if (receiveTimer) clearTimeout(receiveTimer);
              receiveTimer = undefined;
              armFinalTimeout();
            } else {
              armReceiveTimeout();
            }
          },

          async end(): Promise<void> {
            if (fatalError) throw fatalError;
            if (cancelled || openOptions.signal.aborted) throw abortError();
            if (!lastPackageSent) {
              throw new Error('ASR stream must end with an explicit endOfStream audio chunk');
            }
            if (finalReceived) return;
            if (!endPromise) {
              endPromise = new Promise<void>((endResolve, endReject) => {
                resolveEnd = endResolve;
                rejectEnd = endReject;
              });
              armFinalTimeout();
            }
            return endPromise;
          },

          async cancel(): Promise<void> {
            await cancel();
          },
        });
      }
    });

    socket.addEventListener('message', event => {
      messageTail = messageTail.then(async () => {
        if (cancelled || finalReceived || fatalError) return;
        const bytes = await eventBytes(event.data);
        const decoded = decodeDoubaoServerFrame(bytes, maxServerFrameBytes);
        receivedPacketOrdinal += 1;
        if (decoded.payload.payload_sequence === undefined) {
          decoded.payload.payload_sequence = receivedPacketOrdinal;
        }
        if (receiveTimer) clearTimeout(receiveTimer);
        receiveTimer = undefined;
        await openOptions.onDecodedPayload(decoded.payload);
        const payloadFinal = decoded.payload.is_last_package === true;
        if (decoded.final || payloadFinal) {
          finish();
        } else {
          armReceiveTimeout();
        }
      }).catch(error => {
        fail(error instanceof Error ? error : new Error('failed to decode Doubao ASR response'));
      });
    });

    socket.addEventListener('error', event => {
      fail(safeWebSocketConnectionError(event));
    });

    socket.addEventListener('close', event => {
      opened = false;
      // ws can deliver close while the final payload callback is still awaiting
      // its downstream commit. Process all already-arrived frames before
      // deciding whether the stream was closed prematurely.
      void messageTail.then(() => {
        if (closingNormally || cancelled || finalReceived) return;
        fail(new Error(`Doubao ASR WebSocket closed before stream final (code ${event.code})`));
      });
    });
  });
}

export function createDoubaoWebSocketTransport(
  options: DoubaoWebSocketTransportOptions = {},
): DoubaoInjectedTransport {
  // Validate static options at construction time rather than after a paid
  // provider session has already been requested.
  positiveInteger(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connectTimeoutMs');
  positiveInteger(options.receiveTimeoutMs, DEFAULT_RECEIVE_TIMEOUT_MS, 'receiveTimeoutMs');
  positiveInteger(options.finalTimeoutMs, DEFAULT_FINAL_TIMEOUT_MS, 'finalTimeoutMs');
  packetInterval(options.minPacketIntervalMs);
  positiveInteger(
    options.maxServerFrameBytes,
    DEFAULT_MAX_SERVER_FRAME_BYTES,
    'maxServerFrameBytes',
  );

  return {
    open(openOptions) {
      return openConnection(options, openOptions);
    },
  };
}
