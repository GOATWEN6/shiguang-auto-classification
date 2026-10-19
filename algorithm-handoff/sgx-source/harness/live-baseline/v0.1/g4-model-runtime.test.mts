import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  BudgetController,
  FrozenCostCatalog,
  GenerationCancellationRegistry,
  ModelCallLedger,
  type AlgorithmModule,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/index.ts';
import {
  createAuditedTextRuntime,
  createAuditedTtsRuntime,
  type AuditedTextRunInput,
} from '../../../src/lib/model-runtime/index.ts';
import {
  FakeTtsProvider,
  ProviderRetryRunner,
} from '../../../src/lib/provider-runtime/index.ts';

type G4Fixture = { id: string; scenarioId?: string; assertion: string };
type G4FixtureFile = {
  schemaVersion: string;
  paidExecutionEnabled: boolean;
  fixedCaseCount: number;
  groups: Record<string, G4Fixture[]>;
};

const fixtures = JSON.parse(readFileSync(
  new URL('./g4-fixtures.json', import.meta.url),
  'utf8',
)) as G4FixtureFile;

const expectedIds = [
  'D01-NORMAL-CHAT', 'D02-MODE-ISOLATION', 'D03-PURPOSE-ISOLATION', 'D04-PRE-ABORT',
  'D05-INFLIGHT-ABORT', 'D06-IDENTITY', 'D07-USAGE-TIMING', 'D08-HIDDEN-RETRY',
  'I01-ACKNOWLEDGE', 'I02-ONE-FOLLOW-UP', 'I03-MULTI-QUESTION-OVERREACH',
  'I04-BLOCKED-TOPIC', 'I05-NO-SAVE', 'I06-TERMINAL-SUPPRESS', 'I07-STALE-CANCEL',
  'I08-SCHEMA-FAILURE-FALLBACK',
  'T01-STREAM-SUCCESS', 'T02-TEXT-PRESERVED', 'T03-PRE-ABORT', 'T04-MIDSTREAM-ABORT',
  'T05-STALE-AUDIO', 'T06-FOUR-FAILURES', 'T07-INVALID-AUDIO-USAGE', 'T08-HIDDEN-RETRY',
  'ST01-ORDINARY-SOURCES', 'ST02-UNKNOWN-YEAR', 'ST03-PRIVATE-PHOTO', 'ST04-CONFLICT',
  'ST05-BLOCKED-TOPIC', 'ST06-NO-SAVE', 'ST07-SOURCE-CONFLICT', 'ST08-REVOKE-DELETE',
  'PF01-PREFERENCE', 'PF02-EVENT-NOT-TRAIT', 'PF03-RELATION', 'PF04-TEMPORAL',
  'PF05-BLOCKED-TOPIC', 'PF06-PROTECTED-HEALTH', 'PF07-CONFLICT', 'PF08-DELETE',
  'X01-TEXT-FAILURE', 'X02-TTS-FAILURE', 'X03-STORY-FAILURE', 'X04-PROFILE-FAILURE',
] as const;

const expectedModelBehaviorIds = [
  'D04-PRE-ABORT', 'D05-INFLIGHT-ABORT', 'D06-IDENTITY', 'D07-USAGE-TIMING',
  'D08-HIDDEN-RETRY',
  'T01-STREAM-SUCCESS', 'T02-TEXT-PRESERVED', 'T03-PRE-ABORT', 'T04-MIDSTREAM-ABORT',
  'T05-STALE-AUDIO', 'T06-FOUR-FAILURES', 'T07-INVALID-AUDIO-USAGE', 'T08-HIDDEN-RETRY',
  'X02-TTS-FAILURE',
] as const;
const executedModelBehaviorIds = new Set<string>();

function cover(...ids: typeof expectedModelBehaviorIds[number][]): void {
  for (const id of ids) {
    assert.equal(executedModelBehaviorIds.has(id), false, `${id} executed more than once`);
    executedModelBehaviorIds.add(id);
  }
}

after(() => {
  assert.deepEqual(
    [...executedModelBehaviorIds].sort(),
    [...expectedModelBehaviorIds].sort(),
  );
});

function identity(generationId: number, invocationId: string): RuntimeIdentity {
  return {
    sessionEpoch: 'g4-session',
    turnId: `g4-turn-${generationId}`,
    generationId,
    invocationId,
    evidenceRefs: [`g4-evidence-${generationId}`],
  };
}

function activate(
  registry: GenerationCancellationRegistry,
  module: AlgorithmModule,
  generationId: number,
  invocationId: string,
) {
  const base = identity(generationId, invocationId);
  const signal = registry.begin(base, module);
  const bound = registry.bindResponse(base, module, `g4-response-${generationId}`);
  return { identity: bound, signal };
}

function deterministicClock(values: readonly string[]) {
  const remaining = [...values];
  return () => {
    const value = remaining.shift();
    assert.ok(value, 'runtime read more clock values than the frozen trace supplies');
    return value;
  };
}

function textCompletion(inputTokens = 5, outputTokens = 2) {
  return {
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    costCny: 0,
  };
}

function ttsCompletion(inputCharacters = 4, outputAudioMs = 320) {
  return {
    usage: { inputCharacters, outputAudioMs },
    costCny: 0,
  };
}

