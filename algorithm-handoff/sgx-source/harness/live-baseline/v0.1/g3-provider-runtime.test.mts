import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  BudgetController,
  FrozenCostCatalog,
  GenerationCancellationRegistry,
  ModelCallLedger,
  type AlgorithmModule,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/index.ts';
import {
  FakeAsrProvider,
  FakeLlmProvider,
  FakeMemorySemanticProvider,
  FakeTtsProvider,
  ProviderRetryRunner,
  type OfflineProvider,
  type ProviderAttemptOutcome,
  type ProviderEventHandler,
} from '../../../src/lib/provider-runtime/index.ts';

type FixtureAttempt = {
  events?: Array<Record<string, unknown>>;
  outcome: Record<string, unknown>;
};

type G3Fixture = {
  id: string;
  category: string;
  attempts?: FixtureAttempt[];
  expected: Record<string, unknown>;
};

type G3FixtureFile = {
  schemaVersion: string;
  paidExecutionEnabled: boolean;
  fixedCaseCount: number;
  cases: G3Fixture[];
};

const fixtures = JSON.parse(readFileSync(
  new URL('./g3-fixtures.json', import.meta.url),
  'utf8',
)) as G3FixtureFile;

const modules: AlgorithmModule[] = [
  'asr',
  'tts',
  'daily_chat',
  'formal_interview',
  'memory',
  'story_draft',
  'profile_draft',
];

const providerForModule: Record<AlgorithmModule, string> = {
  asr: 'fake-asr',
  tts: 'fake-tts',
  daily_chat: 'fake-llm',
  formal_interview: 'fake-llm',
  memory: 'fake-memory-semantic',
  story_draft: 'fake-llm',
  profile_draft: 'fake-llm',
};

function fixture(id: string): G3Fixture {
  const found = fixtures.cases.find(item => item.id === id);
  assert.ok(found, `missing G3 fixture ${id}`);
  return structuredClone(found);
}

function identity(generationId = 1): RuntimeIdentity {
  return {
    sessionEpoch: 'g3-session-epoch-001',
    turnId: `g3-turn-${generationId}`,
    generationId,
    invocationId: `g3-base-invocation-${generationId}`,
    evidenceRefs: [`g3-input-evidence-${generationId}`],
  };
}

function makeLedger(
  providerOverrides: Partial<Record<AlgorithmModule, string>> = {},
  worstCaseCostCny = 0,
): ModelCallLedger {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const catalog = new FrozenCostCatalog(
    'g3-offline-price-fixture-v1',
    modules.map(module => ({
      module,
      provider: providerOverrides[module] ?? providerForModule[module],
      modelOrResource: 'scripted-v0.1',
      priceVersion: 'offline-zero-cost-v1',
      billingUnit: 'request' as const,
      maximumBillableUnits: 1,
      worstCaseCostCny,
      priceSourceHash: 'g3-offline-source-sha256',
      inputLimitHash: 'g3-input-limit-sha256',
    })),
    'offline_fixture',
  );
  return new ModelCallLedger(budget, catalog);
}

function deterministicNow(): () => string {
  const base = Date.parse('2026-10-03T10:00:00.000Z');
  let tick = 0;
  return () => new Date(base + tick++).toISOString();
}

function makeRunner(ledger: ModelCallLedger, cancellationRegistry = new GenerationCancellationRegistry()) {
  return {
    cancellationRegistry,
    runner: new ProviderRetryRunner({
      ledger,
      cancellationRegistry,
      now: deterministicNow(),
    }),
  };
}

function invocationFor(
  testCase: G3Fixture,
  provider: OfflineProvider<unknown, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return {
    runId: 'g3-offline-run-001',
    phaseId: 'G3',
    module: 'daily_chat' as const,
    scenarioId: testCase.id,
    caseId: testCase.id,
    identity: identity(),
    provider,
    input: { prompt: '完全虚构的 G3 离线输入' },
    billingUnit: 'request' as const,
    billableUnits: 1,
    inputLimitHash: 'g3-input-limit-sha256',
    configHash: 'g3-config-sha256',
    inputHash: `g3-input-${testCase.id}`,
    fallbackValue: { text: '暂时无法完成，请稍后再试。' },
    validateOutput: (value: unknown): value is { text: string } => Boolean(
      value
      && typeof value === 'object'
      && typeof (value as { text?: unknown }).text === 'string'
      && (value as { text: string }).text.trim(),
    ),
    ...overrides,
  };
}

