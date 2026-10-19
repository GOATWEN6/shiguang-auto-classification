import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateInterviewCompletion,
  evaluateTopicLedger,
  type TopicLedgerEvaluationState,
} from '../../../src/lib/interview-policy/index.ts';
import {
  evaluateAutoSaveWhitelist,
  planRetrievalLevels,
  type MemoryPolicyContext,
  type MemoryProposal,
} from '../../../src/lib/memory-runtime/index.ts';

const basePolicy: MemoryPolicyContext = {
  interactionPreferenceAutoSavePolicy: 'on',
  ordinaryMemoryAutoSavePolicy: 'on',
  interviewAutoOrganizePolicy: 'on',
  longitudinalObservationAuthorization: 'off',
  actorRole: 'elder',
  subjectId: 'elder-1',
  familySpaceId: 'family-1',
  purpose: 'daily_chat',
  visibilityScope: ['elder_only'],
  authorizationVersion: 'auth-v1',
};

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    proposalId: 'proposal-1',
    contentType: 'preference',
    normalizedClaim: '喜欢听评弹',
    query: '喜欢听评弹',
    topK: 3,
    eventTime: null,
    validFrom: null,
    validTo: null,
    handlingProfile: 'ordinary',
    retentionPolicy: 'long_term_reviewable',
    importanceReasons: [],
    sensitivityLevel: 'S0',
    sensitivityCategories: [],
    allowedUses: ['daily_chat'],
    forbiddenUses: [],
    reviewTrigger: 'elder_correction',
    expiryOrSupersedeRule: 'newer_explicit_preference',
    mustNotHappen: [],
    relationships: [],
    signals: {
      origin: 'SELF_REPORT',
      explicitRemember: false,
      explicitCorrection: false,
      governanceAction: 'NONE',
      containsCredential: false,
      conflict: false,
      ambiguousSubject: false,
      purposeExpansion: false,
      visibilityExpansion: false,
      shortTerm: false,
      interactionPreference: false,
      interviewMaterial: false,
      ordinaryMemory: true,
      reversible: true,
      auditable: true,
      temporalState: 'CURRENT',
    },
    sourceEvidenceRefs: ['evidence-1'],
    sourceActor: { actorId: 'elder-1', actorRole: 'elder' },
    ...overrides,
  };
}

test('topic ledger reaches USABLE and then RICH without requiring every facet', () => {
  const first = evaluateTopicLedger(null, {
    topicId: 'life-event', sourceRefs: ['turn-1'], observedFacets: ['EVENT', 'TIME'],
    hasDirectUserEvidence: true, hasAnchor: true,
  });
  assert.equal(first.operationalStatus, 'USABLE');
  assert.equal(first.status, 'COVERED');
  assert.deepEqual(first.coveredFacets, ['EVENT', 'TIME']);

  const second = evaluateTopicLedger(first, {
    topicId: 'life-event', sourceRefs: ['turn-2'], observedFacets: ['SCENE', 'MEANING'],
    hasDirectUserEvidence: true, hasAnchor: true, hasMeaningfulContext: true,
    userDirection: 'CONTINUE',
  });
  assert.equal(second.operationalStatus, 'RICH');
  assert.equal(second.completionReason, 'RICH_CONTEXT');
  assert.deepEqual(second.sourceRefs, ['turn-1', 'turn-2']);
});

test('elder skip and policy block are terminal for the current topic', () => {
  const state: TopicLedgerEvaluationState = {
    topicId: 'family-and-relationship', status: 'OPEN', operationalStatus: 'IN_PROGRESS',
    coveredFacets: ['PERSON'], sourceRefs: ['turn-1'], openLeadIds: ['lead-1'],
    followUpDepth: 1, questionCount: 1, completionReason: null, resumeHint: '以后再谈',
  };
  const skipped = evaluateTopicLedger(state, {
    topicId: state.topicId, sourceRefs: [], observedFacets: [], hasDirectUserEvidence: true,
    hasAnchor: false, userDirection: 'SKIP',
  });
  assert.equal(skipped.operationalStatus, 'SKIPPED_BY_ELDER');
  assert.equal(skipped.status, 'SKIPPED');

  const blocked = evaluateTopicLedger(null, {
    topicId: 'health', sourceRefs: ['turn-health'], observedFacets: ['EVENT'],
    hasDirectUserEvidence: true, hasAnchor: true, policyBlocked: true,
  });
  assert.equal(blocked.operationalStatus, 'BLOCKED');
  assert.equal(blocked.status, 'BLOCKED');
});

test('low-risk elder preference is the only ordinary candidate accepted by whitelist', () => {
  const decision = evaluateAutoSaveWhitelist(proposal({ signals: {
    ...proposal().signals, interactionPreference: true, ordinaryMemory: false,
  }, contentType: 'accessibility_preference' }), basePolicy);
  assert.equal(decision.disposition, 'AUTO_WRITE');
  assert.equal(decision.eligible, true);
  assert.equal(decision.policyVersion, 'sgx-memory-auto-save-whitelist-v0.1');
});

