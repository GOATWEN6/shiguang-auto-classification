export type AlgorithmModule =
  | 'asr'
  | 'tts'
  | 'daily_chat'
  | 'formal_interview'
  | 'memory'
  | 'story_draft'
  | 'profile_draft';

export type RuntimeChannel = AlgorithmModule | 'vad' | 'orchestrator';

/**
 * Records whether cancellation had nested asynchronous work to join. Timeout
 * and failed acknowledgement are explicit degraded states; neither means the
 * nested sink confirmed that its output was dropped.
 */
export type CancellationCleanupStatus = 'NOT_REQUIRED' | 'JOINED' | 'TIMED_OUT' | 'FAILED';

export interface RuntimeIdentity {
  sessionEpoch: string;
  turnId: string;
  generationId: number;
  invocationId: string;
  responseId?: string;
  evidenceRefs: readonly string[];
}

export interface ProviderUsage {
  inputAudioMs?: number;
  outputAudioMs?: number;
  inputCharacters?: number;
  outputCharacters?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export type NormalizedErrorCode =
  | 'network_transient'
  | 'provider_429'
  | 'provider_5xx'
  | 'provider_503'
  | 'incomplete_stream'
  | 'retryable_timeout'
  | 'auth_401_403'
  | 'quota_402'
  | 'invalid_config'
  | 'invalid_schema'
  | 'quality_only'
  | 'safety_refusal'
  | 'authorization_withdrawn'
  | 'hard_invariant_failure'
  | 'budget_hard_cap_exceeded'
  | 'pricing_catalog_invalid'
  | 'cancelled'
  | 'unknown';

export interface NormalizedRuntimeError {
  code: NormalizedErrorCode;
  message: string;
  retryable: boolean;
  providerStatus?: number;
}

export interface RuntimeResultMeta {
  identity: RuntimeIdentity;
  module: AlgorithmModule;
  attemptId: string;
  startedAt: string;
  completedAt: string;
  usage?: ProviderUsage;
  costCny?: number;
  retentionObjectIds: readonly string[];
}

export type ModuleResult<T> =
  | {
      ok: true;
      status: 'success';
      value: T;
      meta: RuntimeResultMeta;
    }
  | {
      ok: false;
      status: 'failed' | 'cancelled' | 'fallback';
      error: NormalizedRuntimeError;
      fallbackValue?: T;
      meta: RuntimeResultMeta;
    };

function assertNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

export function assertRuntimeIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  assertNonEmptyString(identity.sessionEpoch, 'sessionEpoch');
  assertNonEmptyString(identity.turnId, 'turnId');
  assertNonEmptyString(identity.invocationId, 'invocationId');
  if (!Number.isInteger(identity.generationId) || identity.generationId < 0) {
    throw new Error('generationId must be a non-negative integer');
  }
  if (identity.responseId !== undefined) {
    assertNonEmptyString(identity.responseId, 'responseId');
  }
  if (!Array.isArray(identity.evidenceRefs)) {
    throw new Error('evidenceRefs must be an array');
  }
  for (const evidenceRef of identity.evidenceRefs) {
    assertNonEmptyString(evidenceRef, 'evidenceRefs item');
  }
  return identity;
}

export function runtimeIdentityKey(identity: RuntimeIdentity): string {
  assertRuntimeIdentity(identity);
  return JSON.stringify([
    identity.sessionEpoch,
    identity.turnId,
    identity.generationId,
    identity.invocationId,
  ]);
}
