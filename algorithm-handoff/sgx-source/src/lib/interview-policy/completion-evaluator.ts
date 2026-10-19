import type { TopicOperationalStatus } from './topic-ledger-evaluator.ts';

export type InterviewCompletionAction = 'CONTINUE' | 'OFFER_CHOICES' | 'PAUSE' | 'END' | 'REVIEW';
export type InterviewCompletionReason =
  | 'CONTINUE_NATURAL'
  | 'NATURAL_PAUSE_CONFIRMATION'
  | 'ELDER_ENDED'
  | 'ELDER_PAUSED'
  | 'RESOURCE_LIMIT'
  | 'SAFETY_OR_AUTHORITY_STOP'
  | 'TURN_NOT_FINAL'
  | 'TURN_RUNTIME_FAILURE'
  | 'NO_USEFUL_NEXT_ACTION';

export interface InterviewCompletionInput {
  inputFinal: boolean;
  responseReady: boolean;
  ttsSettled: boolean;
  memoryTaskSettled: boolean;
  explicitEnd?: boolean;
  explicitPause?: boolean;
  naturalPause?: boolean;
  continueChoice: 'CONTINUE' | 'STOP' | 'UNKNOWN';
  safetyOrAuthorityStop?: boolean;
  runtimeFailure?: boolean;
  hasUsefulNextAction: boolean;
  topicStatus?: TopicOperationalStatus;
  elapsedMinutes: number;
  questionCount: number;
  maxMinutes: number;
  maxQuestions: number;
}

export interface InterviewCompletionResult {
  action: InterviewCompletionAction;
  reason: InterviewCompletionReason;
  turnComplete: boolean;
  topicComplete: boolean;
  sessionComplete: boolean;
  topicStatus: TopicOperationalStatus | null;
  resourceLimitReached: boolean;
  reasonCodes: string[];
}

function assertNonNegativeFinite(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(field + ' must be a non-negative finite number');
}

/**
 * Separates turn delivery, topic usefulness, and session end decisions.
 * Resource limits are safety ceilings; they never claim that a story is rich.
 */
export function evaluateInterviewCompletion(input: InterviewCompletionInput): InterviewCompletionResult {
  assertNonNegativeFinite(input.elapsedMinutes, 'elapsedMinutes');
  assertNonNegativeFinite(input.questionCount, 'questionCount');
  assertNonNegativeFinite(input.maxMinutes, 'maxMinutes');
  assertNonNegativeFinite(input.maxQuestions, 'maxQuestions');

  const resourceLimitReached = input.elapsedMinutes >= input.maxMinutes || input.questionCount >= input.maxQuestions;
  const topicStatus = input.topicStatus ?? null;
  const topicComplete = topicStatus === 'USABLE' || topicStatus === 'RICH';
  // Memory extraction is asynchronous. It must expose a clear pending or
  // failed state, but it must not hold the elder's next turn hostage.
  const turnComplete = input.inputFinal && input.responseReady && input.ttsSettled;
  const reasonCodes: string[] = [];

  if (!input.inputFinal) {
    return {
      action: 'REVIEW', reason: 'TURN_NOT_FINAL', turnComplete: false, topicComplete,
      sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes: ['FINAL_INPUT_REQUIRED'],
    };
  }
  if (input.runtimeFailure || !input.responseReady || !input.ttsSettled) {
    return {
      action: 'REVIEW', reason: 'TURN_RUNTIME_FAILURE', turnComplete: false, topicComplete,
      sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes: ['RUNTIME_SETTLEMENT_REQUIRED'],
    };
  }
  if (input.safetyOrAuthorityStop) {
    return {
      action: 'END', reason: 'SAFETY_OR_AUTHORITY_STOP', turnComplete, topicComplete,
      sessionComplete: true, topicStatus, resourceLimitReached, reasonCodes: ['SAFETY_OR_AUTHORITY_STOP'],
    };
  }
  if (input.explicitEnd || input.continueChoice === 'STOP') {
    return {
      action: 'END', reason: 'ELDER_ENDED', turnComplete, topicComplete,
      sessionComplete: true, topicStatus, resourceLimitReached, reasonCodes: ['ELDER_ENDS_SESSION'],
    };
  }
  if (input.explicitPause) {
    return {
      action: 'PAUSE', reason: 'ELDER_PAUSED', turnComplete, topicComplete,
      sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes: ['ELDER_PAUSES_SESSION'],
    };
  }
  if (resourceLimitReached) {
    return {
      action: 'END', reason: 'RESOURCE_LIMIT', turnComplete, topicComplete,
      sessionComplete: true, topicStatus, resourceLimitReached, reasonCodes: ['RESOURCE_CEILING_REACHED'],
    };
  }
  if (input.naturalPause && input.continueChoice === 'UNKNOWN') {
    return {
      action: 'OFFER_CHOICES', reason: 'NATURAL_PAUSE_CONFIRMATION', turnComplete, topicComplete,
      sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes: ['NATURAL_PAUSE_NEEDS_ELDER_CHOICE'],
    };
  }
  if (!input.memoryTaskSettled) reasonCodes.push('MEMORY_ASYNC_PENDING');
  if (!input.hasUsefulNextAction) {
    return {
      action: 'OFFER_CHOICES', reason: 'NO_USEFUL_NEXT_ACTION', turnComplete, topicComplete,
      sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes: ['NO_HIGH_VALUE_FOLLOW_UP'],
    };
  }
  if (input.continueChoice === 'CONTINUE' || !input.naturalPause) reasonCodes.push('CONTINUE_WITH_ELDER_DIRECTION');
  return {
    action: 'CONTINUE', reason: 'CONTINUE_NATURAL', turnComplete, topicComplete,
    sessionComplete: false, topicStatus, resourceLimitReached, reasonCodes,
  };
}
