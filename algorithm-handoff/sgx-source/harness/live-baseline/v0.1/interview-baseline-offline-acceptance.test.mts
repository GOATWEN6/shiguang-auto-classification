import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canUseRetrievalLevel,
  planRetrievalLevels,
} from '../../../src/lib/memory-runtime/index.ts';
import {
  decideInterviewNextActionWithContinuation,
  evaluateInterviewCompletion,
  evaluateTopicLedger as evaluateInterviewTopicLedger,
  resolveInterviewInvitationResponse,
  type InterviewPolicyInput,
} from '../../../src/lib/interview-policy/index.ts';
import {
  findUnsupportedEventPrecondition,
  hasUnsupportedEmotionAssertion,
} from '../../../src/lib/response-runtime/index.ts';
import { validateSemanticTurnShadowProposal } from '../../../src/lib/algorithm-service/index.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const CASES = JSON.parse(fs.readFileSync(
  path.join(REPO_ROOT, 'harness/oss-p0/interview/cases.json'), 'utf8',
)).cases as Array<{ id: string; input: InterviewPolicyInput }>;

function fixture(id: string): InterviewPolicyInput {
  const found = CASES.find(item => item.id === id);
  assert.ok(found, `missing frozen fixture ${id}`);
  return structuredClone(found.input);
}

function liveRequest(input: InterviewPolicyInput, suffix: string) {
  const next = structuredClone(input) as InterviewPolicyInput & {
    sessionEpoch: string;
    runtime: InterviewPolicyInput['runtime'] & { sessionEpoch: string; generationId: number };
  };
  const sessionEpoch = `offline-${suffix}`;
  const generationId = 1;
  next.sessionEpoch = sessionEpoch;
  next.runtime = { ...next.runtime, sessionEpoch, generationId };
  const evidenceRefs = [
    next.asr.ref,
    next.runtime.ref,
    next.uiEvent?.ref,
    next.incomingEvent?.ref,
    ...next.memoryRefs.map(item => item.ref),
  ].filter((ref): ref is string => Boolean(ref));
  return {
    input: next,
    identity: {
      sessionEpoch,
      turnId: `turn-${suffix}`,
      generationId,
      invocationId: `invocation-${suffix}`,
      evidenceRefs,
    },
  };
}

function decide(input: InterviewPolicyInput, suffix: string) {
  return decideInterviewNextActionWithContinuation(liveRequest(input, suffix));
}

function textFixture(
  text: string,
  overrides: Partial<InterviewPolicyInput> = {},
): InterviewPolicyInput {
  return {
    mode: 'FORMAL_INTERVIEW',
    sessionStatus: 'ACTIVE',
    currentTopic: '第一次工作',
    selectedTopic: null,
    pendingModeOffer: null,
    followUpDepth: 0,
    asr: { status: 'FINAL', text, ref: `turn:offline:${text.slice(0, 4)}` },
    uiEvent: null,
    runtime: { vad: 'SILENT', tts: 'IDLE', network: 'ONLINE', provider: 'READY' },
    blockedTopics: [],
    memoryRefs: [],
    ...overrides,
  };
}

function shadowProposal(text: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '0.1',
    intentKind: 'CONTINUE',
    shareInterest: 'EXPLICIT',
    proposal: {
      schemaVersion: '0.1',
      userIntent: 'CONTINUE_TOPIC',
      topicId: 'work',
      observedFacets: ['EVENT'],
      sourceSpans: [{ evidenceRef: 'turn:shadow', quote: text }],
      memoryCandidates: [],
      relatedMemoryQuery: null,
      userUncertainty: 'LOW',
      needsClarification: false,
    },
    narrativeCues: [{
      cueId: 'cue-1', kind: 'EVENT_TURN', epistemic: 'EXPLICIT',
      sourceEvidenceRefs: ['turn:shadow'], topicId: 'work',
    }],
    nextActionCandidates: [{
      candidateId: 'candidate-1', action: 'FOLLOW_UP', topicId: 'work',
      premiseRefs: ['turn:shadow', 'cue-1'], reasonCodes: ['NEW_DETAIL'],
      proposedQuestionIntent: '询问一个具体片段',
    }],
    ...overrides,
  };
}

function includesReason(decision: { reasonCodes: string[] }, reason: string): void {
  assert.ok(decision.reasonCodes.includes(reason), `${reason} missing from ${decision.reasonCodes.join(',')}`);
}

function patchValue(decision: { statePatch: Record<string, unknown> }, key: string, expected: unknown): void {
  assert.deepEqual(decision.statePatch[key], expected, `statePatch.${key}`);
}

