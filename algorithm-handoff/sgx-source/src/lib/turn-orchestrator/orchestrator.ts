import { createHash, randomUUID } from 'node:crypto';

import type { RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import { GenerationLeaseTree, type OwnedGenerationLeaseHandle } from '../algorithm-runtime/lease-tree.ts';
import type { InterviewMode, InterviewSessionStatus } from '../interview-policy/contracts.ts';
import {
  assertExactKeys,
  assertNonEmptyString,
  assertPlainRecord,
  assertTimestamp,
  stableFingerprint,
  type AsrTurnFinalRequest,
  type ClientSessionStartRequest,
  type GovernedSessionSnapshot,
  type GovernedTurnHandle,
  type TrustedSessionAuthority,
  type TrustedSessionStatePatch,
  type TypedTextFinalRequest,
} from './contracts.ts';
import { InMemoryTurnEvidenceStore } from './evidence-store.ts';
import { InMemoryGovernedSessionStore } from './session-store.ts';
import type { RetentionGovernanceAdapter } from './retention-governance.ts';
import {
  createTurnAsyncJobCoordinator,
  type AsyncJobAdapter,
  type AsyncJobRequest,
  type AsyncJobStatusRecord,
} from './async-jobs.ts';

export type TurnPhase =
  | 'ASR_PARTIAL'
  | 'MODEL_PENDING'
  | 'PRE_TTS'
  | 'TTS_STREAMING'
  | 'ASYNC_JOBS'
  | 'COMPLETED'
  | 'INTERRUPTED'
  | 'ERROR';

export interface ExplicitUiModeAction {
  type: 'MEMORY_TOPIC_CLICK';
  eventRef: string;
  targetMode: 'FORMAL_INTERVIEW';
}

export type FinalTurnInput =
  | {
      schemaVersion: 'orchestrated-turn-v0.1';
      idempotencyToken: string;
      /** Accepted only by the server composition after a definite provider final. */
      source: 'SERVER_ASR_FINAL';
      text: string;
      asrRequestId: string;
      receivedAt: string;
      uiAction?: ExplicitUiModeAction;
    }
  | {
      schemaVersion: 'orchestrated-turn-v0.1';
      idempotencyToken: string;
      source: 'TYPED_TEXT';
      text: string;
      receivedAt: string;
      uiAction?: ExplicitUiModeAction;
    }
  | {
      schemaVersion: 'orchestrated-turn-v0.1';
      idempotencyToken: string;
      source: 'ASR_FINAL';
      receivedAt: string;
      segments: AsrTurnFinalRequest['segments'];
      uiAction?: ExplicitUiModeAction;
    };

export interface PartialTurnInput {
  schemaVersion: 'orchestrated-partial-v0.1';
  idempotencyToken: string;
  partialId: string;
  text: string;
  receivedAt: string;
}

export interface TurnResponseRequest {
  mode: InterviewMode;
  identity: RuntimeIdentity;
  signal: AbortSignal;
}

export interface TurnResponseResult {
  status: 'success' | 'fallback' | 'cancelled' | 'suppressed' | 'policy_direct';
  text: string;
  policyEngine: 'DailyChatPolicy' | 'InterviewPolicyV0.2';
  action: string;
  questionCount: 0 | 1;
  evidenceRefs: string[];
  retentionIntent: 'DEFAULT' | 'NO_SAVE';
  retentionScope: 'NONE' | 'CURRENT_TURN' | 'PREVIOUS_COMPLETED_TURN' | 'CURRENT_TOPIC' | 'CURRENT_SESSION';
  sessionControl: 'CONTINUE' | 'PAUSE' | 'END';
  /** Server-only policy transition applied after current child work settles. */
  policyStatePatch?: TrustedSessionStatePatch;
}

export interface TurnTtsResult {
  status: 'success' | 'cancelled' | 'audio_unavailable' | 'skipped';
  audioChunkCount: number;
}

export interface TurnProcessingAdapter {
  respond(request: TurnResponseRequest): Promise<TurnResponseResult>;
  synthesize(request: {
    identity: RuntimeIdentity;
    text: string;
    signal: AbortSignal;
  }): Promise<TurnTtsResult>;
  planAsyncJobs(request: {
    mode: InterviewMode;
    identity: RuntimeIdentity;
    response: TurnResponseResult;
  }): AsyncJobRequest[];
}

export interface TurnPhaseContext {
  opaqueSessionHandle: string;
  targetHandle: string;
  identity: RuntimeIdentity | null;
}

export interface TurnRunResult {
  schemaVersion: 'orchestrated-turn-result-v0.1';
  status: 'completed' | 'interrupted' | 'error';
  phase: TurnPhase;
  opaqueSessionHandle: string;
  targetHandle: string;
  sessionEpoch: string;
  turnId: string;
  generationId: number;
  evidenceId: string;
  mode: InterviewMode;
  response: TurnResponseResult | null;
  tts: TurnTtsResult;
  asyncJobs: AsyncJobStatusRecord[];
  errorCode: string | null;
  retentionEffect: TurnRetentionEffect | null;
  canonicalWriteCount: 0;
}

export interface TurnRetentionEffect {
  status: 'APPLIED' | 'PARTIAL';
  scope: 'CURRENT_TURN' | 'PREVIOUS_COMPLETED_TURN' | 'CURRENT_TOPIC' | 'CURRENT_SESSION';
  targetEvidenceRefHashes: string[];
  rawEvidenceInvalidated: boolean;
  downstreamStatus: 'APPLIED' | 'NOT_CONFIGURED' | 'FAILED';
  withdrawnRecordCount: number;
  invalidatedArtifactCount: number;
  deleteBy: string;
}

export interface SessionStartReceipt {
  schemaVersion: 'orchestrated-session-v0.1';
  replayed: boolean;
  opaqueSessionHandle: string;
  sessionEpoch: string;
  mode: InterviewMode;
}

export interface PartialReceipt {
  schemaVersion: 'orchestrated-partial-result-v0.1';
  status: 'WAIT';
  replayed: boolean;
  targetHandle: string;
}

export interface InterruptRequest {
  schemaVersion: 'orchestrated-interrupt-v0.1';
  idempotencyToken: string;
  targetHandle: string;
  reason: 'user_restart_utterance' | 'self_correction' | 'explicit_cancel' | 'user_speech'
    | 'source_correction' | 'safety_stop' | 'session_end';
}

export interface InterruptReceipt {
  schemaVersion: 'orchestrated-interrupt-result-v0.1';
  accepted: boolean;
  replayed: boolean;
  interruptId: string;
  targetHandle: string;
}

export interface OrchestratorAuditRecord {
  requestId: string;
  opaqueSessionId: string;
  turnId: string | null;
  generationId: number | null;
  module: 'orchestrator';
  status: string;
  errorCode: string | null;
  costCny: 0;
  version: 'v0.1';
}

export interface TurnOrchestratorOptions {
  sessions?: InMemoryGovernedSessionStore;
  evidenceStore?: InMemoryTurnEvidenceStore;
  processing: TurnProcessingAdapter;
  asyncAdapters: Readonly<Record<'MEMORY' | 'STORY' | 'PROFILE', AsyncJobAdapter>>;
  retentionGovernance?: RetentionGovernanceAdapter;
  phaseHook?: (phase: TurnPhase, context: TurnPhaseContext) => Promise<void> | void;
  onResponse?: (response: TurnResponseResult, context: TurnPhaseContext) => void;
  now?: () => string;
  id?: () => string;
  asyncSettlementTimeoutMs?: number;
}

interface SessionBinding {
  internalSessionId: string;
  authority: TrustedSessionAuthority;
}

interface ActivePartial {
  targetHandle: string;
  fingerprint: string;
  cancelled: boolean;
}

interface ActiveFinal {
  targetHandle: string;
  handle: GovernedTurnHandle;
  identity: RuntimeIdentity;
  tree: GenerationLeaseTree;
  root: OwnedGenerationLeaseHandle;
  phase: TurnPhase;
}

interface IdempotentRun {
  fingerprint: string;
  result: Promise<TurnRunResult>;
}

interface IdempotentInterrupt {
  fingerprint: string;
  result: InterruptReceipt;
}

const INTERRUPT_REASONS = new Set<InterruptRequest['reason']>([
  'user_restart_utterance', 'self_correction', 'explicit_cancel', 'user_speech',
  'source_correction', 'safety_stop', 'session_end',
]);

function assertUiAction(value: unknown): asserts value is ExplicitUiModeAction {
  assertPlainRecord(value, 'request.uiAction');
  assertExactKeys(value, ['type', 'eventRef', 'targetMode'], 'request.uiAction');
  if (value.type !== 'MEMORY_TOPIC_CLICK') throw new TypeError('request.uiAction.type is not supported');
  assertNonEmptyString(value.eventRef, 'request.uiAction.eventRef');
  if (value.targetMode !== 'FORMAL_INTERVIEW') {
    throw new TypeError('request.uiAction.targetMode must be FORMAL_INTERVIEW');
  }
}

function assertFinalTurnInput(value: unknown): asserts value is FinalTurnInput {
  assertPlainRecord(value, 'request');
  const common = ['schemaVersion', 'idempotencyToken', 'source', 'receivedAt', 'uiAction'];
  if (value.schemaVersion !== 'orchestrated-turn-v0.1') {
    throw new TypeError('request.schemaVersion must be orchestrated-turn-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertTimestamp(value.receivedAt, 'request.receivedAt');
  if (value.uiAction !== undefined) assertUiAction(value.uiAction);
  if (value.source === 'SERVER_ASR_FINAL') {
    assertExactKeys(value, [...common, 'text', 'asrRequestId'], 'request');
    assertNonEmptyString(value.text, 'request.text');
    assertNonEmptyString(value.asrRequestId, 'request.asrRequestId');
    return;
  }
  if (value.source === 'TYPED_TEXT') {
    assertExactKeys(value, [...common, 'text'], 'request');
    assertNonEmptyString(value.text, 'request.text');
    return;
  }
  if (value.source === 'ASR_FINAL') {
    assertExactKeys(value, [...common, 'segments'], 'request');
    if (!Array.isArray(value.segments) || value.segments.length === 0) {
      throw new TypeError('request.segments must be a non-empty array');
    }
    return;
  }
  throw new TypeError('request.source must be TYPED_TEXT or ASR_FINAL');
}

function assertPartialTurnInput(value: unknown): asserts value is PartialTurnInput {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, [
    'schemaVersion', 'idempotencyToken', 'partialId', 'text', 'receivedAt',
  ], 'request');
  if (value.schemaVersion !== 'orchestrated-partial-v0.1') {
    throw new TypeError('request.schemaVersion must be orchestrated-partial-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertNonEmptyString(value.partialId, 'request.partialId');
  if (typeof value.text !== 'string') throw new TypeError('request.text must be a string');
  assertTimestamp(value.receivedAt, 'request.receivedAt');
}

function assertInterruptRequest(value: unknown): asserts value is InterruptRequest {
  assertPlainRecord(value, 'request');
  assertExactKeys(value, ['schemaVersion', 'idempotencyToken', 'targetHandle', 'reason'], 'request');
  if (value.schemaVersion !== 'orchestrated-interrupt-v0.1') {
    throw new TypeError('request.schemaVersion must be orchestrated-interrupt-v0.1');
  }
  assertNonEmptyString(value.idempotencyToken, 'request.idempotencyToken');
  assertNonEmptyString(value.targetHandle, 'request.targetHandle');
  if (typeof value.reason !== 'string' || !INTERRUPT_REASONS.has(value.reason as InterruptRequest['reason'])) {
    throw new TypeError('request.reason is not supported');
  }
}

function responseCancelled(): TurnResponseResult {
  return {
    status: 'cancelled', text: '', policyEngine: 'DailyChatPolicy', action: 'CANCELLED',
    questionCount: 0, evidenceRefs: [], retentionIntent: 'DEFAULT', retentionScope: 'NONE',
    sessionControl: 'CONTINUE',
  };
}

function skippedTts(): TurnTtsResult {
  return { status: 'skipped', audioChunkCount: 0 };
}

export class TurnOrchestrator {
  readonly sessions: InMemoryGovernedSessionStore;
  readonly evidenceStore: InMemoryTurnEvidenceStore;
  private readonly processing: TurnProcessingAdapter;
  private readonly asyncAdapters: TurnOrchestratorOptions['asyncAdapters'];
  private readonly retentionGovernance?: RetentionGovernanceAdapter;
  private readonly phaseHook?: TurnOrchestratorOptions['phaseHook'];
  private readonly onResponse?: TurnOrchestratorOptions['onResponse'];
  private readonly now: () => string;
  private readonly id: () => string;
  private readonly asyncSettlementTimeoutMs: number;
  private readonly sessionBindings = new Map<string, SessionBinding>();
  private readonly handleBySessionId = new Map<string, string>();
  private readonly activePartial = new Map<string, ActivePartial>();
  private readonly activeFinal = new Map<string, ActiveFinal>();
  private readonly partialOperations = new Map<string, ActivePartial>();
  private readonly runOperations = new Map<string, IdempotentRun>();
  private readonly interruptOperations = new Map<string, IdempotentInterrupt>();
  private readonly endOperations = new Map<string, GovernedSessionSnapshot>();
  private readonly pendingExpiredRefs = new Set<string>();
  private readonly audit: OrchestratorAuditRecord[] = [];
  private acceptedFinalTurns = 0;
  private acceptedInterrupts = 0;

  constructor(options: TurnOrchestratorOptions) {
    if (!options?.processing) throw new TypeError('processing is required');
    this.now = options.now ?? (() => new Date().toISOString());
    this.sessions = options.sessions ?? new InMemoryGovernedSessionStore();
    this.evidenceStore = options.evidenceStore ?? new InMemoryTurnEvidenceStore(this.sessions, { now: this.now });
    this.processing = options.processing;
    this.asyncAdapters = options.asyncAdapters;
    this.retentionGovernance = options.retentionGovernance;
    for (const kind of ['MEMORY', 'STORY', 'PROFILE'] as const) {
      const adapter = this.asyncAdapters?.[kind];
      if (!adapter || typeof adapter.run !== 'function' || typeof adapter.commit !== 'function') {
        throw new TypeError(`asyncAdapters.${kind} requires run and commit`);
      }
    }
    this.phaseHook = options.phaseHook;
    this.onResponse = options.onResponse;
    this.id = options.id ?? (() => randomUUID());
    this.asyncSettlementTimeoutMs = options.asyncSettlementTimeoutMs ?? 500;
    if (!Number.isInteger(this.asyncSettlementTimeoutMs) || this.asyncSettlementTimeoutMs < 0
      || this.asyncSettlementTimeoutMs > 60_000) {
      throw new TypeError('asyncSettlementTimeoutMs must be an integer from 0 through 60000');
    }
  }

  startSession(
    request: ClientSessionStartRequest,
    authority: TrustedSessionAuthority,
  ): SessionStartReceipt {
    const started = this.sessions.startSession(request, authority);
    let opaqueSessionHandle = this.handleBySessionId.get(started.session.sessionId);
    if (!opaqueSessionHandle) {
      opaqueSessionHandle = `session_${this.id()}`;
      this.handleBySessionId.set(started.session.sessionId, opaqueSessionHandle);
      this.sessionBindings.set(opaqueSessionHandle, {
        internalSessionId: started.session.sessionId,
        authority: structuredClone(authority),
      });
    }
    this.log(opaqueSessionHandle, null, null, 'session_started', null);
    return {
      schemaVersion: 'orchestrated-session-v0.1',
      replayed: started.replayed,
      opaqueSessionHandle,
      sessionEpoch: started.session.sessionEpoch,
      mode: started.session.mode,
    };
  }

  observePartial(opaqueSessionHandle: string, request: PartialTurnInput): PartialReceipt {
    assertPartialTurnInput(request);
    const binding = this.requireBinding(opaqueSessionHandle);
    const session = this.requireUsableSession(binding.internalSessionId);
    const key = `${binding.internalSessionId}\u0000${request.idempotencyToken}`;
    const fingerprint = stableFingerprint(request);
    const prior = this.partialOperations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different partial payload');
      }
      return {
        schemaVersion: 'orchestrated-partial-result-v0.1',
        status: 'WAIT', replayed: true, targetHandle: prior.targetHandle,
      };
    }
    const target: ActivePartial = {
      targetHandle: `target_${this.id()}`,
      fingerprint,
      cancelled: false,
    };
    this.partialOperations.set(key, target);
    this.activePartial.set(opaqueSessionHandle, target);
    this.log(opaqueSessionHandle, null, session.generationId, 'asr_partial_wait', null);
    return {
      schemaVersion: 'orchestrated-partial-result-v0.1',
      status: 'WAIT', replayed: false, targetHandle: target.targetHandle,
    };
  }

  runFinalTurn(opaqueSessionHandle: string, request: FinalTurnInput): Promise<TurnRunResult> {
    assertFinalTurnInput(request);
    const binding = this.requireBinding(opaqueSessionHandle);
    const key = `${binding.internalSessionId}\u0000${request.idempotencyToken}`;
    const fingerprint = stableFingerprint(request);
    const prior = this.runOperations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different final payload');
      }
      return prior.result.then(result => this.sanitizeReplayResult(result));
    }
    const result = this.sweepExpiredEvidence().then(sweep => {
      if (this.retentionGovernance && sweep.status === 'PARTIAL') {
        throw new Error('retention_expiry_propagation_failed');
      }
      return this.executeFinal(opaqueSessionHandle, binding, structuredClone(request));
    });
    this.runOperations.set(key, { fingerprint, result });
    return result;
  }

  /** Public validity gate for HTTP replay/audio caches. */
  isEvidenceUsable(evidenceId: string): boolean {
    const evidence = evidenceId ? this.evidenceStore.get(evidenceId) : null;
    if (!evidence) return false;
    const session = this.sessions.getSession(evidence.sessionId);
    return Boolean(session && session.sessionEpoch === evidence.identity.sessionEpoch
      && session.actorId === evidence.actorId && session.subjectId === evidence.subjectId
      && session.familySpaceId === evidence.familySpaceId
      && session.authorizationVersion === evidence.authorizationVersion
      && JSON.stringify([...session.visibilityScope].sort())
        === JSON.stringify([...evidence.visibilityScope].sort()));
  }

  /** Never re-runs a model to refresh a withdrawn or expired cached result. */
  sanitizeReplayResult(result: TurnRunResult): TurnRunResult {
    const refs = [result.evidenceId, ...(result.response?.evidenceRefs ?? [])];
    if (refs.every(ref => this.isEvidenceUsable(ref))) return structuredClone(result);
    return {
      ...structuredClone(result),
      status: 'error',
      phase: 'ERROR',
      response: null,
      tts: skippedTts(),
      asyncJobs: [],
      errorCode: 'evidence_unavailable',
    };
  }

  /** Call from the server scheduler as well as before a new final turn. */
  async sweepExpiredEvidence(now: string = this.now()): Promise<{
    status: 'APPLIED' | 'PARTIAL';
    evidenceRefHashes: string[];
    withdrawnRecordCount: number;
    invalidatedArtifactCount: number;
  }> {
    assertTimestamp(now, 'now');
    for (const ref of this.evidenceStore.purgeExpired(now)) this.pendingExpiredRefs.add(ref);
    this.evidenceStore.purgeInvalidatedDue(now);
    const refs = [...this.pendingExpiredRefs];
    const result = { status: 'APPLIED' as 'APPLIED' | 'PARTIAL',
      evidenceRefHashes: refs.map(ref => createHash('sha256').update(ref).digest('hex')).sort(),
      withdrawnRecordCount: 0, invalidatedArtifactCount: 0 };
    if (!refs.length) return result;
    this.scrubReplayCaches();
    if (!this.retentionGovernance) return { ...result, status: 'PARTIAL' };
    try {
      const propagated = await this.retentionGovernance.withdraw({
        actionId: `expiry:${stableFingerprint(refs.slice().sort())}`,
        actorId: 'retention_scheduler', occurredAt: now,
        reasonCode: 'RETENTION_40_DAY_EXPIRY', evidenceRefs: refs,
      });
      for (const ref of refs) this.pendingExpiredRefs.delete(ref);
      return { ...result, withdrawnRecordCount: propagated.withdrawnRecordIds.length,
        invalidatedArtifactCount: propagated.invalidatedArtifactRefs.length };
    } catch {
      return { ...result, status: 'PARTIAL' };
    }
  }

  private scrubReplayCaches(): void {
    for (const operation of this.runOperations.values()) {
      const scrubbed = operation.result.then(result => this.sanitizeReplayResult(result));
      // Cached pre-turn validation failures may already have been handled by
      // their caller. Keep their rejection without creating an unhandled one
      // merely because unrelated evidence was withdrawn.
      void scrubbed.catch(() => undefined);
      operation.result = scrubbed;
    }
  }

  interrupt(opaqueSessionHandle: string, request: InterruptRequest): InterruptReceipt {
    assertInterruptRequest(request);
    const binding = this.requireBinding(opaqueSessionHandle);
    const key = `${binding.internalSessionId}\u0000${request.idempotencyToken}`;
    const fingerprint = stableFingerprint(request);
    const prior = this.interruptOperations.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw new Error('idempotencyToken reused with a different interrupt payload');
      }
      return { ...prior.result, replayed: true };
    }
    let accepted = false;
    const partial = this.activePartial.get(opaqueSessionHandle);
    if (partial?.targetHandle === request.targetHandle && !partial.cancelled) {
      partial.cancelled = true;
      this.activePartial.delete(opaqueSessionHandle);
      accepted = true;
    }
    const active = this.activeFinal.get(opaqueSessionHandle);
    if (!accepted && active?.targetHandle === request.targetHandle) {
      accepted = active.tree.cancel(active.root, request.reason).cancelled;
      if (accepted) active.phase = 'INTERRUPTED';
    }
    const result: InterruptReceipt = {
      schemaVersion: 'orchestrated-interrupt-result-v0.1',
      accepted,
      replayed: false,
      interruptId: `interrupt_${this.id()}`,
      targetHandle: request.targetHandle,
    };
    this.interruptOperations.set(key, { fingerprint, result });
    if (accepted) this.acceptedInterrupts += 1;
    this.log(
      opaqueSessionHandle,
      active?.identity.turnId ?? null,
      active?.identity.generationId ?? null,
      accepted ? 'interrupt_accepted' : 'interrupt_rejected',
      accepted ? null : 'stale_target',
    );
    return result;
  }

  endSession(opaqueSessionHandle: string, idempotencyToken: string): GovernedSessionSnapshot {
    assertNonEmptyString(idempotencyToken, 'idempotencyToken');
    const binding = this.requireBinding(opaqueSessionHandle);
    const key = `${binding.internalSessionId}\u0000${idempotencyToken}`;
    const replay = this.endOperations.get(key);
    if (replay) return structuredClone(replay);
    const active = this.activeFinal.get(opaqueSessionHandle);
    if (active) active.tree.cancel(active.root, 'session_end');
    const session = this.sessions.getSession(binding.internalSessionId);
    if (!session) throw new Error('session no longer exists');
    const ended = session.status === 'ENDED' ? session : this.sessions.compareAndSwap({
      schemaVersion: 'trusted-session-cas-v0.1',
      sessionId: session.sessionId,
      expectedStateVersion: session.stateVersion,
      operationId: `end:${idempotencyToken}`,
      patch: { status: 'ENDED' },
    });
    this.endOperations.set(key, structuredClone(ended));
    this.log(opaqueSessionHandle, active?.identity.turnId ?? null,
      active?.identity.generationId ?? null, 'session_ended', null);
    return structuredClone(ended);
  }

  getMetrics(): { acceptedFinalTurns: number; acceptedInterrupts: number; networkCalls: 0; costCny: 0 } {
    return {
      acceptedFinalTurns: this.acceptedFinalTurns,
      acceptedInterrupts: this.acceptedInterrupts,
      networkCalls: 0,
      costCny: 0,
    };
  }

  getAuditRecords(): OrchestratorAuditRecord[] {
    return structuredClone(this.audit);
  }

  getCurrentTarget(opaqueSessionHandle: string): string | null {
    this.requireBinding(opaqueSessionHandle);
    return this.activeFinal.get(opaqueSessionHandle)?.targetHandle
      ?? this.activePartial.get(opaqueSessionHandle)?.targetHandle
      ?? null;
  }

  getSessionSnapshot(opaqueSessionHandle: string): GovernedSessionSnapshot {
    const binding = this.requireBinding(opaqueSessionHandle);
    const session = this.sessions.getSession(binding.internalSessionId);
    if (!session) throw new Error('session no longer exists');
    return session;
  }

  private async executeFinal(
    opaqueSessionHandle: string,
    binding: SessionBinding,
    request: FinalTurnInput,
  ): Promise<TurnRunResult> {
    const priorPartial = this.activePartial.get(opaqueSessionHandle);
    this.activePartial.delete(opaqueSessionHandle);
    let session = this.requireUsableSession(binding.internalSessionId);
    if (request.uiAction) {
      if (session.mode !== 'DAILY_CHAT') throw new Error('explicit mode action is only valid from DAILY_CHAT');
      session = this.sessions.applyTrustedModeTransition({
        schemaVersion: 'trusted-mode-transition-v0.1',
        sessionId: session.sessionId,
        expectedStateVersion: session.stateVersion,
        operationId: `ui-mode:${request.uiAction.eventRef}`,
        targetMode: request.uiAction.targetMode,
        source: 'EXPLICIT_UI_ACTION',
        eventRef: request.uiAction.eventRef,
      });
    }
    const opened = this.sessions.openTurn({
      schemaVersion: 'client-turn-open-v0.1',
      sessionId: session.sessionId,
      idempotencyToken: request.idempotencyToken,
    });
    const committed = request.source === 'TYPED_TEXT'
      ? this.evidenceStore.commitTypedText(opened.handle, {
          schemaVersion: 'typed-text-final-v0.1',
          idempotencyToken: request.idempotencyToken,
          text: request.text,
          receivedAt: request.receivedAt,
        } satisfies TypedTextFinalRequest)
      : this.evidenceStore.commitAsrFinal(opened.handle, {
          schemaVersion: 'asr-turn-final-v0.1',
          idempotencyToken: request.idempotencyToken,
          receivedAt: request.receivedAt,
          segments: request.source === 'SERVER_ASR_FINAL' ? [{
            kind: 'transcript_final',
            evidenceId: `asr:${request.asrRequestId}`,
            segmentKey: `segment:${request.asrRequestId}:0`,
            identity: opened.handle.identity,
            attemptId: request.asrRequestId,
            connectionId: request.asrRequestId,
            receivedAt: request.receivedAt,
            providerSequence: 0,
            segmentIndex: 0,
            revision: 0,
            text: request.text,
          }] : request.segments,
        });
    this.acceptedFinalTurns += opened.replayed ? 0 : 1;
    const identity = committed.boundTurn.identity;
    const tree = new GenerationLeaseTree({ treeId: `turn-tree:${this.id()}` });
    const root = tree.startRoot({
      taskId: `turn:${identity.turnId}`,
      taskKind: 'TURN_ROOT',
      channel: 'orchestrator',
      identity,
    });
    const targetHandle = priorPartial && !priorPartial.cancelled
      ? priorPartial.targetHandle
      : `target_${this.id()}`;
    const active: ActiveFinal = {
      targetHandle, handle: opened.handle, identity, tree, root, phase: 'MODEL_PENDING',
    };
    if (this.activeFinal.has(opaqueSessionHandle)) throw new Error('session already has an active final turn');
    this.activeFinal.set(opaqueSessionHandle, active);
    let response: TurnResponseResult | null = null;
    let tts = skippedTts();
    let asyncJobs: AsyncJobStatusRecord[] = [];
    let errorCode: string | null = null;
    let retentionEffect: TurnRetentionEffect | null = null;
    try {
      await this.enterPhase('MODEL_PENDING', opaqueSessionHandle, active);
      if (!tree.accepts(root).accepted) return this.interruptedResult(opaqueSessionHandle, active, committed.evidence.evidenceId);

      const responseLease = tree.spawnChild(root, {
        taskId: `response:${identity.turnId}`,
        taskKind: 'RESPONSE',
        channel: committed.boundTurn.mode === 'DAILY_CHAT' ? 'daily_chat' : 'formal_interview',
        identity,
      });
      response = await this.processing.respond({
        mode: committed.boundTurn.mode,
        identity,
        signal: responseLease.signal,
      });
      if (!tree.accepts(responseLease).accepted || response.status === 'cancelled') {
        tree.cancel(responseLease, 'response_cancelled');
        return this.interruptedResult(opaqueSessionHandle, active, committed.evidence.evidenceId, response);
      }
      const responseCompletion = tree.complete(responseLease);
      if (!responseCompletion.completed) throw new Error('response lease did not settle cleanly');

      if (response.retentionIntent === 'NO_SAVE') {
        const occurredAt = this.now();
        const scope = response.retentionScope;
        const targets = scope === 'CURRENT_TURN' ? [committed.evidence]
          : scope === 'PREVIOUS_COMPLETED_TURN'
            ? [this.evidenceStore.getPreviousCompletedInSession(committed.evidence.evidenceId)]
              .filter((value): value is NonNullable<typeof value> => value !== null)
          : scope === 'CURRENT_SESSION'
            ? this.evidenceStore.listCompletedInSession(committed.evidence.evidenceId)
            : [];
        // Topic attribution is not in the evidence contract. Do not guess that
        // a topic request means one turn or the entire conversation.
        if (!targets.length || scope === 'CURRENT_TOPIC' || scope === 'NONE') {
          errorCode = 'retention_scope_unresolved';
          response = { ...response, status: 'fallback', action: 'CLARIFY', questionCount: 0,
            text: '请明确要撤回刚才一段，还是这次会话的全部内容。' };
        } else {
          const reasonCode = `ELDER_NO_SAVE_${scope}`;
          const tombstones = targets.map(target => this.evidenceStore.invalidateEvidence(target.evidenceId, {
            actionId: `no-save:${identity.turnId}`,
            actorId: binding.authority.actorId,
            occurredAt, reasonCode,
          }));
          if (tombstones.some(value => !value)) throw new Error('retention target is no longer available');
          this.scrubReplayCaches();
          retentionEffect = {
            status: 'APPLIED', scope,
            targetEvidenceRefHashes: targets.map(target => (
              createHash('sha256').update(target.evidenceId).digest('hex')
            )).sort(),
            rawEvidenceInvalidated: true,
            downstreamStatus: 'NOT_CONFIGURED',
            withdrawnRecordCount: 0,
            invalidatedArtifactCount: 0,
            deleteBy: tombstones[0]!.deleteBy,
          };
          if (this.retentionGovernance) {
            try {
              const propagated = await this.retentionGovernance.withdraw({
                actionId: `no-save:${identity.turnId}`,
                actorId: binding.authority.actorId,
                occurredAt,
                reasonCode,
                evidenceRefs: targets.map(target => target.evidenceId),
              });
              retentionEffect = {
                ...retentionEffect,
                downstreamStatus: 'APPLIED',
                withdrawnRecordCount: propagated.withdrawnRecordIds.length,
                invalidatedArtifactCount: propagated.invalidatedArtifactRefs.length,
              };
            } catch {
              retentionEffect = { ...retentionEffect, status: 'PARTIAL', downstreamStatus: 'FAILED' };
              response = {
                ...response,
                status: 'fallback',
                text: '这次没有完整处理好。我已经先让这段内容停止使用，请稍后再试。',
                questionCount: 0,
              };
              errorCode = 'retention_propagation_failed';
            }
          }
        }
      }

      await this.enterPhase('PRE_TTS', opaqueSessionHandle, active);
      if (!tree.accepts(root).accepted) {
        return this.interruptedResult(opaqueSessionHandle, active, committed.evidence.evidenceId, response);
      }
      this.onResponse?.(response, { opaqueSessionHandle, targetHandle, identity });
      if (response.text.length > 0 && response.sessionControl === 'CONTINUE') {
        const ttsLease = tree.spawnChild(root, {
          taskId: `tts:${identity.turnId}`,
          taskKind: 'TTS', channel: 'tts', identity,
        });
        await this.enterPhase('TTS_STREAMING', opaqueSessionHandle, active);
        if (tree.accepts(ttsLease).accepted) {
          tts = await this.processing.synthesize({ identity, text: response.text, signal: ttsLease.signal });
        } else {
          tts = { status: 'cancelled', audioChunkCount: 0 };
        }
        if (tree.accepts(ttsLease).accepted) tree.complete(ttsLease);
        else tree.cancel(ttsLease, 'tts_cancelled');
      }

      if (!tree.accepts(root).accepted) {
        return this.interruptedResult(
          opaqueSessionHandle, active, committed.evidence.evidenceId, response, tts,
        );
      }

      await this.enterPhase('ASYNC_JOBS', opaqueSessionHandle, active);
      if (tree.accepts(root).accepted && response.retentionIntent !== 'NO_SAVE') {
        const coordinator = createTurnAsyncJobCoordinator({
          coordinatorId: `jobs:${identity.turnId}`,
          tree,
          turnRoot: root,
          adapters: this.asyncAdapters,
          now: this.now,
        });
        for (const job of this.processing.planAsyncJobs({
          mode: committed.boundTurn.mode,
          identity,
          response,
        })) coordinator.submit(job);
        const settlement = await coordinator.settle({ timeoutMs: this.asyncSettlementTimeoutMs });
        asyncJobs = settlement.jobs;
        if (settlement.status === 'pending') {
          tree.cancel(root, 'async_settlement_timeout');
          errorCode = 'async_settlement_timeout';
        }
      } else if (response.retentionIntent === 'NO_SAVE') {
        tree.cancelForNoSave(root, 'no_save');
      }

      if (!tree.accepts(root).accepted) {
        return this.interruptedResult(
          opaqueSessionHandle, active, committed.evidence.evidenceId, response, tts, asyncJobs,
        );
      }

      if (response.sessionControl !== 'CONTINUE' || response.policyStatePatch) {
        const current = this.sessions.getSession(session.sessionId);
        if (!current) throw new Error('session no longer exists');
        this.sessions.compareAndSwap({
          schemaVersion: 'trusted-session-cas-v0.1',
          sessionId: current.sessionId,
          expectedStateVersion: current.stateVersion,
          operationId: `turn-control:${identity.turnId}`,
          patch: { ...response.policyStatePatch,
            ...(response.sessionControl === 'CONTINUE' ? {}
              : { status: response.sessionControl === 'END' ? 'ENDED' as const : 'PAUSED' as const }) },
        });
      }

      if (tree.accepts(root).accepted) {
        const completed = tree.complete(root);
        if (!completed.completed) throw new Error('turn root has unsettled child work');
      }
      active.phase = errorCode ? 'ERROR' : 'COMPLETED';
      this.log(opaqueSessionHandle, identity.turnId, identity.generationId,
        errorCode ? 'turn_error' : 'turn_completed', errorCode);
      return {
        schemaVersion: 'orchestrated-turn-result-v0.1',
        status: errorCode ? 'error' : 'completed',
        phase: active.phase,
        opaqueSessionHandle,
        targetHandle,
        sessionEpoch: identity.sessionEpoch,
        turnId: identity.turnId,
        generationId: identity.generationId,
        evidenceId: committed.evidence.evidenceId,
        mode: committed.boundTurn.mode,
        response,
        tts,
        asyncJobs,
        errorCode,
        retentionEffect,
        canonicalWriteCount: 0,
      };
    } catch {
      tree.cancel(root, 'orchestrator_error');
      active.phase = 'ERROR';
      this.log(opaqueSessionHandle, identity.turnId, identity.generationId,
        'turn_error', 'orchestrator_error');
      return {
        schemaVersion: 'orchestrated-turn-result-v0.1',
        status: 'error', phase: 'ERROR', opaqueSessionHandle, targetHandle,
        sessionEpoch: identity.sessionEpoch, turnId: identity.turnId,
        generationId: identity.generationId, evidenceId: committed.evidence.evidenceId,
        mode: committed.boundTurn.mode, response, tts, asyncJobs,
        errorCode: 'orchestrator_error', retentionEffect, canonicalWriteCount: 0,
      };
    } finally {
      this.activeFinal.delete(opaqueSessionHandle);
      this.sessions.closeTurn(opened.handle);
    }
  }

  private interruptedResult(
    opaqueSessionHandle: string,
    active: ActiveFinal,
    evidenceId: string,
    response: TurnResponseResult | null = null,
    tts: TurnTtsResult = skippedTts(),
    asyncJobs: AsyncJobStatusRecord[] = [],
  ): TurnRunResult {
    active.phase = 'INTERRUPTED';
    this.log(opaqueSessionHandle, active.identity.turnId, active.identity.generationId,
      'turn_interrupted', null);
    return {
      schemaVersion: 'orchestrated-turn-result-v0.1',
      status: 'interrupted', phase: 'INTERRUPTED', opaqueSessionHandle,
      targetHandle: active.targetHandle, sessionEpoch: active.identity.sessionEpoch,
      turnId: active.identity.turnId, generationId: active.identity.generationId,
      evidenceId, mode: this.sessions.getSession(active.handle.sessionId)?.mode ?? 'DAILY_CHAT',
      response: response ?? responseCancelled(), tts, asyncJobs,
      errorCode: null, retentionEffect: null, canonicalWriteCount: 0,
    };
  }

  private async enterPhase(
    phase: TurnPhase,
    opaqueSessionHandle: string,
    active: ActiveFinal,
  ): Promise<void> {
    active.phase = phase;
    await this.phaseHook?.(phase, {
      opaqueSessionHandle,
      targetHandle: active.targetHandle,
      identity: structuredClone(active.identity),
    });
  }

  private requireBinding(opaqueSessionHandle: string): SessionBinding {
    assertNonEmptyString(opaqueSessionHandle, 'opaqueSessionHandle');
    const binding = this.sessionBindings.get(opaqueSessionHandle);
    if (!binding) throw new Error('unknown session handle');
    return binding;
  }

  private requireUsableSession(sessionId: string): GovernedSessionSnapshot {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error('unknown session');
    // Let a paused turn reach InterviewPolicy. The policy is the authority
    // that distinguishes an explicit continuation from an unrelated input;
    // the session store still blocks RECOVERING and ENDED sessions.
    if (session.status !== 'ACTIVE' && session.status !== 'PAUSED') {
      throw new Error(`session is ${session.status}`);
    }
    return session;
  }

  private log(
    opaqueSessionHandle: string,
    turnId: string | null,
    generationId: number | null,
    status: string,
    errorCode: string | null,
  ): void {
    this.audit.push({
      requestId: `request_${this.id()}`,
      opaqueSessionId: opaqueSessionHandle,
      turnId,
      generationId,
      module: 'orchestrator',
      status,
      errorCode,
      costCny: 0,
      version: 'v0.1',
    });
  }
}
