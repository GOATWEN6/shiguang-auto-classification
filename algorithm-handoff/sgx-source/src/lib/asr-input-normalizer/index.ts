/**
 * A deliberately small, deterministic presentation-layer normalizer.
 *
 * `rawTranscript` is immutable evidence. `dialogueText` is a derived view for
 * subtitles and downstream language modules. This module never emits
 * cognitive, health, personality, or memory conclusions.
 */

export type DialogueCandidateType =
  | 'empty'
  | 'control_command'
  | 'short_answer'
  | 'short_narrative'
  | 'long_narrative';

export type DialogueNormalizationOperationKind =
  | 'TRIM_OUTER_WHITESPACE'
  | 'REMOVE_STANDALONE_FILLER'
  | 'COLLAPSE_REDUNDANT_PUNCTUATION';

export interface DialogueNormalizationOperation {
  kind: DialogueNormalizationOperationKind;
  sourceSpan: string;
  replacement: string;
  reasonCode: string;
  rawRange: { start: number; end: number };
}

export interface DialogueNormalizationAudit {
  normalizationVersion: 'dialogue-normalizer-v0.1';
  candidateType: DialogueCandidateType;
  operations: DialogueNormalizationOperation[];
  ambiguityFlags: string[];
}

export interface NormalizeDialogueTranscriptInput {
  rawTranscript: string;
  /** Optional provider duration. Character count remains the safe fallback. */
  durationMs?: number;
}

export interface NormalizeDialogueTranscriptResult {
  rawTranscript: string;
  dialogueText: string;
  fallback: boolean;
  needsReview: boolean;
  reasons: string[];
  audit: DialogueNormalizationAudit;
}

const CONTROL_OR_NEGATION = /(?:先停|停一下|暂停|结束|换个话题|别保存|不要保存|不保存|别存|不要存|撤回|删除|删掉|删了|清除|不要|别|不是|不对|改成|纠正)/u;
const CORRECTION = /(?:不是|不对|改成|纠正|更正|记错|认错)/u;
const UNCERTAINTY = /(?:可能|大概|大约|记不清|不确定|好像|左右|前后)/u;
// “啊/呀”只在句首、且被停顿标点隔开时才按填充词处理；句末语气词
// 和人名中的同音字必须保留。纠正、控制和不确定表达会在上层被整体保留。
const FILLER_WORDS = new Set(['嗯', '呃', '额', '那个', '啊', '呀']);
const FILLER_PREFIX = /^(嗯|呃|额|那个|啊|呀)(?=(?:[，,、\s…]|……))/u;
const SHORT_CHAR_LIMIT = 40;
const SHORT_DURATION_LIMIT_MS = 15_000;

function normalized(value: string): string {
  // NFC keeps the punctuation that the ASR provider emitted. NFKC would
  // silently turn Chinese full-width punctuation (，、……) into ASCII, which
  // changes the immutable transcript before we even audit a cleanup.
  return value.normalize('NFC');
}

function candidateType(raw: string, durationMs: number | undefined): DialogueCandidateType {
  const text = raw.trim();
  if (!text) return 'empty';
  if (CONTROL_OR_NEGATION.test(text)) return 'control_command';
  const long = text.length > SHORT_CHAR_LIMIT
    || (durationMs !== undefined && durationMs > SHORT_DURATION_LIMIT_MS);
  if (long) return 'long_narrative';
  return /(?:昨天|今天|以前|小时候|年轻时|后来|当年|我在|我曾|我记得)/u.test(text)
    ? 'short_narrative'
    : 'short_answer';
}

function addOperation(
  operations: DialogueNormalizationOperation[],
  kind: DialogueNormalizationOperationKind,
  sourceSpan: string,
  replacement: string,
  reasonCode: string,
  rawRange: { start: number; end: number },
): void {
  operations.push({ kind, sourceSpan, replacement, reasonCode, rawRange });
}

function removeLeadingFillers(
  raw: string,
  operations: DialogueNormalizationOperation[],
): { text: string; removedLength: number } {
  let text = raw;
  let removed = 0;
  while (true) {
    const match = FILLER_PREFIX.exec(text);
    if (!match) break;
    const word = match[1];
    if (!FILLER_WORDS.has(word)) break;
    const afterWord = text.slice(word.length);
    const punctuation = afterWord.match(/^(?:[，,、\s…]|……)+/u)?.[0] ?? '';
    if (!punctuation) break;
    const sourceSpan = `${word}${punctuation}`;
    addOperation(operations, 'REMOVE_STANDALONE_FILLER', sourceSpan, '', 'NON_SEMANTIC_FILLER', {
      start: removed,
      end: removed + sourceSpan.length,
    });
    text = text.slice(sourceSpan.length);
    removed += sourceSpan.length;
  }
  return { text, removedLength: removed };
}

