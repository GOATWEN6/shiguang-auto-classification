import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_STYLE_VERSION,
  IMAGE_STYLE_VERSION,
  assertArticleDraft,
  assertImagePlan,
  createArticleDraft,
  createImagePlan,
} from '../../../src/lib/derived-artifact-runtime/index.ts';

const section = {
  sectionId: 'section-1', heading: '阳台上的茉莉',
  text: '我先种了一盆茉莉，花盆放在阳台靠东的角落。',
  sourceRefs: [{ recordId: 'record-1', evidenceRefs: ['E1'], quote: '我先种了一盆茉莉，花盆放在阳台靠东的角落。' }],
  claimMode: 'DIRECT' as const, uncertainty: 'NONE' as const,
};

test('article draft preserves sources and uses plain warm minimal-edit style', () => {
  const draft = createArticleDraft({ articleId: 'article-1', title: '阳台上的茉莉', sections: [section] });
  assert.equal(draft.schemaVersion, 'article-draft-v0.1');
  assert.equal(draft.styleId, ARTICLE_STYLE_VERSION);
  assert.equal(draft.status, 'NEEDS_REVIEW');
  assert.deepEqual(draft.sourceRecordIds, ['record-1']);
  assert.deepEqual(draft.sourceEvidenceRefs, ['E1']);
  assert.equal(draft.userEditedText, null);
  assertArticleDraft(draft);
});

test('image plan with a user description takes precedence and still requires review', () => {
  const plan = createImagePlan({
    planId: 'image-1', articleId: 'article-1', sectionIds: ['section-1'],
    userDescription: '画阳台东侧的一盆茉莉，清晨的自然光，温和纪实插画。',
    sourceRecordIds: ['record-1'], sourceEvidenceRefs: ['E1'], memoryUseLevel: 'R1',
  });
  assert.equal(plan.styleId, IMAGE_STYLE_VERSION);
  assert.equal(plan.representation, 'USER_DESCRIBED_SCENE');
  assert.equal(plan.referencePolicy, 'DIRECT_SOURCE_ONLY');
  assert.equal(plan.requiresHumanReview, true);
  assertImagePlan(plan);
});

test('image plan without a description falls back to a non-photographic object-focused plan', () => {
  const plan = createImagePlan({ planId: 'image-2', articleId: 'article-1', sectionIds: ['section-1'] });
  assert.equal(plan.representation, 'OBJECT_FOCUSED_FALLBACK');
  assert.equal(plan.referencePolicy, 'NO_MEMORY_REFERENCE');
  assert.equal(plan.promptBrief.includes('不补造'), true);
  assert.throws(() => createImagePlan({ planId: 'image-3', articleId: 'article-1', sectionIds: ['section-1'], memoryUseLevel: 'R3' }), /memory_level_blocked/);
});

test('memory-referencing image plans require explicit source bindings', () => {
  assert.throws(() => createImagePlan({
    planId: 'image-4', articleId: 'article-1', sectionIds: ['section-1'], memoryUseLevel: 'R1',
  }), /memory_sources_required/);
});