function adversarialCase(id: string): G3Fixture {
  return {
    id,
    category: 'adversarial_regression',
    expected: {},
  };
}

async function ignoreExpectedRunnerFailure(action: Promise<unknown>): Promise<void> {
  try {
    await action;
  } catch {
    // The runner may either normalize a contract breach into ModuleResult or
    // throw after cleaning up. These tests assert the cleanup boundary below.
  }
}

test('the frozen G3 denominator contains exactly eight unique offline cases', () => {
  assert.equal(fixtures.schemaVersion, 'g3-fixtures-v0.1');
  assert.equal(fixtures.paidExecutionEnabled, false);
  assert.equal(fixtures.fixedCaseCount, 8);
  assert.equal(fixtures.cases.length, 8);
  assert.equal(new Set(fixtures.cases.map(item => item.id)).size, 8);
  assert.deepEqual(fixtures.cases.map(item => item.id), [
    'G3-01-HAPPY-BOUNDARIES',
    'G3-02-SEGMENT-REORDER-DEDUP',
    'G3-03-RECONNECT-LATE-OLD-CONNECTION',
    'G3-04-TIMEOUT-THEN-SUCCESS',
    'G3-05-429-503-THEN-SUCCESS',
    'G3-06-FOUR-FAILURES-FALLBACK',
    'G3-07-INVALID-SCHEMA-FAIL-FAST',
    'G3-08-CANCEL-OLD-GENERATION',
  ]);
});

test('four named Fake providers are injectable, offline and distinguishable', () => {
  const named = [
    new FakeAsrProvider({ attempts: [] }),
    new FakeLlmProvider({ attempts: [] }),
    new FakeTtsProvider({ attempts: [] }),
    new FakeMemorySemanticProvider({ attempts: [] }),
  ];
  assert.deepEqual(named.map(provider => provider.providerKind), [
    'asr',
    'llm',
    'tts',
    'memory_semantic',
  ]);
  assert.deepEqual(named.map(provider => provider.providerName), [
    'fake-asr',
    'fake-llm',
    'fake-tts',
    'fake-memory-semantic',
  ]);
  assert.ok(named.every(provider => provider.modelVersion === 'scripted-v0.1'));
  assert.ok(named.every(provider => provider.paidExecutionEnabled === false));
  assert.ok(named.every(provider => provider.listInvocations().length === 0));
});

test('a timeout retries once with frozen inputs and the second attempt succeeds with usage', async () => {
  const testCase = fixture('G3-04-TIMEOUT-THEN-SUCCESS');
  const provider = new FakeLlmProvider({ attempts: testCase.attempts ?? [] });
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  const execution = await runner.run(invocationFor(testCase, provider));
  const attempts = ledger.listAttempts();

  assert.equal(execution.result.ok, true);
  assert.equal(execution.result.status, 'success');
  assert.deepEqual(execution.result.value, { text: '第二次成功' });
  assert.equal(execution.fallbackCount, 0);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].errorCode, 'retryable_timeout');
  assert.equal(attempts[0].retryEligible, true);
  assert.equal(attempts[1].usableResult, true);
  assert.deepEqual(attempts[1].usage, {
    inputTokens: 12,
    outputTokens: 5,
    totalTokens: 17,
  });
  assert.equal(new Set(attempts.map(item => item.inputHash)).size, 1);
  assert.equal(new Set(attempts.map(item => item.configHash)).size, 1);
  assert.equal(new Set(attempts.map(item => item.provider)).size, 1);
  assert.equal(provider.listInvocations().length, 2);
});

test('429 and 503 are normalized, audited and retried before a usable success', async () => {
  const testCase = fixture('G3-05-429-503-THEN-SUCCESS');
  const provider = new FakeLlmProvider({ attempts: testCase.attempts ?? [] });
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  const execution = await runner.run(invocationFor(testCase, provider));
  const attempts = ledger.listAttempts();

  assert.equal(execution.result.status, 'success');
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts.slice(0, 2).map(item => item.errorCode), [
    'provider_429',
    'provider_503',
  ]);
  assert.ok(attempts.slice(0, 2).every(item => item.retryEligible === true));
  assert.equal(attempts[2].usableResult, true);
  assert.deepEqual(attempts[2].usage, {
    inputTokens: 8,
    outputTokens: 4,
    totalTokens: 12,
  });
});

