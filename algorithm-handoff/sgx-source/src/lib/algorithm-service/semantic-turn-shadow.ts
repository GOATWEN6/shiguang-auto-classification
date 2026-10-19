import {
  validateSemanticTurnProposal,
  type SemanticTurnProposal,
  type SemanticTurnValidationContext,
  type SemanticUncertainty,
} from './semantic-turn-proposal.ts';

export const SEMANTIC_TURN_SHADOW_VERSION = 'semantic-turn-shadow-v0.1';

export type SemanticIntentKind =
  | 'CONTINUE'
  | 'THINKING'
  | 'UNCERTAIN_MEMORY'
  | 'POSSIBLE_AVOID'
  | 'DECLINE_TOPIC'
  | 'CHANGE_TOPIC'
  | 'ACCEPT_INVITATION'
  | 'DECLINE_INVITATION'
  | 'PAUSE_INTERVIEW'
  | 'END_INTERVIEW'
  | 'NO_SAVING'
  | 'UNKNOWN';

export type SemanticShareInterest = 'NONE' | 'AMBIGUOUS' | 'EXPLICIT';

export type NarrativeCueKind =
  | 'PERSON_RELATION'
  | 'EVENT_TURN'
  | 'SELF_EXPRESSED_MEANING'
  | 'OPEN_DETAIL';

export type NarrativeCueEpistemic = 'EXPLICIT' | 'UNANSWERED' | 'MODEL_INFERENCE';

export type SemanticActionKind =
  | 'WAIT'
  | 'ACKNOWLEDGE'
  | 'FOLLOW_UP'
  | 'FOLLOW_USER_TOPIC'
  | 'OFFER_DIRECTION'
  | 'CLARIFY'
  | 'INVITE_INTERVIEW'
  | 'PAUSE_INTERVIEW'
  | 'END_INTERVIEW';

export interface NarrativeCue {
  cueId: string;
  kind: NarrativeCueKind;
  epistemic: NarrativeCueEpistemic;
  sourceEvidenceRefs: string[];
  topicId: string | null;
}

export interface SemanticActionCandidate {
  candidateId: string;
  action: SemanticActionKind;
  topicId: string | null;
  premiseRefs: string[];
  reasonCodes: string[];
  proposedQuestionIntent: string | null;
}

/**
 * One lightweight semantic analysis produced by the LLM in shadow mode.
 *
 * `proposal` is the source-bound contract already used by the Memory
 * extractor. Cues and actions are observations/candidates only. They do not
 * grant permission, change the InterviewPolicy decision, or write Memory.
 */
export interface SemanticTurnShadowProposal {
  schemaVersion: '0.1';
  intentKind: SemanticIntentKind;
  shareInterest: SemanticShareInterest;
  proposal: SemanticTurnProposal;
  narrativeCues: NarrativeCue[];
  nextActionCandidates: SemanticActionCandidate[];
}

export interface SemanticTurnShadowValidationContext extends SemanticTurnValidationContext {
  mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW';
  currentTopic: string | null;
  allowedActionKinds?: readonly SemanticActionKind[];
}

export interface SemanticTurnShadowValidationResult {
  accepted: boolean;
  proposal: SemanticTurnShadowProposal | null;
  reasonCodes: string[];
}

export type SemanticTurnShadowStatus = 'ACCEPTED' | 'REJECTED' | 'ERROR';

export interface SemanticTurnShadowRecord {
  schemaVersion: typeof SEMANTIC_TURN_SHADOW_VERSION;
  status: SemanticTurnShadowStatus;
  mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW';
  evidenceRef: string;
  policySideEffect: 'NONE';
  reasonCodes: string[];
  analysis: SemanticTurnShadowProposal | null;
}