const zeroBillingVerifier = {
  verify(request: { reportedCostCny: number }) {
    return request.reportedCostCny === 0 ? { costCny: 0 } : null;
  },
};

test('G4 fixture denominator freezes 44 unique IDs in five 8-case groups plus four isolation controls', () => {
  assert.equal(fixtures.schemaVersion, 'g4-fixtures-v0.1');
  assert.equal(fixtures.paidExecutionEnabled, false);
  assert.equal(fixtures.fixedCaseCount, 44);
  assert.deepEqual(Object.fromEntries(
    Object.entries(fixtures.groups).map(([group, cases]) => [group, cases.length]),
  ), {
    daily_chat: 8,
    formal_interview: 8,
    tts: 8,
    story_draft: 8,
    profile_draft: 8,
    isolation: 4,
  });
  const actual = Object.values(fixtures.groups).flat().map(item => item.id);
  assert.equal(new Set(actual).size, 44);
  assert.deepEqual(actual, [...expectedIds]);
  assert.ok(Object.values(fixtures.groups).flat().every(item => item.assertion.trim().length > 0));
});

test('D04 and T03: pre-cancelled calls acquire no runtime executor invocation and remain unbilled', async () => {
  cover('D04-PRE-ABORT', 'T03-PRE-ABORT');
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 1, 'g4-pre-abort-text');
  const tts = activate(registry, 'tts', 2, 'g4-pre-abort-tts');
  registry.cancel(text.identity, 'daily_chat', 'pre_abort');
  registry.cancel(tts.identity, 'tts', 'pre_abort');
  let textTransportCalls = 0;
  let ttsTransportCalls = 0;
  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:00:00.000Z',
    transport: {
      async invoke() {
        textTransportCalls += 1;
        return textCompletion();
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:00:00.000Z',
    transport: {
      async synthesize() {
        ttsTransportCalls += 1;
        return ttsCompletion();
      },
    },
  });

  const [textResult, ttsResult] = await Promise.all([
    textRuntime.run({
      module: 'daily_chat', identity: text.identity,
      attemptId: 'g4-attempt-text-pre-abort', requestId: 'g4-request-text-pre-abort', prompt: '你好',
    }),
    ttsRuntime.run({
      identity: tts.identity,
      attemptId: 'g4-attempt-tts-pre-abort', requestId: 'g4-request-tts-pre-abort', text: '你好',
    }),
  ]);

  assert.equal(textResult.status, 'cancelled');
  assert.equal(ttsResult.status, 'cancelled');
  assert.equal(textTransportCalls, 0);
  assert.equal(ttsTransportCalls, 0);
  assert.deepEqual(
    [textResult.telemetry.runtimeGateExecutionCount, textResult.telemetry.costCny, textResult.telemetry.billingState],
    [0, 0, 'UNBILLED'],
  );
  assert.deepEqual(
    [ttsResult.telemetry.runtimeGateExecutionCount, ttsResult.telemetry.costCny, ttsResult.telemetry.billingState],
    [0, 0, 'UNBILLED'],
  );
});

test('D07: text uses the canonical lease, one runtime gate and visible-output timing', async () => {
  cover('D07-USAGE-TIMING');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'daily_chat', 3, 'g4-text-success');
  let runtimeExecutorInvocations = 0;
  const visible: string[] = [];
  const runtime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: deterministicClock([
      '2026-10-03T12:00:00.000Z',
      '2026-10-03T12:00:00.010Z',
      '2026-10-03T12:00:00.040Z',
      '2026-10-03T12:00:00.090Z',
    ]),
    transport: {
      async invoke(request, emit, executeRuntimeRequest) {
        assert.equal(request.signal, active.signal);
        assert.equal(request.sdkRetryPolicy, 'DISABLED');
        assert.deepEqual(request.identity, active.identity);
        return executeRuntimeRequest(async () => {
          runtimeExecutorInvocations += 1;
          await emit({ kind: 'text_delta', identity: active.identity, text: '' });
          await emit({ kind: 'text_delta', identity: active.identity, text: '您好' });
          return textCompletion();
        });
      },
    },
  });
  const result = await runtime.run({
    module: 'daily_chat', identity: active.identity,
    attemptId: 'g4-attempt-text-success', requestId: 'g4-request-text-success', prompt: '问候',
    onVisibleText: (fragment: string) => { visible.push(fragment); return 'COMMITTED'; },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.text, '您好');
  assert.deepEqual(visible, ['您好']);
  assert.equal(runtimeExecutorInvocations, 1);
  assert.deepEqual(result.telemetry, {
    queuedAt: '2026-10-03T12:00:00.000Z',
    providerStartedAt: '2026-10-03T12:00:00.010Z',
    firstOutputAt: '2026-10-03T12:00:00.040Z',
    completedAt: '2026-10-03T12:00:00.090Z',
    firstOutputLatencyMs: 40,
    totalLatencyMs: 90,
    usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    costCny: 0,
    billingState: 'VALIDATED',
    sdkRetryPolicy: 'DISABLED',
    runtimeGateExecutionCount: 1,
    cancellationCleanupStatus: 'NOT_REQUIRED',
  });
  assert.deepEqual(registry.accepts(active.identity, 'daily_chat'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('D05: cancellation wins a hanging provider race, finalizes and rejects late text', async () => {
  cover('D05-INFLIGHT-ABORT');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'daily_chat', 4, 'g4-text-cancel');
  let emitLate: ((event: unknown) => Promise<void>) | undefined;
  let release!: () => void;
  let markStarted!: () => void;
  const transportDone = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const visible: string[] = [];
  const runtime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:00:00.000Z',
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          emitLate = emit;
          markStarted();
          await transportDone;
          return textCompletion(1, 1);
        });
      },
    },
  });
  const running = runtime.run({
    module: 'daily_chat', identity: active.identity,
    attemptId: 'g4-attempt-text-cancel', requestId: 'g4-request-text-cancel', prompt: '继续',
    onVisibleText: (fragment: string) => { visible.push(fragment); return 'COMMITTED'; },
  });
  await started;
  registry.cancel(active.identity, 'daily_chat', 'user_interrupt');
  const result = await Promise.race([
    running,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('runtime waited for a cancelled provider')), 100);
    }),
  ]);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(
    [result.telemetry.runtimeGateExecutionCount, result.telemetry.costCny, result.telemetry.billingState],
    [1, null, 'UNKNOWN'],
  );
  assert.ok(emitLate);
  await emitLate({ kind: 'text_delta', identity: active.identity, text: '迟到文本' });
  assert.deepEqual(visible, []);
  assert.deepEqual(registry.accepts(active.identity, 'daily_chat'), {
    accepted: false,
    reason: 'finalized',
  });
  release();
});