test('four retryable failures emit one fallback, normalize generic 5xx and never start attempt five', async () => {
  const testCase = fixture('G3-06-FOUR-FAILURES-FALLBACK');
  const provider = new FakeLlmProvider({ attempts: testCase.attempts ?? [] });
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  const execution = await runner.run(invocationFor(testCase, provider));
  const attempts = ledger.listAttempts();

  assert.equal(execution.result.ok, false);
  assert.equal(execution.result.status, 'fallback');
  assert.deepEqual(execution.result.fallbackValue, { text: '暂时无法完成，请稍后再试。' });
  assert.equal(execution.fallbackCount, 1);
  assert.equal(attempts.length, 4);
  assert.deepEqual(attempts.map(item => item.attemptIndex), [1, 2, 3, 4]);
  assert.deepEqual(attempts.map(item => item.errorCode), [
    'retryable_timeout',
    'provider_429',
    'provider_5xx',
    'incomplete_stream',
  ]);
  assert.deepEqual(attempts.map(item => item.retryEligible), [true, true, true, false]);
  assert.equal(provider.listInvocations().length, 4);
  assert.equal(runner.pendingAttemptCount, 0);
});

test('invalid output or usage fails as invalid_schema without an automatic retry', async () => {
  const testCase = fixture('G3-07-INVALID-SCHEMA-FAIL-FAST');
  const provider = new FakeLlmProvider({ attempts: testCase.attempts ?? [] });
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  const execution = await runner.run(invocationFor(testCase, provider));
  const attempts = ledger.listAttempts();

  assert.equal(execution.result.ok, false);
  assert.equal(execution.result.status, 'fallback');
  assert.equal(execution.result.error.code, 'invalid_schema');
  assert.equal(execution.result.error.retryable, false);
  assert.equal(execution.fallbackCount, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].errorCode, 'invalid_schema');
  assert.equal(attempts[0].retryEligible, false);
  assert.equal(provider.listInvocations().length, 1);
});

test('cancelled calls do not retry and late events are rejected after the AbortSignal fires', async () => {
  const testCase = fixture('G3-08-CANCEL-OLD-GENERATION');
  const provider = new FakeLlmProvider({ attempts: testCase.attempts ?? [] });
  const ledger = makeLedger();
  const { runner, cancellationRegistry } = makeRunner(ledger);
  let partialCount = 0;
  const execution = await runner.run(invocationFor(testCase, provider, {
    onEvent: (event: { kind: string; identity: RuntimeIdentity }) => {
      if (event.kind === 'partial') partialCount += 1;
      if (event.kind === 'cancel_point') {
        assert.equal(cancellationRegistry.cancel(
          event.identity,
          'daily_chat',
          'g3_fixture_cancel',
        ), true);
      }
    },
  }));
  const attempts = ledger.listAttempts();

  assert.equal(execution.result.ok, false);
  assert.equal(execution.result.status, 'cancelled');
  assert.equal(execution.result.error.code, 'cancelled');
  assert.equal(execution.result.error.retryable, false);
  assert.equal(partialCount, 1);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].retryEligible, false);
  assert.equal(provider.listInvocations().length, 1);
  assert.equal(execution.acceptedEvents.some((event: { kind: string }) => (
    event.kind === 'segment_final' || event.kind === 'usage'
  )), false);
  assert.deepEqual(
    execution.rejectedEvents.map((item: { event: { kind: string }; reason: string }) => [
      item.event.kind,
      item.reason,
    ]),
    [
      ['segment_final', 'cancelled'],
      ['usage', 'cancelled'],
    ],
  );
  assert.equal(runner.pendingAttemptCount, 0);
});

test('a malformed provider outcome cannot leave an active invocation or accept a late callback', async () => {
  const testCase = adversarialCase('G3-ADV-MALFORMED-OUTCOME');
  const ledger = makeLedger();
  const { runner, cancellationRegistry } = makeRunner(ledger);
  let capturedEmit: ProviderEventHandler | undefined;
  let consumerCalls = 0;
  const provider: OfflineProvider<unknown, unknown> = {
    providerKind: 'llm',
    providerName: 'fake-llm',
    modelVersion: 'scripted-v0.1',
    paidExecutionEnabled: false,
    async invoke(_input, _context, emit) {
      capturedEmit = emit;
      return null as unknown as ProviderAttemptOutcome<unknown>;
    },
  };
  const invocation = invocationFor(testCase, provider, {
    onEvent: () => { consumerCalls += 1; },
  });

  await ignoreExpectedRunnerFailure(runner.run(invocation));
  assert.equal(runner.pendingAttemptCount, 0);
  assert.equal(cancellationRegistry.accepts(invocation.identity, 'daily_chat').accepted, false);
  assert.equal(ledger.listAttempts().some(item => item.state === 'IN_FLIGHT'), false);
  assert.ok(capturedEmit);
  await capturedEmit({
    kind: 'final',
    identity: invocation.identity,
    value: { text: 'must be rejected as late' },
  });
  assert.equal(consumerCalls, 0);
});

