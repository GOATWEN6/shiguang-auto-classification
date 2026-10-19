import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAlgorithmComposition,
  normalizeSemanticTurnShadowModelOutput,
  validateSemanticTurnShadowProposal,
  type LiveProvider,
} from '../../../src/lib/algorithm-service/index.ts';
import type { TrustedSessionAuthority } from '../../../src/lib/turn-orchestrator/index.ts';

const evidenceText = '我以前在纺织厂工作，后来搬到了上海，最记得下雨天上班。';
const context = {
  evidenceText,
  allowedEvidenceRefs: ['evidence-1'],
  mode: 'FORMAL_INTERVIEW' as const,
  currentTopic: '工作经历',
};

function validShadow(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '0.1',
    intentKind: 'CONTINUE',
    shareInterest: 'EXPLICIT',
    proposal: {
      schemaVersion: '0.1',
      userIntent: 'CONTINUE_TOPIC',
      topicId: 'work-and-study',
      observedFacets: ['EVENT', 'PLACE', 'SCENE'],
      sourceSpans: [{ evidenceRef: 'evidence-1', quote: '以前在纺织厂工作' }],
      memoryCandidates: [],
      relatedMemoryQuery: '纺织厂工作',
      userUncertainty: 'LOW',
      needsClarification: false,
    },
    narrativeCues: [{
      cueId: 'cue-1', kind: 'EVENT_TURN', epistemic: 'EXPLICIT',
      sourceEvidenceRefs: ['evidence-1'], topicId: 'work-and-study',
    }],
    nextActionCandidates: [{
      candidateId: 'action-1', action: 'FOLLOW_UP', topicId: 'work-and-study',
      premiseRefs: ['evidence-1', 'cue-1'], reasonCodes: ['NEW_EVENT_DETAIL'],
      proposedQuestionIntent: '询问当时印象最深的人或事',
    }],
    ...overrides,
  };
}

test('shadow accepts explicit narrative cues and source-bound candidate action', () => {
  const result = validateSemanticTurnShadowProposal(validShadow(), context);
  assert.equal(result.accepted, true);
  assert.equal(result.proposal?.nextActionCandidates[0]?.action, 'FOLLOW_UP');
  assert.equal(result.proposal?.narrativeCues[0]?.epistemic, 'EXPLICIT');
});

test('uncertain memory stays uncertain and can request clarification without persistence authority', () => {
  const result = validateSemanticTurnShadowProposal({
    ...validShadow(),
    intentKind: 'UNCERTAIN_MEMORY',
    shareInterest: 'AMBIGUOUS',
    proposal: {
      ...validShadow().proposal,
      userIntent: 'UNKNOWN',
      userUncertainty: 'HIGH',
      needsClarification: true,
      memoryCandidates: [],
    },
    narrativeCues: [{
      cueId: 'cue-uncertain', kind: 'OPEN_DETAIL', epistemic: 'UNANSWERED',
      sourceEvidenceRefs: ['evidence-1'], topicId: 'work-and-study',
    }],
    nextActionCandidates: [{
      candidateId: 'action-clarify', action: 'CLARIFY', topicId: 'work-and-study',
      premiseRefs: ['cue-uncertain'], reasonCodes: ['UNCERTAINTY_EXPLICIT'],
      proposedQuestionIntent: '确认老人愿意继续讲哪一部分',
    }],
  }, context);
  assert.equal(result.accepted, true);
  assert.equal(result.proposal?.proposal.needsClarification, true);
  assert.equal(result.proposal?.proposal.memoryCandidates.length, 0);
});

test('decline and no-saving observations remain valid shadow data but do not create a memory candidate', () => {
  const result = validateSemanticTurnShadowProposal({
    ...validShadow(),
    intentKind: 'NO_SAVING',
    shareInterest: 'NONE',
    proposal: {
      ...validShadow().proposal,
      userIntent: 'SKIP_TOPIC',
      memoryCandidates: [],
    },
    narrativeCues: [],
    nextActionCandidates: [{
      candidateId: 'action-wait', action: 'ACKNOWLEDGE', topicId: null,
      premiseRefs: ['evidence-1'], reasonCodes: ['NO_SAVING_REQUEST'],
      proposedQuestionIntent: null,
    }],
  }, context);
  assert.equal(result.accepted, true);
  assert.equal(result.proposal?.intentKind, 'NO_SAVING');
  assert.equal(result.proposal?.proposal.memoryCandidates.length, 0);
});

