import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertRuntimeIdentity,
  runtimeIdentityKey,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/contracts.ts';
import { GenerationCancellationRegistry } from '../../../src/lib/algorithm-runtime/cancellation-registry.ts';
import {
  APPROVED_MAX_ATTEMPTS_PER_CASE,
  BudgetController,
  FrozenCostCatalog,
  ModelCallLedger,
} from '../../../src/lib/algorithm-runtime/model-call-ledger.ts';
import { DataLifecycleRegistry } from '../../../src/lib/algorithm-runtime/data-lifecycle.ts';
import { assertRepositoryReadyForPaidExecution } from '../../../src/lib/algorithm-runtime/governance-repository.ts';

const identity = (generationId: number, turnId = `turn-${generationId}`): RuntimeIdentity => ({
  sessionEpoch: 'epoch-2026-10-02-a',
  turnId,
  generationId,
  invocationId: `invocation-${generationId}`,
  evidenceRefs: [`evidence-${generationId}`],
});

const testModules = [
  'asr', 'tts', 'daily_chat', 'formal_interview', 'memory', 'story_draft', 'profile_draft',
] as const;

const frozenCosts = (
  source: 'offline_fixture' | 'provider_price_snapshot' = 'offline_fixture',
  worstCaseCostCny = 0
) => new FrozenCostCatalog('pricing-fixture-v1', [
  ...testModules,
].map(module => ({
  module,
  provider: 'fixture-provider',
  modelOrResource: 'fixture-model',
  priceVersion: 'fixture-price-v1',
  billingUnit: 'request' as const,
  maximumBillableUnits: 1,
  worstCaseCostCny,
  priceSourceHash: 'price-source-fixture-v1',
  inputLimitHash: 'input-limit-fixture-v1',
})), source);

const frozenAttemptPricing = {
  provider: 'fixture-provider',
  modelVersion: 'fixture-model',
  billingUnit: 'request' as const,
  billableUnits: 1,
  inputLimitHash: 'input-limit-fixture-v1',
};

const objectIds = {
  audio: '00000000-0000-4000-8000-000000000001',
  transcript: '00000000-0000-4000-8000-000000000002',
  story: '00000000-0000-4000-8000-000000000003',
  source40d: '00000000-0000-4000-8000-000000000004',
  profile40d: '00000000-0000-4000-8000-000000000005',
};

test('runtime identity preserves session, turn, generation and evidence boundaries', () => {
  const valid = identity(3);
  assert.equal(assertRuntimeIdentity(valid), valid);
  assert.equal(
    runtimeIdentityKey(valid),
    '["epoch-2026-10-02-a","turn-3",3,"invocation-3"]'
  );
  assert.throws(
    () => assertRuntimeIdentity({ ...valid, generationId: -1 }),
    /generationId/
  );
  assert.throws(
    () => assertRuntimeIdentity({ ...valid, evidenceRefs: [''] }),
    /evidenceRefs/
  );
});

test('paid execution rejects an in-memory governance repository', () => {
  assert.throws(
    () => assertRepositoryReadyForPaidExecution({ durability: 'memory' }),
    /durable governance repository/
  );
  assert.doesNotThrow(
    () => assertRepositoryReadyForPaidExecution({ durability: 'durable' })
  );
  assert.throws(() => frozenCosts().assertReadyForPaidExecution(), /provider price snapshot/);
  assert.doesNotThrow(() => frozenCosts('provider_price_snapshot', 0.01).assertReadyForPaidExecution());
});