const INTENTS = new Set<SemanticIntentKind>([
  'CONTINUE', 'THINKING', 'UNCERTAIN_MEMORY', 'POSSIBLE_AVOID', 'DECLINE_TOPIC',
  'CHANGE_TOPIC', 'ACCEPT_INVITATION', 'DECLINE_INVITATION', 'PAUSE_INTERVIEW',
  'END_INTERVIEW', 'NO_SAVING', 'UNKNOWN',
]);
const SHARE_INTEREST = new Set<SemanticShareInterest>(['NONE', 'AMBIGUOUS', 'EXPLICIT']);
const CUE_KINDS = new Set<NarrativeCueKind>([
  'PERSON_RELATION', 'EVENT_TURN', 'SELF_EXPRESSED_MEANING', 'OPEN_DETAIL',
]);
const EPISTEMICS = new Set<NarrativeCueEpistemic>(['EXPLICIT', 'UNANSWERED', 'MODEL_INFERENCE']);
const ACTIONS = new Set<SemanticActionKind>([
  'WAIT', 'ACKNOWLEDGE', 'FOLLOW_UP', 'FOLLOW_USER_TOPIC', 'OFFER_DIRECTION',
  'CLARIFY', 'INVITE_INTERVIEW', 'PAUSE_INTERVIEW', 'END_INTERVIEW',
]);

const PROPOSAL_INTENTS = new Set<SemanticTurnProposal['userIntent']>([
  'CONTINUE_TOPIC', 'SWITCH_TOPIC', 'SKIP_TOPIC', 'PAUSE', 'END',
  'ASK_FOR_HELP', 'ORDINARY_CHAT', 'UNKNOWN',
]);
const PROPOSAL_FACETS = new Set<SemanticTurnProposal['observedFacets'][number]>([
  'PERSON', 'TIME', 'PLACE', 'EVENT', 'SCENE', 'RELATIONSHIP', 'MEANING', 'CHANGE', 'OBJECT',
]);
const PROPOSAL_UNCERTAINTIES = new Set<SemanticUncertainty>(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown, field: string, reasons: string[], max = 16): value is string[] {
  if (!Array.isArray(value)) {
    reasons.push(field + '_MUST_BE_ARRAY');
    return false;
  }
  if (value.length > max) reasons.push(field + '_TOO_MANY');
  if (value.some(item => !nonEmptyString(item))) reasons.push(field + '_ITEM_INVALID');
  if (value.every(item => typeof item === 'string') && new Set(value).size !== value.length) {
    reasons.push(field + '_DUPLICATED');
  }
  return value.every(item => typeof item === 'string');
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], field: string, reasons: string[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) reasons.push(field + '_UNSUPPORTED_FIELD_' + key);
  }
}

function assertNullableString(value: unknown, field: string, reasons: string[]): void {
  if (value !== null && !nonEmptyString(value)) reasons.push(field + '_INVALID');
}

export interface SemanticTurnShadowNormalizationContext {
  evidenceText: string;
  allowedEvidenceRefs: readonly string[];
}

export interface SemanticTurnShadowNormalizationResult {
  value: unknown;
  normalized: boolean;
  reasonCodes: string[];
}

const AUTHORITY_KEYS = new Set([
  'authorization', 'canPersistMemory', 'delete', 'persist', 'save', 'share', 'write',
]);

function containsAuthorityKey(value: unknown, depth = 0): boolean {
  if (depth > 4 || !isRecord(value)) return false;
  if (Object.keys(value).some(key => AUTHORITY_KEYS.has(key))) return true;
  return Object.values(value).some(item => containsAuthorityKey(item, depth + 1));
}

function firstText(...values: unknown[]): string {
  for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim();
  return '';
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringValues(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim());
}

function normalizeTopicId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.find(item => typeof item === 'string' && item.trim())?.trim() ?? null;
  return null;
}

function mapIntent(value: unknown, intentKind: unknown, text: string): SemanticTurnProposal['userIntent'] {
  if (typeof value === 'string' && PROPOSAL_INTENTS.has(value as SemanticTurnProposal['userIntent'])) {
    return value as SemanticTurnProposal['userIntent'];
  }
  const source = `${String(value ?? '')} ${text}`;
  if (/(?:暂停|等会儿再聊|先停)/u.test(source)) return 'PAUSE';
  if (/(?:结束|到这里|今天聊到这|访谈先结束)/u.test(source)) return 'END';
  if (/(?:换.{0,8}话题|改聊|先随便聊|日常闲聊)/u.test(source)) return 'SWITCH_TOPIC';
  if (/(?:不想|不愿|拒绝|别再|不要再|不再|不接受)/u.test(source)) return 'SKIP_TOPIC';
  if (/(?:同意|愿意进入|进入正式访谈|我想聊|继续刚才|继续之前|接着聊)/u.test(source)) return 'CONTINUE_TOPIC';
  if (/(?:帮我|请把|整理成|生成|写成|查询|还记得)/u.test(source)) return 'ASK_FOR_HELP';
  if (/(?:记不起来|还没想好|不确定|不知道|模糊)/u.test(source)) return 'UNKNOWN';
  switch (intentKind) {
    case 'CHANGE_TOPIC': return 'SWITCH_TOPIC';
    case 'PAUSE_INTERVIEW': return 'PAUSE';
    case 'END_INTERVIEW': return 'END';
    case 'DECLINE_TOPIC': case 'DECLINE_INVITATION': case 'POSSIBLE_AVOID': return 'SKIP_TOPIC';
    case 'ACCEPT_INVITATION': return 'CONTINUE_TOPIC';
    case 'UNCERTAIN_MEMORY': case 'NO_SAVING': case 'UNKNOWN': return 'UNKNOWN';
    default: return 'CONTINUE_TOPIC';
  }
}

