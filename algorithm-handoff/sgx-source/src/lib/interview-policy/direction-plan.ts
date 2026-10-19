import crypto from 'node:crypto';

export type InterviewGuidanceMode = 'FOLLOW_USER' | 'OFFER_CHOICES' | 'GUIDED_OUTLINE';
export type TopicLedgerStatus = 'OPEN' | 'COVERED' | 'SKIPPED' | 'DEFERRED' | 'BLOCKED';
export type TopicLedgerScope = 'CURRENT_TURN' | 'CURRENT_SESSION' | 'FUTURE_SESSIONS';
export type ElderDirection = 'NONE' | 'CONTINUE' | 'SKIP_CURRENT' | 'SWITCH_TOPIC' | 'END_SESSION';
export type DirectionUncertainty = 'LOW' | 'MEDIUM' | 'HIGH';
export type DirectionEvidenceKind = 'ELDER_TURN' | 'ELDER_UI' | 'SYSTEM_PLAN' | 'MEMORY';

export interface InterviewProgramTopic {
  topicId: string;
  title: string;
  goalTypes: readonly string[];
}

/** Owner/expert-approved bounds. This is a catalog, not a mandatory life-stage sequence. */
export interface InterviewProgram {
  schemaVersion: '0.1';
  programId: string;
  version: string;
  allowedGoalTypes: readonly string[];
  allowedOutputTypes: readonly string[];
  topics: readonly InterviewProgramTopic[];
  redLines: readonly string[];
  qualityPriorities: readonly string[];
}

export interface SessionPlan {
  schemaVersion: '0.1';
  sessionPlanId: string;
  programId: string;
  programVersion: string;
  sessionEpoch: string;
  consent: {
    status: 'EXPLICIT';
    evidenceRef: string;
  };
  goalTypes: readonly string[];
  outputTypes: readonly string[];
  /** Omission means FOLLOW_USER; callers cannot infer guided mode from silence. */
  guidanceMode?: InterviewGuidanceMode;
  burdenBudget: {
    maxMinutes: number;
    maxQuestions: number;
    maxFollowUpDepth: number;
  };
  authorizationVersion: string;
  memorySnapshotId: string | null;
}

export interface TopicLedgerEntry {
  topicId: string;
  status: TopicLedgerStatus;
  scope: TopicLedgerScope;
  /** Session in which this scope was created. */
  scopeSessionEpoch: string;
  /** Required only for CURRENT_TURN; null for wider scopes. */
  scopeTurnId: string | null;
  sourceRefs: readonly string[];
}

export type TopicLedger = readonly TopicLedgerEntry[];

export interface PlanState {
  schemaVersion: '0.1';
  planVersion: number;
  sessionEpoch: string;
  turnId: string;
  currentTopicId: string | null;
  openLeadIds: readonly string[];
  topicLedger: TopicLedger;
  resumeTopicId: string | null;
}

export interface DirectionEvidenceRef {
  ref: string;
  purpose: string;
  kind: DirectionEvidenceKind;
  sessionEpoch: string;
  turnId: string;
}

export interface DirectionAuthorityBoundary {
  canProposeTopic: true;
  canPersistMemory: false;
  canEndSession: false;
  canGenerateUtterance: false;
}

/**
 * A deterministic topic proposal consumed by InterviewPolicy.
 *
 * It intentionally has no save command, session command, or natural-language
 * utterance. Those authorities stay with Memory policy, session control, and
 * the policy-constrained realizer respectively.
 */
export interface DirectionPlan {
  schemaVersion: '0.1';
  directionPlanId: string;
  programId: string;
  programVersion: string;
  sessionPlanId: string;
  sessionEpoch: string;
  turnId: string;
  stateVersion: number;
  stateCurrentTopicId: string | null;
  guidanceMode: InterviewGuidanceMode;
  elderDirection: ElderDirection;
  elderRequestedTopicId: string | null;
  uncertainty: DirectionUncertainty;
  selectedTopicId: string | null;
  candidateTopicIds: string[];
  reasonCodes: string[];
  evidenceRefs: DirectionEvidenceRef[];
  authorityBoundary: DirectionAuthorityBoundary;
}