function collapsePunctuation(
  text: string,
  operations: DialogueNormalizationOperation[],
  rawOffset: number,
): string {
  return text.replace(/[，,、]{2,}/gu, (match, offset: number) => {
    const keep = match[0];
    const removed = match.slice(1);
    // The range points at the redundant suffix, so the retained punctuation
    // remains explicitly represented in the audit trail.
    addOperation(operations, 'COLLAPSE_REDUNDANT_PUNCTUATION', removed, '', 'REDUNDANT_PUNCTUATION', {
      start: rawOffset + offset + 1,
      end: rawOffset + offset + match.length,
    });
    return keep;
  });
}

export function normalizeDialogueTranscript(
  input: NormalizeDialogueTranscriptInput,
): NormalizeDialogueTranscriptResult {
  if (!input || typeof input.rawTranscript !== 'string') {
    throw new TypeError('rawTranscript must be a string');
  }
  const rawTranscript = normalized(input.rawTranscript);
  const operations: DialogueNormalizationOperation[] = [];
  const reasons: string[] = [];
  const type = candidateType(rawTranscript, input.durationMs);
  const ambiguityFlags: string[] = [];

  if (!rawTranscript.trim()) {
    return {
      rawTranscript,
      dialogueText: rawTranscript,
      fallback: true,
      needsReview: true,
      reasons: ['EMPTY_TRANSCRIPT'],
      audit: { normalizationVersion: 'dialogue-normalizer-v0.1', candidateType: type, operations, ambiguityFlags },
    };
  }

  if (CONTROL_OR_NEGATION.test(rawTranscript)) ambiguityFlags.push('CONTROL_OR_NEGATION_SIGNAL');
  if (CORRECTION.test(rawTranscript)) ambiguityFlags.push('CORRECTION_SIGNAL');
  if (UNCERTAINTY.test(rawTranscript)) ambiguityFlags.push('UNCERTAINTY_SIGNAL');

  const leading = rawTranscript.match(/^\s+/u)?.[0] ?? '';
  let text = rawTranscript;
  if (leading) {
    addOperation(operations, 'TRIM_OUTER_WHITESPACE', leading, '', 'OUTER_WHITESPACE', {
      start: 0, end: leading.length,
    });
    text = text.slice(leading.length);
  }

  // Long speech and all control/correction/uncertain utterances retain their
  // words. Only punctuation and outer whitespace may be normalized.
  // Uncertainty must remain in the transcript, but a clear leading pause such
  // as “那个……” may still be removed. Control and correction utterances are
  // kept byte-for-byte because they can change consent or meaning.
  const preserveWords = type === 'long_narrative'
    || CONTROL_OR_NEGATION.test(rawTranscript)
    || CORRECTION.test(rawTranscript);
  let removedLeadingLength = 0;
  if (!preserveWords) {
    const before = text;
    const result = removeLeadingFillers(text, operations);
    text = result.text;
    removedLeadingLength = result.removedLength;
    if (text !== before) reasons.push('NORMALIZATION_APPLIED');
  }

  const punctuationBefore = text;
  // Offset is only used for audit readability; all source text remains intact.
  text = collapsePunctuation(text, operations, leading.length + removedLeadingLength);
  if (text !== punctuationBefore) reasons.push('NORMALIZATION_APPLIED');

  const trailing = text.match(/\s+$/u)?.[0] ?? '';
  if (trailing) {
    addOperation(operations, 'TRIM_OUTER_WHITESPACE', trailing, '', 'OUTER_WHITESPACE', {
      start: rawTranscript.length - trailing.length,
      end: rawTranscript.length,
    });
    text = text.slice(0, -trailing.length);
  }

  if (type === 'long_narrative') reasons.push('LONG_NARRATIVE_LIMITED_NORMALIZATION');
  if (ambiguityFlags.includes('CONTROL_OR_NEGATION_SIGNAL')) reasons.push('CONTROL_OR_NEGATION_PRESERVED');
  if (CORRECTION.test(rawTranscript) || UNCERTAINTY.test(rawTranscript)) {
    reasons.push('CORRECTION_OR_UNCERTAINTY_PRESERVED');
  }

  if (!text.trim()) {
    return {
      rawTranscript,
      dialogueText: rawTranscript,
      fallback: true,
      needsReview: true,
      reasons: [...reasons, 'WOULD_REMOVE_ALL_CONTENT'],
      audit: { normalizationVersion: 'dialogue-normalizer-v0.1', candidateType: type, operations: [], ambiguityFlags },
    };
  }

  // A filler-only utterance is not safe to turn into an empty message.
  if (type !== 'long_narrative' && !text.replace(/[\s…，,、。！？!?]/gu, '').trim()) {
    return {
      rawTranscript,
      dialogueText: rawTranscript,
      fallback: true,
      needsReview: true,
      reasons: [...reasons, 'WOULD_REMOVE_ALL_CONTENT'],
      audit: { normalizationVersion: 'dialogue-normalizer-v0.1', candidateType: type, operations: [], ambiguityFlags },
    };
  }

  return {
    rawTranscript,
    dialogueText: text,
    fallback: false,
    needsReview: ambiguityFlags.length > 0 || type === 'long_narrative',
    reasons,
    audit: { normalizationVersion: 'dialogue-normalizer-v0.1', candidateType: type, operations, ambiguityFlags },
  };
}