test('T01: TTS streams through the canonical lease and records validated billing', async () => {
  cover('T01-STREAM-SUCCESS');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'tts', 5, 'g4-tts-success');
  let runtimeExecutorInvocations = 0;
  const delivered: Uint8Array[] = [];
  const runtime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: deterministicClock([
      '2026-10-03T12:01:00.000Z',
      '2026-10-03T12:01:00.020Z',
      '2026-10-03T12:01:00.070Z',
      '2026-10-03T12:01:00.120Z',
    ]),
    transport: {
      async synthesize(request, emit, executeRuntimeRequest) {
        assert.equal(request.signal, active.signal);
        assert.equal(request.sdkRetryPolicy, 'DISABLED');
        return executeRuntimeRequest(async () => {
          runtimeExecutorInvocations += 1;
          await emit({ kind: 'audio_chunk', identity: active.identity, audio: new Uint8Array() });
          await emit({ kind: 'audio_chunk', identity: active.identity, audio: new Uint8Array([1, 2, 3]) });
          return ttsCompletion();
        });
      },
    },
  });
  const result = await runtime.run({
    identity: active.identity,
    attemptId: 'g4-attempt-tts-success', requestId: 'g4-request-tts-success', text: '慢慢讲述',
    onAudio: (audio: Uint8Array) => { delivered.push(audio); return 'COMMITTED'; },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.text, '慢慢讲述');
  assert.equal(runtimeExecutorInvocations, 1);
  assert.deepEqual(delivered, [new Uint8Array([1, 2, 3])]);
  assert.equal(result.telemetry.firstOutputLatencyMs, 70);
  assert.equal(result.telemetry.totalLatencyMs, 120);
  assert.deepEqual(result.telemetry.usage, { inputCharacters: 4, outputAudioMs: 320 });
  assert.equal(result.telemetry.costCny, 0);
  assert.equal(result.telemetry.billingState, 'VALIDATED');
  assert.equal(result.telemetry.runtimeGateExecutionCount, 1);
});

test('T04: midstream cancellation settles promptly and rejects later audio', async () => {
  cover('T04-MIDSTREAM-ABORT');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'tts', 51, 'g4-tts-midstream-cancel');
  let emitLate!: (event: unknown) => Promise<void>;
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const delivered: number[] = [];
  const runtime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          emitLate = emit;
          await emit({ kind: 'audio_chunk', identity: active.identity, audio: new Uint8Array([1]) });
          started();
          await barrier;
          return ttsCompletion();
        });
      },
    },
  });
  const running = runtime.run({
    identity: active.identity,
    attemptId: 'g4-attempt-tts-midstream',
    requestId: 'g4-request-tts-midstream',
    text: '先播放一小段',
    onAudio: chunk => { delivered.push(chunk[0] ?? -1); return 'COMMITTED'; },
  });
  await ready;
  assert.deepEqual(delivered, [1]);
  registry.cancel(active.identity, 'tts', 'barge_in');
  const result = await Promise.race([
    running,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('TTS cancel did not settle')), 100)),
  ]);
  assert.equal(result.status, 'cancelled');
  await emitLate({ kind: 'audio_chunk', identity: active.identity, audio: new Uint8Array([2]) });
  assert.deepEqual(delivered, [1]);
  release();
});

