import type {
  AlgorithmModule,
  NormalizedErrorCode,
  ProviderUsage,
} from './contracts';

const MONEY_SCALE = 1_000_000;
const MODULES: AlgorithmModule[] = [
  'asr',
  'tts',
  'daily_chat',
  'formal_interview',
  'memory',
  'story_draft',
  'profile_draft',
];

export const APPROVED_MAX_ATTEMPTS_PER_CASE = 4;

export interface BudgetPolicy {
  hardCapCny: number;
  reviewAtCny: number;
  billingUncertaintyBufferRatio: number;
}

export type BudgetDecisionReason = 'allowed' | 'owner_review_required' | 'hard_cap_exceeded';

export interface BudgetDecision {
  allowed: boolean;
  reason: BudgetDecisionReason;
  reservedCny: number;
  projectedExposureCny: number;
  remainingHardCapCny: number;
}

export interface BudgetSnapshot {
  settledCny: number;
  completedUnbilledEstimateCny: number;
  inFlightReservationCny: number;
  approvedNextBatchReservationCny: number;
  exposureCny: number;
  remainingHardCapCny: number;
  reviewAtCny: number;
  approvedThroughCny?: number;
  hardCapBreached: boolean;
}

export interface BudgetReviewAuthorization {
  reviewId: string;
  approvedThroughCny: number;
  approvedAt: string;
  approvedBy: string;
  reportHash: string;
  manifestHash: string;
}

type ReservationBucket = 'in_flight' | 'approved_next_batch';

interface Reservation {
  amountUnits: number;
  bucket: ReservationBucket;
}

export interface BudgetControllerState {
  schemaVersion: 'budget-controller-v0.1';
  policyFingerprint: string;
  settledUnits: number;
  completedUnbilled: Array<[string, number]>;
  reservations: Array<[string, Reservation]>;
  reviews: BudgetReviewAuthorization[];
  approvedThroughUnits?: number;
}

