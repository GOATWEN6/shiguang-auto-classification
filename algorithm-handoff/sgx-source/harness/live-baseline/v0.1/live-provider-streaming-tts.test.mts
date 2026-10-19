import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('openai', { defaultExport: class OfflineOpenAI {} });
const { createLiveProvider } = await import('../../../src/lib/algorithm-service/live-provider.ts');
const { synthesizeDoubaoStreamingTts, STREAMING_TTS_PCM_MIME_TYPE } =
  await import('../../../src/lib/algorithm-service/streaming-tts.ts');
import type { LiveProviderConfig, ProviderAttemptAudit } from '../../../src/lib/algorithm-service/live-provider.ts';

const config: LiveProviderConfig = {
  text: { apiKey: 'offline-fixture', baseURL: 'https://offline.invalid', model: 'offline', timeoutMs: 100 },
  asr: { apiKey: 'offline-fixture', resourceId: 'offline' },
  tts: { provider: 'doubao', endpoint: 'https://offline.invalid', apiKey: 'offline-fixture', resourceId: 'offline',
    model: 'seed-tts-2.0', voiceId: 'offline', outputFormat: 'mp3', sampleRate: 24_000,
    speed: 1, volume: 1, pitch: 1, synthesisTimeoutMs: 1_000 },
};
const encoder = new TextEncoder();
const audioMessage = (bytes: number[]) => JSON.stringify({ code: 0, data: Buffer.from(bytes).toString('base64') });
const signal = () => new AbortController().signal;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

test('first PCM chunk is delivered before EOF; subsequent chunks aggregate without a second full callback', async () => {
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let requestBody: any;
  let requestId: string | null = null;
  const fetched = deferred<void>();
  const heard = deferred<void>();
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }));
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requestBody = JSON.parse(init!.body as string);
    requestId = new Headers(init?.headers).get('X-Api-Request-Id');
    fetched.resolve();
    return response;
  });
  const callbacks: Array<{ audio: Uint8Array; mimeType: string }> = [];
  const audits: ProviderAttemptAudit[] = [];
  const reservations: string[] = [];
  try {
    const provider = createLiveProvider(config, audit => audits.push(audit), {
      beforeAttempt(module, id) { assert.equal(module, 'tts'); reservations.push(id); },
    });
    let completed = false;
    const resultPromise = provider.synthesize('您好，我们慢慢聊。', { signal: signal(), onAudio(audio, mimeType) {
      callbacks.push({ audio, mimeType }); heard.resolve();
    } });
    void resultPromise.then(() => { completed = true; });
    await fetched.promise;
    stream.enqueue(encoder.encode(`${audioMessage([1, 2, 3, 4])}\n`));
    await heard.promise;
    assert.equal(completed, false);
    assert.equal(callbacks.length, 1);
    assert.deepEqual([...callbacks[0].audio], [1, 2, 3, 4]);
    assert.equal(callbacks[0].mimeType, 'audio/pcm;rate=24000;channels=1');
    assert.equal(requestBody.req_params.audio_params.format, 'pcm');
    assert.equal(requestBody.req_params.audio_params.sample_rate, 24_000);
    assert.equal(requestId, reservations[0]);
    stream.enqueue(encoder.encode(`${audioMessage([5, 6])}\n{"code":20000000}`));
    stream.close();
    const result = await resultPromise;
    assert.deepEqual([...result.audio], [1, 2, 3, 4, 5, 6]);
    assert.equal(result.mimeType, STREAMING_TTS_PCM_MIME_TYPE);
    assert.equal(callbacks.length, 2);
    assert.equal(reservations.length, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'success');
  } finally { fetchMock.mock.restore(); }
});

test('SSE metadata, newline and adjacent JSON objects survive every byte boundary and PCM alignment', async () => {
  const raw = `: heartbeat\nevent: audio\ndata: ${audioMessage([1, 2, 3])}\n\n`
    + `${audioMessage([4, 5, 6])}{"code":0,"meta":{"caption":"含有{括号}和\\\"引号"}}\n`
    + 'data: [DONE]\n\n';
  const encoded = encoder.encode(raw);
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(controller) { for (const byte of encoded) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  })));
  const delivered: Uint8Array[] = [];
  try {
    const result = await synthesizeDoubaoStreamingTts(config.tts, '您好', { signal: signal(), onAudio(audio) {
      assert.equal(audio.length % 2, 0);
      delivered.push(new Uint8Array(audio));
      audio.fill(0); // Retained audio must not alias a mutable callback buffer.
    } });
    assert.deepEqual([...Buffer.concat(delivered)], [1, 2, 3, 4, 5, 6]);
    assert.deepEqual([...result.audio], [1, 2, 3, 4, 5, 6]);
  } finally { fetchMock.mock.restore(); }
});

test('provider error after an audio chunk records failure and does not retry or duplicate delivered samples', async () => {
  let requests = 0;
  let cancelled = false;
  const audits: ProviderAttemptAudit[] = [];
  const reservations: string[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(audioMessage([1, 2])));
      controller.enqueue(encoder.encode('{"code":55000000,"message":"do not log raw detail"}'));
    }, cancel() { cancelled = true; } }));
  });
  const delivered: Uint8Array[] = [];
  try {
    const provider = createLiveProvider(config, audit => audits.push(audit), {
      beforeAttempt(_module, id) { reservations.push(id); },
    });
    await assert.rejects(provider.synthesize('您好', { signal: signal(), onAudio(audio) { delivered.push(audio); } }),
      /^Error: provider_business_failure$/u);
    assert.equal(requests, 1);
    assert.equal(reservations.length, 1);
    assert.deepEqual([...Buffer.concat(delivered)], [1, 2]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'failed');
    assert.equal(audits[0].errorCode, 'provider_business_failure');
    assert.equal(cancelled, true);
    assert.equal(JSON.stringify(audits).includes('raw detail'), false);
  } finally { fetchMock.mock.restore(); }
});