test('T05: a newer generation supersedes the old lease and stale audio cannot play', async () => {
  cover('T05-STALE-AUDIO');
  const registry = new GenerationCancellationRegistry();
  const old = activate(registry, 'tts', 52, 'g4-tts-old-generation');
  let emitOld!: (event: unknown) => Promise<void>;
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { started = resolve; });
  const delivered: number[] = [];
  const runtime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          emitOld = emit;
          started();
          await barrier;
          return ttsCompletion();
        });
      },
    },
  });
  const running = runtime.run({
    identity: old.identity,
    attemptId: 'g4-attempt-tts-old',
    requestId: 'g4-request-tts-old',
    text: '旧一轮音频',
    onAudio: chunk => { delivered.push(chunk[0] ?? -1); return 'COMMITTED'; },
  });
  await ready;
  const nextBase = identity(53, 'g4-tts-new-generation');
  registry.begin(nextBase, 'tts');
  await emitOld({ kind: 'audio_chunk', identity: old.identity, audio: new Uint8Array([9]) });
  const result = await Promise.race([
    running,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('stale TTS did not settle')), 100)),
  ]);
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(delivered, []);
  registry.finalize(nextBase, 'tts');
  release();
});

test('T06: governed retry runner stops after four TTS failures without attempt five', async () => {
  cover('T06-FOUR-FAILURES');
  const modules: AlgorithmModule[] = [
    'asr', 'tts', 'daily_chat', 'formal_interview', 'memory', 'story_draft', 'profile_draft',
  ];
  const providerByModule: Record<AlgorithmModule, string> = {
    asr: 'fake-asr',
    tts: 'fake-tts',
    daily_chat: 'fake-llm',
    formal_interview: 'fake-llm',
    memory: 'fake-memory-semantic',
    story_draft: 'fake-llm',
    profile_draft: 'fake-llm',
  };
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const catalog = new FrozenCostCatalog(
    'g4-offline-retry-catalog-v1',
    modules.map(module => ({
      module,
      provider: providerByModule[module],
      modelOrResource: 'scripted-v0.1',
      priceVersion: 'offline-zero-cost-v1',
      billingUnit: 'request' as const,
      maximumBillableUnits: 1,
      worstCaseCostCny: 0,
      priceSourceHash: 'g4-offline-source-sha256',
      inputLimitHash: 'g4-input-limit-sha256',
    })),
    'offline_fixture',
  );
  const ledger = new ModelCallLedger(budget, catalog);
  const retryRegistry = new GenerationCancellationRegistry();
  const runner = new ProviderRetryRunner({ ledger, cancellationRegistry: retryRegistry });
  const provider = new FakeTtsProvider({
    attempts: [
      { outcome: { type: 'error', code: 'retryable_timeout' } },
      { outcome: { type: 'http_error', status: 429 } },
      { outcome: { type: 'http_error', status: 500 } },
      { outcome: { type: 'error', code: 'incomplete_stream' } },
    ],
  });
  const result = await runner.run({
    runId: 'g4-offline-run',
    phaseId: 'G4',
    module: 'tts',
    scenarioId: 'S06',
    caseId: 'T06-FOUR-FAILURES',
    identity: identity(54, 'g4-tts-four-failures'),
    provider,
    input: { text: '虚构 TTS 输入' },
    billingUnit: 'request',
    billableUnits: 1,
    inputLimitHash: 'g4-input-limit-sha256',
    configHash: 'g4-config-sha256',
    inputHash: 'g4-input-sha256',
    fallbackValue: { audioUnavailable: true },
    validateOutput: (value: unknown): value is { audio?: string; audioUnavailable?: boolean } => Boolean(
      value && typeof value === 'object' && typeof (value as { audio?: unknown }).audio === 'string'
    ),
  });
  assert.equal(result.result.status, 'fallback');
  assert.equal(result.fallbackCount, 1);
  assert.equal(provider.listInvocations().length, 4);
  assert.deepEqual(ledger.listAttempts().map(attempt => attempt.attemptIndex), [1, 2, 3, 4]);
  assert.equal(runner.pendingAttemptCount, 0);
});

test('T02/X02: TTS physical failure preserves text and reports unknown billing', async () => {
  cover('T02-TEXT-PRESERVED', 'X02-TTS-FAILURE');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'tts', 6, 'g4-tts-failure');
  const runtime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:02:00.000Z',
    transport: {
      async synthesize(_request, _emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          throw new Error('offline injected TTS failure');
        });
      },
    },
  });
  const result = await runtime.run({
    identity: active.identity,
    attemptId: 'g4-attempt-tts-failure', requestId: 'g4-request-tts-failure', text: '这段文字仍要显示',
  });
  assert.equal(result.status, 'audio_unavailable');
  assert.equal(result.text, '这段文字仍要显示');
  assert.equal(result.audioChunks.length, 0);
  assert.deepEqual(
    [result.telemetry.runtimeGateExecutionCount, result.telemetry.costCny, result.telemetry.billingState],
    [1, null, 'UNKNOWN'],
  );
});