export interface CreateDirectionPlanInput {
  program: InterviewProgram;
  sessionPlan: SessionPlan;
  state: PlanState;
  elderDirection?: ElderDirection;
  elderRequestedTopicId?: string | null;
  uncertainty?: DirectionUncertainty;
  /** Explicit upstream choice. This module does not rank topics. */
  selectedTopicId?: string | null;
  /** Explicit upstream order. This module only filters invalid/unavailable values. */
  candidateTopicIds?: readonly string[];
  reasonCodes?: readonly string[];
  evidenceRefs?: readonly DirectionEvidenceRef[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${field} must be an object`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${field} must contain unique values`);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new Error(`${field} contains unsupported field: ${key}`);
  }
}

function assertEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): asserts value is T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new TypeError(`${field} must be one of ${allowed.join(', ')}`);
  }
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function directionPlanIdFor(planWithoutId: Omit<DirectionPlan, 'directionPlanId'>): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(planWithoutId)))
    .digest('hex')
    .slice(0, 24);
  return `direction-v0.1:${digest}`;
}

export function assertInterviewProgram(value: unknown): InterviewProgram {
  assertRecord(value, 'program');
  if (value.schemaVersion !== '0.1') throw new TypeError('program.schemaVersion must be 0.1');
  assertNonEmptyString(value.programId, 'program.programId');
  assertNonEmptyString(value.version, 'program.version');
  assertStringArray(value.allowedGoalTypes, 'program.allowedGoalTypes');
  assertStringArray(value.allowedOutputTypes, 'program.allowedOutputTypes');
  if (value.allowedGoalTypes.length === 0) throw new Error('program.allowedGoalTypes must not be empty');
  if (value.allowedOutputTypes.length === 0) throw new Error('program.allowedOutputTypes must not be empty');
  assertUnique(value.allowedGoalTypes, 'program.allowedGoalTypes');
  assertUnique(value.allowedOutputTypes, 'program.allowedOutputTypes');
  const allowedGoalTypes = value.allowedGoalTypes;
  assertStringArray(value.redLines, 'program.redLines');
  assertStringArray(value.qualityPriorities, 'program.qualityPriorities');
  if (!Array.isArray(value.topics)) throw new TypeError('program.topics must be an array');
  const topicIds: string[] = [];
  value.topics.forEach((topic, index) => {
    assertRecord(topic, `program.topics[${index}]`);
    assertNonEmptyString(topic.topicId, `program.topics[${index}].topicId`);
    assertNonEmptyString(topic.title, `program.topics[${index}].title`);
    assertStringArray(topic.goalTypes, `program.topics[${index}].goalTypes`);
    if (topic.goalTypes.length === 0) throw new Error(`program.topics[${index}].goalTypes must not be empty`);
    assertUnique(topic.goalTypes, `program.topics[${index}].goalTypes`);
    for (const goalType of topic.goalTypes) {
      if (!allowedGoalTypes.includes(goalType)) {
        throw new Error(`program.topics[${index}].goalTypes must be inside program.allowedGoalTypes`);
      }
    }
    topicIds.push(topic.topicId);
  });
  assertUnique(topicIds, 'program topic ids');
  return value as unknown as InterviewProgram;
}

export function assertSessionPlan(value: unknown): SessionPlan {
  assertRecord(value, 'sessionPlan');
  if (value.schemaVersion !== '0.1') throw new TypeError('sessionPlan.schemaVersion must be 0.1');
  for (const field of ['sessionPlanId', 'programId', 'programVersion', 'sessionEpoch', 'authorizationVersion'] as const) {
    assertNonEmptyString(value[field], `sessionPlan.${field}`);
  }
  assertRecord(value.consent, 'sessionPlan.consent');
  if (value.consent.status !== 'EXPLICIT') throw new Error('sessionPlan requires explicit consent');
  assertNonEmptyString(value.consent.evidenceRef, 'sessionPlan.consent.evidenceRef');
  assertStringArray(value.goalTypes, 'sessionPlan.goalTypes');
  assertStringArray(value.outputTypes, 'sessionPlan.outputTypes');
  if (value.goalTypes.length === 0) throw new Error('sessionPlan.goalTypes must not be empty');
  if (value.outputTypes.length === 0) throw new Error('sessionPlan.outputTypes must not be empty');
  assertUnique(value.goalTypes, 'sessionPlan.goalTypes');
  assertUnique(value.outputTypes, 'sessionPlan.outputTypes');
  if (value.guidanceMode !== undefined) {
    assertEnum(value.guidanceMode, ['FOLLOW_USER', 'OFFER_CHOICES', 'GUIDED_OUTLINE'], 'sessionPlan.guidanceMode');
  }
  assertRecord(value.burdenBudget, 'sessionPlan.burdenBudget');
  for (const field of ['maxMinutes', 'maxQuestions', 'maxFollowUpDepth'] as const) {
    assertNonNegativeInteger(value.burdenBudget[field], `sessionPlan.burdenBudget.${field}`);
  }
  if (value.memorySnapshotId !== null) {
    assertNonEmptyString(value.memorySnapshotId, 'sessionPlan.memorySnapshotId');
  }
  return value as unknown as SessionPlan;
}