test('superseded, cancelled and response-mismatched outputs are rejected', () => {
  const registry = new GenerationCancellationRegistry();
  const first = identity(1);
  const firstSignal = registry.begin(first, 'daily_chat');
  const firstBound = registry.bindResponse(first, 'daily_chat', 'response-1');

  assert.equal(firstSignal.aborted, false);
  assert.throws(() => registry.begin(first, 'daily_chat'), /already active/);
  assert.deepEqual(registry.accepts(firstBound, 'daily_chat'), { accepted: true });
  assert.deepEqual(
    registry.accepts({ ...firstBound, evidenceRefs: ['wrong-evidence'] }, 'daily_chat'),
    { accepted: false, reason: 'evidence_mismatch' }
  );
  assert.deepEqual(registry.accepts(first, 'daily_chat'), {
    accepted: false,
    reason: 'response_id_missing',
  });
  assert.deepEqual(
    registry.accepts({ ...firstBound, responseId: 'response-other' }, 'daily_chat'),
    { accepted: false, reason: 'response_id_mismatch' }
  );

  const second = identity(2);
  const secondSignal = registry.begin(second, 'daily_chat');
  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(registry.accepts(firstBound, 'daily_chat'), {
    accepted: false,
    reason: 'generation_mismatch',
  });
  assert.deepEqual(registry.accepts(second, 'daily_chat'), { accepted: true });

  assert.equal(registry.cancel(second, 'daily_chat', 'user_interrupt'), true);
  assert.equal(secondSignal.aborted, true);
  assert.deepEqual(registry.accepts(second, 'daily_chat'), {
    accepted: false,
    reason: 'cancelled',
  });

  const otherSession = { ...identity(3), sessionEpoch: 'epoch-2026-10-02-a:child' };
  const otherSignal = registry.begin(otherSession, 'daily_chat');
  assert.equal(registry.cancelSession('epoch-2026-10-02-a', 'session_end'), 0);
  assert.equal(otherSignal.aborted, false);
  assert.equal(registry.finalize(otherSession, 'daily_chat'), true);
  assert.deepEqual(registry.accepts(otherSession, 'daily_chat'), {
    accepted: false,
    reason: 'finalized',
  });

  const beforeRestart = new GenerationCancellationRegistry();
  const inFlight = identity(9);
  beforeRestart.begin(inFlight, 'tts');
  const afterRestart = GenerationCancellationRegistry.restore(beforeRestart.exportState());
  assert.deepEqual(afterRestart.accepts(inFlight, 'tts'), {
    accepted: false,
    reason: 'finalized',
  });

  const durableTombstones = new GenerationCancellationRegistry();
  const firstOld = { ...identity(1000), invocationId: 'old-invocation-0' };
  for (let index = 0; index < 300; index += 1) {
    const item = {
      ...identity(1000 + index),
      invocationId: `old-invocation-${index}`,
    };
    durableTombstones.begin(item, 'tts');
    durableTombstones.finalize(item, 'tts');
  }
  assert.throws(() => durableTombstones.begin(firstOld, 'tts'), /finalized invocationId/);
});

test('execution leases expose the registry signal and forged identities cannot cancel or finalize', () => {
  const registry = new GenerationCancellationRegistry();
  const base = { ...identity(77), evidenceRefs: ['evidence-77'] };
  const signal = registry.begin(base, 'formal_interview');
  const bound = registry.bindResponse(base, 'formal_interview', 'response-77');
  const lease = registry.acquireLease(bound, 'formal_interview');

  assert.ok(lease);
  assert.equal(lease.signal, signal);
  assert.deepEqual(lease.accepts(), { accepted: true });
  const permit = registry.borrowLease(lease);
  assert.ok(permit);
  assert.equal(permit.signal, signal);
  assert.equal(permit.channel, 'formal_interview');
  assert.equal(permit.cleanupStatus(), 'NOT_REQUIRED');
  assert.equal('cancel' in permit, false);
  assert.equal('finalize' in permit, false);
  assert.equal(registry.isBorrowedPermitCurrent(permit, bound, 'formal_interview'), true);
  assert.equal(registry.isBorrowedPermitCurrent({ ...permit } as any, bound, 'formal_interview'), false);
  assert.equal(registry.acquireLease({ ...bound, evidenceRefs: ['forged'] }, 'formal_interview'), null);
  assert.equal(registry.cancel({ ...bound, evidenceRefs: ['forged'] }, 'formal_interview', 'forged'), false);
  assert.equal(registry.finalize({ ...bound, responseId: 'forged' }, 'formal_interview'), false);
  assert.deepEqual(registry.accepts(bound, 'formal_interview'), { accepted: true });
  assert.equal(lease.finalize(), true);
  assert.equal(signal.aborted, true);
  assert.equal(registry.isBorrowedPermitCurrent(permit, bound, 'formal_interview'), false);
  assert.deepEqual(registry.accepts(bound, 'formal_interview'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('budget exposure includes a 20% buffer and pauses before reaching CNY 45', () => {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });

  assert.deepEqual(budget.reserve('reservation-1', 30), {
    allowed: true,
    reason: 'allowed',
    reservedCny: 36,
    projectedExposureCny: 36,
    remainingHardCapCny: 24,
  });
  assert.deepEqual(budget.assessNextBatch(7.5), {
    allowed: false,
    reason: 'owner_review_required',
    reservedCny: 9,
    projectedExposureCny: 45,
    remainingHardCapCny: 15,
  });
  assert.equal(budget.snapshot().exposureCny, 36);

  assert.throws(() => budget.authorizeReviewedExposure({
    reviewId: 'owner-review-incomplete',
    approvedThroughCny: 60,
    approvedAt: '2026-10-03T00:00:00.000Z',
    approvedBy: 'algorithm-owner',
    reportHash: '',
    manifestHash: 'manifest-sha256-fixture',
  }), /requires approver, report hash and manifest hash/);

  budget.authorizeReviewedExposure({
    reviewId: 'owner-review-001',
    approvedThroughCny: 60,
    approvedAt: '2026-10-03T00:00:00.000Z',
    approvedBy: 'algorithm-owner',
    reportHash: 'review-report-sha256-fixture',
    manifestHash: 'manifest-sha256-fixture',
  });
  assert.equal(budget.assessNextBatch(20).reason, 'allowed');
  assert.equal(budget.assessNextBatch(20.01).reason, 'hard_cap_exceeded');

  const restored = BudgetController.restore({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  }, budget.exportState());
  assert.deepEqual(restored.snapshot(), budget.snapshot());
  assert.throws(
    () => BudgetController.restore({
      hardCapCny: 600,
      reviewAtCny: 45,
      billingUncertaintyBufferRatio: 0.2,
    }, budget.exportState()),
    /budget policy mismatch/
  );

  const hardCapOnly = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 60,
    billingUncertaintyBufferRatio: 0.2,
  });
  assert.equal(hardCapOnly.assessNextBatch(51).reason, 'hard_cap_exceeded');
});

