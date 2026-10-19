import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SEMANTIC_TURN_PROPOSAL_VERSION,
  validateSemanticTurnProposal,
} from '../../../src/lib/algorithm-service/index.ts';

const evidenceText = '我以前在纺织厂工作，后来搬到了上海，最记得下雨天上班。';
const context = { evidenceText, allowedEvidenceRefs: ['evidence-1'] } as const;

function validProposal() {
  return {
    schemaVersion: '0.1',
    userIntent: 'CONTINUE_TOPIC',
    topicId: 'work-and-study',
    observedFacets: ['EVENT', 'PLACE', 'SCENE'],
    sourceSpans: [{ evidenceRef: 'evidence-1', quote: '以前在纺织厂工作' }],
    memoryCandidates: [{
      claim: '老人以前在纺织厂工作', contentType: 'life_event', sensitivityHint: 'S0',
      sourceEvidenceRefs: ['evidence-1'],
    }],
    relatedMemoryQuery: '纺织厂工作',
    userUncertainty: 'LOW',
    needsClarification: false,
  };
}

test('valid AI semantic proposal is accepted with source-bound candidates', () => {
  const result = validateSemanticTurnProposal(validProposal(), context);
  assert.equal(result.accepted, true);
  assert.equal(result.proposal?.schemaVersion, '0.1');
  assert.deepEqual(result.proposal?.memoryCandidates[0]?.sourceEvidenceRefs, ['evidence-1']);
  assert.equal(SEMANTIC_TURN_PROPOSAL_VERSION, 'semantic-turn-proposal-v0.1');
});

test('unknown intent with no candidate is valid and supports graceful uncertainty', () => {
  const value = {
    ...validProposal(), userIntent: 'UNKNOWN', topicId: null, observedFacets: [],
    sourceSpans: [], memoryCandidates: [], relatedMemoryQuery: null,
    userUncertainty: 'UNKNOWN', needsClarification: true,
  };
  const result = validateSemanticTurnProposal(value, context);
  assert.equal(result.accepted, true);
  assert.equal(result.proposal?.userIntent, 'UNKNOWN');
});

test('non-contiguous quote is rejected before any policy decision', () => {
  const value = { ...validProposal(), sourceSpans: [{
    evidenceRef: 'evidence-1', quote: '以前在纺织厂工作，上海最记得',
  }] };
  const result = validateSemanticTurnProposal(value, context);
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('SOURCE_SPAN_0_QUOTE_NOT_CONTIGUOUS'));
});

test('candidate cannot cite an evidence ref that was not validated in a source span', () => {
  const value = { ...validProposal(), memoryCandidates: [{
    claim: '老人以前在纺织厂工作', contentType: 'life_event', sensitivityHint: 'S0',
    sourceEvidenceRefs: ['evidence-other'],
  }] };
  const result = validateSemanticTurnProposal(value, context);
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('MEMORY_CANDIDATE_0_SOURCE_REF_NOT_IN_VALIDATED_SPANS'));
});

test('unsupported authority field is rejected instead of being silently ignored', () => {
  const result = validateSemanticTurnProposal({ ...validProposal(), canPersistMemory: true }, context);
  assert.equal(result.accepted, false);
  assert.ok(result.reasonCodes.includes('proposal_UNSUPPORTED_FIELD_canPersistMemory'));
});