function mapIntentKind(value: unknown, text: string): SemanticIntentKind {
  if (typeof value === 'string' && INTENTS.has(value as SemanticIntentKind)) return value as SemanticIntentKind;
  if (/(?:不保存|不要保存|别保存)/u.test(text)) return 'NO_SAVING';
  if (/(?:暂停|等会儿再聊|先停)/u.test(text)) return 'PAUSE_INTERVIEW';
  if (/(?:结束|到这里|今天聊到这)/u.test(text)) return 'END_INTERVIEW';
  if (/(?:换.{0,8}话题|改聊|先随便聊)/u.test(text)) return 'CHANGE_TOPIC';
  if (/(?:不想|不愿|拒绝|别再|不要再|不再)/u.test(text)) return 'DECLINE_TOPIC';
  if (/(?:愿意进入|同意进入|聊往事)/u.test(text)) return 'ACCEPT_INVITATION';
  if (/(?:记不起来|还没想好|不确定|不知道|模糊)/u.test(text)) return 'UNCERTAIN_MEMORY';
  return 'UNKNOWN';
}

function mapShareInterest(value: unknown, intentKind: SemanticIntentKind, text: string): SemanticShareInterest {
  if (typeof value === 'string' && SHARE_INTEREST.has(value as SemanticShareInterest)) {
    return value as SemanticShareInterest;
  }
  if (['DECLINE_TOPIC', 'DECLINE_INVITATION', 'POSSIBLE_AVOID', 'NO_SAVING', 'END_INTERVIEW'].includes(intentKind)) {
    return 'NONE';
  }
  if (/(?:想聊|愿意|分享|继续|同意)/u.test(text)) return 'EXPLICIT';
  return 'AMBIGUOUS';
}

function mapFacet(value: unknown, source: string): SemanticTurnProposal['observedFacets'][number] | null {
  if (typeof value === 'string' && PROPOSAL_FACETS.has(value as SemanticTurnProposal['observedFacets'][number])) {
    return value as SemanticTurnProposal['observedFacets'][number];
  }
  const text = `${String(value ?? '')} ${source}`;
  if (/(?:人物|人|师傅|儿子|女儿|父亲|母亲|同学|老师)/u.test(text)) return 'PERSON';
  if (/(?:关系|家里|家庭|夫妻|父子|母女)/u.test(text)) return 'RELATIONSHIP';
  if (/(?:时间|年份|年|春天|小时候|以前|后来)/u.test(text)) return 'TIME';
  if (/(?:地点|工厂|学校|城市|上海|阳台|家里)/u.test(text)) return 'PLACE';
  if (/(?:场景|天气|室内|户外|餐桌)/u.test(text)) return 'SCENE';
  if (/(?:变化|搬家|转行|后来|从那以后)/u.test(text)) return 'CHANGE';
  if (/(?:意义|感受|希望|不想|愿意|只想|喜欢|爱好)/u.test(text)) return 'MEANING';
  if (/(?:物件|机器|书包|收音机|照片|物品)/u.test(text)) return 'OBJECT';
  if (/(?:事件|事情|经历|故事|工作|进厂|婚礼|生日)/u.test(text)) return 'EVENT';
  return null;
}