export function assertPlanState(value: unknown): PlanState {
  assertRecord(value, 'planState');
  if (value.schemaVersion !== '0.1') throw new TypeError('planState.schemaVersion must be 0.1');
  assertNonNegativeInteger(value.planVersion, 'planState.planVersion');
  assertNonEmptyString(value.sessionEpoch, 'planState.sessionEpoch');
  assertNonEmptyString(value.turnId, 'planState.turnId');
  if (value.currentTopicId !== null) assertNonEmptyString(value.currentTopicId, 'planState.currentTopicId');
  if (value.resumeTopicId !== null) assertNonEmptyString(value.resumeTopicId, 'planState.resumeTopicId');
  assertStringArray(value.openLeadIds, 'planState.openLeadIds');
  if (!Array.isArray(value.topicLedger)) throw new TypeError('planState.topicLedger must be an array');
  const topicIds: string[] = [];
  value.topicLedger.forEach((entry, index) => {
    assertRecord(entry, `planState.topicLedger[${index}]`);
    assertNonEmptyString(entry.topicId, `planState.topicLedger[${index}].topicId`);
    assertEnum(
      entry.status,
      ['OPEN', 'COVERED', 'SKIPPED', 'DEFERRED', 'BLOCKED'],
      `planState.topicLedger[${index}].status`,
    );
    assertEnum(
      entry.scope,
      ['CURRENT_TURN', 'CURRENT_SESSION', 'FUTURE_SESSIONS'],
      `planState.topicLedger[${index}].scope`,
    );
    assertNonEmptyString(entry.scopeSessionEpoch, `planState.topicLedger[${index}].scopeSessionEpoch`);
    if (entry.scope === 'CURRENT_TURN') {
      assertNonEmptyString(entry.scopeTurnId, `planState.topicLedger[${index}].scopeTurnId`);
    } else if (entry.scopeTurnId !== null) {
      throw new Error(`planState.topicLedger[${index}].scopeTurnId must be null outside CURRENT_TURN`);
    }
    assertStringArray(entry.sourceRefs, `planState.topicLedger[${index}].sourceRefs`);
    topicIds.push(entry.topicId);
  });
  assertUnique(topicIds, 'planState topic ledger ids');
  return value as unknown as PlanState;
}

function ledgerEntryApplies(entry: TopicLedgerEntry, state: PlanState): boolean {
  if (entry.scope === 'CURRENT_TURN') {
    return entry.scopeSessionEpoch === state.sessionEpoch && entry.scopeTurnId === state.turnId;
  }
  if (entry.scope === 'CURRENT_SESSION') return entry.scopeSessionEpoch === state.sessionEpoch;
  return true;
}

function allowedTopicIds(program: InterviewProgram, sessionPlan: SessionPlan, state: PlanState): Set<string> {
  const sessionGoals = new Set(sessionPlan.goalTypes);
  const known = new Set(
    program.topics
      .filter((topic) => topic.goalTypes.some((goalType) => sessionGoals.has(goalType)))
      .map((topic) => topic.topicId),
  );
  for (const entry of state.topicLedger) {
    const unavailable = ['BLOCKED', 'SKIPPED', 'DEFERRED'].includes(entry.status);
    if (unavailable && ledgerEntryApplies(entry, state)) {
      known.delete(entry.topicId);
    }
  }
  return known;
}

function filterProvidedTopics(
  values: readonly string[],
  allowed: ReadonlySet<string>,
  excludedTopicId: string | null = null,
): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (!allowed.has(value) || value === excludedTopicId || result.includes(value)) continue;
    result.push(value);
    if (result.length === 3) break;
  }
  return result;
}

/**
 * Build a plan without ranking or free topic selection. Caller-provided order
 * is preserved, except that an explicit elder switch is placed first.
 */
