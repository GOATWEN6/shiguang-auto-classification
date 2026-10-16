import { createHash } from 'node:crypto';

import { runCase as runPolicyGate } from './policy.ts';
import type {
  EvidenceFragment,
  GovernanceAction,
  HybridExtractionResult,
  HybridExtractorOptions,
  HybridInput,
  MemoryAdapterMetadata,
  MemoryCaseInput,
  MemoryOrigin,
  MemoryPolicyContext,
  MemoryProposal,
  MemoryRelationship,
  RawSemanticProposal,
  SemanticProviderResponse,
  SensitivityLevel,
  SourceActor,
} from './contracts.ts';

type HybridProposal = MemoryProposal & {
  rawEvidenceRef: string;
  sourceEvidenceRefs: string[];
  sourceActor: SourceActor;
};

export const hybridExtractorMetadata = {
  extractorId: 'sgx-memory-hybrid-candidate-extractor',
  extractorVersion: '0.2.0',
  contractVersion: 'sgx-memory-candidate-adapter-v1',
  dependencies: [] as const,
  network: false,
  model: false,
  acceptedInputFields: ['policy', 'evidence', 'currentRecords'] as const,
  readsStructuredProposals: false,
  readsExpectedOracle: false,
  caseIdRules: false,
  canonicalWriteCapability: false,
} as const;

export const hybridAdapterMetadata: MemoryAdapterMetadata = {
  adapterId: 'sgx-memory-hybrid-candidate-adapter',
  adapterVersion: '0.2.0',
  contractVersion: 'sgx-memory-candidate-adapter-v1',
  externalFramework: false,
  canonicalWriteCapability: false,
};

const healthPattern = /吃不下|食欲|胃口|住院|疼痛|认知|健忘|记忆力|疾病|医嘱|用药|血压|血糖|头晕|发晕|眩晕|摔到头|头部受伤|胸闷|呼吸/u;
const safetyPattern = /跌倒|摔倒|摔到|摔伤|走失|迷路|煤气|燃气|忘关火|火灾|触电|吞咽|噎住|自伤|轻生|危险/u;
const financePattern = /借款|借钱|贷款|网贷|欠款|债务|元钱|万元|财产|遗产|存款|转账|汇款|投资|股票|基金|银行卡/u;
const credentialPattern = /密码|验证码|银行卡号|身份证号|私钥|token|api[ _-]?key/u;
const familyConflictPattern = /家庭冲突|家人冲突|亲戚矛盾|家庭矛盾|争吵|吵架|闹翻|不和/u;
const interactionPreferencePattern = /一次问一个|问题一次|字要大|大字号|字幕/u;
const lifeEventPattern = /结婚|第一次.*工作|搬到|迁居|毕业|退休|年轻时|小时候|上夜班/u;
const temporaryPattern = /这周|本周|今天|最近|当前会话|这次/u;
const historicalPattern = /以前|退休前|曾经|旧记录|此前|当年/u;
const explicitRememberPattern = /记住|帮我记|下次.*继续/u;
const explicitCorrectionPattern = /不是.*是|不对|改成|改一下|纠正|更正|认错|应该是|其实是|没有改成/u;
const temporalUncertaintyPattern = /(大概|大约|约莫|可能|也许|记不清|不确定|左右|前后)/u;
// “最近爱做/喜欢……” is a current preference signal, not automatically a
// disposable session fact. Other recent wording remains contextual unless the
// provider explicitly marks it as durable.
const recentPreferencePattern = /最近(?:.{0,8})(?:喜欢|爱做|爱吃|爱听|爱看|常做|习惯|偏好|不喜欢|不爱)/u;

