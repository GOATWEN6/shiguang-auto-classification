export const SEMANTIC_TURN_PROPOSAL_VERSION = 'semantic-turn-proposal-v0.1';

export type SemanticUserIntent =
  | 'CONTINUE_TOPIC'
  | 'SWITCH_TOPIC'
  | 'SKIP_TOPIC'
  | 'PAUSE'
  | 'END'
  | 'ASK_FOR_HELP'
  | 'ORDINARY_CHAT'
  | 'UNKNOWN';

export type SemanticFacet =
  | 'PERSON'
  | 'TIME'
  | 'PLACE'
  | 'EVENT'
  | 'SCENE'
  | 'RELATIONSHIP'
  | 'MEANING'
  | 'CHANGE'
  | 'OBJECT';

export type SemanticUncertainty = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
export type SemanticSensitivityHint = 'S0' | 'S1' | 'S2' | 'UNKNOWN';

export interface SemanticSourceSpan {
  evidenceRef: string;
  quote: string;
}

export interface SemanticMemoryCandidate {
  claim: string;
  contentType: string;
  sensitivityHint: SemanticSensitivityHint;
  sourceEvidenceRefs: string[];
}

export interface SemanticTurnProposal {
  schemaVersion: '0.1';
  userIntent: SemanticUserIntent;
  topicId: string | null;
  observedFacets: SemanticFacet[];
  sourceSpans: SemanticSourceSpan[];
  memoryCandidates: SemanticMemoryCandidate[];
  relatedMemoryQuery: string | null;
  userUncertainty: SemanticUncertainty;
  needsClarification: boolean;
}

export interface SemanticTurnValidationContext {
  evidenceText: string;
  allowedEvidenceRefs: readonly string[];
}

export interface SemanticTurnValidationResult {
  accepted: boolean;
  proposal: SemanticTurnProposal | null;
  reasonCodes: string[];
}

