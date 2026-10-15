import { createHash } from 'node:crypto';

import type {
  EvidenceFragment,
  MemoryAdapterMetadata,
  MemoryCandidate,
  MemoryCaseInput,
  MemoryPolicyContext,
  MemoryPolicyDecision,
  MemoryProposal,
  MemoryRunOutput,
  MemoryTransactionInput,
  ScoredEvidenceFragment,
  TransactionInspection,
} from './contracts.ts';

export const adapterMetadata: MemoryAdapterMetadata = {
  adapterId: 'sgx-raw-fragment-deterministic-baseline',
  adapterVersion: '0.1.0',
  contractVersion: 'sgx-memory-candidate-adapter-v1',
  externalFramework: false,
  canonicalWriteCapability: false,
};

const stopCharacters = new Set(
  '，。！？；：、“”‘’（）()[]【】的了是在和与把被为于又也而并或及到从由对将这那我你他她它'.split(''),
);

function normalizeText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(value: unknown): Set<string> {
  const text = normalizeText(value);
  const tokens = new Set<string>();

  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]*/g)) {
    tokens.add(match[0]);
  }

  const chinese = [...text].filter(
    character => /[\u3400-\u9fff]/u.test(character) && !stopCharacters.has(character),
  );
  for (const character of chinese) tokens.add(character);
  for (let index = 0; index < chinese.length - 1; index += 1) {
    tokens.add(`${chinese[index]}${chinese[index + 1]}`);
  }

  return tokens;
}

function scoreEvidence(query: string, item: EvidenceFragment): number {
  const queryTokens = tokenSet(query);
  const itemTokens = tokenSet(`${item.text} ${item.ref} ${item.kind}`);
  let score = 0;
  for (const token of queryTokens) {
    if (itemTokens.has(token)) score += token.length > 1 ? 3 : 1;
  }
  if (normalizeText(item.text).includes(normalizeText(query))) score += 20;
  return score;
}

function isEvidenceUsable(item: EvidenceFragment, policy: MemoryPolicyContext): boolean {
  if (item.subjectId !== policy.subjectId) return false;
  if (item.useStatus !== 'ACTIVE') return false;
  if (item.familySpaceId !== policy.familySpaceId) return false;
  if (!item.allowedPurposes.includes('*') && !item.allowedPurposes.includes(policy.purpose)) return false;
  if (item.authorizationVersion !== '*' && item.authorizationVersion !== policy.authorizationVersion) return false;
  if (
    !item.visibilityScope.includes('*')
    && !policy.visibilityScope.every(scope => item.visibilityScope.includes(scope))
  ) return false;
  return true;
}

export function retrieveRawFragments(
  caseInput: MemoryCaseInput,
  candidateProposal: MemoryProposal,
): ScoredEvidenceFragment[] {
  return caseInput.evidence
    .filter(item => isEvidenceUsable(item, caseInput.policy))
    .map((item, position) => ({
      ...item,
      score: scoreEvidence(candidateProposal.query, item),
      position,
    }))
    .filter(item => item.score > 0)
    .sort(
      (left, right) => right.score - left.score
        || left.position - right.position
        || left.ref.localeCompare(right.ref),
    )
    .slice(0, candidateProposal.topK)
    .map(({ position: _position, ...item }) => item);
}

export function inspectMemoryTransaction(transaction: MemoryTransactionInput): TransactionInspection {
  const prior = transaction.existingIdempotencyRecord;
  if (prior && prior.idempotencyKey === transaction.idempotencyKey) {
    if (prior.payloadHash === transaction.payloadHash) {
      return {
        status: 'REPLAY',
        blockReason: null,
        replayedResultRef: prior.resultRef,
      };
    }
    return {
      status: 'KEY_PAYLOAD_CONFLICT',
      blockReason: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD',
      replayedResultRef: null,
    };
  }

  if (transaction.expectedVersion !== transaction.currentVersion) {
    return {
      status: 'STALE_VERSION',
      blockReason: 'EXPECTED_VERSION_MISMATCH',
      replayedResultRef: null,
    };
  }

  return { status: 'NEW', blockReason: null, replayedResultRef: null };
}

