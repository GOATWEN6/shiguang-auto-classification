import {
  assertRuntimeIdentity,
  type RuntimeIdentity,
} from '../algorithm-runtime/index.ts';
import type {
  DailyChatAccessContext,
  DailyChatDecisionRequest,
  DailyChatGenerationPlan,
  InterviewGenerationPlan,
  InterviewRealizerRequest,
  TrustedDailyChatReference,
} from './contracts.ts';
import { hasUnsupportedEmotionAssertion } from './spoken-text.ts';

type PlainRecord = Record<string, unknown>;

function assertPlainRecord(value: unknown, field: string): asserts value is PlainRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${field} must be a plain object`);
  }
}

function assertExactKeys(value: PlainRecord, allowed: readonly string[], field: string): void {
  const allowedKeys = new Set<PropertyKey>(allowed);
  for (const key of Reflect.ownKeys(value)) {
    if (!allowedKeys.has(key)) throw new TypeError(`${field}.${String(key)} is not allowed`);
  }
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertStringArray(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  value.forEach((item, index) => assertNonEmptyString(item, `${field}[${index}]`));
}

function assertNoDuplicates(value: readonly string[], field: string): void {
  if (new Set(value).size !== value.length) throw new TypeError(`${field} must not contain duplicates`);
}

function assertExactRuntimeIdentity(value: unknown, field: string): asserts value is RuntimeIdentity {
  assertPlainRecord(value, field);
  assertExactKeys(
    value,
    ['sessionEpoch', 'turnId', 'generationId', 'invocationId', 'responseId', 'evidenceRefs'],
    field,
  );
  assertRuntimeIdentity(value as unknown as RuntimeIdentity);
  assertNoDuplicates((value as unknown as RuntimeIdentity).evidenceRefs, `${field}.evidenceRefs`);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function questionMarkCount(text: string): number {
  return [...text].filter(character => character === '?' || character === '？').length;
}

export function assertExactLivePolicyRequest(value: unknown): void {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['input', 'identity'], 'request');
}

export function assertDailyChatDecisionRequest(value: unknown): asserts value is DailyChatDecisionRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'identity', 'intent'], 'request');
  if (value.schemaVersion !== 'daily-chat-decision-v0.1') {
    throw new TypeError('request.schemaVersion must be daily-chat-decision-v0.1');
  }
  if (value.intent !== 'ACKNOWLEDGE' && value.intent !== 'RESPOND') {
    throw new TypeError('request.intent is invalid');
  }
  assertExactRuntimeIdentity(value.identity, 'request.identity');
}

export function assertInterviewRealizerRequest(value: unknown): asserts value is InterviewRealizerRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'identity'], 'request');
  if (value.schemaVersion !== 'interview-realizer-request-v0.1') {
    throw new TypeError('request.schemaVersion must be interview-realizer-request-v0.1');
  }
  assertExactRuntimeIdentity(value.identity, 'request.identity');
}

export function validateDailyChatAccessContext(value: unknown): DailyChatAccessContext {
  assertPlainRecord(value, 'accessContext');
  assertExactKeys(
    value,
    ['subjectId', 'familySpaceId', 'authorizationVersion', 'visibilityScope'],
    'accessContext',
  );
  assertNonEmptyString(value.subjectId, 'accessContext.subjectId');
  assertNonEmptyString(value.familySpaceId, 'accessContext.familySpaceId');
  assertNonEmptyString(value.authorizationVersion, 'accessContext.authorizationVersion');
  assertStringArray(value.visibilityScope, 'accessContext.visibilityScope');
  if (value.visibilityScope.length === 0) {
    throw new TypeError('accessContext.visibilityScope must not be empty');
  }
  assertNoDuplicates(value.visibilityScope, 'accessContext.visibilityScope');
  return {
    subjectId: value.subjectId,
    familySpaceId: value.familySpaceId,
    authorizationVersion: value.authorizationVersion,
    visibilityScope: [...value.visibilityScope],
  };
}

export function validateTrustedDailyChatReference(
  value: unknown,
  expectedRef: string,
): TrustedDailyChatReference | null {
  if (value === null) return null;
  assertPlainRecord(value, 'resolvedReference');
  assertExactKeys(
    value,
    [
      'ref',
      'text',
      'purpose',
      'subjectId',
      'familySpaceId',
      'authorizationVersion',
      'visibilityScope',
    ],
    'resolvedReference',
  );
  if (value.ref !== expectedRef) throw new TypeError('resolvedReference.ref does not match requested ref');
  assertNonEmptyString(value.ref, 'resolvedReference.ref');
  if (typeof value.text !== 'string') throw new TypeError('resolvedReference.text must be a string');
  if (!['daily_chat', 'formal_interview', 'story', 'profile'].includes(String(value.purpose))) {
    throw new TypeError('resolvedReference.purpose is invalid');
  }
  assertNonEmptyString(value.subjectId, 'resolvedReference.subjectId');
  assertNonEmptyString(value.familySpaceId, 'resolvedReference.familySpaceId');
  assertNonEmptyString(value.authorizationVersion, 'resolvedReference.authorizationVersion');
  assertStringArray(value.visibilityScope, 'resolvedReference.visibilityScope');
  if (value.visibilityScope.length === 0) {
    throw new TypeError('resolvedReference.visibilityScope must not be empty');
  }
  assertNoDuplicates(value.visibilityScope, 'resolvedReference.visibilityScope');
  return {
    ref: value.ref,
    text: value.text,
    purpose: value.purpose as TrustedDailyChatReference['purpose'],
    subjectId: value.subjectId,
    familySpaceId: value.familySpaceId,
    authorizationVersion: value.authorizationVersion,
    visibilityScope: [...value.visibilityScope],
  };
}

export interface ValidDailyChatOutput {
  text: string;
  questionCount: 0 | 1;
  evidenceRefs: string[];
}

export function validateDailyChatOutput(
  value: unknown,
  plan: DailyChatGenerationPlan,
): ValidDailyChatOutput | null {
  try {
    assertPlainRecord(value, 'dailyChatOutput');
    assertExactKeys(
      value,
      ['schemaVersion', 'planId', 'mode', 'intent', 'text', 'questions', 'evidenceRefs'],
      'dailyChatOutput',
    );
    if (
      value.schemaVersion !== '0.1'
      || value.planId !== plan.planId
      || value.mode !== 'DAILY_CHAT'
      || value.intent !== plan.intent
    ) return null;
    assertNonEmptyString(value.text, 'dailyChatOutput.text');
    assertStringArray(value.questions, 'dailyChatOutput.questions');
    assertStringArray(value.evidenceRefs, 'dailyChatOutput.evidenceRefs');
    assertNoDuplicates(value.evidenceRefs, 'dailyChatOutput.evidenceRefs');
    const count = questionMarkCount(value.text);
    if (count > plan.maxQuestions || value.questions.length !== count) return null;
    if (count === 1 && (!value.text.endsWith(value.questions[0])
      || questionMarkCount(value.questions[0]) !== 1)) return null;
    const allowed = new Set(plan.allowedEvidenceRefs);
    if (value.evidenceRefs.some(ref => !allowed.has(ref))) return null;
    return { text: value.text, questionCount: count as 0 | 1, evidenceRefs: [...value.evidenceRefs] };
  } catch {
    return null;
  }
}

export interface ValidInterviewOutput {
  text: string;
}

export function validateInterviewOutput(
  value: unknown,
  plan: InterviewGenerationPlan,
): ValidInterviewOutput | null {
  try {
    assertPlainRecord(value, 'interviewOutput');
    assertExactKeys(
      value,
      [
        'schemaVersion',
        'decisionId',
        'mode',
        'action',
        'retentionIntent',
        'questionCount',
        'evidenceRefs',
        'topicId',
        'text',
        'questions',
      ],
      'interviewOutput',
    );
    if (
      value.schemaVersion !== '0.1'
      || value.decisionId !== plan.decisionId
      || value.mode !== 'FORMAL_INTERVIEW'
      || value.action !== plan.action
      || value.retentionIntent !== 'DEFAULT'
      || value.questionCount !== plan.questionCount
      || value.topicId !== plan.topicId
    ) return null;
    assertNonEmptyString(value.text, 'interviewOutput.text');
    if (plan.questionCount === 0 && value.text !== plan.frozenPolicyText) return null;
    assertStringArray(value.evidenceRefs, 'interviewOutput.evidenceRefs');
    assertNoDuplicates(value.evidenceRefs, 'interviewOutput.evidenceRefs');
    if (!sameStrings(value.evidenceRefs, plan.evidenceRefs)) return null;
    assertStringArray(value.questions, 'interviewOutput.questions');
    if (value.questions.length !== plan.questionCount
      || questionMarkCount(value.text as string) !== plan.questionCount) return null;
    if (plan.questionCount === 1 && (
      !String(value.text).endsWith(value.questions[0])
      || questionMarkCount(value.questions[0]) !== 1
      || value.text.length > 300
      || hasUnsupportedEmotionAssertion(value.text, plan.frozenPolicyText)
    )) return null;
    return { text: value.text as string };
  } catch {
    return null;
  }
}

export function knownIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return {
    sessionEpoch: identity.sessionEpoch,
    turnId: identity.turnId,
    generationId: identity.generationId,
    invocationId: identity.invocationId,
    ...(identity.responseId === undefined ? {} : { responseId: identity.responseId }),
    evidenceRefs: [...identity.evidenceRefs],
  };
}

export function sameExactIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionEpoch === right.sessionEpoch
    && left.turnId === right.turnId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId
    && left.responseId === right.responseId
    && sameStrings(left.evidenceRefs, right.evidenceRefs);
}