test('T-01 explicit topic switch follows the elder direction', () => {
  const decision = decide(fixture('I-010'), 't01');
  assert.equal(decision.interviewAction, 'SWITCH_TOPIC');
  includesReason(decision, 'EXPLICIT_SWITCH_TOPIC');
  patchValue(decision, 'currentTopic', '种花');
  assert.equal(decision.utterancePlan.questionCount, 1);
});

test('T-02 thinking is WAIT and is not treated as refusal', () => {
  const decision = decide(textFixture('我想想……'), 't02');
  assert.equal(decision.interactionAction, 'WAIT');
  assert.equal(decision.interviewAction, 'NONE');
  includesReason(decision, 'ELDER_THINKING');
  assert.deepEqual(decision.statePatch, {});
  assert.equal(decision.utterancePlan.questionCount, 0);
});

test('T-03 uncertain years remain uncertain instead of being selected by policy', () => {
  const decision = decide(fixture('I-008'), 't03');
  assert.equal(decision.interviewAction, 'CLARIFY');
  includesReason(decision, 'CONFLICTING_TIME_CLAIMS');
  assert.equal(decision.uncertainty, 'HIGH');
  assert.doesNotMatch(decision.utterancePlan.suggestedText, /1958|1968/u);
});

test('T-04 privacy and no-repeat-topic instructions stop the topic immediately', () => {
  const decision = decide(fixture('I-036'), 't04');
  assert.equal(decision.interviewAction, 'SWITCH_TOPIC');
  includesReason(decision, 'PRIVACY_RESTRICTION');
  includesReason(decision, 'EXPLICIT_TABOO');
  patchValue(decision, 'blockedTopicsAdd', ['家庭矛盾']);
  assert.deepEqual(decision.memoryCandidates, []);
});