function mapUncertainty(value: unknown, source: string): SemanticUncertainty {
  if (typeof value === 'string' && PROPOSAL_UNCERTAINTIES.has(value as SemanticUncertainty)) {
    return value as SemanticUncertainty;
  }
  if (typeof value === 'string' && value.trim().toUpperCase() === 'NONE') return 'LOW';
  if (/(?:记不起来|还没想好|不知道|是否生病|不确定)/u.test(`${String(value ?? '')} ${source}`)) return 'HIGH';
  if (/(?:大概|可能|前后|模糊|记不清)/u.test(`${String(value ?? '')} ${source}`)) return 'MEDIUM';
  return 'UNKNOWN';
}

function resolveSourceRef(value: unknown, aliases: readonly { alias: string; evidenceRef: string }[], allowed: Set<string>): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const token = String(value).trim();
  if (allowed.has(token)) return token;
  return aliases.find(item => item.alias === token)?.evidenceRef ?? null;
}

function uniqueStringsSafe(values: readonly string[]): string[] {
  return [...new Set(values.filter(item => item.trim()))];
}

function inferContentType(claim: string): string {
  if (/(?:喜欢|爱好|偏好|常听|常看)/u.test(claim)) return 'preference';
  if (/(?:语速|称呼|一次一问|聊天|交流)/u.test(claim)) return 'interaction_preference';
  if (/(?:计划|准备|打算|明天|下周)/u.test(claim)) return 'temporary_plan';
  if (/(?:健康|生病|吃不下|血压|用药)/u.test(claim)) return 'health_context';
  if (/(?:儿子|女儿|父亲|母亲|师傅|同学|家人)/u.test(claim)) return 'relationship';
  return 'life_event';
}

/**
 * Models used by the internal baseline have returned two older variants of
 * this observation schema. This adapter only performs loss-aware renaming and
 * source rebinding; the strict validator below still decides acceptance.
 * It never maps authority fields and never invents a source outside this turn.
 */