test('non-contiguous source quote rejects the entire shadow proposal before policy mapping', () => {
  const result = validateSemanticTurnShadowProposal({
    ...validShadow(),
    proposal: {
      ...validShadow().proposal,
      sourceSpans: [{ evidenceRef: 'evidence-1', quote: '以前在纺织厂工作，上海最记得' }],
    },
  }, context);
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('PROPOSAL_SOURCE_SPAN_0_QUOTE_NOT_CONTIGUOUS'));
});

test('candidate action cannot cite an unvalidated premise or add persistence authority', () => {
  const result = validateSemanticTurnShadowProposal({
    ...validShadow(),
    canPersistMemory: true,
    nextActionCandidates: [{
      candidateId: 'action-1', action: 'FOLLOW_UP', topicId: null,
      premiseRefs: ['unverified'], reasonCodes: [], proposedQuestionIntent: null,
    }],
  }, context);
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('shadow_UNSUPPORTED_FIELD_canPersistMemory'));
  assert.ok(result.reasonCodes.includes('NEXT_ACTION_CANDIDATE_0_PREMISE_REF_NOT_VALIDATED'));
});

test('legacy provider shadow output is normalized and then revalidated against the current contract', () => {
  const legacy = {
    schemaVersion: 'semantic-turn-proposal-v0.1',
    intentKind: 'CONTINUE',
    shareInterest: 'AMBIGUOUS',
    proposal: {
      userIntent: '用户主动分享过往工作经历',
      topicId: 'topic_textile_factory_work_experience',
      observedFacets: ['过往职业经历提及'],
      sourceSpans: [{ spanId: 'span_1', quote: '我以前在纺织厂工作' }],
      memoryCandidates: [{ refSpanId: 'span_1', content: '用户曾在纺织厂工作过' }],
      relatedMemoryQuery: [], userUncertainty: null, needsClarification: false,
    },
    narrativeCues: [{ cueId: 'cue_1', kind: 'EVENT_TURN', epistemic: 'EXPLICIT',
      sourceEvidenceRefs: ['evidence-1'], topicId: 'topic_textile_factory_work_experience' }],
    nextActionCandidates: [{ candidateId: 'candidate_1', action: 'FOLLOW_UP',
      topicId: 'topic_textile_factory_work_experience', premiseRefs: ['span_1'],
      reasonCodes: ['new_detail'], proposedQuestionIntent: '询问工作期间印象最深的经历' }],
  };
  const normalized = normalizeSemanticTurnShadowModelOutput(legacy, context);
  assert.equal(normalized.normalized, true);
  assert.ok(normalized.reasonCodes.includes('MODEL_OUTPUT_NORMALIZED'));
  const result = validateSemanticTurnShadowProposal(normalized.value, context);
  assert.equal(result.accepted, true, JSON.stringify(result));
  assert.equal(result.proposal?.proposal.userIntent, 'CONTINUE_TOPIC');
  assert.deepEqual(result.proposal?.proposal.sourceSpans, [{
    evidenceRef: 'evidence-1', quote: '我以前在纺织厂工作',
  }]);
  assert.deepEqual(result.proposal?.proposal.memoryCandidates[0]?.sourceEvidenceRefs, ['evidence-1']);
  assert.deepEqual(result.proposal?.nextActionCandidates[0]?.premiseRefs, ['evidence-1']);
});

test('shadow normalization refuses outputs that attempt to add authority fields', () => {
  const normalized = normalizeSemanticTurnShadowModelOutput({
    schemaVersion: 'semantic-turn-shadow-output-v0.1', canPersistMemory: true,
    proposal: {}, narrativeCues: [], nextActionCandidates: [],
  }, context);
  assert.equal(normalized.normalized, false);
  assert.ok(normalized.reasonCodes.includes('MODEL_AUTHORITY_FIELD_PRESENT'));
  const result = validateSemanticTurnShadowProposal(normalized.value, context);
  assert.equal(result.accepted, false);
});

function authority(id = 'shadow'): TrustedSessionAuthority {
  return { schemaVersion: 'trusted-session-authority-v0.1', actorId: `actor-${id}`,
    subjectId: `elder-${id}`, familySpaceId: `family-${id}`, authorizationVersion: 'auth-v1',
    visibilityScope: ['elder_only'] };
}