test('interview material, health, family reports and AI derivations do not enter autosave', () => {
  const interview = evaluateAutoSaveWhitelist(proposal({ signals: {
    ...proposal().signals, interviewMaterial: true, ordinaryMemory: false,
  }, contentType: 'life_event' }), basePolicy);
  assert.equal(interview.disposition, 'C2_BATCH_CONFIRM');

  const health = evaluateAutoSaveWhitelist(proposal({ sensitivityLevel: 'S2', signals: {
    ...proposal().signals, ordinaryMemory: false,
  }, contentType: 'health' }), basePolicy);
  assert.equal(health.disposition, 'C3_STRONG_CONFIRM');

  const family = evaluateAutoSaveWhitelist(proposal({ signals: {
    ...proposal().signals, origin: 'FAMILY_REPORT', ordinaryMemory: false,
  } }), basePolicy);
  assert.equal(family.disposition, 'SOURCED_ONLY');

  const derived = evaluateAutoSaveWhitelist(proposal({ signals: {
    ...proposal().signals, origin: 'AI_DERIVED', ordinaryMemory: false,
  } }), basePolicy);
  assert.equal(derived.disposition, 'NO_MEMORY');
});

test('retrieval levels are progressive and never default to sensitive R3', () => {
  const daily = planRetrievalLevels({ scene: 'DAILY_CHAT', authorizationVersion: 'auth-v1' });
  assert.equal(daily.maxAllowedLevel, 'R1');
  assert.equal(daily.allowedLevels.includes('R3'), false);

  const interview = planRetrievalLevels({
    scene: 'FORMAL_INTERVIEW', userMentionedRelatedHistory: true, authorizationVersion: 'auth-v1',
  });
  assert.equal(interview.maxAllowedLevel, 'R2');
  assert.equal(interview.expansionAllowed, true);

  const blockedSensitive = planRetrievalLevels({
    scene: 'FORMAL_INTERVIEW', userMentionedRelatedHistory: true,
    explicitSensitiveAuthorization: false, authorizationVersion: 'auth-v1',
  });
  assert.equal(blockedSensitive.maxAllowedLevel, 'R2');
  assert.equal(blockedSensitive.allowedLevels.includes('R3'), false);

  const authorizedReview = planRetrievalLevels({
    scene: 'COGNITIVE_REVIEW', explicitSensitiveAuthorization: true,
    authorizationVersion: 'auth-v1',
  });
  assert.equal(authorizedReview.maxAllowedLevel, 'R3');
});

test('completion separates natural pause, explicit end and resource ceiling', () => {
  const common = {
    inputFinal: true, responseReady: true, ttsSettled: true, memoryTaskSettled: true,
    continueChoice: 'UNKNOWN' as const, hasUsefulNextAction: true, topicStatus: 'USABLE' as const,
    elapsedMinutes: 3, questionCount: 2, maxMinutes: 20, maxQuestions: 12,
  };
  const pause = evaluateInterviewCompletion({ ...common, naturalPause: true });
  assert.equal(pause.action, 'OFFER_CHOICES');
  assert.equal(pause.sessionComplete, false);
  assert.equal(pause.topicComplete, true);

  const ended = evaluateInterviewCompletion({ ...common, explicitEnd: true, continueChoice: 'STOP' });
  assert.equal(ended.action, 'END');
  assert.equal(ended.reason, 'ELDER_ENDED');

  const capped = evaluateInterviewCompletion({ ...common, elapsedMinutes: 20 });
  assert.equal(capped.action, 'END');
  assert.equal(capped.reason, 'RESOURCE_LIMIT');
});

test('completion does not claim a topic is complete when only the turn settled', () => {
  const result = evaluateInterviewCompletion({
    inputFinal: true, responseReady: true, ttsSettled: true, memoryTaskSettled: true,
    continueChoice: 'CONTINUE', hasUsefulNextAction: true, topicStatus: 'IN_PROGRESS',
    elapsedMinutes: 1, questionCount: 1, maxMinutes: 20, maxQuestions: 12,
  });
  assert.equal(result.turnComplete, true);
  assert.equal(result.topicComplete, false);
  assert.equal(result.sessionComplete, false);
});

test('pending asynchronous Memory does not delay the next turn', () => {
  const result = evaluateInterviewCompletion({
    inputFinal: true, responseReady: true, ttsSettled: true, memoryTaskSettled: false,
    continueChoice: 'CONTINUE', hasUsefulNextAction: true, topicStatus: 'IN_PROGRESS',
    elapsedMinutes: 1, questionCount: 1, maxMinutes: 20, maxQuestions: 12,
  });
  assert.equal(result.turnComplete, true);
  assert.equal(result.sessionComplete, false);
  assert.ok(result.reasonCodes.includes('MEMORY_ASYNC_PENDING'));
});