export function normalizeSemanticTurnShadowModelOutput(
  value: unknown,
  context: SemanticTurnShadowNormalizationContext,
): SemanticTurnShadowNormalizationResult {
  if (!isRecord(value)) return { value, normalized: false, reasonCodes: [] };
  if (containsAuthorityKey(value)) return { value, normalized: false, reasonCodes: ['MODEL_AUTHORITY_FIELD_PRESENT'] };
  const proposalInput = isRecord(value.proposal) ? value.proposal : {};
  const allowed = new Set(context.allowedEvidenceRefs);
  const topText = JSON.stringify(value);
  const rawSpans = Array.isArray(proposalInput.sourceSpans) ? proposalInput.sourceSpans : [];
  const aliases: Array<{ alias: string; evidenceRef: string }> = [];
  const sourceSpans: Array<{ evidenceRef: string; quote: string; id: string }> = [];
  rawSpans.forEach((item, index) => {
    if (!isRecord(item) || typeof item.quote !== 'string' || !item.quote.trim()) return;
    let evidenceRef: string | null = null;
    if (typeof item.evidenceRef === 'string') evidenceRef = allowed.has(item.evidenceRef) ? item.evidenceRef : null;
    else if (allowed.size === 1) evidenceRef = [...allowed][0] ?? null;
    if (!evidenceRef) return;
    const id = typeof item.spanId === 'string' && item.spanId.trim() ? item.spanId.trim() : `span:${index}`;
    sourceSpans.push({ evidenceRef, quote: item.quote.trim(), id });
    for (const alias of [id, String(index), `span:${index}`, `span_${index}`, `span-${index}`]) {
      aliases.push({ alias, evidenceRef });
    }
  });
  const allSourceRefs = uniqueStringsSafe(sourceSpans.map(item => item.evidenceRef));
  const sourceFor = (item: Record<string, unknown>): string[] => {
    const raw: unknown[] = [
      ...stringValues(item.sourceEvidenceRefs), ...stringValues(item.sourceSpanRefs),
      ...stringValues(item.targetSpanRefs), ...stringValues(item.targetSpanIds),
      ...stringValues(item.referenceSpanId), ...stringValues(item.refSpanId),
      ...stringValues(item.ref), ...stringValues(item.spanRef),
    ];
    for (const key of ['sourceSpanIndex', 'refSpanIndex', 'refSpanIndex', 'spanRefIndex', 'targetSpanIndex']) {
      if (typeof item[key] === 'number' || typeof item[key] === 'string') raw.push(item[key]);
    }
    const mapped = raw.map(ref => resolveSourceRef(ref, aliases, allowed)).filter((ref): ref is string => Boolean(ref));
    if (mapped.length) return uniqueStringsSafe(mapped);
    if (sourceSpans.length === 1 && Object.keys(item).length > 0) return allSourceRefs;
    return [];
  };
  const quoteFor = (refs: readonly string[]): string | null => {
    const span = sourceSpans.find(item => refs.includes(item.evidenceRef)) ?? sourceSpans[0];
    return span?.quote ?? null;
  };
  const rawMemory = Array.isArray(proposalInput.memoryCandidates) ? proposalInput.memoryCandidates : [];
  const memoryCandidates = rawMemory.flatMap((rawItem, index) => {
    const item: Record<string, unknown> = isRecord(rawItem) ? rawItem : { ref: rawItem };
    const sourceEvidenceRefs = sourceFor(item);
    if (!sourceEvidenceRefs.length) return [];
    const claim = firstText(item.claim, item.normalizedClaim, item.content, item.summary,
      item.label, item.facet, item.targetFacet, quoteFor(sourceEvidenceRefs));
    if (!claim) return [];
    const hint = firstText(item.sensitivityHint, item.sensitivityLevel);
    return [{
      claim, contentType: firstText(item.contentType) || inferContentType(claim),
      sensitivityHint: ['S0', 'S1', 'S2', 'UNKNOWN'].includes(hint) ? hint : 'UNKNOWN',
      sourceEvidenceRefs,
    }];
  });
  const normalizedSourceRefs = new Set(sourceSpans.map(item => item.evidenceRef));
  const rawCues = Array.isArray(value.narrativeCues) ? value.narrativeCues : [];
  const narrativeCues = rawCues.flatMap((rawItem, index) => {
    if (!isRecord(rawItem)) return [];
    const sourceEvidenceRefs = stringValues(rawItem.sourceEvidenceRefs)
      .map(ref => resolveSourceRef(ref, aliases, allowed)).filter((ref): ref is string => Boolean(ref));
    const refs = uniqueStringsSafe(sourceEvidenceRefs.length ? sourceEvidenceRefs : allSourceRefs);
    if (!refs.length || !refs.every(ref => normalizedSourceRefs.has(ref))) return [];
    const cueText = `${JSON.stringify(rawItem)} ${context.evidenceText}`;
    const kind = CUE_KINDS.has(rawItem.kind as NarrativeCueKind)
      ? rawItem.kind as NarrativeCueKind : mapFacet(rawItem.kind, cueText) === 'PERSON'
        ? 'PERSON_RELATION' : mapFacet(rawItem.kind, cueText) === 'MEANING'
          ? 'SELF_EXPRESSED_MEANING' : mapFacet(rawItem.kind, cueText) === 'EVENT'
            ? 'EVENT_TURN' : 'OPEN_DETAIL';
    const epistemic = EPISTEMICS.has(rawItem.epistemic as NarrativeCueEpistemic)
      ? rawItem.epistemic as NarrativeCueEpistemic : 'EXPLICIT';
    return [{ cueId: firstText(rawItem.cueId) || `cue:${index + 1}`, kind,
      epistemic, sourceEvidenceRefs: refs, topicId: normalizeTopicId(rawItem.topicId) }];
  });
  const cueIds = new Set(narrativeCues.map(item => item.cueId));
  const rawActions = Array.isArray(value.nextActionCandidates) ? value.nextActionCandidates : [];
  const nextActionCandidates = rawActions.flatMap((rawItem, index) => {
    if (!isRecord(rawItem)) return [];
    const action = ACTIONS.has(rawItem.action as SemanticActionKind)
      ? rawItem.action as SemanticActionKind : null;
    if (!action) return [];
    const premises = stringValues(rawItem.premiseRefs).flatMap(ref => {
      const sourceRef = resolveSourceRef(ref, aliases, allowed);
      if (sourceRef) return [sourceRef];
      if (cueIds.has(ref)) return [ref];
      return [];
    });
    const question = nullableText(rawItem.proposedQuestionIntent);
    return [{ candidateId: firstText(rawItem.candidateId) || `candidate:${index + 1}`, action,
      topicId: normalizeTopicId(rawItem.topicId), premiseRefs: uniqueStringsSafe(premises),
      reasonCodes: stringValues(rawItem.reasonCodes), proposedQuestionIntent: question }];
  });
  const intentKind = mapIntentKind(value.intentKind, topText);
  const userIntent = mapIntent(proposalInput.userIntent, intentKind, context.evidenceText);
  const facetSource = `${context.evidenceText} ${JSON.stringify(proposalInput.observedFacets ?? [])}`;
  const observedFacets = uniqueStringsSafe((Array.isArray(proposalInput.observedFacets) ? proposalInput.observedFacets : [])
    .map(item => mapFacet(item, facetSource))
    .filter((item): item is SemanticTurnProposal['observedFacets'][number] => item !== null));
  const relatedMemoryQuery = stringValues(proposalInput.relatedMemoryQuery).join('；') || null;
  const normalized = {
    schemaVersion: '0.1', intentKind, shareInterest: mapShareInterest(value.shareInterest, intentKind, topText),
    proposal: {
      schemaVersion: '0.1', userIntent, topicId: normalizeTopicId(proposalInput.topicId),
      observedFacets, sourceSpans: sourceSpans.map(({ evidenceRef, quote }) => ({ evidenceRef, quote })),
      memoryCandidates, relatedMemoryQuery,
      userUncertainty: mapUncertainty(proposalInput.userUncertainty, context.evidenceText),
      needsClarification: proposalInput.needsClarification === true,
    }, narrativeCues, nextActionCandidates,
  };
  const originalVersion = typeof value.schemaVersion === 'string' ? value.schemaVersion : 'missing';
  const reasonCodes = ['MODEL_OUTPUT_NORMALIZED'];
  if (originalVersion !== '0.1') reasonCodes.push(`MODEL_SCHEMA_VERSION_NORMALIZED_${originalVersion}`);
  return { value: normalized, normalized: true, reasonCodes };
}