test('late billing updates the attempt and price-catalog overruns stop the run', () => {
  const makeBudget = () => new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const start = (ledger: ModelCallLedger, runId: string) => ledger.startAttempt({
    runId,
    phaseId: 'P1',
    module: 'daily_chat',
    scenarioId: 'S01',
    caseId: `${runId}-daily-chat`,
    attemptIndex: 1,
    ...frozenAttemptPricing,
    configHash: 'config-v1',
    inputHash: 'input-v1',
    startedAt: '2026-10-03T01:00:00.000Z',
  });
  const completeUnbilled = (ledger: ModelCallLedger, attemptId: string) => ledger.completeAttempt({
    attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'PASS',
    qualityStatus: 'PASS',
    completedAt: '2026-10-03T01:00:01.000Z',
  });

  const normalLedger = new ModelCallLedger(makeBudget(), frozenCosts('offline_fixture', 1));
  const normalAttempt = start(normalLedger, 'run-late-billing-normal');
  assert.equal(completeUnbilled(normalLedger, normalAttempt.attemptId).billingStatus, 'UNBILLED');
  const normalSettlement = normalLedger.settleAttemptBilling(
    normalAttempt.attemptId,
    0.8,
    '2026-10-03T01:05:00.000Z'
  );
  assert.equal(normalSettlement.billingStatus, 'SETTLED');
  assert.equal(normalSettlement.settledCostCny, 0.8);
  assert.equal(normalSettlement.unbilledEstimatedCostCny, undefined);
  assert.equal(normalLedger.getStopLatch(), null);

  const lateOverrunLedger = new ModelCallLedger(makeBudget(), frozenCosts('offline_fixture', 1));
  const lateOverrunAttempt = start(lateOverrunLedger, 'run-late-billing-overrun');
  completeUnbilled(lateOverrunLedger, lateOverrunAttempt.attemptId);
  const lateOverrun = lateOverrunLedger.settleAttemptBilling(
    lateOverrunAttempt.attemptId,
    1.21,
    '2026-10-03T01:05:00.000Z'
  );
  assert.equal(lateOverrun.errorCode, 'pricing_catalog_invalid');
  assert.equal(lateOverrun.usableResult, false);
  assert.equal(lateOverrunLedger.getStopLatch()?.code, 'pricing_catalog_invalid');

  const directOverrunLedger = new ModelCallLedger(makeBudget(), frozenCosts('offline_fixture', 1));
  const directOverrunAttempt = start(directOverrunLedger, 'run-direct-billing-overrun');
  const directOverrun = directOverrunLedger.completeAttempt({
    attemptId: directOverrunAttempt.attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'PASS',
    qualityStatus: 'PASS',
    completedAt: '2026-10-03T01:00:01.000Z',
    settledCostCny: 1.21,
  });
  assert.equal(directOverrun.errorCode, 'pricing_catalog_invalid');
  assert.equal(directOverrun.usableResult, false);
  assert.equal(directOverrunLedger.getStopLatch()?.code, 'pricing_catalog_invalid');
});

