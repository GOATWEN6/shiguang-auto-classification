import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  InMemoryGovernedSessionStore,
  InMemoryTurnEvidenceStore,
  TurnOrchestrator,
  type AsyncJobAdapter,
  type TrustedSessionAuthority,
  type TurnProcessingAdapter,
} from '../../../src/lib/turn-orchestrator/index.ts';
import { createAlgorithmHttpService } from '../../../src/lib/turn-orchestrator/http-service.ts';

type HttpServiceOptions = Parameters<typeof createAlgorithmHttpService>[0];
type HttpService = ReturnType<typeof createAlgorithmHttpService>;

type G5Fixture = {
  httpAcceptance: {
    ordinaryLogAllowedFields: string[];
    ordinaryLogForbiddenFields: string[];
  };
};

const fixture = JSON.parse(readFileSync(
  new URL('./g5-fixtures.json', import.meta.url),
  'utf8',
)) as G5Fixture;

const MANIFEST_SHA256 = '3e23e2e148082a318a44da725045346914dac2113a67f02c1b4a2d3fad9fb18d';
const FIXTURE_SHA256 = '9304b9199c5517cec3d5b3e9a73db3fe5a43f8848442bf9c53d3b71a63158064';
const RUNTIME_SHA256 = 'a'.repeat(64);
const ASR_RESOURCE_SHA256 = 'b'.repeat(64);

const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-fiction-http-001',
  subjectId: 'elder-fiction-http-001',
  familySpaceId: 'family-fiction-http-001',
  authorizationVersion: 'auth-g5-v0.1',
  visibilityScope: ['elder_only'],
};

