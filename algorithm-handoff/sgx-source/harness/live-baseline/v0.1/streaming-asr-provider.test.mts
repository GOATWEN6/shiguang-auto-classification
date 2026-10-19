import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createDoubaoStreamingAsrAdapter } from '../../../src/lib/asr-runtime/doubao-streaming-adapter.ts';
import type { DoubaoTransportOpenOptions, Pcm16AudioChunk } from '../../../src/lib/asr-runtime/contracts.ts';
import { openLiveStreamingAsr } from '../../../src/lib/algorithm-service/streaming-asr.ts';
import type { ProviderAttemptAudit } from '../../../src/lib/algorithm-service/live-provider.ts';

const config = { apiKey: 'offline-synthetic-credential', resourceId: 'offline-synthetic-resource' };
const chunk = (sequence: number, endOfStream = false): Pcm16AudioChunk => ({ sequence,
  audio: new Uint8Array(endOfStream ? 320 : 4096), endOfStream,
  format: { codec: 'pcm16', sampleRateHz: 16_000, bitsPerSample: 16, channels: 1 } });

function fixture(overrides: {
  send?: (chunk: Pcm16AudioChunk, emit: DoubaoTransportOpenOptions['onDecodedPayload']) => Promise<void>;
  end?: (emit: DoubaoTransportOpenOptions['onDecodedPayload']) => Promise<void>;
  openError?: Error;
} = {}) {
  const audits: ProviderAttemptAudit[] = [];
  const sent: Pcm16AudioChunk[] = [];
  let reservations = 0;
  let cancellations = 0;
  let emit!: DoubaoTransportOpenOptions['onDecodedPayload'];
  const hooks = {
    gate: { beforeAttempt(module: string) { assert.equal(module, 'asr'); reservations += 1; } },
    onAttempt(audit: ProviderAttemptAudit) { audits.push(audit); },
    adapterFactory: () => createDoubaoStreamingAsrAdapter({ transportFactory: () => ({
      open(options) {
        if (overrides.openError) throw overrides.openError;
        emit = options.onDecodedPayload;
        return {
          async send(value) { sent.push(value); await overrides.send?.(value, emit); },
          async end() { await overrides.end?.(emit); },
          cancel() { cancellations += 1; },
        };
      },
    }) }),
  };
  return { hooks, audits, sent, emit: (payload: unknown) => emit(payload),
    get reservations() { return reservations; }, get cancellations() { return cancellations; } };
}

test('PCM reaches one ongoing provider connection before finish; partials never replace definite finals', async () => {
  const f = fixture({ end: async emit => {
    await emit({ result: { text: '重复的最后显示稿', utterances: [
      { definite: true, text: '我喜欢听京剧。', start_time: 0 },
      { definite: true, text: '今天听了一段。', start_time: 200 },
    ] }, is_last_package: true });
  } });
  const partials: string[] = [];
  const session = await openLiveStreamingAsr(config, { requestId: 'offline-stream-1',
    signal: new AbortController().signal, onPartial: text => partials.push(text) }, f.hooks);
  await session.send(chunk(0));
  assert.equal(f.sent.length, 1);
  assert.equal(f.audits.length, 0);
  await f.emit({ result: { text: '我喜欢', utterances: [{ definite: false, text: '我喜欢' }] } });
  await f.emit({ result: { text: '我喜欢听京剧。', utterances: [
    { definite: true, text: '我喜欢听京剧。', start_time: 0 },
  ] } });
  await session.send(chunk(1, true));
  const result = await session.finish();
  assert.equal(result.text, '我喜欢听京剧。今天听了一段。');
  assert.equal(result.payloadCount, 3);
  assert.equal(result.audioDurationMs, 138);
  assert.ok(result.firstPartialMs !== null);
  assert.equal(partials[0], '我喜欢');
  assert.equal(f.reservations, 1);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].status, 'success');
  assert.equal(f.audits[0].requestId, 'offline-stream-1');
  assert.deepEqual(await session.finish(), result);
});

test('abort cancels in-flight send, rejects finish and suppresses late partials with one audit', async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const f = fixture({ send: async () => blocked });
  const controller = new AbortController();
  const partials: string[] = [];
  const session = await openLiveStreamingAsr(config, { requestId: 'offline-stream-cancel',
    signal: controller.signal, onPartial: text => partials.push(text) }, f.hooks);
  const sending = session.send(chunk(0));
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await assert.rejects(sending, { name: 'AbortError' });
  await f.emit({ result: { text: '迟到内容', utterances: [{ definite: true, text: '迟到内容', start_time: 0 }] } });
  await assert.rejects(session.finish(), { name: 'AbortError' });
  release();
  assert.deepEqual(partials, []);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].status, 'cancelled');
  assert.equal(f.reservations, 1);
  assert.ok(f.cancellations >= 1);
});

test('partial-only provider EOS fails once rather than manufacturing a final transcript', async () => {
  const f = fixture({ end: async emit => emit({ result: { text: '只有显示稿',
    utterances: [{ definite: false, text: '只有显示稿', start_time: 0 }] }, is_last_package: true }) });
  const session = await openLiveStreamingAsr(config, { requestId: 'offline-no-final',
    signal: new AbortController().signal }, f.hooks);
  await session.send(chunk(0, true));
  await assert.rejects(session.finish(), /^Error: asr_no_final$/u);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].errorCode, 'asr_no_final');
  assert.equal(f.reservations, 1);
});

test('out-of-order audio fails and cancels without hidden retries or credential diagnostics', async () => {
  const f = fixture();
  const session = await openLiveStreamingAsr(config, { requestId: 'offline-gap',
    signal: new AbortController().signal }, f.hooks);
  await session.send(chunk(0));
  await assert.rejects(session.send(chunk(2)), /^Error: asr_audio_chunk_invalid$/u);
  assert.equal(f.sent.length, 1);
  assert.equal(f.reservations, 1);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].status, 'failed');
  assert.equal(JSON.stringify(f.audits).includes(config.apiKey), false);
});

test('provider open failure retains one reservation and only a redacted code', async () => {
  const f = fixture({ openError: new Error(`HTTP 403 ${config.apiKey} private-provider-body`) });
  await assert.rejects(openLiveStreamingAsr(config, { requestId: 'offline-open-failure',
    signal: new AbortController().signal }, f.hooks), /^Error: provider_http_403$/u);
  assert.equal(f.reservations, 1);
  assert.equal(f.audits.length, 1);
  assert.equal(f.audits[0].errorCode, 'provider_http_403');
  assert.equal(JSON.stringify(f.audits).includes(config.apiKey), false);
  assert.equal(JSON.stringify(f.audits).includes('private-provider-body'), false);
});