/**
 * Validate the richer handoff contract while keeping all model output in the
 * shadow plane. Fail closed on unsupported authority-like fields.
 */
export function validateSemanticTurnShadowProposal(
  value: unknown,
  context: SemanticTurnShadowValidationContext,
): SemanticTurnShadowValidationResult {
  const reasons: string[] = [];
  if (!isRecord(value)) return { accepted: false, proposal: null, reasonCodes: ['SHADOW_MUST_BE_OBJECT'] };
  hasOnlyKeys(value, [
    'schemaVersion', 'intentKind', 'shareInterest', 'proposal', 'narrativeCues', 'nextActionCandidates',
  ], 'shadow', reasons);
  if (value.schemaVersion !== '0.1') reasons.push('SHADOW_SCHEMA_VERSION_UNSUPPORTED');
  if (typeof value.intentKind !== 'string' || !INTENTS.has(value.intentKind as SemanticIntentKind)) {
    reasons.push('INTENT_KIND_INVALID');
  }
  if (typeof value.shareInterest !== 'string' || !SHARE_INTEREST.has(value.shareInterest as SemanticShareInterest)) {
    reasons.push('SHARE_INTEREST_INVALID');
  }
  if (!Array.isArray(value.narrativeCues)) reasons.push('NARRATIVE_CUES_MUST_BE_ARRAY');
  if (!Array.isArray(value.nextActionCandidates)) reasons.push('NEXT_ACTION_CANDIDATES_MUST_BE_ARRAY');

  const proposalResult = validateSemanticTurnProposal(value.proposal, context);
  if (!proposalResult.accepted || !proposalResult.proposal) {
    reasons.push(...proposalResult.reasonCodes.map(reason => 'PROPOSAL_' + reason));
  }
  const validatedSourceRefs = new Set(proposalResult.proposal?.sourceSpans.map(span => span.evidenceRef) ?? []);

  const cues: NarrativeCue[] = [];
  const cueIds = new Set<string>();
  const narrativeCues = Array.isArray(value.narrativeCues) ? value.narrativeCues : [];
  if (narrativeCues.length > 12) reasons.push('NARRATIVE_CUES_TOO_MANY');
  narrativeCues.forEach((item, index) => {
    const field = 'NARRATIVE_CUE_' + index;
    if (!isRecord(item)) {
      reasons.push(field + '_MUST_BE_OBJECT');
      return;
    }
    hasOnlyKeys(item, ['cueId', 'kind', 'epistemic', 'sourceEvidenceRefs', 'topicId'], field, reasons);
    if (!nonEmptyString(item.cueId)) reasons.push(field + '_ID_INVALID');
    else if (cueIds.has(item.cueId)) reasons.push(field + '_ID_DUPLICATED');
    else cueIds.add(item.cueId);
    if (typeof item.kind !== 'string' || !CUE_KINDS.has(item.kind as NarrativeCueKind)) reasons.push(field + '_KIND_INVALID');
    if (typeof item.epistemic !== 'string' || !EPISTEMICS.has(item.epistemic as NarrativeCueEpistemic)) reasons.push(field + '_EPISTEMIC_INVALID');
    const refs = stringArray(item.sourceEvidenceRefs, field + '_SOURCE_REFS', reasons, 8)
      ? item.sourceEvidenceRefs as string[] : [];
    if (refs.some(ref => !validatedSourceRefs.has(ref))) reasons.push(field + '_SOURCE_REF_NOT_VALIDATED');
    assertNullableString(item.topicId, field + '_TOPIC_ID', reasons);
    if (nonEmptyString(item.cueId) && typeof item.kind === 'string' && CUE_KINDS.has(item.kind as NarrativeCueKind)
      && typeof item.epistemic === 'string' && EPISTEMICS.has(item.epistemic as NarrativeCueEpistemic)
      && refs.length > 0 && refs.every(ref => validatedSourceRefs.has(ref))
      && (item.topicId === null || nonEmptyString(item.topicId))) {
      cues.push({ cueId: item.cueId, kind: item.kind as NarrativeCueKind,
        epistemic: item.epistemic as NarrativeCueEpistemic, sourceEvidenceRefs: [...refs],
        topicId: item.topicId as string | null });
    }
  });

  const candidates: SemanticActionCandidate[] = [];
  const candidateIds = new Set<string>();
  const nextActionCandidates = Array.isArray(value.nextActionCandidates) ? value.nextActionCandidates : [];
  if (nextActionCandidates.length > 8) reasons.push('NEXT_ACTION_CANDIDATES_TOO_MANY');
  const permittedActions = new Set(context.allowedActionKinds ?? [...ACTIONS]);
  nextActionCandidates.forEach((item, index) => {
    const field = 'NEXT_ACTION_CANDIDATE_' + index;
    if (!isRecord(item)) {
      reasons.push(field + '_MUST_BE_OBJECT');
      return;
    }
    hasOnlyKeys(item, [
      'candidateId', 'action', 'topicId', 'premiseRefs', 'reasonCodes', 'proposedQuestionIntent',
    ], field, reasons);
    if (!nonEmptyString(item.candidateId)) reasons.push(field + '_ID_INVALID');
    else if (candidateIds.has(item.candidateId)) reasons.push(field + '_ID_DUPLICATED');
    else candidateIds.add(item.candidateId);
    if (typeof item.action !== 'string' || !ACTIONS.has(item.action as SemanticActionKind)) reasons.push(field + '_ACTION_INVALID');
    else if (!permittedActions.has(item.action as SemanticActionKind)) reasons.push(field + '_ACTION_NOT_PERMITTED_IN_MODE');
    assertNullableString(item.topicId, field + '_TOPIC_ID', reasons);
    const premiseRefs = stringArray(item.premiseRefs, field + '_PREMISE_REFS', reasons, 12)
      ? item.premiseRefs as string[] : [];
    if (premiseRefs.some(ref => !validatedSourceRefs.has(ref) && !cueIds.has(ref))) {
      reasons.push(field + '_PREMISE_REF_NOT_VALIDATED');
    }
    const reasonCodes = stringArray(item.reasonCodes, field + '_REASON_CODES', reasons, 12)
      ? item.reasonCodes as string[] : [];
    assertNullableString(item.proposedQuestionIntent, field + '_QUESTION_INTENT', reasons);
    if (nonEmptyString(item.candidateId) && typeof item.action === 'string' && ACTIONS.has(item.action as SemanticActionKind)
      && permittedActions.has(item.action as SemanticActionKind)
      && (item.topicId === null || nonEmptyString(item.topicId))
      && premiseRefs.every(ref => validatedSourceRefs.has(ref) || cueIds.has(ref))
      && (item.proposedQuestionIntent === null || nonEmptyString(item.proposedQuestionIntent))) {
      candidates.push({ candidateId: item.candidateId, action: item.action as SemanticActionKind,
        topicId: item.topicId as string | null, premiseRefs: [...premiseRefs], reasonCodes: [...reasonCodes],
        proposedQuestionIntent: item.proposedQuestionIntent as string | null });
    }
  });

  if (reasons.length > 0 || !proposalResult.proposal) {
    return { accepted: false, proposal: null, reasonCodes: [...new Set(reasons)] };
  }
  return {
    accepted: true,
    proposal: {
      schemaVersion: '0.1',
      intentKind: value.intentKind as SemanticIntentKind,
      shareInterest: value.shareInterest as SemanticShareInterest,
      proposal: proposalResult.proposal,
      narrativeCues: cues,
      nextActionCandidates: candidates,
    },
    reasonCodes: ['SEMANTIC_TURN_SHADOW_VALIDATED'],
  };
}