test('attempts and restored ledgers are bound to the frozen provider, model and input limits', () => {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const catalog = frozenCosts('offline_fixture', 1);
  const ledger = new ModelCallLedger(budget, catalog);
  const baseAttempt = {
    runId: 'run-pricing-binding',
    phaseId: 'P1',
    module: 'asr' as const,
    scenarioId: 'S01',
    caseId: 'S01-asr',
    attemptIndex: 1,
    ...frozenAttemptPricing,
    configHash: 'config-v1',
    inputHash: 'input-v1',
    startedAt: '2026-10-03T02:00:00.000Z',
  };
  assert.throws(
    () => ledger.startAttempt({ ...baseAttempt, provider: 'different-provider' }),
    /frozen pricing and input-limit rule/
  );
  assert.throws(
    () => ledger.startAttempt({ ...baseAttempt, billableUnits: 2 }),
    /frozen pricing and input-limit rule/
  );

  const attempt = ledger.startAttempt(baseAttempt);
  ledger.completeAttempt({
    attemptId: attempt.attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'PASS',
    qualityStatus: 'PASS',
    completedAt: '2026-10-03T02:00:01.000Z',
    settledCostCny: 0.5,
  });
  const restoredBudget = BudgetController.restore({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  }, budget.exportState());
  assert.throws(
    () => ModelCallLedger.restore(
      restoredBudget,
      frozenCosts('offline_fixture', 2),
      ledger.exportState()
    ),
    /pricing catalog mismatch/
  );
  const inconsistentBudgetState = structuredClone(budget.exportState());
  inconsistentBudgetState.settledUnits += 1;
  const inconsistentBudget = BudgetController.restore({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  }, inconsistentBudgetState);
  assert.throws(
    () => ModelCallLedger.restore(
      inconsistentBudget,
      catalog,
      ledger.exportState()
    ),
    /settled budget does not match restored attempts/
  );
});

test('sub-cent costs accumulate without rounding loss and invalid settlement is atomic', () => {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  for (let index = 0; index < 200; index += 1) {
    const reservationId = `micro-${index}`;
    assert.equal(budget.reserve(reservationId, 0.004).allowed, true);
    budget.completeAsSettled(reservationId, 0.004);
  }
  assert.equal(budget.snapshot().settledCny, 0.8);

  budget.reserve('atomic-invalid', 0.1);
  const before = budget.snapshot();
  assert.throws(() => budget.completeAsSettled('atomic-invalid', Number.NaN), /non-negative/);
  assert.deepEqual(budget.snapshot(), before);
});