function provider(shadowOutput: unknown): LiveProvider {
  return {
    async json(_system, input, options) {
      const data = input as any;
      if (options.module === 'semantic_turn_shadow') {
        const encoded = JSON.stringify(shadowOutput).replaceAll('evidence-1', data.evidenceRef);
        return JSON.parse(encoded);
      }
      if (options.module === 'memory') {
        const source = data.evidence[0];
        return { proposals: [{ providerProposalId: 'semantic-1', contentType: 'preference',
          normalizedClaim: source.text, query: source.text, sourceEvidenceRefs: [source.ref],
          sourceSpans: [{ evidenceRef: source.ref, quote: source.text }], eventTime: null,
          validFrom: null, validTo: null, sensitivityLevel: 'S0',
          signals: { temporalState: 'CURRENT', shortTerm: false, conflict: false,
            ambiguousSubject: false, purposeExpansion: false, visibilityExpansion: false } }] };
      }
      return { text: '我听到了，我们慢慢聊。', questions: [] };
    },
    async synthesize() { return { audio: new Uint8Array([1, 2, 3]), mimeType: 'audio/mpeg' }; },
    async transcribe() { return { text: '我喜欢越剧。', payloadCount: 1 }; },
  };
}

function start(composition: ReturnType<typeof createAlgorithmComposition>): string {
  return composition.orchestrator.startSession({ schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: 'shadow-start', requestedMode: 'DAILY_CHAT' }, authority()).opaqueSessionHandle;
}

test('composition wires shadow analysis without changing policy response or Memory side effects', async () => {
  const c = createAlgorithmComposition({
    provider: provider(validShadow({
      proposal: { ...validShadow().proposal,
        sourceSpans: [{ evidenceRef: 'evidence-1', quote: '我平时喜欢听越剧。' }],
      },
      narrativeCues: [{ cueId: 'cue-1', kind: 'SELF_EXPRESSED_MEANING', epistemic: 'EXPLICIT',
        sourceEvidenceRefs: ['evidence-1'], topicId: null }],
      nextActionCandidates: [{ candidateId: 'action-1', action: 'ACKNOWLEDGE', topicId: null,
        premiseRefs: ['evidence-1'], reasonCodes: ['ORDINARY_CHAT'], proposedQuestionIntent: null }],
    })),
    semanticTurnShadow: { enabled: true },
  });
  const handle = start(c);
  const result = await c.orchestrator.runFinalTurn(handle, {
    schemaVersion: 'orchestrated-turn-v0.1', idempotencyToken: 'shadow-turn', source: 'TYPED_TEXT',
    text: '我平时喜欢听越剧。', receivedAt: '2026-10-13T01:00:00.000Z',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.mode, 'DAILY_CHAT');
  assert.equal(result.response?.policyEngine, 'DailyChatPolicy');
  const shadow = await c.waitForSemanticTurnShadow(result.turnId);
  assert.equal(shadow?.status, 'ACCEPTED', JSON.stringify(shadow));
  assert.equal(shadow?.policySideEffect, 'NONE');
  assert.equal(c.view(handle).semanticTurnShadow.length, 1);
});

test('invalid shadow output is recorded and does not block the user turn', async () => {
  const c = createAlgorithmComposition({
    provider: provider({ ...validShadow(), proposal: {
      ...validShadow().proposal,
      sourceSpans: [{ evidenceRef: 'evidence-1', quote: '不在原文里的拼接内容' }],
    } }),
    semanticTurnShadow: { enabled: true },
  });
  const handle = start(c);
  const result = await c.orchestrator.runFinalTurn(handle, {
    schemaVersion: 'orchestrated-turn-v0.1', idempotencyToken: 'shadow-invalid', source: 'TYPED_TEXT',
    text: '我平时喜欢听越剧。', receivedAt: '2026-10-13T01:00:00.000Z',
  });
  assert.equal(result.status, 'completed');
  const shadow = await c.waitForSemanticTurnShadow(result.turnId);
  assert.equal(shadow?.status, 'REJECTED');
  assert.ok(shadow?.reasonCodes.some(code => code.includes('QUOTE_NOT_CONTIGUOUS')));
});