export function createDirectionPlan(input: CreateDirectionPlanInput): DirectionPlan {
  const program = assertInterviewProgram(input.program);
  const sessionPlan = assertSessionPlan(input.sessionPlan);
  const state = assertPlanState(input.state);
  if (sessionPlan.programId !== program.programId || sessionPlan.programVersion !== program.version) {
    throw new Error('sessionPlan must bind the supplied program id and version');
  }
  if (state.sessionEpoch !== sessionPlan.sessionEpoch) {
    throw new Error('planState.sessionEpoch must match sessionPlan.sessionEpoch');
  }
  for (const goalType of sessionPlan.goalTypes) {
    if (!program.allowedGoalTypes.includes(goalType)) {
      throw new Error('sessionPlan.goalTypes must be a subset of the Program allowlist');
    }
  }
  for (const outputType of sessionPlan.outputTypes) {
    if (!program.allowedOutputTypes.includes(outputType)) {
      throw new Error('sessionPlan.outputTypes must be a subset of the Program allowlist');
    }
  }
  const programTopicIds = new Set(program.topics.map((topic) => topic.topicId));
  for (const entry of state.topicLedger) {
    if (!programTopicIds.has(entry.topicId)) throw new Error('topicLedger contains a topic outside the Program');
  }
  for (const topicId of [state.currentTopicId, state.resumeTopicId]) {
    if (topicId !== null && !programTopicIds.has(topicId)) {
      throw new Error('planState references a topic outside the Program');
    }
  }

  const allowed = allowedTopicIds(program, sessionPlan, state);
  const elderDirection = input.elderDirection ?? 'NONE';
  assertEnum(
    elderDirection,
    ['NONE', 'CONTINUE', 'SKIP_CURRENT', 'SWITCH_TOPIC', 'END_SESSION'],
    'elderDirection',
  );

  if (elderDirection !== 'SWITCH_TOPIC' && (input.elderRequestedTopicId ?? null) !== null) {
    throw new Error('elderRequestedTopicId is only valid with SWITCH_TOPIC');
  }

  const evidenceRefs = (input.evidenceRefs ?? []).map((item) => ({ ...item }));
  evidenceRefs.forEach((item, index) => {
    assertRecord(item, `evidenceRefs[${index}]`);
    assertExactKeys(
      item,
      ['ref', 'purpose', 'kind', 'sessionEpoch', 'turnId'],
      `evidenceRefs[${index}]`,
    );
    assertNonEmptyString(item.ref, `evidenceRefs[${index}].ref`);
    assertNonEmptyString(item.purpose, `evidenceRefs[${index}].purpose`);
    assertEnum(item.kind, ['ELDER_TURN', 'ELDER_UI', 'SYSTEM_PLAN', 'MEMORY'], `evidenceRefs[${index}].kind`);
    assertNonEmptyString(item.sessionEpoch, `evidenceRefs[${index}].sessionEpoch`);
    assertNonEmptyString(item.turnId, `evidenceRefs[${index}].turnId`);
  });
  if (elderDirection !== 'NONE') {
    const hasCurrentElderEvidence = evidenceRefs.some((item) =>
      (item.kind === 'ELDER_TURN' || item.kind === 'ELDER_UI')
      && item.sessionEpoch === state.sessionEpoch
      && item.turnId === state.turnId);
    if (!hasCurrentElderEvidence) {
      throw new Error('elderDirection requires current-turn elder evidence');
    }
  }

  let candidates = filterProvidedTopics(input.candidateTopicIds ?? [], allowed);
  let selectedTopicId = input.selectedTopicId ?? state.currentTopicId;
  if (selectedTopicId !== null && !allowed.has(selectedTopicId)) selectedTopicId = null;

  if (elderDirection === 'CONTINUE') {
    if (state.currentTopicId === null || !allowed.has(state.currentTopicId)) {
      throw new Error('elder CONTINUE requires an available current topic');
    }
    selectedTopicId = state.currentTopicId;
    candidates = [state.currentTopicId];
  } else if (elderDirection === 'END_SESSION') {
    selectedTopicId = null;
    candidates = [];
  } else if (elderDirection === 'SKIP_CURRENT') {
    selectedTopicId = null;
    candidates = filterProvidedTopics(candidates, allowed, state.currentTopicId);
  } else if (elderDirection === 'SWITCH_TOPIC') {
    const requested = input.elderRequestedTopicId ?? null;
    if (requested !== null && requested === state.currentTopicId) {
      throw new Error('elder SWITCH_TOPIC must request a different topic');
    }
    if (requested !== null && !allowed.has(requested)) {
      throw new Error('elderRequestedTopicId is unavailable or blocked');
    }
    selectedTopicId = requested;
    candidates = requested === null
      ? filterProvidedTopics(candidates, allowed, state.currentTopicId)
      : filterProvidedTopics([requested, ...candidates], allowed, state.currentTopicId);
  }

  const reasonCodes = [...new Set([
    ...(elderDirection === 'NONE' ? [] : [`ELDER_${elderDirection}`]),
    ...(input.reasonCodes ?? []),
  ])];
  if (reasonCodes.length === 0) reasonCodes.push('FOLLOW_USER_DEFAULT');

  const withoutId: Omit<DirectionPlan, 'directionPlanId'> = {
    schemaVersion: '0.1',
    programId: program.programId,
    programVersion: program.version,
    sessionPlanId: sessionPlan.sessionPlanId,
    sessionEpoch: sessionPlan.sessionEpoch,
    turnId: state.turnId,
    stateVersion: state.planVersion,
    stateCurrentTopicId: state.currentTopicId,
    guidanceMode: sessionPlan.guidanceMode ?? 'FOLLOW_USER',
    elderDirection,
    elderRequestedTopicId: input.elderRequestedTopicId ?? null,
    uncertainty: input.uncertainty ?? (elderDirection === 'NONE' ? 'MEDIUM' : 'LOW'),
    selectedTopicId,
    candidateTopicIds: candidates,
    reasonCodes,
    evidenceRefs,
    authorityBoundary: {
      canProposeTopic: true,
      canPersistMemory: false,
      canEndSession: false,
      canGenerateUtterance: false,
    },
  };
  return assertDirectionPlan({
    ...withoutId,
    directionPlanId: directionPlanIdFor(withoutId),
  });
}

