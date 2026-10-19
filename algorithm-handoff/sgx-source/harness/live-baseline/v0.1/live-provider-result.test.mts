import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

let completionCalls = 0;
class OfflineOpenAI {
  chat = { completions: { create: async () => {
    completionCalls += 1;
    return { choices: [{ message: { content: 'not-json' } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 } };
  } } };
}
mock.module('openai', { defaultExport: OfflineOpenAI });
const { createLiveProvider } = await import('../../../src/lib/algorithm-service/live-provider.ts');
import type { LiveProviderConfig, ProviderAttemptAudit } from '../../../src/lib/algorithm-service/live-provider.ts';
const config: LiveProviderConfig = {
  text: { apiKey: 'offline-fixture', baseURL: 'https://offline.invalid', model: 'offline', timeoutMs: 100 },
  asr: { apiKey: 'offline-fixture', resourceId: 'offline' },
  tts: { provider: 'doubao', endpoint: 'https://offline.invalid', apiKey: 'offline-fixture', resourceId: 'offline',
    model: 'seed-tts-2.0', voiceId: 'offline', outputFormat: 'mp3', sampleRate: 24_000,
    speed: 1, volume: 1, pitch: 1, synthesisTimeoutMs: 100 },
};

test('invalid JSON is failed once with token usage preserved, without hidden regeneration', async () => {
  const audits: ProviderAttemptAudit[] = [];
  let reservations = 0;
  const provider = createLiveProvider(config, audit => audits.push(audit), {
    beforeAttempt() { reservations += 1; },
  });
  await assert.rejects(provider.json('offline', {}, { signal: new AbortController().signal, module: 'daily_chat' }), /invalid_json/);
  assert.equal(completionCalls, 1);
  assert.equal(reservations, 1);
  assert.equal(audits[0].status, 'failed');
  assert.equal(audits[0].errorCode, 'invalid_json');
  assert.equal(audits[0].inputTokens, 100);
  assert.equal(audits[0].outputTokens, 10);
  assert.ok(audits[0].estimatedTextCostCny! > 0);
});

test('HTTP 200 with empty TTS result stops after one call and reservation', async () => {
  const audits: ProviderAttemptAudit[] = [];
  let reservations = 0;
  let requests = 0;
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    requests += 1;
    return new Response('{}', { status: 200 });
  });
  try {
    const provider = createLiveProvider(config, audit => audits.push(audit), {
      beforeAttempt() { reservations += 1; },
    });
    await assert.rejects(provider.synthesize('测试', { signal: new AbortController().signal }), /empty_provider_result/);
    assert.equal(requests, 1);
    assert.equal(reservations, 1);
    assert.equal(audits[0].status, 'failed');
    assert.equal(audits[0].errorCode, 'empty_provider_result');
  } finally { fetchMock.mock.restore(); }
});