test('D08/T08: a caught second runtime gate execution still fails closed', async () => {
  cover('D08-HIDDEN-RETRY', 'T08-HIDDEN-RETRY');
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 7, 'g4-hidden-text');
  const tts = activate(registry, 'tts', 8, 'g4-hidden-tts');
  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:03:00.000Z',
    transport: {
      async invoke(_request, _emit, executeRuntimeRequest) {
        const completion = await executeRuntimeRequest(async () => textCompletion());
        await assert.rejects(() => executeRuntimeRequest(async () => textCompletion()));
        return completion;
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    now: () => '2026-10-03T12:03:00.000Z',
    transport: {
      async synthesize(_request, _emit, executeRuntimeRequest) {
        const completion = await executeRuntimeRequest(async () => ttsCompletion());
        await assert.rejects(() => executeRuntimeRequest(async () => ttsCompletion()));
        return completion;
      },
    },
  });
  const [textResult, ttsResult] = await Promise.all([
    textRuntime.run({
      module: 'daily_chat', identity: text.identity,
      attemptId: 'g4-attempt-hidden-text', requestId: 'g4-request-hidden-text', prompt: 'x',
    }),
    ttsRuntime.run({
      identity: tts.identity,
      attemptId: 'g4-attempt-hidden-tts', requestId: 'g4-request-hidden-tts', text: 'x',
    }),
  ]);
  assert.equal(textResult.status, 'failed');
  assert.equal(textResult.error.code, 'invalid_config');
  assert.equal(textResult.telemetry.runtimeGateExecutionCount, 1);
  assert.equal(ttsResult.status, 'audio_unavailable');
  assert.equal(ttsResult.error.code, 'invalid_config');
  assert.equal(ttsResult.telemetry.runtimeGateExecutionCount, 1);
});

test('a caller-supplied foreign signal is ignored and cannot replace the canonical lease signal', async () => {
  cover('D06-IDENTITY');
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'daily_chat', 9, 'g4-foreign-signal');
  const foreign = new AbortController();
  foreign.abort('forged');
  const runtime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(request, emit, executeRuntimeRequest) {
        assert.equal(request.signal, active.signal);
        assert.notEqual(request.signal, foreign.signal);
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: active.identity, text: '可信信号' });
          return textCompletion();
        });
      },
    },
  });
  const forgedInput: AuditedTextRunInput & { signal: AbortSignal } = {
    module: 'daily_chat',
    identity: active.identity,
    signal: foreign.signal,
    attemptId: 'g4-attempt-foreign-signal',
    requestId: 'g4-request-foreign-signal',
    prompt: '继续',
  };
  const result = await runtime.run(forgedInput);
  assert.equal(result.status, 'success');
  assert.equal(result.text, '可信信号');
});

test('text and audio callbacks are ordered and visible before transport completion', async () => {
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 10, 'g4-live-text');
  const tts = activate(registry, 'tts', 11, 'g4-live-audio');
  let releaseText!: () => void;
  let releaseAudio!: () => void;
  let textStreamed!: () => void;
  let audioStreamed!: () => void;
  const textBarrier = new Promise<void>(resolve => { releaseText = resolve; });
  const audioBarrier = new Promise<void>(resolve => { releaseAudio = resolve; });
  const textReady = new Promise<void>(resolve => { textStreamed = resolve; });
  const audioReady = new Promise<void>(resolve => { audioStreamed = resolve; });
  const visible: string[] = [];
  const audio: number[] = [];

  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: text.identity, text: '先' });
          await emit({ kind: 'text_delta', identity: text.identity, text: '后' });
          textStreamed();
          await textBarrier;
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([1]) });
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([2]) });
          audioStreamed();
          await audioBarrier;
          return ttsCompletion();
        });
      },
    },
  });
  const textRunning = textRuntime.run({
    module: 'daily_chat', identity: text.identity,
    attemptId: 'g4-attempt-live-text', requestId: 'g4-request-live-text', prompt: '流式',
    onVisibleText: fragment => { visible.push(fragment); return 'COMMITTED'; },
  });
  const audioRunning = ttsRuntime.run({
    identity: tts.identity,
    attemptId: 'g4-attempt-live-audio', requestId: 'g4-request-live-audio', text: '流式',
    onAudio: chunk => { audio.push(chunk[0] ?? -1); return 'COMMITTED'; },
  });

  await Promise.all([textReady, audioReady]);
  assert.deepEqual(visible, ['先', '后']);
  assert.deepEqual(audio, [1, 2]);
  let textSettled = false;
  let audioSettled = false;
  void textRunning.then(() => { textSettled = true; });
  void audioRunning.then(() => { audioSettled = true; });
  await Promise.resolve();
  assert.equal(textSettled, false);
  assert.equal(audioSettled, false);

  releaseText();
  releaseAudio();
  const [textResult, audioResult] = await Promise.all([textRunning, audioRunning]);
  assert.equal(textResult.status, 'success');
  assert.equal(audioResult.status, 'success');
});