function decideAuthority(proposal: MemoryProposal): string {
  if (proposal.signals.governanceAction === 'RESTORE_REQUEST') {
    return proposal.signals.origin === 'SELF_REPORT' ? 'SELF_ASSERTED' : 'SOURCED_CLAIM';
  }
  if (proposal.signals.governanceAction !== 'NONE') return 'GOVERNANCE_RULE';
  if (
    proposal.signals.origin === 'FAMILY_REPORT'
    || proposal.signals.origin === 'COMMUNITY_REPORT'
  ) return 'SOURCED_CLAIM';
  if (proposal.signals.origin === 'SYSTEM_OBSERVATION') return 'OBSERVATION';
  if (proposal.signals.origin === 'AI_DERIVED') return 'DERIVED_UNSUPPORTED';
  if (proposal.signals.origin === 'PHOTO_MODEL') return 'MODEL_CANDIDATE';
  return 'SELF_ASSERTED';
}

function compactStrings(values: Array<string | null>): string[] {
  return values.filter((value): value is string => value !== null);
}

export function evaluateMemoryPolicy(
  proposal: MemoryProposal,
  policy: MemoryPolicyContext,
  transactionInspection: TransactionInspection,
): MemoryPolicyDecision {
  const signals = proposal.signals;
  const transactionBlocked = transactionInspection.status === 'STALE_VERSION'
    || transactionInspection.status === 'KEY_PAYLOAD_CONFLICT';

  if (transactionBlocked) {
    return {
      disposition: 'BLOCKED',
      confirmationBasis: 'blocked_by_guard',
      reasonCodes: transactionInspection.blockReason ? [transactionInspection.blockReason] : [],
    };
  }

  if (signals.governanceAction === 'RESTORE_REQUEST' && policy.actorRole !== 'elder') {
    return {
      disposition: 'BLOCKED',
      confirmationBasis: 'blocked_by_guard',
      reasonCodes: ['ONLY_ELDER_CAN_REAUTHORIZE_REVOKED_TOPIC'],
    };
  }

  if (signals.governanceAction === 'RESTRICT' || signals.governanceAction === 'REVOKE') {
    return {
      disposition: 'AUTO_WRITE',
      confirmationBasis: 'explicit_revoke',
      reasonCodes: ['EXPLICIT_GOVERNANCE_COMMAND', 'PRIVACY_RESTRICTION_TAKES_EFFECT_FIRST'],
    };
  }

  if (signals.governanceAction === 'DELETE') {
    return {
      disposition: 'C3_STRONG_CONFIRM',
      confirmationBasis: 'explicit_item',
      reasonCodes: ['HIGH_IMPACT_DELETE_REQUIRES_SCOPE_CONFIRMATION'],
    };
  }

  if (signals.containsCredential) {
    return { disposition: 'NO_MEMORY', confirmationBasis: 'none', reasonCodes: ['CREDENTIALS_FORBIDDEN'] };
  }

  if (signals.origin === 'AI_DERIVED') {
    return {
      disposition: 'NO_MEMORY',
      confirmationBasis: 'none',
      reasonCodes: ['AI_DERIVATION_IS_NOT_USER_FACT'],
    };
  }

  if (signals.ambiguousSubject || signals.purposeExpansion || signals.visibilityExpansion) {
    return {
      disposition: 'BLOCKED',
      confirmationBasis: 'blocked_by_guard',
      reasonCodes: compactStrings([
        signals.ambiguousSubject ? 'AMBIGUOUS_SUBJECT' : null,
        signals.purposeExpansion ? 'PURPOSE_EXPANSION_NOT_AUTHORIZED' : null,
        signals.visibilityExpansion ? 'VISIBILITY_EXPANSION_NOT_AUTHORIZED' : null,
      ]),
    };
  }

  if (proposal.sensitivityLevel === 'S2') {
    return {
      disposition: 'C3_STRONG_CONFIRM',
      confirmationBasis: 'strong_confirmation_required',
      reasonCodes: ['HIGH_SENSITIVITY_REQUIRES_STRONG_CONFIRMATION'],
    };
  }

  if (signals.origin === 'SYSTEM_OBSERVATION') {
    if (policy.longitudinalObservationAuthorization === 'on') {
      return {
        disposition: 'SOURCED_ONLY',
        confirmationBasis: 'source_attribution_only',
        reasonCodes: ['AUTHORIZED_NON_SENSITIVE_OBSERVATION_ONLY'],
      };
    }
    return {
      disposition: 'SESSION_ONLY',
      confirmationBasis: 'session_context',
      reasonCodes: ['NO_LONGITUDINAL_OBSERVATION_AUTHORIZATION'],
    };
  }

  if (signals.origin === 'FAMILY_REPORT' || signals.origin === 'COMMUNITY_REPORT') {
    return {
      disposition: 'SOURCED_ONLY',
      confirmationBasis: 'source_attribution_only',
      reasonCodes: ['NON_ELDER_SOURCE_MUST_REMAIN_ATTRIBUTED'],
    };
  }

  if (signals.origin === 'PHOTO_MODEL') {
    return {
      disposition: 'C2_BATCH_CONFIRM',
      confirmationBasis: 'batch_confirmation_required',
      reasonCodes: ['MODEL_IDENTITY_CANDIDATE_REQUIRES_CONFIRMATION'],
    };
  }

  if (signals.conflict) {
    return {
      disposition: 'C2_BATCH_CONFIRM',
      confirmationBasis: 'conflict_clarification_required',
      reasonCodes: ['OPEN_SOURCE_CONFLICT'],
    };
  }

  if (signals.explicitRemember) {
    return {
      disposition: 'AUTO_WRITE',
      confirmationBasis: 'explicit_command',
      reasonCodes: ['ELDER_EXPLICIT_REMEMBER_COMMAND'],
    };
  }

  if (signals.explicitCorrection) {
    return {
      disposition: 'AUTO_WRITE',
      confirmationBasis: 'explicit_item',
      reasonCodes: ['ELDER_EXPLICIT_CORRECTION'],
    };
  }

  if (signals.shortTerm) {
    return {
      disposition: 'SESSION_ONLY',
      confirmationBasis: 'session_context',
      reasonCodes: ['TIME_BOUNDED_CONTEXT'],
    };
  }

  const authorizedPreference = signals.interactionPreference
    && policy.interactionPreferenceAutoSavePolicy === 'on';
  const authorizedInterview = signals.interviewMaterial
    && policy.interviewAutoOrganizePolicy === 'on';
  const authorizedOrdinary = signals.ordinaryMemory
    && policy.ordinaryMemoryAutoSavePolicy === 'on';

  if (
    (authorizedPreference || authorizedInterview || authorizedOrdinary)
    && signals.reversible
    && signals.auditable
  ) {
    return {
      disposition: 'AUTO_WRITE',
      confirmationBasis: 'policy_authorized',
      reasonCodes: ['LOW_RISK_PREAUTHORIZED', 'REVERSIBLE', 'AUDITABLE'],
    };
  }

  return {
    disposition: 'C2_BATCH_CONFIRM',
    confirmationBasis: 'batch_confirmation_required',
    reasonCodes: ['NO_AUTO_WRITE_RULE_MATCH'],
  };
}