export function summarizeSemanticTurnShadow(
  validation: SemanticTurnShadowValidationResult,
  mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW',
  evidenceRef: string,
): SemanticTurnShadowRecord {
  return {
    schemaVersion: SEMANTIC_TURN_SHADOW_VERSION,
    status: validation.accepted ? 'ACCEPTED' : 'REJECTED',
    mode,
    evidenceRef,
    policySideEffect: 'NONE',
    reasonCodes: [...validation.reasonCodes],
    analysis: validation.proposal,
  };
}

export const SEMANTIC_TURN_SHADOW_PROMPT = `你是SGX访谈与日常聊天的语义观察器，只做shadow分析，不执行动作、不保存记忆、不改变当前回复。输出必须是一个JSON对象，不能输出解释、Markdown或其他字段。
顶层字段和固定值如下：
{"schemaVersion":"0.1","intentKind":"CONTINUE","shareInterest":"AMBIGUOUS","proposal":{},"narrativeCues":[],"nextActionCandidates":[]}
schemaVersion必须是字符串"0.1"。intentKind只能是CONTINUE、THINKING、UNCERTAIN_MEMORY、POSSIBLE_AVOID、DECLINE_TOPIC、CHANGE_TOPIC、ACCEPT_INVITATION、DECLINE_INVITATION、PAUSE_INTERVIEW、END_INTERVIEW、NO_SAVING、UNKNOWN。shareInterest只能是NONE、AMBIGUOUS、EXPLICIT。
proposal必须完整包含：schemaVersion、userIntent、topicId、observedFacets、sourceSpans、memoryCandidates、relatedMemoryQuery、userUncertainty、needsClarification。proposal.schemaVersion固定为"0.1"；userIntent只能是CONTINUE_TOPIC、SWITCH_TOPIC、SKIP_TOPIC、PAUSE、END、ASK_FOR_HELP、ORDINARY_CHAT、UNKNOWN；topicId和relatedMemoryQuery必须是字符串或null；observedFacets只能使用PERSON、TIME、PLACE、EVENT、SCENE、RELATIONSHIP、MEANING、CHANGE、OBJECT；userUncertainty只能使用LOW、MEDIUM、HIGH、UNKNOWN；needsClarification必须是布尔值。
sourceSpans每项只能有evidenceRef和quote，evidenceRef必须使用输入中的allowedEvidenceRefs，quote必须是本轮原话中的连续片段。memoryCandidates每项只能有claim、contentType、sensitivityHint、sourceEvidenceRefs；sourceEvidenceRefs必须引用sourceSpans的evidenceRef。没有可靠候选时使用[]，不要猜测。
narrativeCues是暂时线索，不是长期记忆；每项只能有cueId、kind、epistemic、sourceEvidenceRefs、topicId。kind只能是PERSON_RELATION、EVENT_TURN、SELF_EXPRESSED_MEANING、OPEN_DETAIL；epistemic只能是EXPLICIT、UNANSWERED、MODEL_INFERENCE。nextActionCandidates只是候选，不能越过InterviewPolicy；每项只能有candidateId、action、topicId、premiseRefs、reasonCodes、proposedQuestionIntent；action只能是WAIT、ACKNOWLEDGE、FOLLOW_UP、FOLLOW_USER_TOPIC、OFFER_DIRECTION、CLARIFY、INVITE_INTERVIEW、PAUSE_INTERVIEW、END_INTERVIEW。
不要增加authorization、canPersistMemory、save、share、delete、write等字段；不要做心理、认知、健康、家庭冲突或财务推断。不要把模型推断当作sourceSpan。无法确定时使用UNKNOWN、UNKNOWN、[]或null。`;