test('a second clock failure still finalizes the invocation and rejects a late callback', async () => {
  const testCase = adversarialCase('G3-ADV-SECOND-CLOCK-FAILURE');
  const ledger = makeLedger();
  const cancellationRegistry = new GenerationCancellationRegistry();
  let clockCalls = 0;
  const runner = new ProviderRetryRunner({
    ledger,
    cancellationRegistry,
    now: () => {
      clockCalls += 1;
      if (clockCalls === 2) throw new Error('second clock read failed');
      return '2026-10-03T10:00:00.000Z';
    },
  });
  let capturedEmit: ProviderEventHandler | undefined;
  let consumerCalls = 0;
  const provider: OfflineProvider<unknown, unknown> = {
    providerKind: 'llm',
    providerName: 'fake-llm',
    modelVersion: 'scripted-v0.1',
    paidExecutionEnabled: false,
    async invoke(_input, _context, emit) {
      capturedEmit = emit;
      return { ok: true, value: { text: 'provider completed before clock failure' } };
    },
  };
  const invocation = invocationFor(testCase, provider, {
    onEvent: () => { consumerCalls += 1; },
  });

  await assert.rejects(runner.run(invocation), /second clock read failed/);
  assert.equal(runner.pendingAttemptCount, 0);
  assert.equal(cancellationRegistry.accepts(invocation.identity, 'daily_chat').accepted, false);
  assert.equal(ledger.listAttempts().some(item => item.state === 'IN_FLIGHT'), false);
  assert.ok(capturedEmit);
  await capturedEmit({
    kind: 'final',
    identity: invocation.identity,
    value: { text: 'must be rejected after clock failure' },
  });
  assert.equal(consumerCalls, 0);
});

test('conflicting repeated usage fails closed instead of silently taking the last values', async () => {
  const testCase = adversarialCase('G3-ADV-USAGE-CONFLICT');
  const provider = new FakeLlmProvider({
    attempts: [{
      events: [
        { kind: 'usage', usage: { inputTokens: 1, totalTokens: 1 } },
        { kind: 'usage', usage: { inputTokens: 9, totalTokens: 9 } },
      ],
      outcome: { type: 'success', value: { text: 'must not be usable' } },
    }],
  });
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  const execution = await runner.run(invocationFor(testCase, provider));

  assert.equal(execution.result.ok, false);
  if (!execution.result.ok) assert.equal(execution.result.error.code, 'invalid_schema');
  assert.equal(provider.listInvocations().length, 1);
  assert.equal(ledger.listAttempts()[0]?.errorCode, 'invalid_schema');
});

test('a scripted Fake event without kind is rejected as invalid configuration or schema', async () => {
  const testCase = adversarialCase('G3-ADV-FAKE-MISSING-KIND');
  const ledger = makeLedger();
  const { runner } = makeRunner(ledger);
  let rejection: unknown;
  let execution: Awaited<ReturnType<typeof runner.run<{ text: string }>>> | undefined;

  try {
    const provider = new FakeLlmProvider({
      attempts: [{
        events: [{}],
        outcome: { type: 'success', value: { text: 'must not be usable' } },
      }],
    });
    execution = await runner.run(invocationFor(testCase, provider));
  } catch (error) {
    rejection = error;
  }

  if (rejection !== undefined) {
    assert.match(String(rejection), /event|kind|schema|config/i);
  } else {
    assert.ok(execution);
    assert.equal(execution.result.ok, false);
    if (!execution.result.ok) {
      assert.match(execution.result.error.code, /invalid_(?:config|schema)/);
    }
  }
});

