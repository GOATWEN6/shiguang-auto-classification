import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeDialogueTranscript } from '../../../src/lib/asr-input-normalizer/index.ts';

test('removes only clear standalone fillers while retaining sentence-final tone and immutable raw text', () => {
  const rawTranscript = '嗯，呃，我昨天在阳台浇花呀。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 4_200 });

  assert.equal(result.rawTranscript, rawTranscript);
  assert.equal(result.dialogueText, '我昨天在阳台浇花呀。');
  assert.equal(result.fallback, false);
  assert.equal(result.needsReview, false);
  assert.equal(result.audit.candidateType, 'short_narrative');
  assert.deepEqual(result.audit.operations.map(operation => operation.kind), [
    'REMOVE_STANDALONE_FILLER',
    'REMOVE_STANDALONE_FILLER',
  ]);
  assert.deepEqual(result.audit.operations.map(operation => operation.sourceSpan), ['嗯，', '呃，']);
  assert.equal(result.reasons.includes('NORMALIZATION_APPLIED'), true);
});

test('removes a sentence-initial 啊 filler but keeps a sentence-final 呀 particle', () => {
  const rawTranscript = '啊，我小时候常在院子里乘凉呀。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 4_500 });

  assert.equal(result.rawTranscript, rawTranscript);
  assert.equal(result.dialogueText, '我小时候常在院子里乘凉呀。');
  assert.equal(result.audit.operations[0]?.sourceSpan, '啊，');
  assert.equal(result.dialogueText.endsWith('呀。'), true);
});

test('keeps control, negation and consent language intact instead of reducing it to agreement', () => {
  const rawTranscript = '嗯，可以，先停一下，别保存。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 3_000 });

  assert.equal(result.rawTranscript, rawTranscript);
  assert.equal(result.dialogueText, rawTranscript);
  assert.equal(result.audit.candidateType, 'control_command');
  assert.deepEqual(result.audit.operations, []);
  assert.equal(result.audit.ambiguityFlags.includes('CONTROL_OR_NEGATION_SIGNAL'), true);
  assert.equal(result.reasons.includes('CONTROL_OR_NEGATION_PRESERVED'), true);
});

test('keeps correction, uncertainty, years and numbers exactly as spoken', () => {
  const rawTranscript = '啊，不是 1991，是可能 1992，我记不清了。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 5_000 });

  assert.equal(result.dialogueText, rawTranscript);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.audit.operations, []);
  assert.equal(result.audit.ambiguityFlags.includes('CORRECTION_SIGNAL'), true);
  assert.equal(result.audit.ambiguityFlags.includes('UNCERTAINTY_SIGNAL'), true);
  assert.equal(result.reasons.includes('CORRECTION_OR_UNCERTAINTY_PRESERVED'), true);
});

test('distinguishes a paused filler from a demonstrative before a person name', () => {
  const filler = normalizeDialogueTranscript({
    rawTranscript: '那个……我记不清是哪一件。',
    durationMs: 4_500,
  });
  const demonstrative = normalizeDialogueTranscript({
    rawTranscript: '那个赵老师后来还来过。',
    durationMs: 3_000,
  });

  assert.equal(filler.dialogueText, '我记不清是哪一件。');
  assert.equal(filler.needsReview, true);
  assert.equal(filler.audit.operations[0]?.sourceSpan, '那个……');
  assert.equal(demonstrative.dialogueText, '那个赵老师后来还来过。');
  assert.deepEqual(demonstrative.audit.operations, []);
});

test('retains names, dosage, medicine and final particles without producing domain inferences', () => {
  const rawTranscript = '李啊，李师傅让我每天吃 5 毫克阿司匹林呀。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 6_000 });
  const serialized = JSON.stringify(result);

  assert.equal(result.dialogueText, rawTranscript);
  assert.equal(serialized.includes('cognitive'), false);
  assert.equal(serialized.includes('personality'), false);
  assert.equal(serialized.includes('diagnosis'), false);
  assert.deepEqual(result.audit.operations, []);
});

test('collapses only redundant commas and outer whitespace with source-level audit spans', () => {
  const rawTranscript = '  我昨天，，，在阳台浇花。  ';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 3_200 });

  assert.equal(result.rawTranscript, rawTranscript);
  assert.equal(result.dialogueText, '我昨天，在阳台浇花。');
  assert.deepEqual(result.audit.operations.map(operation => operation.kind), [
    'TRIM_OUTER_WHITESPACE',
    'COLLAPSE_REDUNDANT_PUNCTUATION',
    'TRIM_OUTER_WHITESPACE',
  ]);
  assert.deepEqual(result.audit.operations.map(operation => operation.rawRange), [
    { start: 0, end: 2 },
    // Ranges are half-open offsets into the immutable 16-code-unit transcript.
    { start: 6, end: 8 },
    { start: 14, end: 16 },
  ]);
});

test('keeps punctuation audit offsets anchored to raw text after filler removal', () => {
  const rawTranscript = '嗯，我昨天，，在阳台浇花。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 4_000 });
  const punctuation = result.audit.operations.find(operation =>
    operation.kind === 'COLLAPSE_REDUNDANT_PUNCTUATION');

  assert.equal(result.dialogueText, '我昨天，在阳台浇花。');
  assert.deepEqual(punctuation?.rawRange, { start: 6, end: 7 });
  assert.equal(rawTranscript.slice(punctuation?.rawRange.start ?? 0, punctuation?.rawRange.end ?? 0), '，');
});

test('falls back to raw and requests review when cleanup would erase the whole utterance', () => {
  const rawTranscript = '嗯……';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 1_000 });

  assert.equal(result.rawTranscript, rawTranscript);
  assert.equal(result.dialogueText, rawTranscript);
  assert.equal(result.fallback, true);
  assert.equal(result.needsReview, true);
  assert.deepEqual(result.audit.operations, []);
  assert.equal(result.reasons.includes('WOULD_REMOVE_ALL_CONTENT'), true);
});

test('limits long narration to deterministic punctuation cleanup and preserves a leading filler', () => {
  const rawTranscript = '嗯，我记得那年冬天大家都在车站里等车，，天很冷，郑师傅还把自己的大衣借给了一位带孩子的乘客。';
  const result = normalizeDialogueTranscript({ rawTranscript, durationMs: 20_000 });

  assert.equal(result.audit.candidateType, 'long_narrative');
  assert.equal(result.dialogueText.startsWith('嗯，'), true);
  assert.equal(result.dialogueText.includes('车，，天'), false);
  assert.equal(result.dialogueText.includes('车，天'), true);
  assert.equal(result.audit.operations.some(operation => operation.kind === 'REMOVE_STANDALONE_FILLER'), false);
  assert.equal(result.reasons.includes('LONG_NARRATIVE_LIMITED_NORMALIZATION'), true);
});

test('empty input degrades safely without inventing content', () => {
  const result = normalizeDialogueTranscript({ rawTranscript: '', durationMs: 0 });

  assert.equal(result.dialogueText, '');
  assert.equal(result.fallback, true);
  assert.equal(result.needsReview, true);
  assert.equal(result.reasons.includes('EMPTY_TRANSCRIPT'), true);
  assert.deepEqual(result.audit.operations, []);
});