test('text and TTS reject each other\'s usage schema', async () => {
  cover('T07-INVALID-AUDIO-USAGE');
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 12, 'g4-wrong-text-usage');
  const tts = activate(registry, 'tts', 13, 'g4-wrong-tts-usage');
  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: text.identity, text: '已显示' });
          return {
            usage: { inputCharacters: 3, outputAudioMs: 10 },
            costCny: 0,
          } as never;
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([1]) });
          return {
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            costCny: 0,
          } as never;
        });
      },
    },
  });
  const [textResult, ttsResult] = await Promise.all([
    textRuntime.run({
      module: 'daily_chat', identity: text.identity,
      attemptId: 'g4-attempt-wrong-text-usage', requestId: 'g4-request-wrong-text-usage', prompt: 'x',
    }),
    ttsRuntime.run({
      identity: tts.identity,
      attemptId: 'g4-attempt-wrong-tts-usage', requestId: 'g4-request-wrong-tts-usage', text: 'x',
    }),
  ]);
  assert.equal(textResult.status, 'failed');
  assert.equal(textResult.error.code, 'invalid_schema');
  assert.equal(ttsResult.status, 'audio_unavailable');
  assert.equal(ttsResult.error.code, 'invalid_schema');
});

test('usage arithmetic and cost claims require independent validation', async () => {
  const registry = new GenerationCancellationRegistry();
  const inconsistent = activate(registry, 'daily_chat', 131, 'g4-inconsistent-usage');
  const untrustedCost = activate(registry, 'formal_interview', 132, 'g4-untrusted-cost');
  const fractionalTts = activate(registry, 'tts', 133, 'g4-fractional-tts-usage');

  const inconsistentRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: inconsistent.identity, text: '不可结算' });
          return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 999 }, costCny: 0 };
        });
      },
    },
  });
  const costRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: untrustedCost.identity, text: '费用待核' });
          return { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, costCny: 999 };
        });
      },
    },
  });
  const fractionalRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: fractionalTts.identity, audio: new Uint8Array([1]) });
          return { usage: { inputCharacters: 1, outputAudioMs: 10.5 }, costCny: 0 };
        });
      },
    },
  });

  const [usageResult, costResult, ttsResult] = await Promise.all([
    inconsistentRuntime.run({
      module: 'daily_chat', identity: inconsistent.identity,
      attemptId: 'g4-attempt-inconsistent', requestId: 'g4-request-inconsistent', prompt: 'x',
    }),
    costRuntime.run({
      module: 'formal_interview', identity: untrustedCost.identity,
      attemptId: 'g4-attempt-cost', requestId: 'g4-request-cost', prompt: 'x',
    }),
    fractionalRuntime.run({
      identity: fractionalTts.identity,
      attemptId: 'g4-attempt-fractional', requestId: 'g4-request-fractional', text: 'x',
    }),
  ]);
  assert.equal(usageResult.status, 'failed');
  assert.equal(usageResult.error.code, 'invalid_schema');
  assert.equal(costResult.status, 'failed');
  assert.equal(costResult.error.code, 'pricing_catalog_invalid');
  assert.equal(costResult.telemetry.costCny, null);
  assert.equal(costResult.telemetry.billingState, 'UNKNOWN');
  assert.equal(ttsResult.status, 'audio_unavailable');
  assert.equal(ttsResult.error.code, 'invalid_schema');
});

test('abort-aware sinks confirm pending text and audio were dropped before cancellation returns', async () => {
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 134, 'g4-pending-text-sink');
  const tts = activate(registry, 'tts', 135, 'g4-pending-audio-sink');
  let textEntered!: () => void;
  let audioEntered!: () => void;
  const textReady = new Promise<void>(resolve => { textEntered = resolve; });
  const audioReady = new Promise<void>(resolve => { audioEntered = resolve; });
  const visible: string[] = [];
  const audible: number[] = [];

  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: text.identity, text: '不应迟到显示' });
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([9]) });
          return ttsCompletion();
        });
      },
    },
  });

  const textRunning = textRuntime.run({
    module: 'daily_chat', identity: text.identity,
    attemptId: 'g4-attempt-pending-text', requestId: 'g4-request-pending-text', prompt: 'x',
    async onVisibleText(fragment, context) {
      textEntered();
      if (!context.signal.aborted) {
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      if (context.signal.aborted) return 'DROPPED';
      visible.push(fragment);
      return 'COMMITTED';
    },
  });
  const ttsRunning = ttsRuntime.run({
    identity: tts.identity,
    attemptId: 'g4-attempt-pending-audio', requestId: 'g4-request-pending-audio', text: 'x',
    async onAudio(chunk, context) {
      audioEntered();
      if (!context.signal.aborted) {
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      }
      if (context.signal.aborted) return 'DROPPED';
      audible.push(chunk[0] ?? -1);
      return 'COMMITTED';
    },
  });

  await Promise.all([textReady, audioReady]);
  registry.cancel(text.identity, 'daily_chat', 'interrupt');
  registry.cancel(tts.identity, 'tts', 'interrupt');
  const [textResult, ttsResult] = await Promise.race([
    Promise.all([textRunning, ttsRunning]),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('sink did not drop on abort')), 100)),
  ]);
  assert.equal(textResult.status, 'cancelled');
  assert.equal(ttsResult.status, 'cancelled');
  assert.deepEqual(visible, []);
  assert.deepEqual(audible, []);
});