test('transport failure after partial audio is not retried; before audio it reserves and audits each retry', async () => {
  let requests = 0;
  let partial = true;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  const error = () => Object.assign(new Error('fetch failed'), { code: 'ECONNRESET' });
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    if (!partial && requests < 3) throw error();
    if (!partial) return new Response(`${audioMessage([3, 4])}\n`);
    return new Response(new ReadableStream({ start(controller) {
      stream = controller; controller.enqueue(encoder.encode(audioMessage([1, 2])));
    } }));
  });
  const audits: ProviderAttemptAudit[] = [];
  let reservations = 0;
  try {
    const provider = createLiveProvider(config, audit => audits.push(audit), {
      beforeAttempt() { reservations += 1; },
    });
    await assert.rejects(provider.synthesize('您好', { signal: signal(), onAudio() { stream.error(error()); } }),
      /provider_transport_failure/u);
    assert.equal(requests, 1);
    assert.equal(reservations, 1);
    assert.equal(audits[0].status, 'failed');
    partial = false;
    requests = 0;
    reservations = 0;
    audits.length = 0;
    let callbacks = 0;
    const result = await provider.synthesize('您好', { signal: signal(), onAudio() { callbacks += 1; } });
    assert.deepEqual([...result.audio], [3, 4]);
    assert.equal(callbacks, 1);
    assert.equal(requests, 3);
    assert.equal(reservations, 3);
    assert.deepEqual(audits.map(item => [item.attempt, item.status]), [[1, 'failed'], [2, 'failed'], [3, 'success']]);
  } finally { fetchMock.mock.restore(); }
});

test('user cancellation stops the stream and suppresses late chunks with one cancelled audit', async () => {
  const controller = new AbortController();
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  let callbacks = 0;
  const audits: ProviderAttemptAudit[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
    start(source) { stream = source; source.enqueue(encoder.encode(audioMessage([1, 2]))); },
    cancel() { cancelled = true; },
  })));
  try {
    const provider = createLiveProvider(config, audit => audits.push(audit));
    await assert.rejects(provider.synthesize('您好', { signal: controller.signal, onAudio() {
      callbacks += 1;
      controller.abort();
    } }), error => (error as Error).name === 'AbortError');
    assert.equal(cancelled, true);
    assert.throws(() => stream.enqueue(encoder.encode(audioMessage([3, 4]))));
    assert.equal(callbacks, 1);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].status, 'cancelled');
  } finally { fetchMock.mock.restore(); }
});

test('timeout after first audio cancels a stalled reader without implicit replay', async () => {
  let requests = 0;
  let cancelled = false;
  const audits: ProviderAttemptAudit[] = [];
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode(audioMessage([1, 2])));
    }, cancel() { cancelled = true; } }));
  });
  try {
    const provider = createLiveProvider({ ...config, tts: { ...config.tts, synthesisTimeoutMs: 20 } },
      audit => audits.push(audit));
    await assert.rejects(provider.synthesize('您好', { signal: signal(), onAudio() {} }), /^Error: timeout$/u);
    assert.equal(requests, 1);
    assert.equal(cancelled, true);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].errorCode, 'timeout');
  } finally { fetchMock.mock.restore(); }
});

test('malformed JSON, truncated JSON, invalid base64, odd final PCM and bounded oversized objects fail safely', async () => {
  const cases: Array<[string, RegExp]> = [
    ['{"data":"AA==",}', /tts_stream_protocol_failure/u],
    ['{"data":"AA=="', /tts_stream_protocol_failure/u],
    ['{"code":0,"data":"not-base64!"}', /tts_stream_audio_format_invalid/u],
    [audioMessage([1]), /tts_stream_audio_format_invalid/u],
    ['{"x":"' + 'a'.repeat(2 * 1024 * 1024) + '"}', /tts_stream_limit_exceeded/u],
  ];
  for (const [body, expected] of cases) {
    const fetchMock = mock.method(globalThis, 'fetch', async () => new Response(body));
    try {
      await assert.rejects(synthesizeDoubaoStreamingTts(config.tts, '您好', { signal: signal(), onAudio() {} }), expected);
    } finally { fetchMock.mock.restore(); }
  }
});

test('pre-aborted requests reserve nothing; legacy no-callback path still requests and returns MP3', async () => {
  let requests = 0;
  let format: unknown;
  let reservations = 0;
  const controller = new AbortController();
  controller.abort();
  const fetchMock = mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests += 1;
    format = JSON.parse(init!.body as string).req_params.audio_params.format;
    return new Response(audioMessage([1, 2, 3, 4]));
  });
  try {
    const provider = createLiveProvider(config, undefined, { beforeAttempt() { reservations += 1; } });
    await assert.rejects(provider.synthesize('您好', { signal: controller.signal, onAudio() {} }),
      error => (error as Error).name === 'AbortError');
    assert.equal(requests, 0);
    assert.equal(reservations, 0);
    const result = await provider.synthesize('您好', { signal: signal() });
    assert.equal(format, 'mp3');
    assert.equal(result.mimeType, 'audio/mpeg');
    assert.deepEqual([...result.audio], [1, 2, 3, 4]);
    assert.equal(reservations, 1);
  } finally { fetchMock.mock.restore(); }
});