test('module and providerKind mismatch is blocked even when the price catalog provider name matches', async () => {
  const testCase = adversarialCase('G3-ADV-MODULE-PROVIDER-KIND');
  const provider = new FakeTtsProvider({
    attempts: [{ outcome: { type: 'success', value: { text: 'not a chat provider' } } }],
  });
  const ledger = makeLedger({ daily_chat: 'fake-tts' });
  const { runner } = makeRunner(ledger);
  let rejection: unknown;
  let execution: Awaited<ReturnType<typeof runner.run<{ text: string }>>> | undefined;

  try {
    execution = await runner.run(invocationFor(testCase, provider));
  } catch (error) {
    rejection = error;
  }

  if (rejection !== undefined) {
    assert.match(String(rejection), /provider|kind|module|config/i);
  } else {
    assert.ok(execution);
    assert.equal(execution.result.ok, false);
    if (!execution.result.ok) assert.equal(execution.result.error.code, 'invalid_config');
  }
  assert.equal(provider.listInvocations().length, 0);
});

test('failInFlightAttempt atomically closes a reserved attempt and the runner uses it after completion failure', async () => {
  type FailInFlightAttempt = (input: {
    attemptId: string;
    errorCode: 'unknown';
    completedAt: string;
  }) => ReturnType<ModelCallLedger['completeAttempt']>;
  type RecoverableLedger = ModelCallLedger & {
    failInFlightAttempt: FailInFlightAttempt;
  };
  const directLedger = makeLedger({}, 1.25) as RecoverableLedger;
  assert.equal(typeof directLedger.failInFlightAttempt, 'function');
  const directAttempt = directLedger.startAttempt({
    runId: 'g3-fail-in-flight-direct',
    phaseId: 'G3',
    module: 'daily_chat',
    scenarioId: 'G3-ADV-FAIL-IN-FLIGHT-DIRECT',
    caseId: 'G3-ADV-FAIL-IN-FLIGHT-DIRECT',
    attemptIndex: 1,
    provider: 'fake-llm',
    modelVersion: 'scripted-v0.1',
    billingUnit: 'request',
    billableUnits: 1,
    inputLimitHash: 'g3-input-limit-sha256',
    configHash: 'g3-config-sha256',
    inputHash: 'g3-fail-in-flight-direct-input',
    startedAt: '2026-10-03T10:00:00.000Z',
  });
  const directlyFailed = directLedger.failInFlightAttempt({
    attemptId: directAttempt.attemptId,
    errorCode: 'unknown',
    completedAt: '2026-10-03T10:00:01.000Z',
  });

  assert.equal(directlyFailed.state, 'COMPLETED');
  assert.equal(directlyFailed.billingStatus, 'UNBILLED');
  assert.equal(directlyFailed.unbilledEstimatedCostCny, 1.25);
  assert.equal(directlyFailed.errorCode, 'unknown');
  assert.equal(directlyFailed.usableResult, false);
  assert.equal(directlyFailed.retryEligible, false);

  const runnerLedger = makeLedger({}, 1.25) as RecoverableLedger;
  assert.equal(typeof runnerLedger.failInFlightAttempt, 'function');
  const originalFailInFlight = runnerLedger.failInFlightAttempt.bind(runnerLedger);
  let failInFlightCalls = 0;
  runnerLedger.failInFlightAttempt = input => {
    failInFlightCalls += 1;
    return originalFailInFlight(input);
  };
  runnerLedger.completeAttempt = () => {
    throw new Error('injected completeAttempt failure before mutation');
  };
  const cancellationRegistry = new GenerationCancellationRegistry();
  const runner = new ProviderRetryRunner({
    ledger: runnerLedger,
    cancellationRegistry,
    now: deterministicNow(),
  });
  const provider = new FakeLlmProvider({
    attempts: [{ outcome: { type: 'success', value: { text: 'provider success' } } }],
  });
  const testCase = adversarialCase('G3-ADV-LEDGER-COMPLETION-FAILURE');
  const invocation = invocationFor(testCase, provider);

  await assert.rejects(
    runner.run(invocation),
    /injected completeAttempt failure before mutation/,
  );
  assert.equal(failInFlightCalls, 1);
  assert.equal(runner.pendingAttemptCount, 0);
  assert.equal(cancellationRegistry.accepts(invocation.identity, 'daily_chat').accepted, false);
  assert.equal(runnerLedger.listAttempts().some(item => item.state === 'IN_FLIGHT'), false);
  const runnerAttempt = runnerLedger.listAttempts()[0];
  assert.ok(runnerAttempt);
  assert.equal(runnerAttempt.state, 'COMPLETED');
  assert.equal(runnerAttempt.billingStatus, 'UNBILLED');
  assert.equal(runnerAttempt.unbilledEstimatedCostCny, 1.25);
  assert.equal(runnerAttempt.errorCode, 'unknown');
});
