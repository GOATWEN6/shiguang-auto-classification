import type { RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import {
  assertLiveInterviewDecisionRequest,
  type LiveInterviewDecisionRequest,
} from '../interview-policy/contracts.ts';
import type {
  DailyChatAccessContext,
  DailyChatAccessContextResolver,
  DailyChatReferenceResolver,
  InterviewDecisionRequestResolver,
  TrustedDailyChatReference,
} from '../response-runtime/contracts.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertStringArray,
  cloneIdentity,
  type BoundTurnContext,
  type FinalEvidenceReader,
  type FinalTurnEvidence,
  type GovernedSessionStoreReader,
} from './contracts.ts';

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateAccessContext(value: unknown): asserts value is DailyChatAccessContext {
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
}

function accessFor(bound: BoundTurnContext): DailyChatAccessContext {
  return {
    subjectId: bound.authority.subjectId,
    familySpaceId: bound.authority.familySpaceId,
    authorizationVersion: bound.authority.authorizationVersion,
    visibilityScope: [...bound.authority.visibilityScope],
  };
}

function sameAccess(left: DailyChatAccessContext, right: DailyChatAccessContext): boolean {
  return left.subjectId === right.subjectId
    && left.familySpaceId === right.familySpaceId
    && left.authorizationVersion === right.authorizationVersion
    && sameStrings(left.visibilityScope, right.visibilityScope);
}

function sameResponseIdentity(evidence: FinalTurnEvidence, bound: BoundTurnContext): boolean {
  return evidence.sessionId === bound.sessionId
    && evidence.identity.sessionEpoch === bound.identity.sessionEpoch
    && evidence.identity.turnId === bound.identity.turnId
    && evidence.identity.generationId === bound.identity.generationId
    && evidence.identity.invocationId === bound.identity.invocationId
    && evidence.identity.responseId === bound.identity.responseId
    && evidence.identity.evidenceRefs.length === 0;
}

function evidenceAllowed(
  evidence: FinalTurnEvidence,
  bound: BoundTurnContext,
  expectedPurpose: FinalTurnEvidence['purpose'],
): boolean {
  return bound.identity.evidenceRefs.includes(evidence.evidenceId)
    && sameResponseIdentity(evidence, bound)
    && evidence.purpose === expectedPurpose
    && evidence.actorId === bound.authority.actorId
    && evidence.subjectId === bound.authority.subjectId
    && evidence.familySpaceId === bound.authority.familySpaceId
    && evidence.authorizationVersion === bound.authority.authorizationVersion
    && sameStrings(evidence.visibilityScope, bound.authority.visibilityScope);
}

export function createDailyChatAccessContextResolver(
  sessions: GovernedSessionStoreReader,
): DailyChatAccessContextResolver {
  if (!sessions) throw new TypeError('sessions is required');
  return {
    resolve(identity: RuntimeIdentity): DailyChatAccessContext | null {
      const bound = sessions.resolveBoundTurn(identity);
      if (!bound || bound.mode !== 'DAILY_CHAT') return null;
      return accessFor(bound);
    },
  };
}

export function createDailyChatReferenceResolver(
  sessions: GovernedSessionStoreReader,
  evidenceStore: FinalEvidenceReader,
): DailyChatReferenceResolver {
  if (!sessions) throw new TypeError('sessions is required');
  if (!evidenceStore) throw new TypeError('evidenceStore is required');
  return {
    resolve(
      ref: string,
      accessContext: DailyChatAccessContext,
      identity: RuntimeIdentity,
    ): TrustedDailyChatReference | null {
      assertNonEmptyString(ref, 'ref');
      validateAccessContext(accessContext);
      const bound = sessions.resolveBoundTurn(identity);
      if (!bound || bound.mode !== 'DAILY_CHAT') return null;
      if (!sameAccess(accessContext, accessFor(bound))) return null;
      if (!bound.identity.evidenceRefs.includes(ref)) return null;
      const evidence = evidenceStore.get(ref);
      if (!evidence || !evidenceAllowed(evidence, bound, 'daily_chat')) return null;
      return {
        ref: evidence.evidenceId,
        text: evidence.text,
        purpose: 'daily_chat',
        subjectId: evidence.subjectId,
        familySpaceId: evidence.familySpaceId,
        authorizationVersion: evidence.authorizationVersion,
        visibilityScope: [...evidence.visibilityScope],
      };
    },
  };
}