function clean(value: unknown): string {
  return String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stableId(prefix: string, parts: unknown[]): string {
  const digest = createHash('sha256').update(parts.map(String).join('|')).digest('hex').slice(0, 16);
  return `${prefix}-${digest}`;
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function evidenceMatchesScope(item: EvidenceFragment | undefined, policy: MemoryPolicyContext): boolean {
  return item?.subjectId === policy.subjectId
    && item.useStatus === 'ACTIVE'
    && item.familySpaceId === policy.familySpaceId
    && (item.allowedPurposes.includes('*') || item.allowedPurposes.includes(policy.purpose))
    && (item.authorizationVersion === '*' || item.authorizationVersion === policy.authorizationVersion)
    && (item.visibilityScope.includes('*') || policy.visibilityScope.every(scope => item.visibilityScope.includes(scope)));
}

function originFor(item: EvidenceFragment): MemoryOrigin {
  if (item.actorRole === 'ai' && item.kind === 'derived_artifact') return 'AI_DERIVED';
  if (item.actorRole === 'ai' || item.kind === 'model_assertion') return 'PHOTO_MODEL';
  if (item.actorRole === 'system' || item.kind === 'system_observation') return 'SYSTEM_OBSERVATION';
  if (item.actorRole === 'community_worker') return 'COMMUNITY_REPORT';
  if (['family', 'family_admin'].includes(item.actorRole)) return 'FAMILY_REPORT';
  return 'SELF_REPORT';
}

function governanceFor(text: string): GovernanceAction {
  if (/恢复.*(?:禁谈|不要再提|撤回)|恢复出来/u.test(text)) return 'RESTORE_REQUEST';
  // A preservation instruction such as “别把以前的习惯全删掉” contains the
  // word “删掉” but is the opposite of a deletion request. Check the scope
  // before the positive verb so a model paraphrase cannot turn it into DELETE.
  if (/(?:别|不要|不能|不可以|千万别).{0,24}(?:删除|删掉|删了|清除|永久移除)/u.test(text)) return 'NONE';
  if (/删除|删掉|删了|清除|永久移除/u.test(text)) return 'DELETE';
  if (/别告诉|不要告诉|不得披露|不要透露|别(?:先)?给.*看|只(?:允许)?本人可见|仅(?:允许)?本人可见/u.test(text)) return 'RESTRICT';
  if (/撤回|以后不要再提|不要再问|不要写进|不要拿它|禁谈|停止使用|别存|别保存|不要保存|不保存/u.test(text)) return 'REVOKE';
  return 'NONE';
}

function riskCategoriesFor(text: string, contentType = ''): string[] {
  const categories: string[] = [];
  if (healthPattern.test(text) || contentType === 'health_context') categories.push('health');
  if (safetyPattern.test(text) || contentType === 'safety_context') categories.push('safety');
  if (financePattern.test(text) || contentType === 'financial_claim') categories.push('financial');
  if (credentialPattern.test(text) || contentType === 'credential_secret') categories.push('credential');
  if (familyConflictPattern.test(text) || contentType === 'family_conflict_claim') categories.push('family_conflict');
  return unique(categories);
}

function contentTypeForRisk(categories: string[]): string {
  if (categories.includes('credential')) return 'credential_secret';
  if (categories.includes('health')) return 'health_context';
  if (categories.includes('safety')) return 'safety_context';
  if (categories.includes('financial')) return 'financial_claim';
  return 'family_conflict_claim';
}

function contentTypeForGovernance(action: GovernanceAction): string {
  if (action === 'DELETE') return 'deletion_request';
  if (action === 'RESTORE_REQUEST') return 'restore_request';
  if (action === 'RESTRICT') return 'privacy_rule';
  return 'taboo_rule';
}

function temporalStateFor(
  text: string,
  origin: MemoryOrigin,
  action: GovernanceAction,
  semanticState?: unknown,
): string {
  if (action === 'REVOKE' || action === 'RESTORE_REQUEST') return 'REVOKED';
  if (action === 'RESTRICT') return 'RESTRICTED';
  if (action === 'DELETE') return 'PENDING_DELETE';
  if (origin === 'AI_DERIVED') return 'UNSUPPORTED';
  if (origin === 'PHOTO_MODEL') return 'MODEL_CANDIDATE';
  if (origin === 'SYSTEM_OBSERVATION') return 'OBSERVATION_ONLY';
  if (semanticState === 'HISTORICAL' || historicalPattern.test(text)) return 'HISTORICAL';
  if (semanticState === 'TEMPORARY_CURRENT' || temporaryPattern.test(text)) return 'TEMPORARY_CURRENT';
  return 'CURRENT';
}

function splitMustExtractClauses(text: string): string[] {
  return clean(text)
    .replace(/[,，](?=别告诉|不要告诉|不得披露|以后不要|请删除|删除|删掉|撤回|别存|别保存|不要保存|不保存|恢复)/gu, '。')
    .replace(/[;；！？]/gu, '。')
    .split('。')
    .map(part => clean(part))
    .filter(part => part.length >= 2);
}

function normalizedRiskClaim(
  clause: string,
  categories: string[],
  item: EvidenceFragment,
): string {
  if (categories.includes('credential')) return '检测到凭据或认证秘密；禁止进入长期记忆。';
  if (categories.includes('health') && /吃不下|食欲|胃口/u.test(clause)) return '老人近期食欲下降。';
  const attribution = item.actorRole === 'elder' ? '老人明确陈述' : `${item.actorRole}来源陈述`;
  return `${attribution}${contentTypeForRisk(categories)}：${clause}`;
}

function normalizedGovernanceClaim(action: GovernanceAction, clause: string): string {
  if (action === 'DELETE') return `请求删除并停止使用相关内容：${clause}`;
  if (action === 'RESTORE_REQUEST') return `请求恢复已撤回或禁谈内容：${clause}`;
  if (action === 'RESTRICT') return `限制相关信息披露：${clause}`;
  return `撤回或禁止继续使用相关内容：${clause}`;
}

function safeCredentialQuery(text: string): string {
  return unique(['密码', '验证码', '银行卡号', '身份证号', '私钥', 'token', 'api key']
    .filter(token => text.toLowerCase().includes(token))).join(' ') || '凭据 认证秘密';
}

interface ProposalDefaultsInput {
  item: EvidenceFragment;
  text: string;
  policy: MemoryPolicyContext;
  contentType: string;
  action: GovernanceAction;
  categories: string[];
  sourceEvidenceRefs: string[];
  proposalId: string;
  normalizedClaim: string;
}

function proposalDefaults({
  item,
  text,
  policy,
  contentType,
  action,
  categories,
  sourceEvidenceRefs,
  proposalId,
  normalizedClaim,
}: ProposalDefaultsInput): HybridProposal {
  const origin = originFor(item);
  const sensitivityLevel = categories.length > 0 || action !== 'NONE' ? 'S2' : /家庭|照片|老伴|亲戚/u.test(text) ? 'S1' : 'S0';
  const shortTerm = action === 'NONE' && temporaryPattern.test(text);
  const temporalState = temporalStateFor(text, origin, action);
  const governance = action !== 'NONE';
  return {
    proposalId,
    contentType,
    normalizedClaim,
    query: categories.includes('credential') ? safeCredentialQuery(text) : text,
    topK: sourceEvidenceRefs.length,
    eventTime: item.eventTime ?? null,
    validFrom: null,
    validTo: null,
    handlingProfile: lifeEventPattern.test(text) ? 'core_life' : shortTerm ? 'contextual_recent' : 'durable_personal',
    retentionPolicy: shortTerm ? 'expire_after_context' : 'until_superseded',
    importanceReasons: ['must_extract_safety_floor'],
    sensitivityLevel,
    sensitivityCategories: unique([...categories, governance ? 'governance' : null]),
    allowedUses: governance ? ['governance_filter'] : [policy.purpose],
    forbiddenUses: governance ? ['ordinary_retrieval', 'story_generation'] : ['family_broadcast'],
    reviewTrigger: 'user_correction',
    expiryOrSupersedeRule: 'supersede_on_new_direct_statement',
    mustNotHappen: unique([
      'must_not_bypass_business_policy_gate',
      'must_not_write_canonical_memory_from_extractor',
      categories.includes('credential') ? 'must_not_store_or_echo_credentials' : null,
    ]),
    relationships: [],
    rawEvidenceRef: sourceEvidenceRefs[0],
    sourceEvidenceRefs,
    sourceActor: { actorId: item.actorId, actorRole: item.actorRole },
    signals: {
      origin,
      explicitRemember: action === 'NONE' && explicitRememberPattern.test(text),
      explicitCorrection: action === 'NONE' && explicitCorrectionPattern.test(text),
      governanceAction: action,
      containsCredential: categories.includes('credential'),
      conflict: false,
      ambiguousSubject: false,
      purposeExpansion: item.kind === 'restricted_transcript' && policy.purpose !== 'care_session',
      visibilityExpansion: false,
      shortTerm,
      interactionPreference: action === 'NONE' && interactionPreferencePattern.test(text),
      interviewMaterial: item.kind === 'interview_transcript',
      ordinaryMemory: action === 'NONE' && origin === 'SELF_REPORT' && sensitivityLevel !== 'S2',
      reversible: true,
      auditable: true,
      temporalState,
    },
  };
}

export function scanMustExtract(input: HybridInput): HybridProposal[] {
  validateRawInput(input);
  const proposals: HybridProposal[] = [];
  for (const item of input.evidence) {
    if (!evidenceMatchesScope(item, input.policy)) continue;
    const clauses = splitMustExtractClauses(item.text);
    clauses.forEach((clause, clauseIndex) => {
      const action = governanceFor(clause);
      const categories = riskCategoriesFor(clause);
      if (action === 'NONE' && categories.length === 0) return;
      const contentType = action === 'NONE' ? contentTypeForRisk(categories) : contentTypeForGovernance(action);
      const normalizedClaim = action === 'NONE'
        ? normalizedRiskClaim(clause, categories, item)
        : normalizedGovernanceClaim(action, clause);
      proposals.push(proposalDefaults({
        item,
        text: clause,
        policy: input.policy,
        contentType,
        action,
        categories,
        sourceEvidenceRefs: [item.ref],
        proposalId: stableId('must', [item.ref, clauseIndex, action, contentType]),
        normalizedClaim,
      }));
    });
  }
  markConflicts(proposals);
  return proposals;
}

interface VerifiedSourceSpan {
  evidenceRef: string;
  quote: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function verifiedSourceSpans(
  rawProposal: RawSemanticProposal,
  evidenceByRef: Map<string, EvidenceFragment>,
  allowedEvidenceRefs: Set<string>,
): VerifiedSourceSpan[] {
  if (!Array.isArray(rawProposal.sourceSpans)) return [];
  const spans: VerifiedSourceSpan[] = [];
  for (const span of rawProposal.sourceSpans) {
    if (!isUnknownRecord(span)) continue;
    const ref = clean(span.evidenceRef);
    const quote = clean(span.quote);
    if (!allowedEvidenceRefs.has(ref)) continue;
    const evidence = evidenceByRef.get(ref);
    if (!evidence || !quote || !clean(evidence.text).includes(quote)) continue;
    spans.push({ evidenceRef: ref, quote });
  }
  return spans;
}

type SanitizedSemanticResult =
  | { proposal: HybridProposal; rejection?: never }
  | { proposal?: never; rejection: string };

function sanitizeSemanticProposal(
  rawValue: unknown,
  input: HybridInput,
  evidenceByRef: Map<string, EvidenceFragment>,
  index: number,
): SanitizedSemanticResult {
  const rawProposal = rawValue as RawSemanticProposal;
  if (!rawProposal || typeof rawProposal !== 'object') return { rejection: 'proposal_not_object' };
  if (rawProposal.sensitivityLevel !== undefined
    && rawProposal.sensitivityLevel !== 'S0'
    && rawProposal.sensitivityLevel !== 'S1'
    && rawProposal.sensitivityLevel !== 'S2') {
    return { rejection: 'invalid_sensitivity_level' };
  }
  if (rawProposal.signals !== undefined && !isUnknownRecord(rawProposal.signals)) {
    return { rejection: 'invalid_signals_object' };
  }
  const rawSignals = rawProposal.signals as Record<string, unknown> | undefined;
  for (const key of ['shortTerm', 'conflict', 'ambiguousSubject', 'purposeExpansion', 'visibilityExpansion']) {
    if (rawSignals?.[key] !== undefined && typeof rawSignals[key] !== 'boolean') {
      return { rejection: `invalid_signal_${key}` };
    }
  }
  if (rawSignals?.temporalState !== undefined && typeof rawSignals.temporalState !== 'string') {
    return { rejection: 'invalid_signal_temporalState' };
  }
  const normalizedClaim = clean(rawProposal.normalizedClaim);
  const contentType = clean(rawProposal.contentType);
  const sourceEvidenceRefs = unique(
    Array.isArray(rawProposal.sourceEvidenceRefs)
      ? rawProposal.sourceEvidenceRefs.map(item => clean(item))
      : [],
  );
  if (!normalizedClaim || !contentType) return { rejection: 'missing_content_type_or_claim' };
  if (sourceEvidenceRefs.length === 0) return { rejection: 'missing_source_evidence_refs' };
  const evidenceItems = sourceEvidenceRefs.map(ref => evidenceByRef.get(ref));
  if (evidenceItems.some(item => !item)) return { rejection: 'unknown_source_evidence_ref' };
  if (evidenceItems.some(item => !evidenceMatchesScope(item, input.policy))) return { rejection: 'source_evidence_out_of_scope_or_inactive' };
  const verifiedEvidenceItems = evidenceItems.filter((item): item is EvidenceFragment => Boolean(item));
  const actors = unique(verifiedEvidenceItems.map(item => `${item.actorId}\u0000${item.actorRole}`));
  if (actors.length !== 1) return { rejection: 'cross_actor_semantic_claim' };

  const spans = verifiedSourceSpans(rawProposal, evidenceByRef, new Set(sourceEvidenceRefs));
  if (spans.length === 0) return { rejection: 'missing_verified_source_span' };
  const verifiedRefs = new Set(spans.map(span => span.evidenceRef));
  if (sourceEvidenceRefs.some(ref => !verifiedRefs.has(ref))) {
    return { rejection: 'unverified_source_evidence_ref' };
  }
  const citedText = spans.map(span => span.quote).join(' ');
  const fullEvidenceText = verifiedEvidenceItems.map(item => clean(item.text)).join(' ');
  const semanticText = `${normalizedClaim} ${clean(rawProposal.query)} ${citedText}`;
  // Consent and policy-eligibility signals must come from verified evidence text,
  // never from provider-authored claims or queries.
  const authorizationText = citedText;
  const riskCategories = unique([
    ...riskCategoriesFor(semanticText, contentType),
    ...riskCategoriesFor(fullEvidenceText, contentType),
  ]);
  const containsCredential = riskCategories.includes('credential');
  const governanceType = ['privacy_rule', 'taboo_rule', 'revocation_rule', 'deletion_request', 'restore_request'].includes(contentType);
  const action = governanceType ? governanceFor(authorizationText) : 'NONE';
  if (governanceType && action === 'NONE') return { rejection: 'governance_type_without_verifiable_command' };
  const governedContentType = action === 'NONE' ? contentType : contentTypeForGovernance(action);
  const firstEvidence = verifiedEvidenceItems[0];
  if (!firstEvidence) return { rejection: 'unknown_source_evidence_ref' };
  const origin = originFor(firstEvidence);
  const durableRecentPreference = (contentType === 'preference' || contentType === 'interaction_preference')
    && recentPreferencePattern.test(semanticText);
  const shortTerm = Boolean(rawSignals?.shortTerm)
    || (temporaryPattern.test(semanticText) && !durableRecentPreference);
  const sensitivityLevel: SensitivityLevel = riskCategories.length > 0 || action !== 'NONE'
    ? 'S2'
    : rawProposal.sensitivityLevel === 'S1' ? 'S1' : 'S0';
  const temporalText = durableRecentPreference ? semanticText.replace(/最近/gu, '') : semanticText;
  const temporalState = shortTerm
    ? 'TEMPORARY_CURRENT'
    : temporalStateFor(temporalText, origin, action, rawSignals?.temporalState);
  const proposalId = stableId('semantic', [
    rawProposal.providerProposalId ?? index,
    sourceEvidenceRefs.join(','),
    contentType,
    normalizedClaim,
  ]);
  const safeNormalizedClaim = containsCredential
    ? '检测到凭据或认证秘密；禁止进入长期记忆。'
    : normalizedClaim;
  const uncertaintyPreservedClaim = action === 'NONE'
    && temporalUncertaintyPattern.test(citedText)
    && !temporalUncertaintyPattern.test(safeNormalizedClaim)
    ? `时间不确定：${safeNormalizedClaim}`
    : safeNormalizedClaim;
  const query = containsCredential
    ? safeCredentialQuery(`${semanticText} ${fullEvidenceText}`)
    : unique([normalizedClaim, ...spans.map(span => span.quote)]).join(' ');
  return {
    proposal: {
      proposalId,
      contentType: governedContentType,
      normalizedClaim: action === 'NONE'
        ? uncertaintyPreservedClaim
        : normalizedGovernanceClaim(action, citedText),
      query,
      topK: sourceEvidenceRefs.length,
      eventTime: clean(rawProposal.eventTime) || firstEvidence.eventTime || null,
      validFrom: clean(rawProposal.validFrom) || null,
      validTo: clean(rawProposal.validTo) || null,
      handlingProfile: ['life_event', 'subjective_meaning'].includes(contentType) ? 'core_life' : shortTerm ? 'contextual_recent' : 'durable_personal',
      retentionPolicy: shortTerm ? 'expire_after_context' : 'until_superseded',
      importanceReasons: ['external_semantic_candidate'],
      sensitivityLevel,
      sensitivityCategories: unique([...riskCategories, action !== 'NONE' ? 'governance' : null]),
      allowedUses: action === 'NONE' ? [input.policy.purpose] : ['governance_filter'],
      forbiddenUses: action === 'NONE' ? ['family_broadcast'] : ['ordinary_retrieval', 'story_generation'],
      reviewTrigger: 'user_correction',
      expiryOrSupersedeRule: 'supersede_on_new_direct_statement',
      mustNotHappen: unique([
        'must_not_bypass_business_policy_gate',
        'must_not_write_canonical_memory_from_extractor',
        containsCredential ? 'must_not_store_or_echo_credentials' : null,
      ]),
      relationships: [],
      rawEvidenceRef: sourceEvidenceRefs[0],
      sourceEvidenceRefs,
      sourceActor: { actorId: firstEvidence.actorId, actorRole: firstEvidence.actorRole },
      signals: {
        origin,
        explicitRemember: action === 'NONE' && explicitRememberPattern.test(authorizationText),
        explicitCorrection: action === 'NONE' && explicitCorrectionPattern.test(authorizationText),
        governanceAction: action,
        containsCredential,
        // A proposal is restricted to one source actor. Unresolved source
        // conflicts are derived later by markConflicts from separate actors;
        // a model must not turn a self-correction into a source conflict.
        conflict: false,
        ambiguousSubject: Boolean(rawSignals?.ambiguousSubject),
        purposeExpansion: Boolean(rawSignals?.purposeExpansion)
          || verifiedEvidenceItems.some(item => item.kind === 'restricted_transcript' && input.policy.purpose !== 'care_session'),
        visibilityExpansion: Boolean(rawSignals?.visibilityExpansion),
        shortTerm,
        interactionPreference: action === 'NONE' && interactionPreferencePattern.test(authorizationText),
        interviewMaterial: verifiedEvidenceItems.some(item => item.kind === 'interview_transcript'),
        ordinaryMemory: action === 'NONE'
          && sensitivityLevel !== 'S2'
          && origin === 'SELF_REPORT'
          && verifiedEvidenceItems.every(item => !['interview_transcript', 'system_observation', 'derived_artifact', 'model_assertion'].includes(item.kind)),
        reversible: true,
        auditable: true,
        temporalState,
      },
    },
  };
}

function tokenSet(value: unknown): Set<string> {
  const text = clean(value).toLowerCase();
  const tokens = new Set(text.match(/[a-z0-9_-]+|[\u3400-\u9fff]/gu) ?? []);
  return tokens;
}

function jaccard(left: string, right: string): number {
  const a = tokenSet(left);
  const b = tokenSet(right);
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function proposalFamily(proposal: HybridProposal): string {
  if (proposal.signals.governanceAction !== 'NONE') return `governance:${proposal.signals.governanceAction}`;
  if (proposal.sensitivityCategories.includes('credential')) return 'risk:credential';
  if (proposal.sensitivityCategories.includes('health')) return 'risk:health';
  if (proposal.sensitivityCategories.includes('safety')) return 'risk:safety';
  if (proposal.sensitivityCategories.includes('financial')) return 'risk:financial';
  if (proposal.sensitivityCategories.includes('family_conflict')) return 'risk:family_conflict';
  if (/^photo_/u.test(proposal.contentType)) return 'photo';
  return proposal.contentType;
}

function sameEvidence(left: HybridProposal, right: HybridProposal): boolean {
  const leftRefs = new Set(left.sourceEvidenceRefs);
  return right.sourceEvidenceRefs.some(ref => leftRefs.has(ref));
}

function shouldMerge(left: HybridProposal, right: HybridProposal): boolean {
  if (!sameEvidence(left, right)) return false;
  const leftFamily = proposalFamily(left);
  const rightFamily = proposalFamily(right);
  if (leftFamily !== rightFamily) return false;
  if (leftFamily.startsWith('risk:') || leftFamily.startsWith('governance:')) return true;
  return jaccard(left.normalizedClaim, right.normalizedClaim) >= 0.72;
}

function mergePair(left: HybridProposal, right: HybridProposal): HybridProposal {
  const semantic = left.importanceReasons.includes('external_semantic_candidate') ? left
    : right.importanceReasons.includes('external_semantic_candidate') ? right
      : null;
  const primary = semantic ?? left;
  const sourceEvidenceRefs = unique([...left.sourceEvidenceRefs, ...right.sourceEvidenceRefs]);
  const sensitivityCategories = unique([...left.sensitivityCategories, ...right.sensitivityCategories]);
  const sensitivityLevel: SensitivityLevel = left.sensitivityLevel === 'S2' || right.sensitivityLevel === 'S2'
    ? 'S2'
    : left.sensitivityLevel === 'S1' || right.sensitivityLevel === 'S1' ? 'S1' : 'S0';
  const action = left.signals.governanceAction !== 'NONE' ? left.signals.governanceAction : right.signals.governanceAction;
  const proposalId = stableId('hybrid', [sourceEvidenceRefs.join(','), proposalFamily(left), primary.normalizedClaim]);
  return {
    ...primary,
    proposalId,
    query: unique([left.query, right.query]).join(' '),
    topK: sourceEvidenceRefs.length,
    sourceEvidenceRefs,
    rawEvidenceRef: sourceEvidenceRefs[0],
    sensitivityLevel,
    sensitivityCategories,
    importanceReasons: unique([...left.importanceReasons, ...right.importanceReasons]),
    allowedUses: action === 'NONE' ? primary.allowedUses : ['governance_filter'],
    forbiddenUses: unique([...left.forbiddenUses, ...right.forbiddenUses]),
    mustNotHappen: unique([...left.mustNotHappen, ...right.mustNotHappen]),
    relationships: uniqueRelationships([...left.relationships, ...right.relationships]),
    signals: {
      ...primary.signals,
      origin: left.signals.origin,
      governanceAction: action,
      containsCredential: left.signals.containsCredential || right.signals.containsCredential,
      conflict: left.signals.conflict || right.signals.conflict,
      ambiguousSubject: left.signals.ambiguousSubject || right.signals.ambiguousSubject,
      purposeExpansion: left.signals.purposeExpansion || right.signals.purposeExpansion,
      visibilityExpansion: left.signals.visibilityExpansion || right.signals.visibilityExpansion,
      ordinaryMemory: sensitivityLevel !== 'S2' && action === 'NONE' && (left.signals.ordinaryMemory || right.signals.ordinaryMemory),
      temporalState: action === 'NONE' ? primary.signals.temporalState : temporalStateFor(primary.normalizedClaim, left.signals.origin, action),
    },
  };
}

function uniqueRelationships(relationships: MemoryRelationship[]): MemoryRelationship[] {
  const seen = new Set<string>();
  return relationships.filter(relationship => {
    const key = JSON.stringify(relationship);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeDeduplicated(
  proposals: HybridProposal[],
): { proposals: HybridProposal[]; mergeCount: number } {
  const merged: HybridProposal[] = [];
  let mergeCount = 0;
  for (const proposal of proposals) {
    const index = merged.findIndex(existing => shouldMerge(existing, proposal));
    if (index === -1) {
      merged.push(proposal);
      continue;
    }
    merged[index] = mergePair(merged[index], proposal);
    mergeCount += 1;
  }
  markConflicts(merged);
  return { proposals: merged, mergeCount };
}

function isGovernanceDuplicate(
  proposal: HybridProposal,
  mustExtractProposals: HybridProposal[],
): boolean {
  if (proposal.signals.governanceAction !== 'NONE') return false;
  const proposalRefs = new Set(proposal.sourceEvidenceRefs);
  const proposalAction = governanceFor(proposal.normalizedClaim);
  if (proposalAction === 'NONE') return false;
  return mustExtractProposals.some(mustExtract =>
    mustExtract.signals.governanceAction === proposalAction
    && mustExtract.sourceEvidenceRefs.some(ref => proposalRefs.has(ref)));
}

function conflictAnchor(proposal: HybridProposal): string | null {
  return clean(proposal.normalizedClaim).match(/photo-[a-z0-9-]+|[零一二三四五六七八九十百千万两0-9]+万元|[零一二三四五六七八九十百千万两0-9]+元/iu)?.[0] ?? null;
}

function markConflicts(proposals: HybridProposal[]): void {
  for (let leftIndex = 0; leftIndex < proposals.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < proposals.length; rightIndex += 1) {
      const left = proposals[leftIndex];
      const right = proposals[rightIndex];
      if (left.sourceActor.actorId === right.sourceActor.actorId) continue;
      if (proposalFamily(left) !== proposalFamily(right)) continue;
      const anchor = conflictAnchor(left);
      if (!anchor || anchor !== conflictAnchor(right)) continue;
      // Conflict wording may appear only in a verified source quote. `query`
      // contains the normalized claim plus those verified quotes, so use both
      // rather than trusting a provider-authored conflict flag.
      const combined = `${left.normalizedClaim} ${left.query} ${right.normalizedClaim} ${right.query}`;
      if (!/不是|没有|否认|明明|不同|冲突|还是/u.test(combined)) continue;
      left.signals.conflict = true;
      right.signals.conflict = true;
      left.sensitivityCategories = unique([...left.sensitivityCategories, 'family_conflict']);
      right.sensitivityCategories = unique([...right.sensitivityCategories, 'family_conflict']);
      const leftLink = { type: 'conflicts_with', targetProposalId: right.proposalId };
      const rightLink = { type: 'conflicts_with', targetProposalId: left.proposalId };
      if (!left.relationships.some(link => JSON.stringify(link) === JSON.stringify(leftLink))) left.relationships.push(leftLink);
      if (!right.relationships.some(link => JSON.stringify(link) === JSON.stringify(rightLink))) right.relationships.push(rightLink);
    }
  }
}

function validateRawInput(input: HybridInput): void {
  if (!input || typeof input !== 'object' || !input.policy || !Array.isArray(input.evidence) || !Array.isArray(input.currentRecords)) {
    throw new TypeError('hybrid extractor requires policy, evidence, and currentRecords');
  }
}

export async function extractHybridCandidates(
  input: HybridInput,
  { semanticProvider }: HybridExtractorOptions = {},
): Promise<HybridExtractionResult> {
  validateRawInput(input);
  const isolatedInput = deepFreeze(structuredClone({
    policy: input.policy,
    evidence: input.evidence,
    currentRecords: input.currentRecords,
  }));
  const mustExtractProposals = scanMustExtract(isolatedInput);
  const semanticResponse: SemanticProviderResponse = semanticProvider
    ? await semanticProvider(isolatedInput)
    : { proposals: [] };
  const rawSemanticProposals = Array.isArray(semanticResponse) ? semanticResponse : semanticResponse?.proposals;
  if (!Array.isArray(rawSemanticProposals)) throw new TypeError('semanticProvider must return an array or { proposals: [] }');

  const evidenceByRef = new Map(isolatedInput.evidence.map(item => [item.ref, item]));
  const semanticProposals: HybridProposal[] = [];
  const semanticRejections: Array<{ index: number; reason: string }> = [];
  rawSemanticProposals.forEach((rawProposal, index) => {
    const result = sanitizeSemanticProposal(rawProposal, isolatedInput, evidenceByRef, index);
    if (!result.proposal) {
      semanticRejections.push({ index, reason: result.rejection });
      return;
    }
    // A provider may paraphrase a no-save/delete/privacy command as an
    // ordinary preference. The deterministic must-extract governance proposal
    // is authoritative; suppress only the same-evidence duplicate so ordinary
    // facts from a mixed utterance remain eligible.
    if (isGovernanceDuplicate(result.proposal, mustExtractProposals)) {
      semanticRejections.push({ index, reason: 'governance_duplicate_suppressed' });
      return;
    }
    semanticProposals.push(result.proposal);
  });
  const merged = mergeDeduplicated([...mustExtractProposals, ...semanticProposals]);
  return {
    extractor: hybridExtractorMetadata,
    proposals: merged.proposals,
    diagnostics: {
      mustExtractCount: mustExtractProposals.length,
      semanticInputCount: rawSemanticProposals.length,
      semanticAcceptedCount: semanticProposals.length,
      semanticRejectedCount: semanticRejections.length,
      semanticRejections,
      mergeCount: merged.mergeCount,
      outputCount: merged.proposals.length,
    },
    invocation: {
      provider: 'offline-injected-semantic-provider',
      model: null,
      network: false,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      actualCostCny: 0,
    },
  };
}

export async function runHybridCase(
  caseInput: Omit<MemoryCaseInput, 'proposals'> & { proposals?: MemoryProposal[] },
  { semanticProvider }: HybridExtractorOptions = {},
) {
  const extraction = await extractHybridCandidates({
    policy: caseInput.policy,
    evidence: caseInput.evidence,
    currentRecords: caseInput.currentRecords,
  }, { semanticProvider });
  const output = await runPolicyGate({
    ...structuredClone(caseInput),
    proposals: structuredClone(extraction.proposals),
  });
  output.adapter = hybridAdapterMetadata;
  for (const candidate of output.candidates) candidate.algorithmVersion = hybridAdapterMetadata.adapterVersion;
  return { extraction, output };
}

export function createHybridAdapter({ semanticProvider }: HybridExtractorOptions = {}) {
  return {
    metadata: hybridAdapterMetadata,
    extract: (input: HybridInput) => extractHybridCandidates(input, { semanticProvider }),
    runCase: async (caseInput: Omit<MemoryCaseInput, 'proposals'> & { proposals?: MemoryProposal[] }) => (
      await runHybridCase(caseInput, { semanticProvider })
    ).output,
  };
}
