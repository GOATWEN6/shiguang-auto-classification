import type {
  AlgorithmModule,
  CancellationCleanupStatus,
  NormalizedRuntimeError,
  ProviderUsage,
  RuntimeIdentity,
} from '../algorithm-runtime/contracts.ts';
import type {
  BorrowedGenerationExecutionPermit,
  GenerationCancellationRegistry,
} from '../algorithm-runtime/cancellation-registry.ts';

export type TextRuntimeModule = Extract<
  AlgorithmModule,
  'daily_chat' | 'formal_interview' | 'story_draft' | 'profile_draft'
>;

export type ProviderBillingState = 'VALIDATED' | 'UNBILLED' | 'UNKNOWN';

export interface ProviderAttemptTelemetry {
  queuedAt: string;
  providerStartedAt: string | null;
  firstOutputAt: string | null;
  completedAt: string;
  firstOutputLatencyMs: number | null;
  totalLatencyMs: number;
  usage: ProviderUsage | null;
  costCny: number | null;
  billingState: ProviderBillingState;
  sdkRetryPolicy: 'DISABLED';
  /** Runtime-owned gate count. This value is never supplied by a transport. */
  runtimeGateExecutionCount: number;
  /** Distinguishes safe join, bounded timeout, and unsafe/invalid sink acknowledgement. */
  cancellationCleanupStatus: CancellationCleanupStatus;
}

export interface TextTransportRequest {
  module: TextRuntimeModule;
  identity: RuntimeIdentity;
  /** Canonical signal from GenerationCancellationRegistry.acquireLease(). */
  signal: AbortSignal;
  attemptId: string;
  requestId: string;
  prompt: string;
  sdkRetryPolicy: 'DISABLED';
}

export interface TtsTransportRequest {
  identity: RuntimeIdentity;
  /** Canonical signal from GenerationCancellationRegistry.acquireLease(). */
  signal: AbortSignal;
  attemptId: string;
  requestId: string;
  text: string;
  sdkRetryPolicy: 'DISABLED';
}

export interface TextProviderUsage extends ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TtsProviderUsage extends ProviderUsage {
  inputCharacters: number;
  outputAudioMs: number;
}

export interface ProviderTransportCompletion<TUsage extends ProviderUsage = ProviderUsage> {
  usage: TUsage;
  /** Untrusted provider claim. A trusted billing verifier must settle it. */
  costCny: number;
}

export interface BillingVerificationRequest {
  module: AlgorithmModule;
  identity: RuntimeIdentity;
  attemptId: string;
  requestId: string;
  usage: ProviderUsage;
  reportedCostCny: number;
}

export interface BillingVerificationResult {
  costCny: number;
}

/**
 * Trusted boundary backed by the frozen price catalog / attempt ledger.
 * A provider transport cannot mark its own cost as validated.
 */
export interface ProviderBillingVerifier {
  verify(request: BillingVerificationRequest): BillingVerificationResult | null;
}

/**
 * The only supported entry point for one runtime-controlled provider executor
 * invocation. It does not, by itself, prove the transport or SDK made exactly
 * one physical network request.
 */
export type ExecuteRuntimeRequest = <T>(operation: () => Promise<T>) => Promise<T>;

export interface AuditedTextTransport {
  invoke(
    request: TextTransportRequest,
    emit: (event: unknown) => Promise<void>,
    executeRuntimeRequest: ExecuteRuntimeRequest,
  ): Promise<ProviderTransportCompletion<TextProviderUsage>>;
}

export interface AuditedTtsTransport {
  synthesize(
    request: TtsTransportRequest,
    emit: (event: unknown) => Promise<void>,
    executeRuntimeRequest: ExecuteRuntimeRequest,
  ): Promise<ProviderTransportCompletion<TtsProviderUsage>>;
}

export interface AuditedTextRuntimeOptions {
  cancellationRegistry: GenerationCancellationRegistry;
  transport: AuditedTextTransport;
  billingVerifier: ProviderBillingVerifier;
  now?: () => string;
  /** Maximum wait for a trusted output sink to acknowledge COMMITTED/DROPPED. */
  sinkAcknowledgementTimeoutMs?: number;
}

export interface AuditedTtsRuntimeOptions {
  cancellationRegistry: GenerationCancellationRegistry;
  transport: AuditedTtsTransport;
  billingVerifier: ProviderBillingVerifier;
  now?: () => string;
  /** Maximum wait for a trusted output sink to acknowledge COMMITTED/DROPPED. */
  sinkAcknowledgementTimeoutMs?: number;
}

export interface AuditedTextRunInput {
  module: TextRuntimeModule;
  identity: RuntimeIdentity;
  attemptId: string;
  requestId: string;
  prompt: string;
  /** A trusted sink must acknowledge commit or confirm the chunk was dropped on abort. */
  onVisibleText?: (
    text: string,
    context: OutputCommitContext,
  ) => 'COMMITTED' | 'DROPPED' | Promise<'COMMITTED' | 'DROPPED'>;
}

export interface AuditedTtsRunInput {
  identity: RuntimeIdentity;
  attemptId: string;
  requestId: string;
  text: string;
  /** A trusted sink must acknowledge enqueue or confirm the chunk was dropped on abort. */
  onAudio?: (
    audio: Uint8Array,
    context: OutputCommitContext,
  ) => 'COMMITTED' | 'DROPPED' | Promise<'COMMITTED' | 'DROPPED'>;
}

export interface OutputCommitContext {
  identity: RuntimeIdentity;
  signal: AbortSignal;
}

interface TextResultBase {
  text: string;
  telemetry: ProviderAttemptTelemetry;
}

export type AuditedTextRunResult =
  | (TextResultBase & { status: 'success' })
  | (TextResultBase & { status: 'cancelled'; error: NormalizedRuntimeError })
  | (TextResultBase & { status: 'failed'; error: NormalizedRuntimeError });

interface TtsResultBase {
  text: string;
  audioChunks: Uint8Array[];
  telemetry: ProviderAttemptTelemetry;
}

export type AuditedTtsRunResult =
  | (TtsResultBase & { status: 'success' })
  | (TtsResultBase & { status: 'cancelled'; error: NormalizedRuntimeError })
  | (TtsResultBase & { status: 'audio_unavailable'; error: NormalizedRuntimeError });

export interface AuditedTextRuntime {
  run(input: AuditedTextRunInput): Promise<AuditedTextRunResult>;
  /** Trusted nested runtimes borrow an outer owner lease and cannot finalize it. */
  runBorrowed(
    input: AuditedTextRunInput,
    permit: BorrowedGenerationExecutionPermit,
  ): Promise<AuditedTextRunResult>;
}

export interface AuditedTtsRuntime {
  run(input: AuditedTtsRunInput): Promise<AuditedTtsRunResult>;
  /** Trusted nested runtimes borrow an outer owner lease and cannot finalize it. */
  runBorrowed(
    input: AuditedTtsRunInput,
    permit: BorrowedGenerationExecutionPermit,
  ): Promise<AuditedTtsRunResult>;
}
