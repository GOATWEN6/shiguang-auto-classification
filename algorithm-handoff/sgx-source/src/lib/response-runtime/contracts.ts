import type {
  BorrowedGenerationExecutionPermit,
  CancellationCleanupStatus,
  GenerationCancellationRegistry,
  RuntimeIdentity,
} from '../algorithm-runtime/index.ts';
import type {
  InteractionAction,
  InterviewAction,
  InterviewRetentionControl,
  LiveInterviewDecisionRequest,
} from '../interview-policy/index.ts';

export type MaybePromise<T> = T | Promise<T>;

export type DailyChatIntent = 'ACKNOWLEDGE' | 'RESPOND';

/** Caller supplies no prompt, fallback, context text, purpose, or evidence allowlist. */
export interface DailyChatDecisionRequest {
  schemaVersion: 'daily-chat-decision-v0.1';
  identity: RuntimeIdentity;
  intent: DailyChatIntent;
}

/** Access scope comes from a trusted session/authorization adapter, never run(). */
export interface DailyChatAccessContext {
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  visibilityScope: string[];
}

export interface DailyChatAccessContextResolver {
  resolve(identity: RuntimeIdentity): MaybePromise<DailyChatAccessContext | null>;
}

/** Returned only by the trusted resolver injected when the runtime is created. */
export interface TrustedDailyChatReference {
  ref: string;
  text: string;
  purpose: 'daily_chat' | 'formal_interview' | 'story' | 'profile';
  subjectId: string;
  familySpaceId: string;
  authorizationVersion: string;
  visibilityScope: string[];
}

export interface DailyChatReferenceResolver {
  resolve(
    ref: string,
    accessContext: DailyChatAccessContext,
    identity: RuntimeIdentity,
  ): MaybePromise<TrustedDailyChatReference | null>;
}

export interface DailyChatGenerationPlan {
  schemaVersion: '0.1';
  planId: string;
  mode: 'DAILY_CHAT';
  promptId: 'daily-chat-v0.1' | 'daily-chat-v0.2';
  schemaId: 'daily-chat-response-v0.1';
  purpose: 'daily_chat';
  intent: DailyChatIntent;
  maxQuestions: 0 | 1;
  suggestedText: string;
  allowedEvidenceRefs: string[];
}

export interface DailyChatGenerationRequest {
  identity: RuntimeIdentity;
  signal: AbortSignal;
  /** Branded read-only permit for a nested model runtime; no cancel/finalize authority. */
  executionPermit: BorrowedGenerationExecutionPermit;
  plan: DailyChatGenerationPlan;
  accessContext: DailyChatAccessContext;
  context: TrustedDailyChatReference[];
}

export interface DailyChatRuntimeResult {
  status: 'success' | 'fallback' | 'cancelled';
  planId: string;
  mode: 'DAILY_CHAT';
  intent: DailyChatIntent;
  text: string;
  questionCount: 0 | 1;
  evidenceRefs: string[];
  fallbackUsed: boolean;
  cancellationCleanupStatus: CancellationCleanupStatus;
}

export interface CreateDailyChatResponseRuntimeOptions {
  cancellationRegistry: GenerationCancellationRegistry;
  /** v0.2 permits one light question for RESPOND; ACKNOWLEDGE remains question-free. */
  allowLightFollowUp?: boolean;
  accessContextResolver: DailyChatAccessContextResolver;
  referenceResolver: DailyChatReferenceResolver;
  /** Bounded wait for an already-started nested generator to finish abort cleanup. */
  cancellationCleanupTimeoutMs?: number;
  generate(request: DailyChatGenerationRequest): MaybePromise<unknown>;
}

export interface DailyChatResponseRuntime {
  run(request: DailyChatDecisionRequest): Promise<DailyChatRuntimeResult>;
}

export interface InterviewGenerationPlan {
  schemaVersion: '0.1';
  promptId: 'interview-realizer-v0.1' | 'interview-realizer-v0.2' | 'interview-realizer-v0.3'
    | 'interview-realizer-v0.4';
  schemaId: 'interview-response-v0.1';
  decisionId: string;
  mode: 'FORMAL_INTERVIEW';
  action: Exclude<InteractionAction | InterviewAction, 'NONE'>;
  retentionIntent: 'DEFAULT';
  questionCount: 0 | 1;
  evidenceRefs: string[];
  topicId: string | null;
  intent: string;
  mustAvoid: string[];
  frozenPolicyText: string;
}

export interface InterviewGenerationRequest {
  identity: RuntimeIdentity;
  signal: AbortSignal;
  /** Branded read-only permit for a nested model runtime; no cancel/finalize authority. */
  executionPermit: BorrowedGenerationExecutionPermit;
  plan: InterviewGenerationPlan;
}

export interface InterviewRuntimeResult {
  status: 'success' | 'fallback' | 'cancelled' | 'suppressed' | 'policy_direct';
  decisionId: string;
  mode: 'FORMAL_INTERVIEW';
  action: Exclude<InteractionAction | InterviewAction, 'NONE'>;
  retentionControl: InterviewRetentionControl;
  questionCount: 0 | 1;
  evidenceRefs: string[];
  topicId: string | null;
  text: string;
  fallbackUsed: boolean;
  cancellationCleanupStatus: CancellationCleanupStatus;
}

export interface CreateInterviewRealizerOptions {
  cancellationRegistry: GenerationCancellationRegistry;
  decisionRequestResolver: InterviewDecisionRequestResolver;
  /** Internal v0.2 test composition; control/safety actions remain policy-direct. */
  naturalizeQuestions?: boolean;
  /** Opt-in v0.3 ordinary continuation; frozen v0.2 remains the default. */
  ordinaryNarrativeContinuation?: boolean;
  /** Bounded wait for an already-started nested generator to finish abort cleanup. */
  cancellationCleanupTimeoutMs?: number;
  generate(request: InterviewGenerationRequest): MaybePromise<unknown>;
}

/** Caller-controlled Interview input is limited to invocation identity. */
export interface InterviewRealizerRequest {
  schemaVersion: 'interview-realizer-request-v0.1';
  identity: RuntimeIdentity;
}

/** Trusted adapter resolves the immutable ASR/runtime/policy input for this identity. */
export interface InterviewDecisionRequestResolver {
  resolve(identity: RuntimeIdentity): LiveInterviewDecisionRequest;
}

export interface InterviewRealizer {
  run(request: InterviewRealizerRequest): Promise<InterviewRuntimeResult>;
}