test('sinks that commit after cancellation are recorded as failed cleanup for text and TTS', async () => {
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 138, 'g4-stale-text-commit');
  const tts = activate(registry, 'tts', 139, 'g4-stale-audio-commit');
  let textEntered!: () => void;
  let audioEntered!: () => void;
  let releaseText!: () => void;
  let releaseAudio!: () => void;
  const textReady = new Promise<void>(resolve => { textEntered = resolve; });
  const audioReady = new Promise<void>(resolve => { audioEntered = resolve; });
  const textRelease = new Promise<void>(resolve => { releaseText = resolve; });
  const audioRelease = new Promise<void>(resolve => { releaseAudio = resolve; });
  let staleTextCommitted = false;
  let staleAudioCommitted = false;

  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: text.identity, text: '迟到文本' });
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([8]) });
          return ttsCompletion();
        });
      },
    },
  });

  const textRunning = textRuntime.run({
    module: 'daily_chat', identity: text.identity,
    attemptId: 'g4-attempt-stale-text-commit', requestId: 'g4-request-stale-text-commit', prompt: 'x',
    async onVisibleText() {
      textEntered();
      await textRelease;
      staleTextCommitted = true;
      return 'COMMITTED' as const;
    },
  });
  const ttsRunning = ttsRuntime.run({
    identity: tts.identity,
    attemptId: 'g4-attempt-stale-audio-commit', requestId: 'g4-request-stale-audio-commit', text: 'x',
    async onAudio() {
      audioEntered();
      await audioRelease;
      staleAudioCommitted = true;
      return 'COMMITTED' as const;
    },
  });

  await Promise.all([textReady, audioReady]);
  registry.cancel(text.identity, 'daily_chat', 'interrupt');
  registry.cancel(tts.identity, 'tts', 'interrupt');
  releaseText();
  releaseAudio();
  const [textResult, ttsResult] = await Promise.all([textRunning, ttsRunning]);
  assert.equal(staleTextCommitted, true);
  assert.equal(staleAudioCommitted, true);
  assert.equal(textResult.status, 'cancelled');
  assert.equal(ttsResult.status, 'cancelled');
  assert.equal(textResult.telemetry.cancellationCleanupStatus, 'FAILED');
  assert.equal(ttsResult.telemetry.cancellationCleanupStatus, 'FAILED');
});

test('non-cooperative sinks cannot keep cancellation pending beyond the acknowledgement timeout', async () => {
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 136, 'g4-hung-text-sink');
  const tts = activate(registry, 'tts', 137, 'g4-hung-audio-sink');
  let textEntered!: () => void;
  let audioEntered!: () => void;
  const textReady = new Promise<void>(resolve => { textEntered = resolve; });
  const audioReady = new Promise<void>(resolve => { audioEntered = resolve; });
  const never = new Promise<never>(() => {});

  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    sinkAcknowledgementTimeoutMs: 10,
    transport: {
      async invoke(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: text.identity, text: '不应显示' });
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    sinkAcknowledgementTimeoutMs: 10,
    transport: {
      async synthesize(_request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: tts.identity, audio: new Uint8Array([7]) });
          return ttsCompletion();
        });
      },
    },
  });

  const textRunning = textRuntime.run({
    module: 'daily_chat', identity: text.identity,
    attemptId: 'g4-attempt-hung-text', requestId: 'g4-request-hung-text', prompt: 'x',
    onVisibleText() { textEntered(); return never; },
  });
  const ttsRunning = ttsRuntime.run({
    identity: tts.identity,
    attemptId: 'g4-attempt-hung-audio', requestId: 'g4-request-hung-audio', text: 'x',
    onAudio() { audioEntered(); return never; },
  });

  await Promise.all([textReady, audioReady]);
  registry.cancel(text.identity, 'daily_chat', 'interrupt');
  registry.cancel(tts.identity, 'tts', 'interrupt');
  const [textResult, ttsResult] = await Promise.race([
    Promise.all([textRunning, ttsRunning]),
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('sink timeout did not release cancellation')), 100)),
  ]);
  assert.equal(textResult.status, 'cancelled');
  assert.equal(ttsResult.status, 'cancelled');
  assert.equal(textResult.telemetry.cancellationCleanupStatus, 'TIMED_OUT');
  assert.equal(ttsResult.telemetry.cancellationCleanupStatus, 'TIMED_OUT');
});