function assertMoney(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function cnyToUnits(value: number): number {
  assertMoney(value, 'CNY amount');
  return Math.round(value * MONEY_SCALE);
}

function unitsToCny(value: number): number {
  return Number((value / MONEY_SCALE).toFixed(6));
}

function bufferedUnits(value: number, ratio: number): number {
  assertMoney(value, 'estimated cost');
  return Math.ceil(value * MONEY_SCALE * (1 + ratio) - Number.EPSILON);
}

function assertIsoTimestamp(value: string, field: string): void {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${field} must be an ISO 8601 UTC timestamp with milliseconds`);
  }
}

function budgetPolicyFingerprint(policy: BudgetPolicy): string {
  return JSON.stringify({
    hardCapCny: policy.hardCapCny,
    reviewAtCny: policy.reviewAtCny,
    billingUncertaintyBufferRatio: policy.billingUncertaintyBufferRatio,
  });
}

export class BudgetController {
  private readonly hardCapUnits: number;
  private readonly reviewAtUnits: number;
  private readonly bufferRatio: number;
  private readonly policyFingerprint: string;
  private settledUnits = 0;
  private approvedThroughUnits?: number;
  private readonly completedUnbilled = new Map<string, number>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly reviews: BudgetReviewAuthorization[] = [];

  constructor(policy: BudgetPolicy) {
    assertMoney(policy.hardCapCny, 'hardCapCny');
    assertMoney(policy.reviewAtCny, 'reviewAtCny');
    if (policy.hardCapCny <= 0) throw new Error('hardCapCny must be greater than zero');
    if (policy.reviewAtCny <= 0 || policy.reviewAtCny > policy.hardCapCny) {
      throw new Error('reviewAtCny must be greater than zero and no more than hardCapCny');
    }
    if (
      !Number.isFinite(policy.billingUncertaintyBufferRatio)
      || policy.billingUncertaintyBufferRatio < 0
    ) {
      throw new Error('billingUncertaintyBufferRatio must be non-negative');
    }
    this.hardCapUnits = cnyToUnits(policy.hardCapCny);
    this.reviewAtUnits = cnyToUnits(policy.reviewAtCny);
    this.bufferRatio = policy.billingUncertaintyBufferRatio;
    this.policyFingerprint = budgetPolicyFingerprint(policy);
  }

  static restore(policy: BudgetPolicy, state: BudgetControllerState): BudgetController {
    if (state.schemaVersion !== 'budget-controller-v0.1') {
      throw new Error('unsupported budget controller state');
    }
    if (state.policyFingerprint !== budgetPolicyFingerprint(policy)) {
      throw new Error('budget policy mismatch while restoring state');
    }
    const controller = new BudgetController(policy);
    if (!Number.isInteger(state.settledUnits) || state.settledUnits < 0) {
      throw new Error('invalid settled budget state');
    }
    controller.settledUnits = state.settledUnits;
    for (const [key, value] of state.completedUnbilled) {
      if (!Number.isInteger(value) || value < 0) throw new Error('invalid unbilled state');
      if (controller.completedUnbilled.has(key)) throw new Error('duplicate unbilled state key');
      controller.completedUnbilled.set(key, value);
    }
    for (const [key, reservation] of state.reservations) {
      if (!Number.isInteger(reservation.amountUnits) || reservation.amountUnits < 0) {
        throw new Error('invalid reservation state');
      }
      if (reservation.bucket !== 'in_flight' && reservation.bucket !== 'approved_next_batch') {
        throw new Error('invalid reservation bucket');
      }
      if (controller.reservations.has(key) || controller.completedUnbilled.has(key)) {
        throw new Error('duplicate budget state key');
      }
      controller.reservations.set(key, { ...reservation });
    }
    let previousApprovedThroughUnits = controller.reviewAtUnits;
    const reviewIds = new Set<string>();
    for (const review of state.reviews) {
      if (
        review.reviewId.trim().length === 0
        || review.approvedBy.trim().length === 0
        || review.reportHash.trim().length === 0
        || review.manifestHash.trim().length === 0
      ) {
        throw new Error('invalid restored budget review');
      }
      if (reviewIds.has(review.reviewId)) throw new Error('duplicate restored budget review');
      assertIsoTimestamp(review.approvedAt, 'approvedAt');
      const approvedUnits = cnyToUnits(review.approvedThroughCny);
      if (approvedUnits <= previousApprovedThroughUnits || approvedUnits > controller.hardCapUnits) {
        throw new Error('invalid restored approved exposure');
      }
      reviewIds.add(review.reviewId);
      previousApprovedThroughUnits = approvedUnits;
      controller.reviews.push({ ...review });
    }
    if (state.approvedThroughUnits !== undefined) {
      if (!Number.isInteger(state.approvedThroughUnits)) {
        throw new Error('invalid restored approved-through state');
      }
      if (state.reviews.length === 0 || state.approvedThroughUnits !== previousApprovedThroughUnits) {
        throw new Error('approved-through state does not match budget reviews');
      }
      controller.approvedThroughUnits = state.approvedThroughUnits;
    } else if (state.reviews.length > 0) {
      throw new Error('restored budget reviews require approved-through state');
    }
    return controller;
  }

  exportState(): BudgetControllerState {
    return {
      schemaVersion: 'budget-controller-v0.1',
      policyFingerprint: this.policyFingerprint,
      settledUnits: this.settledUnits,
      completedUnbilled: Array.from(this.completedUnbilled.entries()),
      reservations: Array.from(
        this.reservations.entries(),
        ([key, reservation]) => [key, { ...reservation }]
      ),
      reviews: this.reviews.map(review => ({ ...review })),
      ...(this.approvedThroughUnits === undefined
        ? {}
        : { approvedThroughUnits: this.approvedThroughUnits }),
    };
  }

  authorizeReviewedExposure(review: BudgetReviewAuthorization): BudgetSnapshot {
    if (review.reviewId.trim().length === 0) throw new Error('reviewId is required');
    if (
      review.approvedBy.trim().length === 0
      || review.reportHash.trim().length === 0
      || review.manifestHash.trim().length === 0
    ) {
      throw new Error('budget review requires approver, report hash and manifest hash');
    }
    if (this.reviews.some(item => item.reviewId === review.reviewId)) {
      throw new Error(`duplicate reviewId: ${review.reviewId}`);
    }
    assertIsoTimestamp(review.approvedAt, 'approvedAt');
    const approvedUnits = cnyToUnits(review.approvedThroughCny);
    const currentFloor = this.approvedThroughUnits ?? this.reviewAtUnits;
    if (approvedUnits <= currentFloor || approvedUnits > this.hardCapUnits) {
      throw new Error('approvedThroughCny must advance the review gate without exceeding hard cap');
    }
    this.approvedThroughUnits = approvedUnits;
    this.reviews.push({ ...review });
    return this.snapshot();
  }

  assessNextBatch(estimatedCostCny: number): BudgetDecision {
    return this.assessReservation(bufferedUnits(estimatedCostCny, this.bufferRatio));
  }

  reserve(
    reservationId: string,
    estimatedCostCny: number,
    bucket: ReservationBucket = 'in_flight'
  ): BudgetDecision {
    if (reservationId.trim().length === 0) throw new Error('reservationId is required');
    if (this.reservations.has(reservationId) || this.completedUnbilled.has(reservationId)) {
      throw new Error(`duplicate reservationId: ${reservationId}`);
    }
    const reservationUnits = bufferedUnits(estimatedCostCny, this.bufferRatio);
    const decision = this.assessReservation(reservationUnits);
    if (decision.allowed) {
      this.reservations.set(reservationId, { amountUnits: reservationUnits, bucket });
    }
    return decision;
  }

  completeAsSettled(reservationId: string, settledCostCny: number): BudgetSnapshot {
    const settledCostUnits = cnyToUnits(settledCostCny);
    this.requireReservation(reservationId);
    this.reservations.delete(reservationId);
    this.settledUnits += settledCostUnits;
    return this.snapshot();
  }

  completeAsUnbilled(reservationId: string, estimatedCostCny?: number): BudgetSnapshot {
    const reservation = this.requireReservation(reservationId);
    const estimatedUnits = estimatedCostCny === undefined
      ? reservation.amountUnits
      : Math.max(reservation.amountUnits, bufferedUnits(estimatedCostCny, this.bufferRatio));
    this.reservations.delete(reservationId);
    this.completedUnbilled.set(reservationId, estimatedUnits);
    return this.snapshot();
  }

  completeAsUnbilledWorstCase(
    reservationId: string,
    worstCaseCostCny: number,
  ): BudgetSnapshot {
    const worstCaseUnits = cnyToUnits(worstCaseCostCny);
    const reservation = this.requireReservation(reservationId);
    if (reservation.bucket !== 'in_flight') {
      throw new Error('worst-case unbilled exposure requires an in-flight reservation');
    }
    if (worstCaseUnits > reservation.amountUnits) {
      throw new Error('worst-case unbilled exposure cannot exceed its reservation');
    }
    this.reservations.delete(reservationId);
    this.completedUnbilled.set(reservationId, worstCaseUnits);
    return this.snapshot();
  }

  settleCompletedUnbilled(reservationId: string, settledCostCny: number): BudgetSnapshot {
    const settledCostUnits = cnyToUnits(settledCostCny);
    if (!this.completedUnbilled.has(reservationId)) {
      throw new Error(`unbilled reservation not found: ${reservationId}`);
    }
    this.completedUnbilled.delete(reservationId);
    this.settledUnits += settledCostUnits;
    return this.snapshot();
  }

  release(reservationId: string): BudgetSnapshot {
    if (!this.reservations.delete(reservationId)) {
      throw new Error(`reservation not found: ${reservationId}`);
    }
    return this.snapshot();
  }

  snapshot(): BudgetSnapshot {
    const completedUnbilledUnits = this.sum(this.completedUnbilled.values());
    let inFlightUnits = 0;
    let approvedNextBatchUnits = 0;
    for (const reservation of this.reservations.values()) {
      if (reservation.bucket === 'in_flight') inFlightUnits += reservation.amountUnits;
      else approvedNextBatchUnits += reservation.amountUnits;
    }
    const exposureUnits = this.settledUnits
      + completedUnbilledUnits
      + inFlightUnits
      + approvedNextBatchUnits;
    return {
      settledCny: unitsToCny(this.settledUnits),
      completedUnbilledEstimateCny: unitsToCny(completedUnbilledUnits),
      inFlightReservationCny: unitsToCny(inFlightUnits),
      approvedNextBatchReservationCny: unitsToCny(approvedNextBatchUnits),
      exposureCny: unitsToCny(exposureUnits),
      remainingHardCapCny: unitsToCny(Math.max(0, this.hardCapUnits - exposureUnits)),
      reviewAtCny: unitsToCny(this.reviewAtUnits),
      ...(this.approvedThroughUnits === undefined
        ? {}
        : { approvedThroughCny: unitsToCny(this.approvedThroughUnits) }),
      hardCapBreached: exposureUnits > this.hardCapUnits,
    };
  }

  private assessReservation(reservationUnits: number): BudgetDecision {
    const currentExposureUnits = cnyToUnits(this.snapshot().exposureCny);
    const projectedUnits = currentExposureUnits + reservationUnits;
    const reviewBlocked = this.approvedThroughUnits === undefined
      ? projectedUnits >= this.reviewAtUnits
      : projectedUnits > this.approvedThroughUnits;
    const reason: BudgetDecisionReason = projectedUnits > this.hardCapUnits
      ? 'hard_cap_exceeded'
      : reviewBlocked
        ? 'owner_review_required'
        : 'allowed';
    return {
      allowed: reason === 'allowed',
      reason,
      reservedCny: unitsToCny(reservationUnits),
      projectedExposureCny: unitsToCny(projectedUnits),
      remainingHardCapCny: unitsToCny(Math.max(0, this.hardCapUnits - projectedUnits)),
    };
  }

  private requireReservation(reservationId: string): Reservation {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) throw new Error(`reservation not found: ${reservationId}`);
    return reservation;
  }

  private sum(values: Iterable<number>): number {
    let total = 0;
    for (const value of values) total += value;
    return total;
  }
}

export interface FrozenModuleCostRule {
  module: AlgorithmModule;
  provider: string;
  modelOrResource: string;
  priceVersion: string;
  billingUnit: 'audio_second' | 'character' | 'token' | 'request';
  maximumBillableUnits: number;
  worstCaseCostCny: number;
  priceSourceHash: string;
  inputLimitHash: string;
}

export type CostCatalogSource = 'offline_fixture' | 'provider_price_snapshot';

export class FrozenCostCatalog {
  private readonly rules = new Map<AlgorithmModule, FrozenModuleCostRule>();
  readonly snapshotId: string;
  readonly source: CostCatalogSource;
  readonly fingerprint: string;

  constructor(
    snapshotId: string,
    rules: readonly FrozenModuleCostRule[],
    source: CostCatalogSource
  ) {
    if (snapshotId.trim().length === 0) throw new Error('pricing snapshotId is required');
    this.snapshotId = snapshotId;
    this.source = source;
    for (const rule of rules) {
      if (this.rules.has(rule.module)) throw new Error(`duplicate pricing rule: ${rule.module}`);
      assertMoney(rule.worstCaseCostCny, `${rule.module} worstCaseCostCny`);
      if (
        rule.provider.trim().length === 0
        || rule.modelOrResource.trim().length === 0
        || rule.priceVersion.trim().length === 0
        || !Number.isFinite(rule.maximumBillableUnits)
        || rule.maximumBillableUnits <= 0
      ) {
        throw new Error(`${rule.module} pricing rule requires provider, model, version and limits`);
      }
      if (rule.priceSourceHash.trim().length === 0 || rule.inputLimitHash.trim().length === 0) {
        throw new Error(`${rule.module} pricing rule requires source and input-limit hashes`);
      }
      this.rules.set(rule.module, { ...rule });
    }
    for (const moduleName of MODULES) {
      if (!this.rules.has(moduleName)) throw new Error(`missing pricing rule: ${moduleName}`);
    }
    this.fingerprint = JSON.stringify({
      snapshotId: this.snapshotId,
      source: this.source,
      rules: MODULES.map(module => this.rules.get(module)),
    });
  }

  estimateWorstCase(module: AlgorithmModule): FrozenModuleCostRule {
    const rule = this.rules.get(module);
    if (!rule) throw new Error(`missing pricing rule: ${module}`);
    return { ...rule };
  }

  assertReadyForPaidExecution(): void {
    if (this.source !== 'provider_price_snapshot') {
      throw new Error('paid execution requires a provider price snapshot');
    }
    for (const moduleName of MODULES) {
      if ((this.rules.get(moduleName)?.worstCaseCostCny ?? 0) <= 0) {
        throw new Error(`paid execution requires a positive worst-case cost for ${moduleName}`);
      }
    }
  }
}

export type ProviderStatus = 'SUCCESS' | 'FAILURE';
export type EvaluationStatus = 'PASS' | 'FAIL' | 'NOT_EVALUATED';
export type BillingStatus = 'RESERVED' | 'SETTLED' | 'UNBILLED';

export interface StartAttemptInput {
  runId: string;
  phaseId: string;
  module: AlgorithmModule;
  scenarioId: string;
  caseId: string;
  attemptIndex: number;
  provider: string;
  modelVersion: string;
  billingUnit: FrozenModuleCostRule['billingUnit'];
  billableUnits: number;
  inputLimitHash: string;
  configHash: string;
  inputHash: string;
  startedAt: string;
}

export interface CompleteAttemptInput {
  attemptId: string;
  providerStatus: ProviderStatus;
  contractStatus: EvaluationStatus;
  qualityStatus: EvaluationStatus;
  errorCode?: NormalizedErrorCode;
  completedAt: string;
  settledCostCny?: number;
  usage?: ProviderUsage;
}

export interface FailInFlightAttemptInput {
  attemptId: string;
  errorCode: NormalizedErrorCode;
  completedAt: string;
}

export interface ModelCallAttempt extends StartAttemptInput {
  attemptId: string;
  state: 'IN_FLIGHT' | 'COMPLETED';
  pricingSnapshotId: string;
  pricingCatalogFingerprint: string;
  reservedCostCny: number;
  billingStatus: BillingStatus;
  settledCostCny?: number;
  billingSettledAt?: string;
  unbilledEstimatedCostCny?: number;
  providerStatus?: ProviderStatus;
  contractStatus?: EvaluationStatus;
  qualityStatus?: EvaluationStatus;
  errorCode?: NormalizedErrorCode;
  completedAt?: string;
  usage?: ProviderUsage;
  usableResult?: boolean;
  retryEligible?: boolean;
}

export interface RuntimeStopLatch {
  code: NormalizedErrorCode;
  attemptId: string;
  triggeredAt: string;
}

export interface ModelCallLedgerState {
  schemaVersion: 'model-call-ledger-v0.1';
  pricingSnapshotId: string;
  pricingCatalogFingerprint: string;
  attempts: ModelCallAttempt[];
  stopLatch?: RuntimeStopLatch;
}

const RETRYABLE_ERRORS = new Set<NormalizedErrorCode>([
  'network_transient',
  'provider_429',
  'provider_5xx',
  'provider_503',
  'incomplete_stream',
  'retryable_timeout',
]);

const HARD_STOP_ERRORS = new Set<NormalizedErrorCode>([
  'auth_401_403',
  'quota_402',
  'authorization_withdrawn',
  'hard_invariant_failure',
  'budget_hard_cap_exceeded',
  'pricing_catalog_invalid',
]);

const NON_USABLE_ERRORS = new Set<NormalizedErrorCode>([
  ...HARD_STOP_ERRORS,
  'network_transient',
  'provider_429',
  'provider_5xx',
  'provider_503',
  'incomplete_stream',
  'retryable_timeout',
  'invalid_config',
  'invalid_schema',
  'safety_refusal',
  'cancelled',
  'unknown',
]);

function cloneAttempt(attempt: ModelCallAttempt): ModelCallAttempt {
  return {
    ...attempt,
    ...(attempt.usage ? { usage: { ...attempt.usage } } : {}),
  };
}

export class ModelCallLedger {
  private readonly attempts = new Map<string, ModelCallAttempt>();
  private readonly budget: BudgetController;
  private readonly costs: FrozenCostCatalog;
  private stopLatch?: RuntimeStopLatch;

  constructor(
    budget: BudgetController,
    costs: FrozenCostCatalog
  ) {
    this.budget = budget;
    this.costs = costs;
  }

  static restore(
    budget: BudgetController,
    costs: FrozenCostCatalog,
    state: ModelCallLedgerState
  ): ModelCallLedger {
    if (state.schemaVersion !== 'model-call-ledger-v0.1') {
      throw new Error('unsupported model call ledger state');
    }
    if (state.pricingSnapshotId !== costs.snapshotId) {
      throw new Error('pricing snapshot mismatch while restoring ledger');
    }
    if (state.pricingCatalogFingerprint !== costs.fingerprint) {
      throw new Error('pricing catalog mismatch while restoring ledger');
    }
    const ledger = new ModelCallLedger(budget, costs);
    const budgetState = budget.exportState();
    const reservations = new Map(budgetState.reservations);
    const completedUnbilled = new Map(budgetState.completedUnbilled);
    let restoredSettledUnits = 0;
    for (const attempt of state.attempts) {
      if (ledger.attempts.has(attempt.attemptId)) throw new Error('duplicate restored attemptId');
      if (
        attempt.pricingSnapshotId !== costs.snapshotId
        || attempt.pricingCatalogFingerprint !== costs.fingerprint
      ) {
        throw new Error('restored attempt pricing does not match the frozen catalog');
      }
      assertIsoTimestamp(attempt.startedAt, 'startedAt');
      if (
        !Number.isInteger(attempt.attemptIndex)
        || attempt.attemptIndex < 1
        || attempt.attemptIndex > APPROVED_MAX_ATTEMPTS_PER_CASE
      ) {
        throw new Error('invalid restored attempt index');
      }
      const expectedAttemptId = JSON.stringify([
        attempt.runId,
        attempt.phaseId,
        attempt.module,
        attempt.scenarioId,
        attempt.caseId,
        attempt.attemptIndex,
      ]);
      if (attempt.attemptId !== expectedAttemptId) {
        throw new Error('restored attemptId does not match attempt identity');
      }
      const expectedRule = costs.estimateWorstCase(attempt.module);
      if (
        attempt.provider !== expectedRule.provider
        || attempt.modelVersion !== expectedRule.modelOrResource
        || attempt.billingUnit !== expectedRule.billingUnit
        || attempt.inputLimitHash !== expectedRule.inputLimitHash
        || !Number.isFinite(attempt.billableUnits)
        || attempt.billableUnits <= 0
        || attempt.billableUnits > expectedRule.maximumBillableUnits
      ) {
        throw new Error('restored attempt does not match the frozen pricing rule');
      }
      const reservation = reservations.get(attempt.attemptId);
      const unbilledUnits = completedUnbilled.get(attempt.attemptId);
      if (attempt.state === 'IN_FLIGHT') {
        if (
          attempt.billingStatus !== 'RESERVED'
          || !reservation
          || reservation.bucket !== 'in_flight'
          || reservation.amountUnits !== cnyToUnits(attempt.reservedCostCny)
          || unbilledUnits !== undefined
        ) {
          throw new Error('restored in-flight attempt does not match budget reservation state');
        }
      } else if (attempt.state === 'COMPLETED') {
        if (
          !attempt.completedAt
          || attempt.providerStatus === undefined
          || attempt.contractStatus === undefined
          || attempt.qualityStatus === undefined
          || attempt.usableResult === undefined
          || attempt.retryEligible === undefined
        ) {
          throw new Error('restored completed attempt is missing result metadata');
        }
        assertIsoTimestamp(attempt.completedAt, 'completedAt');
        if (Date.parse(attempt.completedAt) < Date.parse(attempt.startedAt)) {
          throw new Error('restored attempt completed before it started');
        }
        if (attempt.billingStatus === 'UNBILLED') {
          if (
            reservation
            || unbilledUnits === undefined
            || attempt.unbilledEstimatedCostCny === undefined
            || unbilledUnits !== cnyToUnits(attempt.unbilledEstimatedCostCny)
          ) {
            throw new Error('restored unbilled attempt does not match budget state');
          }
        } else if (attempt.billingStatus === 'SETTLED') {
          if (
            reservation
            || unbilledUnits !== undefined
            || attempt.settledCostCny === undefined
            || !attempt.billingSettledAt
          ) {
            throw new Error('restored settled attempt has invalid billing state');
          }
          assertIsoTimestamp(attempt.billingSettledAt, 'billingSettledAt');
          restoredSettledUnits += cnyToUnits(attempt.settledCostCny);
        } else {
          throw new Error('restored completed attempt cannot remain reserved');
        }
      } else {
        throw new Error('invalid restored attempt state');
      }
      ledger.attempts.set(attempt.attemptId, cloneAttempt(attempt));
    }
    for (const [reservationId, reservation] of reservations) {
      if (reservation.bucket === 'in_flight' && !ledger.attempts.has(reservationId)) {
        throw new Error('budget contains an orphan in-flight reservation');
      }
    }
    for (const unbilledId of completedUnbilled.keys()) {
      if (!ledger.attempts.has(unbilledId)) {
        throw new Error('budget contains an orphan unbilled estimate');
      }
    }
    if (restoredSettledUnits !== budgetState.settledUnits) {
      throw new Error('settled budget does not match restored attempts');
    }
    const restoredHardStopAttempts = ledger.listAttempts().filter(
      attempt => attempt.errorCode !== undefined && HARD_STOP_ERRORS.has(attempt.errorCode)
    );
    if (restoredHardStopAttempts.length > 0 && !state.stopLatch) {
      throw new Error('restored hard-stop attempt requires a stop latch');
    }
    if (state.stopLatch) {
      assertIsoTimestamp(state.stopLatch.triggeredAt, 'stop latch triggeredAt');
      const stoppedAttempt = ledger.attempts.get(state.stopLatch.attemptId);
      if (
        !HARD_STOP_ERRORS.has(state.stopLatch.code)
        || !stoppedAttempt
        || stoppedAttempt.state !== 'COMPLETED'
        || stoppedAttempt.errorCode !== state.stopLatch.code
      ) {
        throw new Error('restored stop latch does not match its attempt');
      }
    }
    ledger.stopLatch = state.stopLatch ? { ...state.stopLatch } : undefined;
    return ledger;
  }

  exportState(): ModelCallLedgerState {
    return {
      schemaVersion: 'model-call-ledger-v0.1',
      pricingSnapshotId: this.costs.snapshotId,
      pricingCatalogFingerprint: this.costs.fingerprint,
      attempts: this.listAttempts(),
      ...(this.stopLatch ? { stopLatch: { ...this.stopLatch } } : {}),
    };
  }

  getStopLatch(): RuntimeStopLatch | null {
    return this.stopLatch ? { ...this.stopLatch } : null;
  }

  startAttempt(input: StartAttemptInput): ModelCallAttempt {
    if (this.stopLatch) throw new Error(`runtime stop latch is active: ${this.stopLatch.code}`);
    assertIsoTimestamp(input.startedAt, 'startedAt');
    if (
      input.provider.trim().length === 0
      || input.modelVersion.trim().length === 0
      || input.inputLimitHash.trim().length === 0
      || !Number.isFinite(input.billableUnits)
      || input.billableUnits <= 0
    ) {
      throw new Error('attempt requires provider, model, input-limit hash and positive billable units');
    }
    if (
      !Number.isInteger(input.attemptIndex)
      || input.attemptIndex < 1
      || input.attemptIndex > APPROVED_MAX_ATTEMPTS_PER_CASE
    ) {
      throw new Error(`maximum attempts per case is ${APPROVED_MAX_ATTEMPTS_PER_CASE}`);
    }
    const caseAttempts = this.listAttempts().filter(item => this.sameCase(item, input));
    if (input.attemptIndex !== caseAttempts.length + 1) {
      throw new Error('attemptIndex must be consecutive and start at one');
    }
    if (caseAttempts.length > 0) {
      const first = caseAttempts[0];
      const previous = caseAttempts[caseAttempts.length - 1];
      if (!previous.retryEligible) throw new Error('previous attempt is not retry-eligible');
      if (
        first.provider !== input.provider
        || first.modelVersion !== input.modelVersion
        || first.billingUnit !== input.billingUnit
        || first.billableUnits !== input.billableUnits
        || first.inputLimitHash !== input.inputLimitHash
        || first.configHash !== input.configHash
        || first.inputHash !== input.inputHash
      ) {
        throw new Error('retries must keep provider, model, pricing inputs, config and input fixed');
      }
    }

    const attemptId = JSON.stringify([
      input.runId,
      input.phaseId,
      input.module,
      input.scenarioId,
      input.caseId,
      input.attemptIndex,
    ]);
    if (this.attempts.has(attemptId)) throw new Error(`duplicate attemptId: ${attemptId}`);
    const estimate = this.costs.estimateWorstCase(input.module);
    if (
      input.provider !== estimate.provider
      || input.modelVersion !== estimate.modelOrResource
      || input.billingUnit !== estimate.billingUnit
      || input.inputLimitHash !== estimate.inputLimitHash
      || input.billableUnits > estimate.maximumBillableUnits
    ) {
      throw new Error('attempt does not match the frozen pricing and input-limit rule');
    }
    const budgetDecision = this.budget.reserve(attemptId, estimate.worstCaseCostCny);
    if (!budgetDecision.allowed) {
      throw new Error(`budget gate blocked attempt: ${budgetDecision.reason}`);
    }

    const attempt: ModelCallAttempt = {
      ...input,
      attemptId,
      state: 'IN_FLIGHT',
      pricingSnapshotId: this.costs.snapshotId,
      pricingCatalogFingerprint: this.costs.fingerprint,
      reservedCostCny: budgetDecision.reservedCny,
      billingStatus: 'RESERVED',
    };
    this.attempts.set(attemptId, attempt);
    return cloneAttempt(attempt);
  }

  completeAttempt(input: CompleteAttemptInput): ModelCallAttempt {
    assertIsoTimestamp(input.completedAt, 'completedAt');
    if (input.settledCostCny !== undefined) assertMoney(input.settledCostCny, 'settledCostCny');
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new Error(`attempt not found: ${input.attemptId}`);
    if (attempt.state !== 'IN_FLIGHT') throw new Error('attempt is already completed');
    if (Date.parse(input.completedAt) < Date.parse(attempt.startedAt)) {
      throw new Error('completedAt cannot be earlier than startedAt');
    }
    const preexistingStopLatch = this.stopLatch;

    const hasNonUsableError = input.errorCode !== undefined && NON_USABLE_ERRORS.has(input.errorCode);
    const usableResult = input.providerStatus === 'SUCCESS'
      && input.contractStatus === 'PASS'
      && !hasNonUsableError;
    const retryEligible = !usableResult
      && input.errorCode !== undefined
      && RETRYABLE_ERRORS.has(input.errorCode)
      && attempt.attemptIndex < APPROVED_MAX_ATTEMPTS_PER_CASE;
    const budgetSnapshot = input.settledCostCny === undefined
      ? this.budget.completeAsUnbilled(input.attemptId)
      : this.budget.completeAsSettled(input.attemptId, input.settledCostCny);
    const finalErrorCode: NormalizedErrorCode | undefined = budgetSnapshot.hardCapBreached
      ? 'budget_hard_cap_exceeded'
      : input.settledCostCny !== undefined && input.settledCostCny > attempt.reservedCostCny
        ? 'pricing_catalog_invalid'
        : input.errorCode ?? (preexistingStopLatch ? 'cancelled' : undefined);
    const hardStopTriggered = preexistingStopLatch !== undefined
      || (finalErrorCode !== undefined && HARD_STOP_ERRORS.has(finalErrorCode));
    const completed: ModelCallAttempt = {
      ...attempt,
      state: 'COMPLETED',
      billingStatus: input.settledCostCny === undefined ? 'UNBILLED' : 'SETTLED',
      ...(input.settledCostCny === undefined
        ? { unbilledEstimatedCostCny: attempt.reservedCostCny }
        : { settledCostCny: input.settledCostCny, billingSettledAt: input.completedAt }),
      providerStatus: input.providerStatus,
      contractStatus: input.contractStatus,
      qualityStatus: input.qualityStatus,
      ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
      completedAt: input.completedAt,
      ...(input.usage ? { usage: { ...input.usage } } : {}),
      usableResult: hardStopTriggered ? false : usableResult,
      retryEligible: hardStopTriggered ? false : retryEligible,
    };
    this.attempts.set(input.attemptId, completed);
    if (!this.stopLatch && finalErrorCode && HARD_STOP_ERRORS.has(finalErrorCode)) {
      this.stopLatch = {
        code: finalErrorCode,
        attemptId: input.attemptId,
        triggeredAt: input.completedAt,
      };
    }
    return cloneAttempt(completed);
  }

  failInFlightAttempt(input: FailInFlightAttemptInput): ModelCallAttempt {
    assertIsoTimestamp(input.completedAt, 'completedAt');
    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new Error(`attempt not found: ${input.attemptId}`);
    if (attempt.state !== 'IN_FLIGHT') throw new Error('attempt is not in flight');
    if (Date.parse(input.completedAt) < Date.parse(attempt.startedAt)) {
      throw new Error('completedAt cannot be earlier than startedAt');
    }

    const worstCaseCostCny = this.costs.estimateWorstCase(attempt.module).worstCaseCostCny;
    const completed: ModelCallAttempt = {
      ...attempt,
      state: 'COMPLETED',
      billingStatus: 'UNBILLED',
      unbilledEstimatedCostCny: worstCaseCostCny,
      providerStatus: 'FAILURE',
      contractStatus: 'NOT_EVALUATED',
      qualityStatus: 'NOT_EVALUATED',
      errorCode: input.errorCode,
      completedAt: input.completedAt,
      usableResult: false,
      retryEligible: false,
    };

    this.budget.completeAsUnbilledWorstCase(input.attemptId, worstCaseCostCny);
    this.attempts.set(input.attemptId, completed);
    if (!this.stopLatch && HARD_STOP_ERRORS.has(input.errorCode)) {
      this.stopLatch = {
        code: input.errorCode,
        attemptId: input.attemptId,
        triggeredAt: input.completedAt,
      };
    }
    return cloneAttempt(completed);
  }

  settleAttemptBilling(
    attemptId: string,
    settledCostCny: number,
    settledAt: string
  ): ModelCallAttempt {
    assertMoney(settledCostCny, 'settledCostCny');
    assertIsoTimestamp(settledAt, 'settledAt');
    const attempt = this.attempts.get(attemptId);
    if (!attempt || attempt.state !== 'COMPLETED') {
      throw new Error(`completed attempt not found: ${attemptId}`);
    }
    if (attempt.billingStatus !== 'UNBILLED' || !attempt.completedAt) {
      throw new Error('attempt is not awaiting billing settlement');
    }
    if (Date.parse(settledAt) < Date.parse(attempt.completedAt)) {
      throw new Error('settledAt cannot be earlier than completedAt');
    }
    const budgetSnapshot = this.budget.settleCompletedUnbilled(attemptId, settledCostCny);
    const costInvalid = settledCostCny > attempt.reservedCostCny;
    const finalErrorCode: NormalizedErrorCode | undefined = budgetSnapshot.hardCapBreached
      ? 'budget_hard_cap_exceeded'
      : costInvalid
        ? 'pricing_catalog_invalid'
        : attempt.errorCode;
    const settled: ModelCallAttempt = {
      ...attempt,
      billingStatus: 'SETTLED',
      settledCostCny,
      billingSettledAt: settledAt,
      unbilledEstimatedCostCny: undefined,
      ...(finalErrorCode ? { errorCode: finalErrorCode } : {}),
      usableResult: costInvalid || budgetSnapshot.hardCapBreached ? false : attempt.usableResult,
      retryEligible: costInvalid || budgetSnapshot.hardCapBreached ? false : attempt.retryEligible,
    };
    this.attempts.set(attemptId, settled);
    if (finalErrorCode && HARD_STOP_ERRORS.has(finalErrorCode)) {
      this.stopLatch = { code: finalErrorCode, attemptId, triggeredAt: settledAt };
    }
    return cloneAttempt(settled);
  }

  listAttempts(): ModelCallAttempt[] {
    return Array.from(this.attempts.values(), cloneAttempt);
  }

  private sameCase(left: ModelCallAttempt, right: StartAttemptInput): boolean {
    return left.runId === right.runId
      && left.phaseId === right.phaseId
      && left.module === right.module
      && left.scenarioId === right.scenarioId
      && left.caseId === right.caseId;
  }
}
