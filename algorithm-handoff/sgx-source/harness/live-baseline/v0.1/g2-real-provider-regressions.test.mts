import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractHybridCandidates,
  type EvidenceFragment,
  type HybridInput,
  type RawSemanticProposal,
} from '../../../src/lib/memory-runtime/index.ts';

function input(text: string): HybridInput {
  return {
    policy: {
      interactionPreferenceAutoSavePolicy: 'on',
      ordinaryMemoryAutoSavePolicy: 'on',
      interviewAutoOrganizePolicy: 'on',
      longitudinalObservationAuthorization: 'off',
      actorRole: 'elder',
      subjectId: 'elder-live-regression',
      familySpaceId: 'family-live-regression',
      purpose: 'daily_chat',
      visibilityScope: ['elder_only'],
      authorizationVersion: 'auth-live-regression',
    },
    evidence: [{
      ref: 'E1',
      kind: 'conversation_transcript',
      actorId: 'elder-live-regression',
      actorRole: 'elder',
      subjectId: 'elder-live-regression',
      familySpaceId: 'family-live-regression',
      allowedPurposes: ['*'],
      authorizationVersion: 'auth-live-regression',
      visibilityScope: ['elder_only'],
      text,
      useStatus: 'ACTIVE',
    } satisfies EvidenceFragment],
    currentRecords: [],
  };
}

function proposal(text: string, overrides: Partial<RawSemanticProposal> = {}): RawSemanticProposal {
  return {
    providerProposalId: 'P1',
    contentType: 'life_event_detail',
    normalizedClaim: text,
    query: text,
    sourceEvidenceRefs: ['E1'],
    sourceSpans: [{ evidenceRef: 'E1', quote: text }],
    sensitivityLevel: 'S0',
    signals: {},
    ...overrides,
  };
}

test('real provider regression: lending a raincoat is not financial', async () => {
  const text = '师傅把一件旧雨衣借给我';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text)] }),
  });
  assert.equal(result.diagnostics.semanticAcceptedCount, 1);
  assert.equal(result.proposals.some(item => item.sensitivityCategories.includes('financial')), false);
});

test('real provider regression: head impact and dizziness are detected from raw evidence', async () => {
  const text = '我刚才摔到头了，现在还有点发晕。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text, { contentType: 'health_context' })] }),
  });
  assert.equal(result.proposals.length >= 1, true);
  assert.equal(result.proposals.every(item => item.sensitivityLevel === 'S2'), true);
  assert.equal(result.proposals.some(item => item.sensitivityCategories.includes('health')), true);
  assert.equal(result.proposals.some(item => item.sensitivityCategories.includes('safety')), true);
});

test('real provider regression: delete wording is taken from evidence and becomes governance', async () => {
  const text = '还是把这张照片和相关故事都删掉吧。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text, { contentType: 'deletion_request' })] }),
  });
  assert.equal(result.diagnostics.semanticRejectedCount, 0);
  assert.equal(result.proposals.some(item => item.signals.governanceAction === 'DELETE'), true);
  assert.equal(result.proposals.some(item => item.contentType === 'deletion_request'), true);
});

test('real provider regression: no-save paraphrase cannot become an ordinary preference', async () => {
  const text = '刚才这段不要保存，也不要以后再拿来问我。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text, {
      contentType: 'interaction_preference',
      normalizedClaim: '老人明确要求刚才这段内容不要保存，也不要以后再拿来问自己',
    })] }),
  });
  assert.equal(result.diagnostics.mustExtractCount, 1);
  assert.equal(result.diagnostics.semanticAcceptedCount, 0);
  assert.equal(result.diagnostics.semanticRejectedCount, 1);
  assert.deepEqual(result.diagnostics.semanticRejections, [{ index: 0, reason: 'governance_duplicate_suppressed' }]);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0]?.signals.governanceAction, 'REVOKE');
  assert.equal(result.proposals[0]?.contentType, 'taboo_rule');
});

test('real provider regression: preservation wording does not become a delete request', async () => {
  const text = '别把以前的习惯全删掉，先保留给我看看。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text, { contentType: 'life_event_detail' })] }),
  });
  assert.equal(result.diagnostics.semanticRejectedCount, 0);
  assert.equal(result.proposals.some(item => item.signals.governanceAction === 'DELETE'), false);
  assert.equal(result.proposals.some(item => item.contentType === 'deletion_request'), false);
});

test('real provider regression: malformed model enums and signals fail closed', async () => {
  const text = '我喜欢兰花。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({
      proposals: [proposal(text, {
        sensitivityLevel: 'normal',
        signals: [] as unknown as RawSemanticProposal['signals'],
      })],
    }),
  });
  assert.equal(result.diagnostics.semanticAcceptedCount, 0);
  assert.equal(result.diagnostics.semanticRejectedCount, 1);
  assert.equal(result.diagnostics.semanticRejections[0]?.reason, 'invalid_sensitivity_level');
});

test('real provider regression: historical event-day wording is not current short-term context', async () => {
  const text = '我第一次进纺织厂当天，师傅把旧雨衣借给我。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text)] }),
  });
  assert.equal(result.diagnostics.semanticAcceptedCount, 1);
  assert.equal(result.proposals[0]?.signals.shortTerm, false);
  assert.notEqual(result.proposals[0]?.signals.temporalState, 'TEMPORARY_CURRENT');
});

test('real provider regression: recent stated hobby remains a current preference', async () => {
  const text = '我自己最近爱做木头小凳子，可以整理这个爱好。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({ proposals: [proposal(text, { contentType: 'preference' })] }),
  });
  assert.equal(result.diagnostics.semanticAcceptedCount, 1);
  assert.equal(result.proposals[0]?.signals.shortTerm, false);
  assert.equal(result.proposals[0]?.signals.temporalState, 'CURRENT');
  assert.equal(result.proposals[0]?.retentionPolicy, 'until_superseded');
});

test('real provider regression: recent health and one-off plans remain contextual', async () => {
  const healthText = '我最近睡不好，白天总觉得累。';
  const health = await extractHybridCandidates(input(healthText), {
    semanticProvider: async () => ({ proposals: [proposal(healthText, { contentType: 'health_context' })] }),
  });
  assert.equal(health.proposals[0]?.signals.shortTerm, true);
  assert.equal(health.proposals[0]?.signals.temporalState, 'TEMPORARY_CURRENT');

  const planText = '我最近准备去看望老同学，这周先安排一下。';
  const plan = await extractHybridCandidates(input(planText), {
    semanticProvider: async () => ({ proposals: [proposal(planText, { contentType: 'temporary_plan' })] }),
  });
  assert.equal(plan.proposals[0]?.signals.shortTerm, true);
  assert.equal(plan.proposals[0]?.signals.temporalState, 'TEMPORARY_CURRENT');
});

test('real provider regression: model cannot turn a same-actor correction into source conflict', async () => {
  const text = '不对，也许是六八年，我也记不准。';
  const result = await extractHybridCandidates(input(text), {
    semanticProvider: async () => ({
      proposals: [proposal(text, {
        contentType: 'correction',
        signals: { conflict: true },
      })],
    }),
  });
  assert.equal(result.diagnostics.semanticAcceptedCount, 1);
  assert.equal(result.proposals[0]?.signals.conflict, false);
  assert.equal(result.proposals[0]?.signals.explicitCorrection, true);
});