const INTENTS = new Set<SemanticUserIntent>([
  'CONTINUE_TOPIC', 'SWITCH_TOPIC', 'SKIP_TOPIC', 'PAUSE', 'END',
  'ASK_FOR_HELP', 'ORDINARY_CHAT', 'UNKNOWN',
]);
const FACETS = new Set<SemanticFacet>([
  'PERSON', 'TIME', 'PLACE', 'EVENT', 'SCENE', 'RELATIONSHIP', 'MEANING', 'CHANGE', 'OBJECT',
]);
const UNCERTAINTIES = new Set<SemanticUncertainty>(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']);
const SENSITIVITY_HINTS = new Set<SemanticSensitivityHint>(['S0', 'S1', 'S2', 'UNKNOWN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, reasons: string[]): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) reasons.push(field + '_UNSUPPORTED_FIELD_' + key);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function containsContiguousQuote(source: string, quote: string): boolean {
  const normalizedSource = normalizedText(source);
  const normalizedQuote = normalizedText(quote);
  return normalizedQuote.length > 0 && normalizedSource.includes(normalizedQuote);
}

function rejectIf(condition: boolean, reason: string, reasons: string[]): void {
  if (condition) reasons.push(reason);
}

/**
 * Validate model semantics before they reach topic, retrieval or Memory
 * policy. It is deliberately fail-closed and has no persistence authority.
 */
export function validateSemanticTurnProposal(
  value: unknown,
  context: SemanticTurnValidationContext,
): SemanticTurnValidationResult {
  const reasons: string[] = [];
  const allowedRefs = new Set(context.allowedEvidenceRefs);
  rejectIf(!nonEmptyString(context.evidenceText), 'EVIDENCE_TEXT_REQUIRED', reasons);
  rejectIf(allowedRefs.size === 0, 'ALLOWED_EVIDENCE_REFS_REQUIRED', reasons);
  if (!isRecord(value)) {
    return { accepted: false, proposal: null, reasonCodes: ['PROPOSAL_MUST_BE_OBJECT', ...reasons] };
  }

  hasOnlyKeys(value, [
    'schemaVersion', 'userIntent', 'topicId', 'observedFacets', 'sourceSpans',
    'memoryCandidates', 'relatedMemoryQuery', 'userUncertainty', 'needsClarification',
  ], 'proposal', reasons);
  rejectIf(value.schemaVersion !== '0.1', 'SCHEMA_VERSION_UNSUPPORTED', reasons);
  rejectIf(typeof value.userIntent !== 'string' || !INTENTS.has(value.userIntent as SemanticUserIntent), 'USER_INTENT_INVALID', reasons);
  rejectIf(value.topicId !== null && !nonEmptyString(value.topicId), 'TOPIC_ID_INVALID', reasons);
  rejectIf(!Array.isArray(value.observedFacets), 'OBSERVED_FACETS_MUST_BE_ARRAY', reasons);
  rejectIf(!Array.isArray(value.sourceSpans), 'SOURCE_SPANS_MUST_BE_ARRAY', reasons);
  rejectIf(!Array.isArray(value.memoryCandidates), 'MEMORY_CANDIDATES_MUST_BE_ARRAY', reasons);
  rejectIf(value.relatedMemoryQuery !== null && !nonEmptyString(value.relatedMemoryQuery), 'RELATED_QUERY_INVALID', reasons);
  rejectIf(typeof value.needsClarification !== 'boolean', 'NEEDS_CLARIFICATION_INVALID', reasons);
  rejectIf(typeof value.userUncertainty !== 'string' || !UNCERTAINTIES.has(value.userUncertainty as SemanticUncertainty), 'USER_UNCERTAINTY_INVALID', reasons);

  const observedFacets = Array.isArray(value.observedFacets) ? value.observedFacets : [];
  rejectIf(observedFacets.length > 9, 'OBSERVED_FACETS_TOO_MANY', reasons);
  rejectIf(observedFacets.some(item => typeof item !== 'string' || !FACETS.has(item as SemanticFacet)), 'OBSERVED_FACET_INVALID', reasons);
  rejectIf(observedFacets.every(item => typeof item === 'string') && !uniqueStrings(observedFacets as string[]), 'OBSERVED_FACETS_DUPLICATED', reasons);

  const spans: SemanticSourceSpan[] = [];
  const sourceSpans = Array.isArray(value.sourceSpans) ? value.sourceSpans : [];
  rejectIf(sourceSpans.length > 12, 'SOURCE_SPANS_TOO_MANY', reasons);
  sourceSpans.forEach((item, index) => {
    if (!isRecord(item)) {
      reasons.push('SOURCE_SPAN_' + index + '_MUST_BE_OBJECT');
      return;
    }
    hasOnlyKeys(item, ['evidenceRef', 'quote'], 'SOURCE_SPAN_' + index, reasons);
    if (!nonEmptyString(item.evidenceRef)) reasons.push('SOURCE_SPAN_' + index + '_REF_INVALID');
    if (!nonEmptyString(item.quote)) reasons.push('SOURCE_SPAN_' + index + '_QUOTE_INVALID');
    if (nonEmptyString(item.evidenceRef) && !allowedRefs.has(item.evidenceRef)) {
      reasons.push('SOURCE_SPAN_' + index + '_REF_NOT_ALLOWED');
    }
    if (nonEmptyString(item.quote) && !containsContiguousQuote(context.evidenceText, item.quote)) {
      reasons.push('SOURCE_SPAN_' + index + '_QUOTE_NOT_CONTIGUOUS');
    }
    if (nonEmptyString(item.evidenceRef) && nonEmptyString(item.quote)) {
      spans.push({ evidenceRef: item.evidenceRef, quote: item.quote });
    }
  });

  const spanRefs = new Set(spans.map(span => span.evidenceRef));
  const candidates: SemanticMemoryCandidate[] = [];
  const memoryCandidates = Array.isArray(value.memoryCandidates) ? value.memoryCandidates : [];
  rejectIf(memoryCandidates.length > 8, 'MEMORY_CANDIDATES_TOO_MANY', reasons);
  memoryCandidates.forEach((item, index) => {
    if (!isRecord(item)) {
      reasons.push('MEMORY_CANDIDATE_' + index + '_MUST_BE_OBJECT');
      return;
    }
    hasOnlyKeys(item, ['claim', 'contentType', 'sensitivityHint', 'sourceEvidenceRefs'], 'MEMORY_CANDIDATE_' + index, reasons);
    if (!nonEmptyString(item.claim)) reasons.push('MEMORY_CANDIDATE_' + index + '_CLAIM_INVALID');
    if (!nonEmptyString(item.contentType)) reasons.push('MEMORY_CANDIDATE_' + index + '_CONTENT_TYPE_INVALID');
    if (typeof item.sensitivityHint !== 'string' || !SENSITIVITY_HINTS.has(item.sensitivityHint as SemanticSensitivityHint)) {
      reasons.push('MEMORY_CANDIDATE_' + index + '_SENSITIVITY_HINT_INVALID');
    }
    if (!Array.isArray(item.sourceEvidenceRefs) || item.sourceEvidenceRefs.length === 0) {
      reasons.push('MEMORY_CANDIDATE_' + index + '_SOURCE_REFS_REQUIRED');
    } else {
      if (item.sourceEvidenceRefs.some(ref => typeof ref !== 'string' || !spanRefs.has(ref))) {
        reasons.push('MEMORY_CANDIDATE_' + index + '_SOURCE_REF_NOT_IN_VALIDATED_SPANS');
      }
      if (!uniqueStrings(item.sourceEvidenceRefs as string[])) {
        reasons.push('MEMORY_CANDIDATE_' + index + '_SOURCE_REFS_DUPLICATED');
      }
    }
    if (nonEmptyString(item.claim) && nonEmptyString(item.contentType)
      && typeof item.sensitivityHint === 'string' && SENSITIVITY_HINTS.has(item.sensitivityHint as SemanticSensitivityHint)
      && Array.isArray(item.sourceEvidenceRefs) && item.sourceEvidenceRefs.every(ref => typeof ref === 'string' && spanRefs.has(ref))) {
      candidates.push({
        claim: item.claim,
        contentType: item.contentType,
        sensitivityHint: item.sensitivityHint as SemanticSensitivityHint,
        sourceEvidenceRefs: [...item.sourceEvidenceRefs] as string[],
      });
    }
  });

  if (reasons.length > 0) return { accepted: false, proposal: null, reasonCodes: [...new Set(reasons)] };
  return {
    accepted: true,
    proposal: {
      schemaVersion: '0.1',
      userIntent: value.userIntent as SemanticUserIntent,
      topicId: value.topicId as string | null,
      observedFacets: [...observedFacets] as SemanticFacet[],
      sourceSpans: spans,
      memoryCandidates: candidates,
      relatedMemoryQuery: value.relatedMemoryQuery as string | null,
      userUncertainty: value.userUncertainty as SemanticUncertainty,
      needsClarification: value.needsClarification as boolean,
    },
    reasonCodes: ['SEMANTIC_PROPOSAL_VALIDATED'],
  };
}

export function assertSemanticTurnProposal(
  value: unknown,
  context: SemanticTurnValidationContext,
): SemanticTurnProposal {
  const result = validateSemanticTurnProposal(value, context);
  if (!result.accepted || !result.proposal) {
    throw new Error('semantic_turn_proposal_invalid:' + result.reasonCodes.join(','));
  }
  return result.proposal;
}
