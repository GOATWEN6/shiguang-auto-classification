import type {
  MemoryDisposition,
  MemoryPolicyContext,
  MemoryProposal,
  MemoryPolicyDecision,
} from './contracts.ts';

export const AUTO_SAVE_WHITELIST_POLICY_VERSION = 'sgx-memory-auto-save-whitelist-v0.1';

export type AutoSaveWhitelistCategory =
  | 'INTERACTION_PREFERENCE'
  | 'ACCESSIBILITY_PREFERENCE'
  | 'ORDINARY_PREFERENCE'
  | 'LOW_RISK_ROUTINE'
  | 'LOW_RISK_CORRECTION'
  | 'NOT_ALLOWED';

export interface AutoSaveWhitelistDecision extends MemoryPolicyDecision {
  policyVersion: typeof AUTO_SAVE_WHITELIST_POLICY_VERSION;
  category: AutoSaveWhitelistCategory;
  eligible: boolean;
  gateChecks: {
    elderDirectSource: boolean;
    lowSensitivity: boolean;
    subjectUnambiguous: boolean;
    noConflict: boolean;
    noPurposeExpansion: boolean;
    noVisibilityExpansion: boolean;
    reversible: boolean;
    auditable: boolean;
  };
}

function sourceIsElder(proposal: MemoryProposal): boolean {
  return proposal.signals.origin === 'SELF_REPORT' && proposal.sourceActor?.actorRole === 'elder';
}

function categoryFor(proposal: MemoryProposal): AutoSaveWhitelistCategory {
  if (proposal.signals.explicitCorrection && proposal.signals.interactionPreference) return 'LOW_RISK_CORRECTION';
  if (proposal.signals.interactionPreference) return 'INTERACTION_PREFERENCE';
  if (proposal.contentType === 'accessibility_preference') return 'ACCESSIBILITY_PREFERENCE';
  if (proposal.signals.ordinaryMemory && proposal.contentType === 'preference') return 'ORDINARY_PREFERENCE';
  if (proposal.signals.ordinaryMemory && proposal.contentType === 'routine') return 'LOW_RISK_ROUTINE';
  return 'NOT_ALLOWED';
}

function result(
  category: AutoSaveWhitelistCategory,
  disposition: MemoryDisposition,
  confirmationBasis: string,
  reasonCodes: string[],
  gateChecks: AutoSaveWhitelistDecision['gateChecks'],
): AutoSaveWhitelistDecision {
  return {
    policyVersion: AUTO_SAVE_WHITELIST_POLICY_VERSION,
    category,
    eligible: disposition === 'AUTO_WRITE',
    disposition,
    confirmationBasis,
    reasonCodes,
    gateChecks,
  };
}

/**
 * Narrow allowlist layered before the existing M2 policy. It never broadens
 * the M2 policy: high sensitivity, credentials, AI-derived claims, source
 * conflicts and governance blocks remain stronger than this allowlist.
 */
export function evaluateAutoSaveWhitelist(
  proposal: MemoryProposal,
  policy: MemoryPolicyContext,
): AutoSaveWhitelistDecision {
  const category = categoryFor(proposal);
  const gateChecks = {
    elderDirectSource: sourceIsElder(proposal),
    lowSensitivity: proposal.sensitivityLevel === 'S0',
    subjectUnambiguous: !proposal.signals.ambiguousSubject,
    noConflict: !proposal.signals.conflict,
    noPurposeExpansion: !proposal.signals.purposeExpansion,
    noVisibilityExpansion: !proposal.signals.visibilityExpansion,
    reversible: proposal.signals.reversible,
    auditable: proposal.signals.auditable,
  };

  if (proposal.signals.containsCredential) {
    return result(category, 'NO_MEMORY', 'none', ['CREDENTIALS_FORBIDDEN'], gateChecks);
  }
  if (proposal.signals.origin === 'AI_DERIVED') {
    return result(category, 'NO_MEMORY', 'none', ['AI_DERIVATION_IS_NOT_USER_FACT'], gateChecks);
  }
  if (proposal.signals.origin === 'FAMILY_REPORT' || proposal.signals.origin === 'COMMUNITY_REPORT') {
    return result(category, 'SOURCED_ONLY', 'source_attribution_only',
      ['NON_ELDER_SOURCE_MUST_REMAIN_ATTRIBUTED'], gateChecks);
  }
  if (proposal.sensitivityLevel === 'S2') {
    return result(category, 'C3_STRONG_CONFIRM', 'strong_confirmation_required',
      ['HIGH_SENSITIVITY_REQUIRES_STRONG_CONFIRMATION'], gateChecks);
  }
  if (proposal.signals.governanceAction !== 'NONE') {
    return result(category, 'BLOCKED', 'governance_rule',
      ['GOVERNANCE_ACTION_IS_NOT_AUTOSAVE'], gateChecks);
  }
  if (proposal.signals.shortTerm) {
    return result(category, 'SESSION_ONLY', 'session_context', ['TIME_BOUNDED_CONTEXT'], gateChecks);
  }
  if (proposal.signals.interviewMaterial) {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['INTERVIEW_MATERIAL_IS_NOT_AUTOSAVE_WHITELIST'], gateChecks);
  }
  if (category === 'NOT_ALLOWED') {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['NO_WHITELIST_CATEGORY'], gateChecks);
  }
  if (policy.subjectId !== proposal.sourceActor?.actorId) {
    return result(category, 'BLOCKED', 'blocked_by_guard', ['SUBJECT_SCOPE_MISMATCH'], gateChecks);
  }
  if (policy.actorRole !== 'elder' || !gateChecks.elderDirectSource) {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['ELDER_DIRECT_SOURCE_REQUIRED'], gateChecks);
  }
  if (proposal.sensitivityLevel !== 'S0') {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['LOW_SENSITIVITY_REQUIRED'], gateChecks);
  }
  const failedGate = Object.entries(gateChecks).find(([, passed]) => !passed);
  if (failedGate) {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['AUTOSAVE_GATE_FAILED_' + failedGate[0].toUpperCase()], gateChecks);
  }

  const policyEnabled = category === 'INTERACTION_PREFERENCE'
    || category === 'ACCESSIBILITY_PREFERENCE'
    || category === 'LOW_RISK_CORRECTION'
    ? policy.interactionPreferenceAutoSavePolicy === 'on'
    : policy.ordinaryMemoryAutoSavePolicy === 'on';
  if (!policyEnabled) {
    return result(category, 'C2_BATCH_CONFIRM', 'batch_confirmation_required',
      ['AUTOSAVE_POLICY_DISABLED'], gateChecks);
  }
  return result(category, 'AUTO_WRITE', 'low_risk_preauthorized',
    ['LOW_RISK_PREAUTHORIZED', 'REVERSIBLE', 'AUDITABLE', 'WHITELIST_CATEGORY'], gateChecks);
}
