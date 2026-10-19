import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';

import { validatePcm16AudioChunk } from '../../../src/lib/asr-runtime/audio-chunk-validator.ts';
import type { DoubaoTransportOpenOptions } from '../../../src/lib/asr-runtime/contracts.ts';

class OfflineWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: OfflineWebSocket[] = [];
  readyState = OfflineWebSocket.CONNECTING;
  binaryType = '';
  sent: Uint8Array[] = [];
  closeReasons: string[] = [];
  readonly url: string;
  readonly options: { headers: Record<string, string>; maxPayload: number };

  constructor(url: string, options: {
    headers: Record<string, string>;
    maxPayload: number;
  }) {
    super();
    this.url = url;
    this.options = options;
    OfflineWebSocket.instances.push(this);
  }

  addEventListener(name: string, listener: (event: any) => void): void {
    this.on(name, listener);
  }

  send(bytes: Uint8Array): void {
    assert.equal(this.readyState, OfflineWebSocket.OPEN);
    this.sent.push(bytes);
  }

  open(): void {
    this.readyState = OfflineWebSocket.OPEN;
    this.emit('open', {});
  }

  close(_code = 1000, reason = ''): void {
    this.closeReasons.push(reason);
    this.readyState = OfflineWebSocket.CLOSED;
    this.emit('close', { code: 1000 });
  }

  message(frame: Uint8Array): void {
    this.emit('message', { data: Buffer.from(frame) });
  }
}

// Module interception prevents even a failed test from reaching the provider.
mock.module('ws', { defaultExport: OfflineWebSocket });
const {
  createDoubaoWebSocketTransport,
  decodeDoubaoServerFrame,
  encodeDoubaoAudioFrame,
  encodeDoubaoFullClientRequestFrame,
  DOUBAO_BIGMODEL_ASYNC_ENDPOINT,
} = await import('../../../src/lib/asr-runtime/doubao-websocket-transport.ts');

function openOptions(
  signal = new AbortController().signal,
  onDecodedPayload: DoubaoTransportOpenOptions['onDecodedPayload'] = () => {},
): DoubaoTransportOpenOptions {
  return {
    identity: {
      sessionEpoch: 'offline-asr', turnId: 'turn-1', generationId: 1,
      invocationId: 'invoke-1', responseId: 'response-1',
      evidenceRefs: [],
    },
    requestId: 'offline-request-1',
    headers: {
      'X-Api-Key': 'synthetic-offline-credential',
      'X-Api-Resource-Id': 'volc.seedasr.sauc.duration',
    },
    signal,
    onDecodedPayload,
  };
}

function lastSocket(): OfflineWebSocket {
  return OfflineWebSocket.instances.at(-1)!;
}

function serverFrame(payload: Record<string, unknown>, final = false): Uint8Array {
  const compressed = gzipSync(Buffer.from(JSON.stringify(payload)));
  const frame = new Uint8Array(8 + compressed.byteLength);
  frame.set([0x11, final ? 0x92 : 0x90, 0x11, 0], 0);
  new DataView(frame.buffer).setUint32(4, compressed.byteLength, false);
  frame.set(compressed, 8);
  return frame;
}

function chunk(sequence: number, endOfStream: boolean) {
  return validatePcm16AudioChunk({
    sequence, endOfStream, audio: new Uint8Array(endOfStream ? 320 : 3200),
    format: { codec: 'pcm16', sampleRateHz: 16000, bitsPerSample: 16, channels: 1 },
  });
}

test('binary request/audio framing preserves gzip JSON and PCM with explicit EOS', () => {
  const request = encodeDoubaoFullClientRequestFrame({ audio: { rate: 16000 } });
  assert.deepEqual([...request.subarray(0, 4)], [0x11, 0x10, 0x11, 0]);
  assert.equal(new DataView(request.buffer).getUint32(4, false), request.length - 8);
  assert.deepEqual(JSON.parse(gunzipSync(request.subarray(8)).toString()), {
    audio: { rate: 16000 },
  });
  const pcm = Uint8Array.of(1, 0, 2, 0);
  const audio = encodeDoubaoAudioFrame(pcm, true);
  assert.deepEqual([...audio.subarray(0, 4)], [0x11, 0x22, 0x01, 0]);
  assert.deepEqual([...gunzipSync(audio.subarray(8))], [...pcm]);
  const decoded = decodeDoubaoServerFrame(serverFrame({ result: { text: '虚构样例' } }, true));
  assert.equal(decoded.final, true);
  assert.equal(decoded.payload.is_last_package, true);
  assert.throws(() => decodeDoubaoServerFrame(new Uint8Array(1024), 512), /size limit/);
  assert.throws(() => decodeDoubaoServerFrame(serverFrame({ value: 'x'.repeat(2000) }), 512), /decompressed/);
});