function temporalStateFor(
  proposal: MemoryProposal,
  transactionInspection: TransactionInspection,
): string {
  if (transactionInspection.status === 'STALE_VERSION') return 'BLOCKED_STALE';
  if (transactionInspection.status === 'KEY_PAYLOAD_CONFLICT') return 'BLOCKED_IDEMPOTENCY';
  return proposal.signals.temporalState;
}

function usageStatusFor(proposal: MemoryProposal, decision: MemoryPolicyDecision): string {
  if (proposal.signals.governanceAction === 'REVOKE') return 'REVOKED';
  if (proposal.signals.governanceAction === 'RESTRICT') return 'RESTRICTED';
  if (['BLOCKED', 'C2_BATCH_CONFIRM', 'C3_STRONG_CONFIRM', 'NO_MEMORY'].includes(decision.disposition)) {
    return 'RESTRICTED';
  }
  return 'ACTIVE';
}

function stableClaimId(caseId: string, proposalId: string): string {
  const digest = createHash('sha256').update(`${caseId}:${proposalId}`).digest('hex').slice(0, 16);
  return `claim-${digest}`;
}

function buildCandidate(
  caseInput: MemoryCaseInput,
  caseId: string,
  proposal: MemoryProposal,
  fragments: ScoredEvidenceFragment[],
  decision: MemoryPolicyDecision,
  transactionInspection: TransactionInspection,
): MemoryCandidate {
  const primary = fragments[0];
  const sourceActor = primary
    ? { actorId: primary.actorId, actorRole: primary.actorRole }
    : { actorId: 'unknown', actorRole: 'unknown' };

  return {
    claimId: stableClaimId(caseId, proposal.proposalId),
    proposalId: proposal.proposalId,
    subjectId: caseInput.policy.subjectId,
    familySpaceId: caseInput.policy.familySpaceId,
    purpose: caseInput.policy.purpose,
    authorizationVersion: caseInput.policy.authorizationVersion,
    contentType: proposal.contentType,
    normalizedClaim: proposal.normalizedClaim,
    evidenceRefs: fragments.map(item => item.ref),
    sourceActor,
    eventTime: proposal.eventTime,
    validFrom: proposal.validFrom,
    validTo: proposal.validTo,
    authorityState: decideAuthority(proposal),
    conflictState: proposal.signals.conflict ? 'OPEN' : 'NONE',
    handlingProfile: proposal.handlingProfile,
    retentionPolicy: proposal.retentionPolicy,
    importanceReasons: proposal.importanceReasons,
    sensitivityLevel: proposal.sensitivityLevel,
    sensitivityCategories: proposal.sensitivityCategories,
    disposition: decision.disposition,
    confirmationBasis: decision.confirmationBasis,
    allowedUses: proposal.allowedUses,
    forbiddenUses: proposal.forbiddenUses,
    visibilityScope: caseInput.policy.visibilityScope,
    reviewTrigger: proposal.reviewTrigger,
    expiryOrSupersedeRule: proposal.expiryOrSupersedeRule,
    mustNotHappen: proposal.mustNotHappen,
    policyVersion: 'sgx-m2-v0.1',
    algorithmVersion: adapterMetadata.adapterVersion,
    temporalState: temporalStateFor(proposal, transactionInspection),
    usageStatus: usageStatusFor(proposal, decision),
    relationships: proposal.relationships,
    reasonCodes: decision.reasonCodes,
    writeEligibility: decision.disposition === 'AUTO_WRITE'
      ? 'ELIGIBLE_FOR_BUSINESS_GATE'
      : 'NOT_ELIGIBLE',
    canonicalWritePerformed: false,
  };
}