test('model call ledger retains all four attempts and never retries non-retryable errors', () => {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const ledger = new ModelCallLedger(budget, frozenCosts());
  assert.equal(APPROVED_MAX_ATTEMPTS_PER_CASE, 4);

  for (let attemptIndex = 1; attemptIndex <= 4; attemptIndex += 1) {
    const attempt = ledger.startAttempt({
      runId: 'run-1',
      phaseId: 'P1',
      module: 'asr',
      scenarioId: 'S01',
      caseId: 'S01-asr',
      attemptIndex,
      ...frozenAttemptPricing,
      configHash: 'config-v1',
      inputHash: 'input-v1',
      startedAt: `2026-10-02T00:00:0${attemptIndex}.000Z`,
    });
    const completed = ledger.completeAttempt({
      attemptId: attempt.attemptId,
      providerStatus: 'FAILURE',
      contractStatus: 'NOT_EVALUATED',
      qualityStatus: 'NOT_EVALUATED',
      errorCode: 'provider_503',
      completedAt: `2026-10-02T00:00:1${attemptIndex}.000Z`,
      settledCostCny: 0,
    });
    assert.equal(completed.retryEligible, attemptIndex < 4);
  }

  assert.equal(ledger.listAttempts().length, 4);
  assert.throws(
    () => ledger.startAttempt({
      runId: 'run-1', phaseId: 'P1', module: 'asr', scenarioId: 'S01',
      caseId: 'S01-asr', attemptIndex: 5,
      ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
      startedAt: '2026-10-02T00:01:00.000Z',
    }),
    /maximum attempts/
  );

  const invalid = ledger.startAttempt({
    runId: 'run-1', phaseId: 'P1', module: 'memory', scenarioId: 'S02',
    caseId: 'S02-memory', attemptIndex: 1,
    ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
    startedAt: '2026-10-02T00:02:00.000Z',
  });
  const invalidCompleted = ledger.completeAttempt({
    attemptId: invalid.attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'FAIL',
    qualityStatus: 'NOT_EVALUATED',
    errorCode: 'invalid_schema',
    completedAt: '2026-10-02T00:02:01.000Z',
    settledCostCny: 0,
  });
  assert.equal(invalidCompleted.retryEligible, false);

  const restoredBudget = BudgetController.restore({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  }, budget.exportState());
  const restoredLedger = ModelCallLedger.restore(
    restoredBudget,
    frozenCosts(),
    ledger.exportState()
  );
  assert.equal(restoredLedger.listAttempts().length, 5);
  assert.throws(
    () => restoredLedger.startAttempt({
      runId: 'run-1', phaseId: 'P1', module: 'asr', scenarioId: 'S01',
      caseId: 'S01-asr', attemptIndex: 5,
      ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
      startedAt: '2026-10-02T00:03:00.000Z',
    }),
    /maximum attempts/
  );
});

test('hard invariant failures cannot be counted as usable and latch the run closed', () => {
  const budget = new BudgetController({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  });
  const ledger = new ModelCallLedger(budget, frozenCosts());
  const attempt = ledger.startAttempt({
    runId: 'run-stop', phaseId: 'P1', module: 'memory', scenarioId: 'S06',
    caseId: 'S06-memory', attemptIndex: 1,
    ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
    startedAt: '2026-10-03T00:00:00.000Z',
  });
  const concurrentAttempt = ledger.startAttempt({
    runId: 'run-stop', phaseId: 'P1', module: 'tts', scenarioId: 'S01',
    caseId: 'S01-tts-concurrent', attemptIndex: 1,
    ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
    startedAt: '2026-10-03T00:00:00.500Z',
  });
  const completed = ledger.completeAttempt({
    attemptId: attempt.attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'PASS',
    qualityStatus: 'FAIL',
    errorCode: 'hard_invariant_failure',
    completedAt: '2026-10-03T00:00:01.000Z',
    settledCostCny: 0,
  });
  assert.equal(completed.usableResult, false);
  assert.equal(ledger.getStopLatch()?.code, 'hard_invariant_failure');
  const lateConcurrentResult = ledger.completeAttempt({
    attemptId: concurrentAttempt.attemptId,
    providerStatus: 'SUCCESS',
    contractStatus: 'PASS',
    qualityStatus: 'PASS',
    completedAt: '2026-10-03T00:00:01.500Z',
    settledCostCny: 0,
  });
  assert.equal(lateConcurrentResult.errorCode, 'cancelled');
  assert.equal(lateConcurrentResult.usableResult, false);
  assert.equal(ledger.getStopLatch()?.code, 'hard_invariant_failure');
  const latchMissingState = structuredClone(ledger.exportState());
  delete latchMissingState.stopLatch;
  const restoredBudget = BudgetController.restore({
    hardCapCny: 60,
    reviewAtCny: 45,
    billingUncertaintyBufferRatio: 0.2,
  }, budget.exportState());
  assert.throws(
    () => ModelCallLedger.restore(restoredBudget, frozenCosts(), latchMissingState),
    /hard-stop attempt requires a stop latch/
  );
  assert.throws(
    () => ledger.startAttempt({
      runId: 'run-stop', phaseId: 'P1', module: 'tts', scenarioId: 'S01',
      caseId: 'S01-tts', attemptIndex: 1,
      ...frozenAttemptPricing, configHash: 'config-v1', inputHash: 'input-v1',
      startedAt: '2026-10-03T00:00:02.000Z',
    }),
    /stop latch/
  );
});