test('handshake, request, EOS and final survive close while downstream commit is pending', async () => {
  let releaseCommit!: () => void;
  const commit = new Promise<void>(resolve => { releaseCommit = resolve; });
  const payloads: unknown[] = [];
  const transport = createDoubaoWebSocketTransport({ maxServerFrameBytes: 2048 });
  const opening = transport.open(openOptions(undefined, async payload => {
    payloads.push(payload);
    await commit;
  }));
  const socket = lastSocket();
  assert.equal(socket.url, DOUBAO_BIGMODEL_ASYNC_ENDPOINT);
  assert.equal(socket.options.headers['X-Api-Request-Id'], 'offline-request-1');
  assert.equal(socket.options.headers['X-Api-Key'], 'synthetic-offline-credential');
  assert.equal(socket.options.maxPayload, 2048);
  socket.open();
  const connection = await opening;
  const request = JSON.parse(gunzipSync(socket.sent[0].subarray(8)).toString());
  assert.deepEqual(request.audio, {
    format: 'pcm', codec: 'raw', rate: 16000, bits: 16, channel: 1,
  });
  assert.equal(request.request.enable_nonstream, true);
  await connection.send(chunk(0, true));
  assert.equal(socket.sent[1][1], 0x22);
  const ending = connection.end();
  socket.message(serverFrame({ result: { text: '虚构样例', utterances: [] } }, true));
  socket.close();
  await Promise.resolve();
  releaseCommit();
  await ending;
  assert.equal(payloads.length, 1);
  assert.equal((payloads[0] as Record<string, unknown>).payload_sequence, 1);
  await connection.end();
});

test('abort before open rejects and closes without sending a request or audio', async () => {
  const controller = new AbortController();
  const opening = createDoubaoWebSocketTransport().open(openOptions(controller.signal));
  const socket = lastSocket();
  controller.abort();
  await assert.rejects(Promise.resolve(opening), { name: 'AbortError' });
  assert.deepEqual(socket.sent, []);
  assert.deepEqual(socket.closeReasons, ['client_cancelled']);
});

test('rejected upgrade is drained and HTTP status is reported without response body', async () => {
  const opening = createDoubaoWebSocketTransport().open(openOptions());
  let drained = false;
  lastSocket().emit('unexpected-response', {}, {
    statusCode: 403,
    resume() { drained = true; },
  });
  await assert.rejects(Promise.resolve(opening), /^Error: Doubao ASR WebSocket connection failed \(HTTP 403\)$/);
  assert.equal(drained, true);
});

test('missing final rejects end and connection errors never expose provider text', async () => {
  const opening = createDoubaoWebSocketTransport({ finalTimeoutMs: 10 }).open(openOptions());
  const socket = lastSocket();
  socket.open();
  const connection = await opening;
  await connection.send(chunk(0, true));
  await assert.rejects(Promise.resolve(connection.end()), /final response timed out/);
  const failedOpening = createDoubaoWebSocketTransport().open(openOptions());
  lastSocket().emit('error', {
    message: 'HTTP 401 synthetic-offline-credential provider-private-body',
  });
  await assert.rejects(Promise.resolve(failedOpening), /^Error: Doubao ASR WebSocket connection failed \(HTTP 401\)$/);
});

test('continuing audio cannot postpone receive timeout when the server sends no response', async () => {
  const opening = createDoubaoWebSocketTransport({ receiveTimeoutMs: 250 }).open(openOptions());
  const socket = lastSocket();
  socket.open();
  const connection = await opening;
  await connection.send(chunk(0, false));
  await connection.send(chunk(1, false));
  await new Promise(resolve => setTimeout(resolve, 180));
  await assert.rejects(Promise.resolve(connection.end()), /receive timed out/);
  assert.deepEqual(socket.closeReasons, ['transport_failure']);
});