test('empty fields, invalid identity and wrong text module fail before a runtime executor invocation', async () => {
  const registry = new GenerationCancellationRegistry();
  const text = activate(registry, 'daily_chat', 14, 'g4-empty-text-fields');
  const tts = activate(registry, 'tts', 15, 'g4-empty-tts-fields');
  let runtimeExecutorInvocations = 0;
  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, _emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          runtimeExecutorInvocations += 1;
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(_request, _emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          runtimeExecutorInvocations += 1;
          return ttsCompletion();
        });
      },
    },
  });

  const emptyText = await textRuntime.run({
    module: 'daily_chat', identity: text.identity,
    attemptId: '', requestId: '', prompt: '   ',
  });
  const emptyTts = await ttsRuntime.run({
    identity: tts.identity,
    attemptId: '', requestId: '', text: '   ',
  });
  const invalidIdentity = await textRuntime.run({
    module: 'daily_chat',
    identity: { ...identity(16, 'g4-invalid-identity'), sessionEpoch: '' },
    attemptId: 'g4-attempt-invalid-identity',
    requestId: 'g4-request-invalid-identity',
    prompt: 'x',
  });
  const wrongModule = await textRuntime.run({
    module: 'tts' as never,
    identity: identity(17, 'g4-wrong-module'),
    attemptId: 'g4-attempt-wrong-module',
    requestId: 'g4-request-wrong-module',
    prompt: 'x',
  });

  assert.equal(emptyText.status, 'failed');
  assert.equal(emptyText.error.code, 'invalid_config');
  assert.equal(emptyTts.status, 'audio_unavailable');
  assert.equal(emptyTts.error.code, 'invalid_config');
  assert.equal(invalidIdentity.status, 'failed');
  assert.equal(invalidIdentity.error.code, 'invalid_config');
  assert.equal(wrongModule.status, 'failed');
  assert.equal(wrongModule.error.code, 'invalid_config');
  assert.equal(runtimeExecutorInvocations, 0);
  assert.deepEqual(registry.accepts(text.identity, 'daily_chat'), {
    accepted: false,
    reason: 'finalized',
  });
  assert.deepEqual(registry.accepts(tts.identity, 'tts'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('a transport that bypasses the runtime request gate cannot report success', async () => {
  const registry = new GenerationCancellationRegistry();
  const active = activate(registry, 'daily_chat', 18, 'g4-gate-bypass');
  const visible: string[] = [];
  const runtime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(_request, emit) {
        await emit({ kind: 'text_delta', identity: active.identity, text: '不可接受' });
        return textCompletion();
      },
    },
  });
  const result = await runtime.run({
    module: 'daily_chat', identity: active.identity,
    attemptId: 'g4-attempt-gate-bypass', requestId: 'g4-request-gate-bypass', prompt: 'x',
    onVisibleText: fragment => { visible.push(fragment); return 'COMMITTED'; },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'invalid_config');
  assert.equal(result.telemetry.runtimeGateExecutionCount, 0);
  assert.equal(result.telemetry.billingState, 'UNBILLED');
  assert.deepEqual(visible, []);
});

test('borrowed execution permits are branded and nested model/TTS runs never finalize their owner', async () => {
  const registry = new GenerationCancellationRegistry();
  const textActive = activate(registry, 'daily_chat', 19, 'g4-borrowed-text');
  const ttsActive = activate(registry, 'tts', 20, 'g4-borrowed-tts');
  const textOwner = registry.acquireLease(textActive.identity, 'daily_chat');
  const ttsOwner = registry.acquireLease(ttsActive.identity, 'tts');
  assert.ok(textOwner);
  assert.ok(ttsOwner);
  const textPermit = registry.borrowLease(textOwner);
  const ttsPermit = registry.borrowLease(ttsOwner);
  assert.ok(textPermit);
  assert.ok(ttsPermit);

  let textTransportCalls = 0;
  const textRuntime = createAuditedTextRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async invoke(request, emit, executeRuntimeRequest) {
        textTransportCalls += 1;
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: request.identity, text: '借用成功' });
          return textCompletion();
        });
      },
    },
  });
  const ttsRuntime = createAuditedTtsRuntime({
    cancellationRegistry: registry,
    billingVerifier: zeroBillingVerifier,
    transport: {
      async synthesize(request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'audio_chunk', identity: request.identity, audio: new Uint8Array([1, 2]) });
          return ttsCompletion();
        });
      },
    },
  });

  const forged = { ...textPermit };
  const rejected = await textRuntime.runBorrowed({
    module: 'daily_chat', identity: textActive.identity,
    attemptId: 'g4-attempt-forged-borrow', requestId: 'g4-request-forged-borrow', prompt: 'x',
  }, forged as any);
  assert.equal(rejected.status, 'failed');
  assert.equal(rejected.error.code, 'invalid_config');
  assert.equal(textTransportCalls, 0);

  const [textResult, ttsResult] = await Promise.all([
    textRuntime.runBorrowed({
      module: 'daily_chat', identity: textActive.identity,
      attemptId: 'g4-attempt-valid-borrow', requestId: 'g4-request-valid-borrow', prompt: 'x',
    }, textPermit),
    ttsRuntime.runBorrowed({
      identity: ttsActive.identity,
      attemptId: 'g4-attempt-valid-tts-borrow', requestId: 'g4-request-valid-tts-borrow', text: '你好',
    }, ttsPermit),
  ]);
  assert.equal(textResult.status, 'success');
  assert.equal(ttsResult.status, 'success');
  const replay = await textRuntime.runBorrowed({
    module: 'daily_chat', identity: textActive.identity,
    attemptId: 'g4-attempt-replayed-borrow', requestId: 'g4-request-replayed-borrow', prompt: 'x',
  }, textPermit);
  assert.equal(replay.status, 'failed');
  assert.equal(replay.error.code, 'invalid_config');
  assert.equal(textTransportCalls, 1);
  assert.deepEqual(registry.accepts(textActive.identity, 'daily_chat'), { accepted: true });
  assert.deepEqual(registry.accepts(ttsActive.identity, 'tts'), { accepted: true });
  assert.equal(textOwner.finalize(), true);
  assert.equal(ttsOwner.finalize(), true);
});