function decisionRequestFor(
  bound: BoundTurnContext,
  evidence: FinalTurnEvidence,
  previousCompletedUserEvidenceRef: string | null,
): LiveInterviewDecisionRequest {
  const runtimeRef = bound.runtimeState.ref;
  if (runtimeRef !== null && !bound.identity.evidenceRefs.includes(runtimeRef)) {
    throw new Error('runtime evidence ref is not bound to the governed turn');
  }
  const runtimeSignalRequiresEvidence = bound.runtimeState.network === 'OFFLINE'
    || bound.runtimeState.provider === 'TIMEOUT'
    || bound.runtimeState.vad === 'SPEAKING'
    || bound.runtimeState.tts === 'PLAYING'
    || bound.runtimeState.silenceSeconds !== undefined
    || bound.runtimeState.waitPreferenceSeconds !== undefined;
  if (runtimeSignalRequiresEvidence && runtimeRef === null) {
    throw new Error('decision-affecting runtime state requires governed evidence');
  }
  const request: LiveInterviewDecisionRequest = {
    input: {
      mode: 'FORMAL_INTERVIEW',
      sessionStatus: bound.status,
      currentTopic: bound.interviewState.currentTopic,
      selectedTopic: bound.interviewState.selectedTopic,
      pendingModeOffer: bound.interviewState.pendingModeOffer,
      followUpDepth: bound.interviewState.followUpDepth,
      previousCompletedUserEvidenceRef,
      sessionEpoch: bound.identity.sessionEpoch,
      asr: {
        status: 'FINAL',
        text: evidence.text,
        ref: evidence.evidenceId,
      },
      uiEvent: null,
      runtime: {
        vad: bound.runtimeState.vad,
        tts: bound.runtimeState.tts,
        network: bound.runtimeState.network,
        provider: bound.runtimeState.provider,
        ref: runtimeRef,
        sessionEpoch: bound.identity.sessionEpoch,
        generationId: bound.identity.generationId,
        ...(bound.runtimeState.silenceSeconds === undefined
          ? {}
          : { silenceSeconds: bound.runtimeState.silenceSeconds }),
        ...(bound.runtimeState.waitPreferenceSeconds === undefined
          ? {}
          : { waitPreferenceSeconds: bound.runtimeState.waitPreferenceSeconds }),
      },
      incomingEvent: null,
      blockedTopics: [...bound.interviewState.blockedTopics],
      memoryRefs: [],
    },
    identity: cloneIdentity(bound.identity),
  };
  assertLiveInterviewDecisionRequest(request);
  return request;
}

export function createInterviewDecisionRequestResolver(
  sessions: GovernedSessionStoreReader,
  evidenceStore: FinalEvidenceReader,
): InterviewDecisionRequestResolver {
  if (!sessions) throw new TypeError('sessions is required');
  if (!evidenceStore) throw new TypeError('evidenceStore is required');
  return {
    resolve(identity: RuntimeIdentity): LiveInterviewDecisionRequest {
      const bound = sessions.resolveBoundTurn(identity);
      if (!bound) throw new Error('no exact bound turn for Interview decision');
      if (bound.mode !== 'FORMAL_INTERVIEW') {
        throw new Error('Interview decision requires a FORMAL_INTERVIEW session');
      }
      if (bound.identity.evidenceRefs.length !== 1) {
        throw new Error('Interview decision requires exactly one governed final-turn evidence ref');
      }
      const evidence = evidenceStore.get(bound.identity.evidenceRefs[0]);
      if (!evidence || !evidenceAllowed(evidence, bound, 'formal_interview')) {
        throw new Error('Interview final-turn evidence is missing or outside the governed scope');
      }
      const previous = evidenceStore.getPreviousCompletedInSession(evidence.evidenceId);
      return structuredClone(decisionRequestFor(bound, evidence, previous?.evidenceId ?? null));
    },
  };
}