test('withdrawal immediately invalidates dependencies and schedules deletion within 24 hours', () => {
  const lifecycle = new DataLifecycleRegistry({
    retentionDays: 40,
    withdrawalDeletionSlaHours: 24,
  });
  lifecycle.registerSource({
    objectId: objectIds.audio,
    kind: 'source_audio',
    capturedAt: '2026-10-02T08:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store', 'object_store'],
  });
  lifecycle.registerDerived({
    objectId: objectIds.transcript,
    kind: 'transcript',
    sourceObjectIds: [objectIds.audio],
    createdAt: '2026-10-03T08:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  lifecycle.registerDerived({
    objectId: objectIds.story,
    kind: 'story_draft',
    sourceObjectIds: [objectIds.transcript],
    createdAt: '2026-10-04T08:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store', 'cache'],
  });

  const source = lifecycle.get(objectIds.audio);
  const story = lifecycle.get(objectIds.story);
  assert.equal(source?.expiresAt, '2026-11-11T08:00:00.000Z');
  assert.equal(story?.expiresAt, source?.expiresAt);

  const affected = lifecycle.withdraw(
    objectIds.audio,
    '2026-10-05T09:30:00.000Z',
    'participant_withdrawal'
  );
  assert.deepEqual(affected.map(item => item.objectId).sort(), Object.values(objectIds).slice(0, 3).sort());
  assert.ok(affected.every(item => item.status === 'INVALIDATED'));
  assert.ok(affected.every(item => item.deletionDueAt === '2026-10-06T09:30:00.000Z'));
  const repeated = lifecycle.withdraw(
    objectIds.audio,
    '2026-10-06T08:00:00.000Z',
    'participant_withdrawal'
  );
  assert.ok(repeated.every(item => item.invalidatedAt === '2026-10-05T09:30:00.000Z'));
  assert.ok(repeated.every(item => item.deletionDueAt === '2026-10-06T09:30:00.000Z'));
  assert.equal(lifecycle.isUsable(objectIds.story, '2026-10-05T09:30:01.000Z'), false);
  assert.deepEqual(lifecycle.listDeletionDue('2026-10-06T09:29:59.000Z'), []);
  assert.equal(lifecycle.listDeletionDue('2026-10-06T09:30:00.000Z').length, 3);

  assert.equal(lifecycle.markDeletionPending(objectIds.story).status, 'DELETION_PENDING');
  assert.throws(
    () => lifecycle.markDeleted(objectIds.story, '2026-10-05T10:00:00.000Z', [
      {
        verificationId: '00000000-0000-4000-8000-000000000101',
        surface: 'runtime_store', status: 'DELETED', completedAt: '2026-10-05T09:59:00.000Z',
      },
    ]),
    /missing deletion receipt/
  );
  const deleted = lifecycle.markDeleted(objectIds.story, '2026-10-05T10:00:00.000Z', [
    {
      verificationId: '00000000-0000-4000-8000-000000000102',
      surface: 'runtime_store', status: 'DELETED', completedAt: '2026-10-05T09:59:00.000Z',
    },
    {
      verificationId: '00000000-0000-4000-8000-000000000103',
      surface: 'cache', status: 'NOT_FOUND', completedAt: '2026-10-05T09:59:30.000Z',
    },
  ]);
  assert.equal(deleted.resultCode, 'DELETED_WITHIN_SLA');
  const audit = lifecycle.getDeletionAudit(objectIds.story);
  assert.ok(audit);
  assert.deepEqual(Object.keys(audit ?? {}).sort(), [
    'completedAt', 'expiresAt', 'objectId', 'requestedAt', 'resultCode', 'scope',
  ]);
  assert.equal(lifecycle.get(objectIds.story), null);
  assert.throws(
    () => lifecycle.registerDerived({
      objectId: '00000000-0000-4000-8000-000000000006',
      kind: 'story_draft',
      sourceObjectIds: [objectIds.audio],
      createdAt: '2026-10-05T11:00:00.000Z',
      requiredDeletionSurfaces: ['runtime_store'],
    }),
    /source is not active/
  );

  const delayedDeadlineState = structuredClone(lifecycle.exportState());
  const delayedSource = delayedDeadlineState.records.find(item => item.objectId === objectIds.audio);
  assert.ok(delayedSource);
  delayedSource.deletionDueAt = '2026-11-01T00:00:00.000Z';
  assert.throws(
    () => DataLifecycleRegistry.restore(
      { retentionDays: 40, withdrawalDeletionSlaHours: 24 },
      delayedDeadlineState
    ),
    /deletion deadline does not match lifecycle policy/
  );

  const restored = DataLifecycleRegistry.restore(
    { retentionDays: 40, withdrawalDeletionSlaHours: 24 },
    lifecycle.exportState()
  );
  assert.equal(restored.listDeletionDue('2026-10-06T09:30:00.000Z').length, 2);
  assert.equal(restored.getDeletionAudit(objectIds.story)?.resultCode, 'DELETED_WITHIN_SLA');
  assert.throws(
    () => DataLifecycleRegistry.restore(
      { retentionDays: 41, withdrawalDeletionSlaHours: 24 },
      lifecycle.exportState()
    ),
    /data lifecycle policy mismatch/
  );
});