interface ProviderCounters {
  response: number;
  tts: number;
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function noopAsyncAdapter(): AsyncJobAdapter {
  return {
    async run() {
      return { ok: false, errorCode: 'not_scheduled' };
    },
    async commit(context) {
      return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
    },
  };
}

function httpHarness(options: { ready?: boolean | (() => boolean) } = {}): {
  service: HttpService;
  orchestrator: TurnOrchestrator;
  counters: ProviderCounters;
} {
  const counters: ProviderCounters = { response: 0, tts: 0 };
  const ids = sequence('http-fake');
  const sessions = new InMemoryGovernedSessionStore({
    idFactory: { next: kind => `${kind}:${ids()}` },
  });
  const evidenceStore = new InMemoryTurnEvidenceStore(sessions, {
    idFactory: { next: kind => `${kind}:${ids()}` },
  });
  const processing: TurnProcessingAdapter = {
    async respond(request) {
      counters.response += 1;
      return {
        status: 'success',
        text: '这是完全虚构的离线回复。',
        policyEngine: request.mode === 'DAILY_CHAT' ? 'DailyChatPolicy' : 'InterviewPolicyV0.2',
        action: request.mode === 'DAILY_CHAT' ? 'RESPOND' : 'FOLLOW_UP',
        questionCount: request.mode === 'DAILY_CHAT' ? 0 : 1,
        evidenceRefs: [...request.identity.evidenceRefs],
        retentionIntent: 'DEFAULT',
        retentionScope: 'NONE',
        sessionControl: 'CONTINUE',
      };
    },
    async synthesize(request) {
      counters.tts += 1;
      return request.signal.aborted
        ? { status: 'cancelled', audioChunkCount: 0 }
        : { status: 'success', audioChunkCount: 1 };
    },
    planAsyncJobs() {
      return [];
    },
  };
  const asyncAdapter = noopAsyncAdapter();
  const orchestrator = new TurnOrchestrator({
    sessions,
    evidenceStore,
    processing,
    asyncAdapters: {
      MEMORY: asyncAdapter,
      STORY: asyncAdapter,
      PROFILE: asyncAdapter,
    },
    id: ids,
  });
  const serviceOptions: HttpServiceOptions = {
    orchestrator,
    metadata: {
      buildId: 'g5-http-black-box-build-001',
      manifestSha256: MANIFEST_SHA256,
      fixtureSha256: FIXTURE_SHA256,
      serviceVersion: 'g5-local-fake-v0.1',
      contractVersion: 'algorithm-http-v0.1',
      interviewPolicyVersion: 'interview-policy-test-v1',
      runtimeFingerprint: {
        schemaVersion: 'algorithm-runtime-fingerprint-v0.1',
        text: { model: 'offline-fake-model', temperature: 0.2, timeoutMs: 30_000 },
        asr: { resourceIdSha256: ASR_RESOURCE_SHA256 },
        tts: { provider: 'offline-fake', model: 'offline-fake-tts', voiceId: 'offline-fake-voice',
          outputFormat: 'pcm', sampleRate: 24_000, speed: 0.95, volume: 1, pitch: 1,
          synthesisTimeoutMs: 20_000 },
        code: { promptCodeSha256: 'c'.repeat(64), interviewPolicyCodeSha256: 'd'.repeat(64),
          responseGuardCodeSha256: 'e'.repeat(64) },
        fingerprintSha256: RUNTIME_SHA256,
      },
    },
    ...(options.ready === undefined ? {} : { ready: options.ready }),
  };
  return {
    service: createAlgorithmHttpService(serviceOptions),
    orchestrator,
    counters,
  };
}

test('readiness refreshes after budget or provider conditions change', async () => {
  let ready = true;
  const { service } = httpHarness({ ready: () => ready });
  assert.equal(service.health().status, 200);
  ready = false;
  assert.equal(service.health().status, 503);
  assert.equal(service.createSession({ requestId: 'dynamic-ready',
    authority: AUTHORITY, body: createBody('dynamic-ready') }).status, 503);
});

function record(value: unknown, field = 'value'): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${field} must be an object`);
  return value as Record<string, unknown>;
}

function createBody(idempotencyKey: string): Record<string, unknown> {
  return {
    schemaVersion: 'algorithm-session-create-v0.1',
    idempotencyKey,
    requestedMode: 'DAILY_CHAT',
  };
}

function partialBody(idempotencyKey: string): Record<string, unknown> {
  return {
    schemaVersion: 'algorithm-turn-v0.1',
    event: 'ASR_PARTIAL',
    idempotencyKey,
    partialId: `partial-${idempotencyKey}`,
    text: '完全虚构的局部转写',
    receivedAt: '2026-10-03T11:00:00.000Z',
  };
}

function finalBody(idempotencyKey: string, text = '我喜欢虚构的兰花。'): Record<string, unknown> {
  return {
    schemaVersion: 'algorithm-turn-v0.1',
    event: 'FINAL',
    idempotencyKey,
    source: 'TYPED_TEXT',
    text,
    receivedAt: '2026-10-03T11:00:01.000Z',
  };
}

function interruptBody(idempotencyKey: string, interruptTargetHandle: string): Record<string, unknown> {
  return {
    schemaVersion: 'algorithm-interrupt-v0.1',
    idempotencyKey,
    interruptTargetHandle,
    reason: 'user_restart_utterance',
  };
}

function endBody(idempotencyKey: string): Record<string, unknown> {
  return {
    schemaVersion: 'algorithm-session-end-v0.1',
    idempotencyKey,
  };
}

function createSession(service: HttpService, key: string): {
  opaqueSessionHandle: string;
  sessionEpoch: string;
} {
  const response = service.createSession({
    requestId: `request-${key}`,
    authority: structuredClone(AUTHORITY),
    body: createBody(key),
  });
  assert.equal(response.status, 201);
  const body = record(response.body, 'create response');
  assert.equal(body.replayed, false);
  assert.equal(typeof body.opaqueSessionHandle, 'string');
  assert.equal(typeof body.sessionEpoch, 'string');
  return {
    opaqueSessionHandle: body.opaqueSessionHandle as string,
    sessionEpoch: body.sessionEpoch as string,
  };
}

function expectExactError(
  result: { status: number; body: unknown },
  expected: { requestId: string; status: number; code: string; message: string; retryable: boolean },
): void {
  assert.equal(result.status, expected.status);
  assert.deepEqual(result.body, {
    requestId: expected.requestId,
    code: expected.code,
    message: expected.message,
    retryable: expected.retryable,
  });
}

function withoutRequestId(value: unknown): Record<string, unknown> {
  const cloned = structuredClone(record(value));
  delete cloned.requestId;
  return cloned;
}

test('health and version are provider-free, offline, unpaid, and expose the frozen fixture hash', () => {
  const { service, counters } = httpHarness();
  assert.deepEqual(service.health(), {
    status: 200,
    body: {
      schemaVersion: 'algorithm-health-v0.1',
      status: 'ready',
      mode: 'LOCAL_FAKE',
      paidExecutionEnabled: false,
      networkCalls: 0,
      costCny: 0,
      components: {
        sessionRegistry: 'ready',
        leaseTree: 'ready',
        evidenceStore: 'ready',
        policy: 'ready',
        responseTts: 'ready',
        asyncJobs: 'ready',
      },
    },
  });
  assert.deepEqual(service.version(), {
    status: 200,
    body: {
      schemaVersion: 'algorithm-version-v0.1',
      apiVersion: 'v0.1',
      serviceVersion: 'g5-local-fake-v0.1',
      contractVersion: 'algorithm-http-v0.1',
      buildId: 'g5-http-black-box-build-001',
      manifestSha256: MANIFEST_SHA256,
      fixtureSha256: FIXTURE_SHA256,
      rollbackCompatibility: 'cancel_or_drain_then_replay_24_turns_10_interrupts',
      paidExecutionEnabled: false,
      interviewPolicyVersion: 'interview-policy-test-v1',
      policyVersion: 'interview-policy-test-v1',
      runtimeFingerprint: {
        schemaVersion: 'algorithm-runtime-fingerprint-v0.1',
        text: { model: 'offline-fake-model', temperature: 0.2, timeoutMs: 30_000 },
        asr: { resourceIdSha256: ASR_RESOURCE_SHA256 },
        tts: { provider: 'offline-fake', model: 'offline-fake-tts', voiceId: 'offline-fake-voice',
          outputFormat: 'pcm', sampleRate: 24_000, speed: 0.95, volume: 1, pitch: 1,
          synthesisTimeoutMs: 20_000 },
        code: { promptCodeSha256: 'c'.repeat(64), interviewPolicyCodeSha256: 'd'.repeat(64),
          responseGuardCodeSha256: 'e'.repeat(64) },
        fingerprintSha256: RUNTIME_SHA256,
      },
    },
  });
  assert.deepEqual(counters, { response: 0, tts: 0 });

  const serializedVersion = JSON.stringify(service.version());
  for (const forbidden of ['apiKey', 'endpoint', 'baseURL', 'resourceId\"']) {
    assert.equal(serializedVersion.includes(forbidden), false, `version leaked ${forbidden}`);
  }

  const unavailable = httpHarness({ ready: false });
  const health = unavailable.service.health();
  assert.equal(health.status, 503);
  assert.equal(record(health.body).status, 'not_ready');
  assert.deepEqual(unavailable.counters, { response: 0, tts: 0 });
});

test('session creation is idempotent and only the server issues session identity', () => {
  const { service, counters } = httpHarness();
  const first = service.createSession({
    requestId: 'request-create-first',
    authority: structuredClone(AUTHORITY),
    body: createBody('session-idempotency-1'),
  });
  const replay = service.createSession({
    requestId: 'request-create-replay',
    authority: structuredClone(AUTHORITY),
    body: createBody('session-idempotency-1'),
  });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  const firstBody = record(first.body);
  const replayBody = record(replay.body);
  assert.equal(firstBody.replayed, false);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.opaqueSessionHandle, firstBody.opaqueSessionHandle);
  assert.equal(replayBody.sessionEpoch, firstBody.sessionEpoch);
  for (const field of ['actorId', 'subjectId', 'familySpaceId', 'authorizationVersion', 'visibilityScope']) {
    assert.equal(Object.hasOwn(firstBody, field), false, `response leaked trusted ${field}`);
  }
  assert.deepEqual(counters, { response: 0, tts: 0 });
});

test('all request bodies reject trusted authority and server-issued identity fields', async () => {
  const { service, orchestrator } = httpHarness();
  const { opaqueSessionHandle } = createSession(service, 'strict-body-session');
  const protectedFields: Array<[string, unknown]> = [
    ['actorId', AUTHORITY.actorId],
    ['subjectId', AUTHORITY.subjectId],
    ['familySpaceId', AUTHORITY.familySpaceId],
    ['authorizationVersion', AUTHORITY.authorizationVersion],
    ['visibilityScope', ['elder_only']],
    ['opaqueSessionHandle', opaqueSessionHandle],
    ['sessionEpoch', 'forged-epoch'],
    ['turnId', 'forged-turn'],
    ['generationId', 999],
    ['evidenceId', 'forged-evidence'],
    ['interruptId', 'forged-interrupt'],
    ['attemptId', 'forged-attempt'],
  ];
  const cases = [
    {
      name: 'create',
      base: createBody('strict-create'),
      invoke: (requestId: string, body: unknown) => service.createSession({
        requestId, authority: structuredClone(AUTHORITY), body,
      }),
    },
    {
      name: 'turn',
      base: finalBody('strict-turn'),
      invoke: (requestId: string, body: unknown) => service.submitTurn({
        requestId, opaqueSessionHandle, body,
      }),
    },
    {
      name: 'interrupt',
      base: interruptBody('strict-interrupt', 'opaque-target-from-prior-response'),
      invoke: (requestId: string, body: unknown) => service.interrupt({
        requestId, opaqueSessionHandle, body,
      }),
    },
    {
      name: 'end',
      base: endBody('strict-end'),
      invoke: (requestId: string, body: unknown) => service.end({
        requestId, opaqueSessionHandle, body,
      }),
    },
  ];
  let probe = 0;
  for (const endpoint of cases) {
    for (const [field, value] of protectedFields) {
      const requestId = `request-forbidden-${endpoint.name}-${++probe}`;
      const result = await endpoint.invoke(requestId, { ...endpoint.base, [field]: value });
      expectExactError(result, {
        requestId,
        status: 400,
        code: 'invalid_schema',
        message: '请求格式不符合 algorithm v0.1 合同。',
        retryable: false,
      });
    }
  }
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 0,
    acceptedInterrupts: 0,
    networkCalls: 0,
    costCny: 0,
  });
});

test('final turn replay is idempotent and Fake execution stays at zero network calls and cost', async () => {
  const { service, orchestrator, counters } = httpHarness();
  const { opaqueSessionHandle } = createSession(service, 'turn-replay-session');
  const body = finalBody('turn-idempotency-1');
  const first = await service.submitTurn({
    requestId: 'request-turn-first', opaqueSessionHandle, body,
  });
  const replay = await service.submitTurn({
    requestId: 'request-turn-replay', opaqueSessionHandle, body: structuredClone(body),
  });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(withoutRequestId(replay.body), withoutRequestId(first.body));
  const result = record(first.body);
  assert.equal(result.status, 'completed');
  assert.equal(typeof result.turnId, 'string');
  assert.equal(typeof result.generationId, 'number');
  assert.equal(typeof result.evidenceId, 'string');
  assert.deepEqual(counters, { response: 1, tts: 1 });
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 1,
    acceptedInterrupts: 0,
    networkCalls: 0,
    costCny: 0,
  });
  const health = record(service.health().body);
  assert.equal(health.networkCalls, 0);
  assert.equal(health.costCny, 0);
});

test('partial target and accepted interrupt replay are idempotent and count once', async () => {
  const { service, orchestrator, counters } = httpHarness();
  const { opaqueSessionHandle } = createSession(service, 'interrupt-session');
  const partial = await service.submitTurn({
    requestId: 'request-partial-first',
    opaqueSessionHandle,
    body: partialBody('partial-idempotency-1'),
  });
  assert.equal(partial.status, 200);
  const partialResult = record(partial.body);
  assert.equal(partialResult.status, 'WAIT');
  assert.equal(typeof partialResult.targetHandle, 'string');
  const body = interruptBody('interrupt-idempotency-1', partialResult.targetHandle as string);
  const first = service.interrupt({
    requestId: 'request-interrupt-first', opaqueSessionHandle, body,
  });
  const replay = service.interrupt({
    requestId: 'request-interrupt-replay', opaqueSessionHandle, body: structuredClone(body),
  });
  assert.equal(first.status, 202);
  assert.equal(replay.status, 202);
  const firstBody = record(first.body);
  const replayBody = record(replay.body);
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.replayed, false);
  assert.equal(replayBody.accepted, true);
  assert.equal(replayBody.replayed, true);
  assert.equal(replayBody.interruptId, firstBody.interruptId);
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 0,
    acceptedInterrupts: 1,
    networkCalls: 0,
    costCny: 0,
  });
  assert.deepEqual(counters, { response: 0, tts: 0 });
});

test('session end is idempotent and every later turn is rejected without provider work', async () => {
  const { service, counters } = httpHarness();
  const { opaqueSessionHandle, sessionEpoch } = createSession(service, 'end-session');
  const body = endBody('end-idempotency-1');
  const first = service.end({
    requestId: 'request-end-first', opaqueSessionHandle, body,
  });
  const replay = service.end({
    requestId: 'request-end-replay', opaqueSessionHandle, body: structuredClone(body),
  });
  assert.equal(first.status, 200);
  assert.equal(replay.status, 200);
  assert.deepEqual(withoutRequestId(replay.body), withoutRequestId(first.body));
  assert.deepEqual(withoutRequestId(first.body), {
    schemaVersion: 'algorithm-session-end-result-v0.1',
    status: 'ENDED',
    sessionEpoch,
  });
  const rejected = await service.submitTurn({
    requestId: 'request-turn-after-end',
    opaqueSessionHandle,
    body: finalBody('turn-after-end'),
  });
  expectExactError(rejected, {
    requestId: 'request-turn-after-end',
    status: 409,
    code: 'session_not_active',
    message: '当前会话不能接收新一轮输入。',
    retryable: false,
  });
  assert.deepEqual(counters, { response: 0, tts: 0 });
});

test('errors are exact and content-free; ordinary logs use only the frozen whitelist', async () => {
  const { service } = httpHarness();
  const missing = await service.submitTurn({
    requestId: 'request-unknown-session',
    opaqueSessionHandle: 'session-does-not-exist',
    body: finalBody('unknown-session', '绝不能出现在错误和日志中的私密句子'),
  });
  expectExactError(missing, {
    requestId: 'request-unknown-session',
    status: 404,
    code: 'session_not_found',
    message: '会话不存在或已失效。',
    retryable: false,
  });

  const { opaqueSessionHandle } = createSession(service, 'log-session');
  const privateText = '绝不能出现在普通日志中的虚构私密句子';
  const completed = await service.submitTurn({
    requestId: 'request-log-turn',
    opaqueSessionHandle,
    body: finalBody('log-turn', privateText),
  });
  assert.equal(completed.status, 200);
  const logs = service.ordinaryLogs();
  assert.ok(logs.length > 0);
  const allowed = new Set(fixture.httpAcceptance.ordinaryLogAllowedFields);
  for (const [index, log] of logs.entries()) {
    for (const key of Reflect.ownKeys(log)) {
      assert.equal(typeof key, 'string');
      assert.equal(allowed.has(key as string), true, `log[${index}] contains non-whitelisted ${String(key)}`);
    }
  }
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes(privateText), false);
  assert.equal(serialized.includes(AUTHORITY.subjectId), false);
  assert.equal(serialized.includes(AUTHORITY.familySpaceId), false);
  for (const forbidden of fixture.httpAcceptance.ordinaryLogForbiddenFields) {
    assert.equal(serialized.includes(`\"${forbidden}\"`), false, `log contains forbidden ${forbidden}`);
  }
});
