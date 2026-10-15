export type RetrievalLevel = 'R0' | 'R1' | 'R2' | 'R3';
export type RetrievalScene =
  | 'DAILY_CHAT'
  | 'FORMAL_INTERVIEW'
  | 'STORY_DRAFT'
  | 'PROFILE_DRAFT'
  | 'CO_CREATION'
  | 'COGNITIVE_REVIEW';

export interface RetrievalLevelRequest {
  scene: RetrievalScene;
  userMentionedRelatedHistory?: boolean;
  userSelectedMaterial?: boolean;
  requestedContinueTopic?: boolean;
  explicitSensitiveAuthorization?: boolean;
  purposeAuthorized?: boolean;
  visibilityAuthorized?: boolean;
  authorizationVersion: string;
}

export interface RetrievalLevelPlan {
  policyVersion: 'sgx-retrieval-levels-v0.1';
  scene: RetrievalScene;
  defaultLevel: 'R0';
  maxAllowedLevel: RetrievalLevel;
  allowedLevels: RetrievalLevel[];
  expansionAllowed: boolean;
  expansionReason: string | null;
  maxItemsByLevel: Record<RetrievalLevel, number>;
  reasonCodes: string[];
  authorizationVersion: string;
}

const ORDER: RetrievalLevel[] = ['R0', 'R1', 'R2', 'R3'];
const MAX_ITEMS: Record<RetrievalLevel, number> = { R0: 1, R1: 3, R2: 8, R3: 3 };

function levelIndex(level: RetrievalLevel): number {
  return ORDER.indexOf(level);
}

function assertRequest(request: RetrievalLevelRequest): void {
  if (!request.authorizationVersion || request.authorizationVersion.trim().length === 0) {
    throw new TypeError('authorizationVersion must be non-empty');
  }
}

/**
 * Plan a minimum-necessary retrieval envelope. This does not fetch records;
 * the live store must still re-check purpose, visibility, version and status.
 */
export function planRetrievalLevels(request: RetrievalLevelRequest): RetrievalLevelPlan {
  assertRequest(request);
  const relatedHistory = Boolean(request.userMentionedRelatedHistory || request.requestedContinueTopic);
  const purposeAuthorized = request.purposeAuthorized !== false;
  const visibilityAuthorized = request.visibilityAuthorized !== false;
  let maxAllowedLevel: RetrievalLevel = 'R0';
  let expansionReason: string | null = null;
  const reasonCodes: string[] = ['DEFAULT_MINIMUM_NECESSARY'];

  if (request.scene === 'DAILY_CHAT') {
    if (relatedHistory && purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = 'R2';
      expansionReason = 'ELDER_REFERENCED_RELATED_HISTORY';
      reasonCodes.push('R2_RELATED_HISTORY_ONLY');
    } else if (purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = 'R1';
      expansionReason = 'LOW_RISK_INTERACTION_PERSONALIZATION';
      reasonCodes.push('R1_STABLE_LOW_RISK');
    }
  } else if (request.scene === 'FORMAL_INTERVIEW') {
    maxAllowedLevel = relatedHistory && purposeAuthorized && visibilityAuthorized ? 'R2' : 'R1';
    expansionReason = maxAllowedLevel === 'R2' ? 'INTERVIEW_RELATED_HISTORY' : 'FORMAL_INTERVIEW_LOW_RISK_CONTEXT';
    reasonCodes.push(maxAllowedLevel === 'R2' ? 'R2_RELATED_HISTORY_ONLY' : 'R1_STABLE_LOW_RISK');
  } else if (request.scene === 'STORY_DRAFT') {
    if (request.userSelectedMaterial && purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = 'R2';
      expansionReason = 'USER_SELECTED_STORY_MATERIAL';
      reasonCodes.push('R2_USER_SELECTED_SOURCES');
    }
  } else if (request.scene === 'PROFILE_DRAFT') {
    if (purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = relatedHistory ? 'R2' : 'R1';
      expansionReason = maxAllowedLevel === 'R2' ? 'USER_REQUESTED_RELATED_PROFILE_CONTEXT' : 'LOW_RISK_PROFILE_CONTEXT';
      reasonCodes.push(maxAllowedLevel === 'R2' ? 'R2_RELATED_HISTORY_ONLY' : 'R1_STABLE_LOW_RISK');
    }
  } else if (request.scene === 'CO_CREATION') {
    if (request.userSelectedMaterial && purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = 'R2';
      expansionReason = 'USER_SELECTED_CO_CREATION_SOURCES';
      reasonCodes.push('R2_USER_SELECTED_SOURCES');
    }
  } else if (request.scene === 'COGNITIVE_REVIEW') {
    if (request.explicitSensitiveAuthorization && purposeAuthorized && visibilityAuthorized) {
      maxAllowedLevel = 'R3';
      expansionReason = 'EXPLICIT_RESTRICTED_REVIEW_AUTHORIZATION';
      reasonCodes.push('R3_RESTRICTED_SCENE_AUTHORIZED');
    } else {
      reasonCodes.push('R3_REQUIRES_EXPLICIT_AUTHORIZATION');
    }
  }

  const sensitiveRequested = Boolean(request.explicitSensitiveAuthorization);
  if (sensitiveRequested && purposeAuthorized && visibilityAuthorized
    && (request.scene === 'STORY_DRAFT' || request.scene === 'CO_CREATION' || request.scene === 'FORMAL_INTERVIEW')) {
    maxAllowedLevel = 'R3';
    expansionReason = 'EXPLICIT_RESTRICTED_SCENE_AUTHORIZATION';
    reasonCodes.push('R3_RESTRICTED_SCENE_AUTHORIZED');
  }
  if (!purposeAuthorized) reasonCodes.push('PURPOSE_NOT_AUTHORIZED');
  if (!visibilityAuthorized) reasonCodes.push('VISIBILITY_NOT_AUTHORIZED');

  const allowedLevels = ORDER.filter(level => levelIndex(level) <= levelIndex(maxAllowedLevel));
  return {
    policyVersion: 'sgx-retrieval-levels-v0.1',
    scene: request.scene,
    defaultLevel: 'R0',
    maxAllowedLevel,
    allowedLevels,
    expansionAllowed: maxAllowedLevel !== 'R0',
    expansionReason,
    maxItemsByLevel: { ...MAX_ITEMS },
    reasonCodes: [...new Set(reasonCodes)],
    authorizationVersion: request.authorizationVersion,
  };
}

export function canUseRetrievalLevel(plan: RetrievalLevelPlan, level: RetrievalLevel): boolean {
  return plan.allowedLevels.includes(level);
}