test('T-05 model inference cannot become an unverified premise or memory source', () => {
  const result = validateSemanticTurnShadowProposal({
    ...shadowProposal('我以前在纺织厂工作。'),
    narrativeCues: [{
      cueId: 'cue-1', kind: 'EVENT_TURN', epistemic: 'MODEL_INFERENCE',
      sourceEvidenceRefs: ['turn:shadow'], topicId: 'work',
    }],
    nextActionCandidates: [{
      candidateId: 'candidate-1', action: 'FOLLOW_UP', topicId: 'work',
      premiseRefs: ['unverified-premise'], reasonCodes: ['MODEL_GUESS'],
      proposedQuestionIntent: '询问一个具体片段',
    }],
  }, {
    mode: 'FORMAL_INTERVIEW', currentTopic: '第一次工作',
    evidenceText: '我以前在纺织厂工作。', allowedEvidenceRefs: ['turn:shadow'],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('NEXT_ACTION_CANDIDATE_0_PREMISE_REF_NOT_VALIDATED'));
});

test('T-06 an engaged narrative gets one relevant follow-up', () => {
  const decision = decide(fixture('I-003'), 't06');
  assert.equal(decision.interviewAction, 'FOLLOW_UP');
  includesReason(decision, 'LONG_ENGAGED_RESPONSE');
  assert.equal(decision.utterancePlan.questionCount, 1);
  assert.equal(decision.interactionAction, 'NONE');
});

test('T-07 unsupported emotional certainty is guarded and rewritten conditionally', () => {
  assert.equal(hasUnsupportedEmotionAssertion('想必他一定很幸福吧。', '他说那天去上班。'), true);
  const guarded = findUnsupportedEventPrecondition('您结婚那天一定很幸福吧？', '我在机械厂工作。');
  assert.equal(guarded?.code, 'MARRIAGE');
  assert.match(guarded?.question ?? '', /如果后来有过成家或婚礼/u);
});

test('T-08 explicit refusal blocks the current direction, while an ambiguous phrase is not made permanent', () => {
  const refused = decide(fixture('I-011'), 't08-refused');
  assert.equal(refused.interviewAction, 'SWITCH_TOPIC');
  patchValue(refused, 'blockedTopicsAdd', ['父亲去世']);

  const ambiguous = decide(textFixture('这件事一言难尽。'), 't08-ambiguous');
  assert.equal(ambiguous.statePatch.blockedTopicsAdd, undefined);
  assert.notEqual(ambiguous.interviewAction, 'SWITCH_TOPIC');
  assert.equal(ambiguous.memoryCandidates.length, 0);
});

test('T-09 a blocked topic cannot be reintroduced because it has high coverage value', () => {
  const decision = decide(fixture('I-013'), 't09');
  assert.equal(decision.interviewAction, 'SWITCH_TOPIC');
  includesReason(decision, 'BLOCKED_TOPIC');
  patchValue(decision, 'currentTopic', null);
  assert.doesNotMatch(decision.utterancePlan.suggestedText, /亲戚矛盾/u);
});

test('T-10 daily-chat history sharing does not silently enter formal interview', () => {
  const decision = decide(textFixture('我以前在上海工作，今天只是想随便聊聊。', {
    mode: 'DAILY_CHAT', currentTopic: null,
  }), 't10');
  assert.equal(decision.mode, 'DAILY_CHAT');
  assert.notEqual(decision.reasonCodes.includes('EXPLICIT_MODE_ENTRY'), true);
  assert.equal(decision.statePatch.mode, undefined);
});

test('T-11 explicit entry enters formal interview without granting save or sharing authority', () => {
  const decision = decide(fixture('I-001'), 't11');
  assert.equal(decision.mode, 'FORMAL_INTERVIEW');
  includesReason(decision, 'EXPLICIT_MODE_ENTRY');
  patchValue(decision, 'mode', 'FORMAL_INTERVIEW');
  assert.equal(decision.retentionControl.intent, 'DEFAULT');
  assert.deepEqual(decision.memoryCandidates, []);
});

test('T-12 a declined pending invitation is cleared for this session and cannot repeat automatically', () => {
  const declinedInput = textFixture('不用，先日常聊吧。', {
    mode: 'DAILY_CHAT', currentTopic: null, pendingModeOffer: 'FORMAL_INTERVIEW',
  });
  const declined = decide(declinedInput, 't12-decline');
  assert.equal(declined.mode, 'DAILY_CHAT');
  includesReason(declined, 'INVITATION_DECLINED');
  patchValue(declined, 'pendingModeOffer', null);

  const later = decide(textFixture('我想聊聊以前的事。', {
    mode: 'DAILY_CHAT', currentTopic: null, pendingModeOffer: null,
  }), 't12-later');
  assert.equal(later.mode, 'DAILY_CHAT');
  assert.notEqual(later.reasonCodes.includes('EXPLICIT_MODE_ENTRY'), true);
});

test('T-13 an ambiguous response before invitation delivery cannot enter interview', () => {
  const result = resolveInterviewInvitationResponse(
    { invitationId: 'inv-1', generationId: 3, deliveryState: 'SENDING' },
    { invitationId: 'inv-1', generationId: 3, text: '嗯' },
  );
  assert.deepEqual(result, { disposition: 'CLARIFY', reasonCode: 'INVITATION_NOT_DELIVERED' });
});

test('T-14 a paused interview resumes only after an explicit continuation signal', () => {
  const decision = decide(textFixture('我想接着说那段工作。', {
    sessionStatus: 'PAUSED', currentTopic: '第一份工作',
  }), 't14');
  assert.equal(decision.mode, 'FORMAL_INTERVIEW');
  includesReason(decision, 'RESUME_INTERVIEW');
  patchValue(decision, 'sessionStatus', 'ACTIVE');
  assert.notEqual(decision.interactionAction, 'END');
});

test('T-15 without continuation permission retrieval stays below related-history and sensitive levels', () => {
  const plan = planRetrievalLevels({
    scene: 'FORMAL_INTERVIEW', userMentionedRelatedHistory: true,
    purposeAuthorized: false, visibilityAuthorized: false, authorizationVersion: 'auth-v1',
  });
  assert.equal(canUseRetrievalLevel(plan, 'R2'), false);
  assert.equal(canUseRetrievalLevel(plan, 'R3'), false);
  assert.ok(plan.reasonCodes.includes('PURPOSE_NOT_AUTHORIZED'));
  assert.ok(plan.reasonCodes.includes('VISIBILITY_NOT_AUTHORIZED'));
});

test('T-16 a request to stop invitations is not silently converted into a permanent topic block', () => {
  const decision = decide(textFixture('以后别再邀请我做访谈。', {
    mode: 'DAILY_CHAT', currentTopic: null,
  }), 't16');
  assert.equal(decision.mode, 'DAILY_CHAT');
  assert.equal(decision.statePatch.blockedTopicsAdd, undefined);
  assert.equal(decision.statePatch.sessionStatus, undefined);
});

test('T-17 a public-speaker request cannot expand retrieval to private or sensitive levels', () => {
  const plan = planRetrievalLevels({
    scene: 'FORMAL_INTERVIEW', userMentionedRelatedHistory: true,
    purposeAuthorized: true, visibilityAuthorized: false,
    explicitSensitiveAuthorization: false, authorizationVersion: 'auth-v1',
  });
  assert.equal(canUseRetrievalLevel(plan, 'R2'), false);
  assert.equal(canUseRetrievalLevel(plan, 'R3'), false);
  assert.ok(plan.reasonCodes.includes('VISIBILITY_NOT_AUTHORIZED'));
});

test('T-18 elder refusal wins over topic coverage', () => {
  const ledger = evaluateInterviewTopicLedger(null, {
    topicId: 'family-conflict', sourceRefs: ['turn:t18'], observedFacets: ['EVENT'],
    hasDirectUserEvidence: true, hasAnchor: true, policyBlocked: false, userDirection: 'SKIP',
  });
  assert.equal(ledger.status, 'SKIPPED');
  assert.equal(ledger.operationalStatus, 'SKIPPED_BY_ELDER');
  const completion = evaluateInterviewCompletion({
    inputFinal: true, responseReady: true, ttsSettled: true, memoryTaskSettled: true,
    explicitEnd: false, explicitPause: false, naturalPause: false,
    continueChoice: 'STOP', hasUsefulNextAction: true, topicStatus: 'IN_PROGRESS',
    elapsedMinutes: 2, questionCount: 2, maxMinutes: 20, maxQuestions: 12,
  });
  assert.equal(completion.action, 'END');
});

test('T-19 ending formal interview has a terminal guard; a new daily session remains available', () => {
  const ended = decide(fixture('I-029'), 't19-end');
  assert.equal(ended.interactionAction, 'END');
  patchValue(ended, 'sessionStatus', 'ENDED');
  assert.equal(ended.runtimeControl.generation.cancelRequested, true);
  const daily = decide(textFixture('今天先聊点家常。', {
    mode: 'DAILY_CHAT', currentTopic: null,
  }), 't19-daily');
  assert.equal(daily.mode, 'DAILY_CHAT');
  assert.notEqual(daily.interactionAction, 'END');
});

test('T-20 “记不清” stays a low-pressure offer and does not force a refusal', () => {
  const decision = decide(fixture('I-019'), 't20');
  assert.equal(decision.interviewAction, 'OFFER_TOPIC');
  includesReason(decision, 'MEMORY_GAP');
  assert.equal(decision.uncertainty, 'LOW');
  assert.equal(decision.statePatch.blockedTopicsAdd, undefined);
});

test('T-21 a late invitation acceptance from an old generation is ignored', () => {
  const result = resolveInterviewInvitationResponse(
    { invitationId: 'inv-current', generationId: 4, deliveryState: 'DELIVERED' },
    { invitationId: 'inv-current', generationId: 3, text: '可以' },
  );
  assert.deepEqual(result, { disposition: 'IGNORE_STALE', reasonCode: 'INVITATION_STALE_GENERATION' });
});

test('T-22 a NarrativeCue without a validated source is rejected before question planning', () => {
  const result = validateSemanticTurnShadowProposal({
    ...shadowProposal('我以前在纺织厂工作。'),
    narrativeCues: [{
      cueId: 'cue-1', kind: 'EVENT_TURN', epistemic: 'EXPLICIT',
      sourceEvidenceRefs: ['unverified'], topicId: 'work',
    }],
  }, {
    mode: 'FORMAL_INTERVIEW', currentTopic: '第一次工作',
    evidenceText: '我以前在纺织厂工作。', allowedEvidenceRefs: ['turn:shadow'],
  });
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('NARRATIVE_CUE_0_SOURCE_REF_NOT_VALIDATED'));
});

