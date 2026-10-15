import type { TopicLedgerStatus } from './direction-plan.ts';

export type TopicFacet =
  | 'PERSON'
  | 'TIME'
  | 'PLACE'
  | 'EVENT'
  | 'SCENE'
  | 'RELATIONSHIP'
  | 'MEANING'
  | 'CHANGE'
  | 'OBJECT';

export type TopicOperationalStatus =
  | 'UNSEEN'
  | 'IN_PROGRESS'
  | 'USABLE'
  | 'RICH'
  | 'DEFERRED'
  | 'SKIPPED_BY_ELDER'
  | 'BLOCKED'
  | 'NOT_APPLICABLE';

export type TopicUserDirection =
  | 'CONTINUE'
  | 'SWITCH_TOPIC'
  | 'SKIP'
  | 'PAUSE'
  | 'END'
  | 'NONE';

export type TopicCompletionReason =
  | 'MINIMUM_USABLE'
  | 'RICH_CONTEXT'
  | 'USER_ENDED'
  | 'USER_SKIPPED'
  | 'DEFERRED_BY_USER'
  | 'BLOCKED_BY_POLICY'
  | 'NOT_APPLICABLE'
  | null;

export interface TopicLedgerEvaluationState {
  topicId: string;
  status: TopicLedgerStatus;
  operationalStatus: TopicOperationalStatus;
  coveredFacets: readonly TopicFacet[];
  sourceRefs: readonly string[];
  openLeadIds: readonly string[];
  followUpDepth: number;
  questionCount: number;
  completionReason: TopicCompletionReason;
  resumeHint: string | null;
  burdenLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  uncertaintyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface TopicLedgerObservation {
  topicId: string;
  sourceRefs: readonly string[];
  observedFacets: readonly TopicFacet[];
  hasDirectUserEvidence: boolean;
  hasAnchor: boolean;
  questionAsked?: boolean;
  hasUnresolvedCriticalConflict?: boolean;
  hasMeaningfulContext?: boolean;
  openLeadIds?: readonly string[];
  resumeHint?: string | null;
  userDirection?: TopicUserDirection;
  policyBlocked?: boolean;
  notApplicable?: boolean;
  burdenLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  uncertaintyLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
}

export interface TopicLedgerEvaluationResult extends TopicLedgerEvaluationState {
  burdenLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  uncertaintyLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  reasonCodes: string[];
}

const FACETS = new Set<TopicFacet>([
  'PERSON', 'TIME', 'PLACE', 'EVENT', 'SCENE', 'RELATIONSHIP', 'MEANING', 'CHANGE', 'OBJECT',
]);

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function requireTopicId(value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError('topicId must be non-empty');
}

function normalizedFacets(values: readonly TopicFacet[]): TopicFacet[] {
  const result = unique(values);
  for (const facet of result) {
    if (!FACETS.has(facet)) throw new TypeError('unsupported topic facet: ' + String(facet));
  }
  return result;
}

function mappedStatus(status: TopicOperationalStatus): TopicLedgerStatus {
  if (status === 'USABLE' || status === 'RICH') return 'COVERED';
  if (status === 'SKIPPED_BY_ELDER') return 'SKIPPED';
  if (status === 'NOT_APPLICABLE' || status === 'BLOCKED') return 'BLOCKED';
  return status === 'DEFERRED' ? 'DEFERRED' : 'OPEN';
}

/**
 * Evaluate one topic from evidence and explicit user direction.
 *
 * This function only updates structured state. It never writes Memory and
 * never creates a natural-language question, so it can run before the LLM
 * realizer without giving the model additional authority.
 */
export function evaluateTopicLedger(
  previous: TopicLedgerEvaluationState | null,
  observation: TopicLedgerObservation,
): TopicLedgerEvaluationResult {
  requireTopicId(observation.topicId);
  if (previous && previous.topicId !== observation.topicId) {
    throw new Error('previous topic must match observation.topicId');
  }
  for (const ref of observation.sourceRefs) {
    if (typeof ref !== 'string' || ref.trim().length === 0) throw new TypeError('sourceRefs must be non-empty strings');
  }
  const observedFacets = normalizedFacets(observation.observedFacets);
  const priorFacets = normalizedFacets(previous?.coveredFacets ?? []);
  const coveredFacets = unique([...priorFacets, ...observedFacets]);
  const sourceRefs = unique([...(previous?.sourceRefs ?? []), ...observation.sourceRefs]);
  const openLeadIds = unique(observation.openLeadIds ?? previous?.openLeadIds ?? []);
  const direction = observation.userDirection ?? 'NONE';
  const burdenLevel = observation.burdenLevel ?? previous?.burdenLevel ?? 'LOW';
  const uncertaintyLevel = observation.uncertaintyLevel ?? previous?.uncertaintyLevel ?? 'MEDIUM';
  const reasonCodes: string[] = [];

  let operationalStatus: TopicOperationalStatus;
  let completionReason: TopicCompletionReason = null;

  if (observation.notApplicable) {
    operationalStatus = 'NOT_APPLICABLE';
    completionReason = 'NOT_APPLICABLE';
    reasonCodes.push('TOPIC_NOT_APPLICABLE');
  } else if (observation.policyBlocked) {
    operationalStatus = 'BLOCKED';
    completionReason = 'BLOCKED_BY_POLICY';
    reasonCodes.push('TOPIC_BLOCKED_BY_POLICY');
  } else if (direction === 'SKIP') {
    operationalStatus = 'SKIPPED_BY_ELDER';
    completionReason = 'USER_SKIPPED';
    reasonCodes.push('ELDER_SKIPPED_TOPIC');
  } else if (direction === 'PAUSE') {
    operationalStatus = previous?.operationalStatus === 'USABLE' || previous?.operationalStatus === 'RICH'
      ? previous.operationalStatus
      : 'DEFERRED';
    completionReason = 'DEFERRED_BY_USER';
    reasonCodes.push('ELDER_PAUSED_TOPIC');
  } else if (direction === 'END') {
    operationalStatus = previous?.operationalStatus === 'USABLE' || previous?.operationalStatus === 'RICH'
      ? previous.operationalStatus
      : observation.hasDirectUserEvidence && observation.hasAnchor ? 'USABLE' : 'IN_PROGRESS';
    completionReason = operationalStatus === 'IN_PROGRESS' ? null : 'USER_ENDED';
    reasonCodes.push('ELDER_ENDED_TOPIC_OR_SESSION');
  } else if (!observation.hasDirectUserEvidence) {
    operationalStatus = previous?.operationalStatus === 'USABLE' || previous?.operationalStatus === 'RICH'
      ? previous.operationalStatus
      : 'IN_PROGRESS';
    reasonCodes.push('DIRECT_USER_EVIDENCE_REQUIRED');
  } else if (sourceRefs.length === 0) {
    operationalStatus = previous?.operationalStatus === 'USABLE' || previous?.operationalStatus === 'RICH'
      ? previous.operationalStatus
      : 'IN_PROGRESS';
    reasonCodes.push('SOURCE_EVIDENCE_REQUIRED');
  } else if (!observation.hasAnchor) {
    operationalStatus = previous?.operationalStatus === 'USABLE' || previous?.operationalStatus === 'RICH'
      ? previous.operationalStatus
      : 'IN_PROGRESS';
    reasonCodes.push('ONE_ANCHOR_REQUIRED_FOR_USABLE');
  } else if (observation.hasUnresolvedCriticalConflict) {
    operationalStatus = 'IN_PROGRESS';
    reasonCodes.push('CRITICAL_CONFLICT_REQUIRES_REVIEW');
  } else if (observation.hasMeaningfulContext || coveredFacets.some(facet =>
    facet === 'SCENE' || facet === 'OBJECT' || facet === 'RELATIONSHIP' || facet === 'MEANING' || facet === 'CHANGE')) {
    operationalStatus = 'RICH';
    completionReason = 'RICH_CONTEXT';
    reasonCodes.push('RICH_CONTEXT_AVAILABLE');
  } else {
    operationalStatus = 'USABLE';
    completionReason = 'MINIMUM_USABLE';
    reasonCodes.push('MINIMUM_USABLE_EVIDENCE');
  }

  if (direction === 'CONTINUE') reasonCodes.push('ELDER_CONTINUE');
  if (direction === 'SWITCH_TOPIC') reasonCodes.push('ELDER_SWITCHED_TOPIC');
  if (burdenLevel === 'HIGH') reasonCodes.push('HIGH_BURDEN_REQUIRES_LOW_LOAD_NEXT_STEP');
  if (uncertaintyLevel === 'HIGH') reasonCodes.push('HIGH_UNCERTAINTY_NO_FACTUAL_EXPANSION');

  const questionCount = (previous?.questionCount ?? 0) + (observation.questionAsked ? 1 : 0);
  const followUpDepth = direction === 'SWITCH_TOPIC' || direction === 'SKIP' ? 0
    : (previous?.followUpDepth ?? 0) + (direction === 'CONTINUE' ? 1 : 0);
  const resumeHint = observation.resumeHint === undefined
    ? previous?.resumeHint ?? null
    : observation.resumeHint;

  return {
    topicId: observation.topicId,
    status: mappedStatus(operationalStatus),
    operationalStatus,
    coveredFacets,
    sourceRefs,
    openLeadIds,
    followUpDepth,
    questionCount,
    completionReason,
    resumeHint,
    burdenLevel,
    uncertaintyLevel,
    reasonCodes: unique(reasonCodes),
  };
}