export function assertDirectionPlan(value: unknown): DirectionPlan {
  assertRecord(value, 'directionPlan');
  const allowedKeys = new Set([
    'schemaVersion',
    'directionPlanId',
    'programId',
    'programVersion',
    'sessionPlanId',
    'sessionEpoch',
    'turnId',
    'stateVersion',
    'stateCurrentTopicId',
    'guidanceMode',
    'elderDirection',
    'elderRequestedTopicId',
    'uncertainty',
    'selectedTopicId',
    'candidateTopicIds',
    'reasonCodes',
    'evidenceRefs',
    'authorityBoundary',
  ]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) throw new Error(`directionPlan contains unsupported authority field: ${key}`);
  }
  if (value.schemaVersion !== '0.1') throw new TypeError('directionPlan.schemaVersion must be 0.1');
  for (const field of ['directionPlanId', 'programId', 'programVersion', 'sessionPlanId', 'sessionEpoch', 'turnId'] as const) {
    assertNonEmptyString(value[field], `directionPlan.${field}`);
  }
  assertNonNegativeInteger(value.stateVersion, 'directionPlan.stateVersion');
  if (value.stateCurrentTopicId !== null) {
    assertNonEmptyString(value.stateCurrentTopicId, 'directionPlan.stateCurrentTopicId');
  }
  assertEnum(value.guidanceMode, ['FOLLOW_USER', 'OFFER_CHOICES', 'GUIDED_OUTLINE'], 'directionPlan.guidanceMode');
  assertEnum(
    value.elderDirection,
    ['NONE', 'CONTINUE', 'SKIP_CURRENT', 'SWITCH_TOPIC', 'END_SESSION'],
    'directionPlan.elderDirection',
  );
  if (value.elderRequestedTopicId !== null) {
    assertNonEmptyString(value.elderRequestedTopicId, 'directionPlan.elderRequestedTopicId');
  }
  if (value.elderDirection !== 'SWITCH_TOPIC' && value.elderRequestedTopicId !== null) {
    throw new Error('elderRequestedTopicId is only valid with SWITCH_TOPIC');
  }
  assertEnum(value.uncertainty, ['LOW', 'MEDIUM', 'HIGH'], 'directionPlan.uncertainty');
  if (value.selectedTopicId !== null) assertNonEmptyString(value.selectedTopicId, 'directionPlan.selectedTopicId');
  assertStringArray(value.candidateTopicIds, 'directionPlan.candidateTopicIds');
  assertUnique(value.candidateTopicIds, 'directionPlan.candidateTopicIds');
  if (value.candidateTopicIds.length > 3) throw new Error('directionPlan supports at most three candidates');
  assertStringArray(value.reasonCodes, 'directionPlan.reasonCodes');
  if (value.reasonCodes.length === 0) throw new Error('directionPlan.reasonCodes must not be empty');
  if (!Array.isArray(value.evidenceRefs)) throw new TypeError('directionPlan.evidenceRefs must be an array');
  value.evidenceRefs.forEach((item, index) => {
    assertRecord(item, `directionPlan.evidenceRefs[${index}]`);
    assertExactKeys(
      item,
      ['ref', 'purpose', 'kind', 'sessionEpoch', 'turnId'],
      `directionPlan.evidenceRefs[${index}]`,
    );
    assertNonEmptyString(item.ref, `directionPlan.evidenceRefs[${index}].ref`);
    assertNonEmptyString(item.purpose, `directionPlan.evidenceRefs[${index}].purpose`);
    assertEnum(
      item.kind,
      ['ELDER_TURN', 'ELDER_UI', 'SYSTEM_PLAN', 'MEMORY'],
      `directionPlan.evidenceRefs[${index}].kind`,
    );
    assertNonEmptyString(item.sessionEpoch, `directionPlan.evidenceRefs[${index}].sessionEpoch`);
    assertNonEmptyString(item.turnId, `directionPlan.evidenceRefs[${index}].turnId`);
  });
  assertRecord(value.authorityBoundary, 'directionPlan.authorityBoundary');
  assertExactKeys(
    value.authorityBoundary,
    ['canProposeTopic', 'canPersistMemory', 'canEndSession', 'canGenerateUtterance'],
    'directionPlan.authorityBoundary',
  );
  if (
    value.authorityBoundary.canProposeTopic !== true ||
    value.authorityBoundary.canPersistMemory !== false ||
    value.authorityBoundary.canEndSession !== false ||
    value.authorityBoundary.canGenerateUtterance !== false
  ) {
    throw new Error('directionPlan authority boundary cannot be expanded');
  }
  if (value.elderDirection === 'END_SESSION' && (value.selectedTopicId !== null || value.candidateTopicIds.length > 0)) {
    throw new Error('elder END_SESSION must suppress further topic proposals');
  }
  if (value.elderDirection === 'SKIP_CURRENT' && value.selectedTopicId !== null) {
    throw new Error('elder SKIP_CURRENT must clear the selected topic');
  }
  if (
    value.elderDirection === 'SKIP_CURRENT'
    && value.stateCurrentTopicId !== null
    && value.candidateTopicIds.includes(value.stateCurrentTopicId)
  ) {
    throw new Error('elder SKIP_CURRENT must exclude the current topic from candidates');
  }
  if (value.elderDirection === 'CONTINUE' && value.selectedTopicId !== value.stateCurrentTopicId) {
    throw new Error('elder CONTINUE must preserve the current topic');
  }
  if (
    value.elderDirection === 'CONTINUE'
    && (
      value.stateCurrentTopicId === null
      || value.candidateTopicIds.length !== 1
      || value.candidateTopicIds[0] !== value.stateCurrentTopicId
    )
  ) {
    throw new Error('elder CONTINUE must expose only the current topic as a candidate');
  }
  if (value.elderDirection !== 'NONE') {
    const hasCurrentElderEvidence = value.evidenceRefs.some((item) =>
      (item.kind === 'ELDER_TURN' || item.kind === 'ELDER_UI')
      && item.sessionEpoch === value.sessionEpoch
      && item.turnId === value.turnId);
    if (!hasCurrentElderEvidence) throw new Error('elderDirection requires current-turn elder evidence');
  }
  if (
    value.elderDirection === 'SWITCH_TOPIC' &&
    value.elderRequestedTopicId !== null &&
    value.selectedTopicId !== value.elderRequestedTopicId
  ) {
    throw new Error('elder requested switch must override the selected topic');
  }
  if (value.elderDirection === 'SWITCH_TOPIC') {
    if (value.elderRequestedTopicId === null && value.selectedTopicId !== null) {
      throw new Error('elder SWITCH_TOPIC without a requested topic must clear the selected topic');
    }
    if (
      value.elderRequestedTopicId !== null
      && (
        value.elderRequestedTopicId === value.stateCurrentTopicId
        || value.candidateTopicIds[0] !== value.elderRequestedTopicId
      )
    ) {
      throw new Error('elder SWITCH_TOPIC must place a different requested topic first');
    }
    if (
      value.stateCurrentTopicId !== null
      && value.candidateTopicIds.includes(value.stateCurrentTopicId)
    ) {
      throw new Error('elder SWITCH_TOPIC must exclude the current topic from candidates');
    }
  }
  const { directionPlanId, ...withoutId } = value as unknown as DirectionPlan;
  if (directionPlanId !== directionPlanIdFor(withoutId)) {
    throw new Error('directionPlan.directionPlanId does not match its content');
  }
  return value as unknown as DirectionPlan;
}