test('T-23 history sharing in daily chat remains daily chat until explicit entry', () => {
  const decision = decide(textFixture('我以前在上海工作，后来常去河边散步。', {
    mode: 'DAILY_CHAT', currentTopic: null,
  }), 't23');
  assert.equal(decision.mode, 'DAILY_CHAT');
  assert.equal(decision.statePatch.mode, undefined);
  assert.notEqual(decision.reasonCodes.includes('EXPLICIT_MODE_ENTRY'), true);
});

test('T-24 an explicit user click can enter interview after an earlier declined invitation', () => {
  const decision = decide({
    ...fixture('I-001'),
    pendingModeOffer: null,
    asr: { status: 'NONE', text: '', ref: null },
    uiEvent: { type: 'MEMORY_TOPIC_CLICK', ref: 'ui:t24:entry' },
  }, 't24');
  assert.equal(decision.mode, 'FORMAL_INTERVIEW');
  includesReason(decision, 'EXPLICIT_MODE_ENTRY');
});

test('T-25 “停访谈但继续聊天” only changes mode and keeps the global session active', () => {
  const decision = decide(textFixture('停访谈，但继续聊天。', {
    mode: 'FORMAL_INTERVIEW', currentTopic: '第一次工作',
  }), 't25');
  assert.equal(decision.mode, 'DAILY_CHAT');
  assert.equal(decision.interactionAction, 'NONE');
  assert.equal(decision.interviewAction, 'ACKNOWLEDGE');
  includesReason(decision, 'INTERVIEW_TO_DAILY_CHAT');
  patchValue(decision, 'mode', 'DAILY_CHAT');
  patchValue(decision, 'sessionStatus', 'ACTIVE');
  assert.notEqual(decision.interactionAction, 'END');
});