test('derived kinds cannot reset retention by registering as a new source', () => {
  const lifecycle = new DataLifecycleRegistry({ retentionDays: 40, withdrawalDeletionSlaHours: 24 });
  assert.throws(
    () => lifecycle.registerSource({
      objectId: '00000000-0000-4000-8000-000000000007',
      kind: 'story_draft' as never,
      capturedAt: '2026-10-03T00:00:00.000Z',
      requiredDeletionSurfaces: ['runtime_store'],
    }),
    /source kind/
  );
  assert.throws(
    () => lifecycle.registerSource({
      objectId: 'contains-readable-user-content',
      kind: 'source_text',
      capturedAt: '2026-10-03T00:00:00.000Z',
      requiredDeletionSurfaces: ['runtime_store'],
    }),
    /opaque UUID/
  );
  lifecycle.registerSource({
    objectId: '00000000-0000-4000-8000-000000000008',
    kind: 'source_text',
    capturedAt: '2026-10-03T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  assert.throws(
    () => lifecycle.registerDerived({
      objectId: '00000000-0000-4000-8000-000000000009',
      kind: 'profile_draft',
      sourceObjectIds: ['00000000-0000-4000-8000-000000000008'],
      createdAt: '2026-10-02T23:59:59.999Z',
      requiredDeletionSurfaces: ['runtime_store'],
    }),
    /source is not active/
  );
  lifecycle.registerDerived({
    objectId: '00000000-0000-4000-8000-000000000009',
    kind: 'profile_draft',
    sourceObjectIds: ['00000000-0000-4000-8000-000000000008'],
    createdAt: '2026-10-04T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  const invalidatedDespiteFutureTimestamp = lifecycle.withdraw(
    '00000000-0000-4000-8000-000000000008',
    '2026-10-03T12:00:00.000Z',
    'participant_withdrawal'
  );
  assert.equal(invalidatedDespiteFutureTimestamp.length, 2);
  assert.ok(invalidatedDespiteFutureTimestamp.every(item => item.status === 'INVALIDATED'));
  const inconsistentState = structuredClone(lifecycle.exportState());
  const inconsistentDerived = inconsistentState.records.find(
    item => item.objectId === '00000000-0000-4000-8000-000000000009'
  );
  assert.ok(inconsistentDerived);
  inconsistentDerived.status = 'ACTIVE';
  delete inconsistentDerived.invalidatedAt;
  delete inconsistentDerived.invalidationReason;
  delete inconsistentDerived.deletionDueAt;
  assert.throws(
    () => DataLifecycleRegistry.restore(
      { retentionDays: 40, withdrawalDeletionSlaHours: 24 },
      inconsistentState
    ),
    /active data depends on an inactive source/
  );
});

test('day-40 sweep makes expired source and derived data unusable and deletion-ready', () => {
  const lifecycle = new DataLifecycleRegistry({ retentionDays: 40, withdrawalDeletionSlaHours: 24 });
  lifecycle.registerSource({
    objectId: objectIds.source40d,
    kind: 'source_text',
    capturedAt: '2026-10-02T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  lifecycle.registerDerived({
    objectId: objectIds.profile40d,
    kind: 'profile_draft',
    sourceObjectIds: [objectIds.source40d],
    createdAt: '2026-10-20T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });

  const extendedExpiryState = structuredClone(lifecycle.exportState());
  const extendedSource = extendedExpiryState.records.find(item => item.objectId === objectIds.source40d);
  assert.ok(extendedSource);
  extendedSource.expiresAt = '2099-01-01T00:00:00.000Z';
  assert.throws(
    () => DataLifecycleRegistry.restore(
      { retentionDays: 40, withdrawalDeletionSlaHours: 24 },
      extendedExpiryState
    ),
    /source expiry does not match retention policy/
  );

  const expired = lifecycle.applyRetentionExpiry('2026-11-13T00:00:00.000Z');
  assert.equal(expired.length, 2);
  assert.ok(expired.every(item => item.status === 'DELETION_PENDING'));
  assert.ok(expired.every(item => item.deletionDueAt === '2026-11-11T00:00:00.000Z'));
  assert.ok(expired.every(item => item.invalidatedAt === '2026-11-11T00:00:00.000Z'));
  assert.equal(lifecycle.isUsable(objectIds.profile40d, '2026-11-11T00:00:00.000Z'), false);
  assert.equal(lifecycle.listOverdueDeletions('2026-11-13T00:00:00.000Z').length, 2);
  lifecycle.markDeletionPending(objectIds.profile40d);
  const lateAudit = lifecycle.markDeleted(objectIds.profile40d, '2026-11-13T00:00:00.000Z', [
    {
      verificationId: '00000000-0000-4000-8000-000000000104',
      surface: 'runtime_store', status: 'DELETED', completedAt: '2026-11-13T00:00:00.000Z',
    },
  ]);
  assert.equal(lateAudit.resultCode, 'DELETED_AFTER_SLA');
});

test('withdrawal deletion never extends data beyond its original day-40 expiry', () => {
  const lifecycle = new DataLifecycleRegistry({ retentionDays: 40, withdrawalDeletionSlaHours: 24 });
  const objectId = '00000000-0000-4000-8000-000000000010';
  lifecycle.registerSource({
    objectId,
    kind: 'source_text',
    capturedAt: '2026-10-02T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  const [withdrawn] = lifecycle.withdraw(
    objectId,
    '2026-11-10T12:00:00.000Z',
    'participant_withdrawal'
  );
  assert.equal(withdrawn.expiresAt, '2026-11-11T00:00:00.000Z');
  assert.equal(withdrawn.deletionDueAt, '2026-11-11T00:00:00.000Z');
});

test('deleting a source before an invalidated derivative remains restorable', () => {
  const lifecycle = new DataLifecycleRegistry({ retentionDays: 40, withdrawalDeletionSlaHours: 24 });
  const sourceId = '00000000-0000-4000-8000-000000000011';
  const derivedId = '00000000-0000-4000-8000-000000000012';
  lifecycle.registerSource({
    objectId: sourceId,
    kind: 'source_text',
    capturedAt: '2026-10-01T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  lifecycle.registerDerived({
    objectId: derivedId,
    kind: 'memory_candidate',
    sourceObjectIds: [sourceId],
    createdAt: '2026-10-02T00:00:00.000Z',
    requiredDeletionSurfaces: ['runtime_store'],
  });
  lifecycle.withdraw(sourceId, '2026-10-03T00:00:00.000Z', 'participant_withdrawal');
  lifecycle.markDeleted(sourceId, '2026-10-03T01:00:00.000Z', [{
    verificationId: '00000000-0000-4000-8000-000000000105',
    surface: 'runtime_store',
    status: 'DELETED',
    completedAt: '2026-10-03T01:00:00.000Z',
  }]);

  const restored = DataLifecycleRegistry.restore(
    { retentionDays: 40, withdrawalDeletionSlaHours: 24 },
    lifecycle.exportState()
  );
  assert.equal(restored.get(sourceId), null);
  assert.equal(restored.getDeletionAudit(sourceId)?.resultCode, 'DELETED_WITHIN_SLA');
  assert.equal(restored.get(derivedId)?.status, 'INVALIDATED');
  assert.equal(restored.listDeletionDue('2026-10-04T00:00:00.000Z').length, 1);
});