function validateInputBoundary(caseInput: MemoryCaseInput): void {
  if (!caseInput || typeof caseInput !== 'object') throw new TypeError('caseInput must be an object');
  if (!caseInput.policy || !Array.isArray(caseInput.evidence) || !Array.isArray(caseInput.proposals)) {
    throw new TypeError('caseInput must include policy, evidence, and proposals');
  }
}

export async function runCase(caseInput: MemoryCaseInput): Promise<MemoryRunOutput> {
  validateInputBoundary(caseInput);
  const transactionInspection = inspectMemoryTransaction(caseInput.transaction);
  const candidates: MemoryCandidate[] = [];
  const retrieval: MemoryRunOutput['retrieval'] = [];

  for (const proposal of caseInput.proposals) {
    const fragments = retrieveRawFragments(caseInput, proposal);
    const decision = evaluateMemoryPolicy(proposal, caseInput.policy, transactionInspection);
    retrieval.push({
      proposalId: proposal.proposalId,
      fragments: fragments.map(item => ({
        ref: item.ref,
        score: item.score,
        kind: item.kind,
        actorId: item.actorId,
        actorRole: item.actorRole,
        familySpaceId: item.familySpaceId,
        allowedPurposes: item.allowedPurposes,
        authorizationVersion: item.authorizationVersion,
        visibilityScope: item.visibilityScope,
        useStatus: item.useStatus,
      })),
    });
    candidates.push(buildCandidate(
      caseInput,
      caseInput.caseId,
      proposal,
      fragments,
      decision,
      transactionInspection,
    ));
  }

  const needsReview = candidates.some(candidate => (
    ['C2_BATCH_CONFIRM', 'C3_STRONG_CONFIRM', 'BLOCKED'].includes(candidate.disposition)
  ));

  return {
    contractVersion: adapterMetadata.contractVersion,
    adapter: adapterMetadata,
    caseId: caseInput.caseId,
    requestId: caseInput.requestId,
    jobStatus: needsReview ? 'needs_review' : 'succeeded',
    candidates,
    retrieval,
    transaction: {
      currentVersion: caseInput.transaction.currentVersion,
      expectedVersion: caseInput.transaction.expectedVersion,
      idempotencyKey: caseInput.transaction.idempotencyKey,
      idempotencyStatus: transactionInspection.status,
      replayedResultRef: transactionInspection.replayedResultRef,
      mutationIntentCount: transactionInspection.status === 'NEW'
        ? candidates.filter(candidate => candidate.writeEligibility === 'ELIGIBLE_FOR_BUSINESS_GATE').length
        : 0,
      canonicalWriteCount: 0,
    },
  };
}
