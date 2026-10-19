import type { RuntimeIdentity } from '../algorithm-runtime/contracts.ts';
import {
  type GenerationLeaseTree,
  type LeaseAcceptance,
  type OwnedGenerationLeaseHandle,
} from '../algorithm-runtime/lease-tree.ts';

export type AsyncJobKind = 'MEMORY' | 'STORY' | 'PROFILE';
export type AsyncJobStatus = 'pending' | 'running' | 'success' | 'failed' | 'cancelled';

export interface AsyncJobRequest {
  jobId: string;
  kind: AsyncJobKind;
  /** Opaque reference resolved by the injected runner; never raw user content. */
  inputRef: string;
  /** Stable opaque fingerprint used only for idempotency conflict detection. */
  payloadFingerprint: string;
  evidenceRefs: readonly string[];
}

export interface AsyncJobRunContext {
  jobId: string;
  kind: AsyncJobKind;
  inputRef: string;
  identity: RuntimeIdentity;
  signal: AbortSignal;
}

export type AsyncJobRunResult =
  | { ok: true; resultId: string; value: unknown }
  | { ok: false; errorCode: string };

export interface AsyncJobCommitContext extends AsyncJobRunContext {
  resultId: string;
  value: unknown;
  /**
   * Durable adapters must call this inside the same transaction that performs
   * the write. Returning COMMITTED without calling it is a contract failure.
   */
  canCommit(): LeaseAcceptance;
}

export type AsyncJobCommitAck = 'COMMITTED' | 'DROPPED';

export interface AsyncJobAdapter {
  run(context: AsyncJobRunContext): Promise<AsyncJobRunResult>;
  commit(context: AsyncJobCommitContext): Promise<AsyncJobCommitAck>;
}

export interface AsyncJobStatusRecord {
  jobId: string;
  kind: AsyncJobKind;
  inputRef: string;
  leaseId: string;
  groupLeaseId: string;
  status: AsyncJobStatus;
  resultId: string | null;
  errorCode: string | null;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface AsyncJobSettlement {
  status: 'settled' | 'pending';
  pendingJobIds: string[];
  jobs: AsyncJobStatusRecord[];
}

export interface TurnAsyncJobCoordinatorOptions {
  coordinatorId: string;
  tree: GenerationLeaseTree;
  turnRoot: OwnedGenerationLeaseHandle;
  adapters: Readonly<Record<AsyncJobKind, AsyncJobAdapter>>;
  now?: () => string;
}

export interface TurnAsyncJobCoordinator {
  submit(request: AsyncJobRequest): AsyncJobStatusRecord;
  get(jobId: string): AsyncJobStatusRecord | null;
  list(): AsyncJobStatusRecord[];
  applyNoSave(reason?: string): string[];
  settle(options: { timeoutMs: number }): Promise<AsyncJobSettlement>;
}

interface NormalizedRequest {
  jobId: string;
  kind: AsyncJobKind;
  inputRef: string;
  payloadFingerprint: string;
  evidenceRefs: string[];
}

interface JobEntry {
  request: NormalizedRequest;
  requestKey: string;
  lease: OwnedGenerationLeaseHandle;
  status: AsyncJobStatusRecord;
  completion: Promise<void>;
}

type AsyncOutcome<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error' }
  | { kind: 'aborted' };

const JOB_KINDS = new Set<AsyncJobKind>(['MEMORY', 'STORY', 'PROFILE']);
const TERMINAL_STATUSES = new Set<AsyncJobStatus>(['success', 'failed', 'cancelled']);
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertTimeout(value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 60_000) {
    throw new TypeError('timeoutMs must be an integer from 0 through 60000');
  }
}

function normalizeErrorCode(value: unknown, fallback: string): string {
  return typeof value === 'string' && ERROR_CODE_PATTERN.test(value) ? value : fallback;
}

function cloneIdentity(identity: RuntimeIdentity, invocationId: string, evidenceRefs: readonly string[]): RuntimeIdentity {
  return {
    ...identity,
    invocationId,
    responseId: undefined,
    evidenceRefs: [...evidenceRefs],
  };
}

function normalizeRequest(request: AsyncJobRequest): NormalizedRequest {
  if (!request || typeof request !== 'object') throw new TypeError('request is required');
  assertNonEmpty(request.jobId, 'jobId');
  if (!JOB_KINDS.has(request.kind)) throw new TypeError('kind must be MEMORY, STORY, or PROFILE');
  assertNonEmpty(request.inputRef, 'inputRef');
  assertNonEmpty(request.payloadFingerprint, 'payloadFingerprint');
  if (!Array.isArray(request.evidenceRefs)) throw new TypeError('evidenceRefs must be an array');
  const evidenceRefs = [...new Set(request.evidenceRefs.map((value, index) => {
    assertNonEmpty(value, `evidenceRefs[${index}]`);
    return value;
  }))].sort();
  if (evidenceRefs.length === 0) throw new TypeError('evidenceRefs must not be empty');
  return {
    jobId: request.jobId,
    kind: request.kind,
    inputRef: request.inputRef,
    payloadFingerprint: request.payloadFingerprint,
    evidenceRefs,
  };
}

function requestKey(request: NormalizedRequest): string {
  return JSON.stringify([
    request.kind,
    request.inputRef,
    request.payloadFingerprint,
    request.evidenceRefs,
  ]);
}

function isRunResult(value: unknown): value is AsyncJobRunResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  if (result.ok === true) {
    return typeof result.resultId === 'string' && result.resultId.trim().length > 0
      && Object.prototype.hasOwnProperty.call(result, 'value');
  }
  return result.ok === false && typeof result.errorCode === 'string';
}

function isTerminal(status: AsyncJobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function cloneStatus(status: AsyncJobStatusRecord): AsyncJobStatusRecord {
  return { ...status };
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<AsyncOutcome<T>> {
  if (signal.aborted) return { kind: 'aborted' };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<AsyncOutcome<T>>(resolve => {
    onAbort = () => resolve({ kind: 'aborted' });
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const settled = promise.then<AsyncOutcome<T>, AsyncOutcome<T>>(
    value => ({ kind: 'value', value }),
    () => ({ kind: 'error' }),
  );
  try {
    return await Promise.race([settled, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

class DefaultTurnAsyncJobCoordinator implements TurnAsyncJobCoordinator {
  private readonly coordinatorId: string;
  private readonly tree: GenerationLeaseTree;
  private readonly turnRoot: OwnedGenerationLeaseHandle;
  private readonly adapters: Readonly<Record<AsyncJobKind, AsyncJobAdapter>>;
  private readonly now: () => string;
  private readonly jobs = new Map<string, JobEntry>();
  private retentionGroup: OwnedGenerationLeaseHandle | null = null;
  private artifactGroup: OwnedGenerationLeaseHandle | null = null;
  private closed = false;

  constructor(options: TurnAsyncJobCoordinatorOptions) {
    assertNonEmpty(options?.coordinatorId, 'coordinatorId');
    if (!options.tree) throw new TypeError('tree is required');
    if (!options.turnRoot || options.turnRoot.taskKind !== 'TURN_ROOT') {
      throw new TypeError('turnRoot must be a TURN_ROOT owner lease');
    }
    if (!options.tree.accepts(options.turnRoot).accepted) {
      throw new Error('turnRoot must be an active issued owner lease');
    }
    for (const kind of JOB_KINDS) {
      const adapter = options.adapters?.[kind];
      if (!adapter || typeof adapter.run !== 'function' || typeof adapter.commit !== 'function') {
        throw new TypeError(`adapters.${kind} requires run and commit callbacks`);
      }
    }
    this.coordinatorId = options.coordinatorId;
    this.tree = options.tree;
    this.turnRoot = options.turnRoot;
    this.adapters = options.adapters;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  submit(rawRequest: AsyncJobRequest): AsyncJobStatusRecord {
    const request = normalizeRequest(rawRequest);
    const fingerprint = requestKey(request);
    const existing = this.jobs.get(request.jobId);
    if (existing) {
      if (existing.requestKey !== fingerprint) {
        throw new Error(`jobId ${request.jobId} was reused with a conflicting payload`);
      }
      return cloneStatus(existing.status);
    }
    if (this.closed) throw new Error('async job coordinator is closed');
    if (!this.tree.accepts(this.turnRoot).accepted) {
      throw new Error('turn root is no longer active');
    }

    const group = this.groupFor(request.kind);
    const lease = this.tree.spawnChild(group, {
      taskId: `async:${this.coordinatorId}:job:${encodeURIComponent(request.jobId)}`,
      taskKind: request.kind === 'MEMORY'
        ? 'MEMORY_CANDIDATE'
        : request.kind === 'STORY' ? 'STORY_DRAFT' : 'PROFILE_DRAFT',
      channel: request.kind === 'MEMORY'
        ? 'memory'
        : request.kind === 'STORY' ? 'story_draft' : 'profile_draft',
      identity: cloneIdentity(
        this.turnRoot.identity,
        `${this.turnRoot.identity.invocationId}:async:${encodeURIComponent(request.jobId)}`,
        request.evidenceRefs,
      ),
    });
    const status: AsyncJobStatusRecord = {
      jobId: request.jobId,
      kind: request.kind,
      inputRef: request.inputRef,
      leaseId: lease.leaseId,
      groupLeaseId: group.leaseId,
      status: 'pending',
      resultId: null,
      errorCode: null,
      queuedAt: this.stamp(),
      startedAt: null,
      completedAt: null,
    };
    const entry: JobEntry = {
      request,
      requestKey: fingerprint,
      lease,
      status,
      completion: Promise.resolve(),
    };
    this.jobs.set(request.jobId, entry);
    entry.completion = Promise.resolve()
      .then(() => this.execute(entry))
      .catch(() => this.failUnexpected(entry));
    return cloneStatus(status);
  }

  get(jobId: string): AsyncJobStatusRecord | null {
    const entry = this.jobs.get(jobId);
    return entry ? cloneStatus(entry.status) : null;
  }

  list(): AsyncJobStatusRecord[] {
    return [...this.jobs.values()]
      .sort((left, right) => left.status.jobId.localeCompare(right.status.jobId))
      .map(entry => cloneStatus(entry.status));
  }

  applyNoSave(reason = 'no_save'): string[] {
    assertNonEmpty(reason, 'reason');
    this.closed = true;
    const cancelled = this.tree.cancelForNoSave(this.turnRoot, reason);
    this.tryFinalizeGroups();
    return cancelled;
  }

  async settle(options: { timeoutMs: number }): Promise<AsyncJobSettlement> {
    assertTimeout(options?.timeoutMs);
    this.closed = true;
    const pendingPromises = [...this.jobs.values()]
      .filter(entry => !isTerminal(entry.status.status))
      .map(entry => entry.completion);

    if (pendingPromises.length > 0 && options.timeoutMs > 0) {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(pendingPromises),
          new Promise<void>(resolve => {
            timeout = setTimeout(resolve, options.timeoutMs);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    }
    this.tryFinalizeGroups();
    const pendingJobIds = this.list()
      .filter(item => !isTerminal(item.status))
      .map(item => item.jobId);
    return {
      status: pendingJobIds.length === 0 ? 'settled' : 'pending',
      pendingJobIds,
      jobs: this.list(),
    };
  }

  private groupFor(kind: AsyncJobKind): OwnedGenerationLeaseHandle {
    if (kind === 'MEMORY') {
      if (!this.retentionGroup) {
        this.retentionGroup = this.tree.spawnChild(this.turnRoot, {
          taskId: `async:${this.coordinatorId}:retention`,
          taskKind: 'RETENTION',
          channel: 'orchestrator',
          identity: cloneIdentity(
            this.turnRoot.identity,
            `${this.turnRoot.identity.invocationId}:async:retention`,
            this.turnRoot.identity.evidenceRefs,
          ),
        });
      }
      return this.retentionGroup;
    }
    if (!this.artifactGroup) {
      this.artifactGroup = this.tree.spawnChild(this.turnRoot, {
        taskId: `async:${this.coordinatorId}:artifact`,
        taskKind: 'ARTIFACT',
        channel: 'orchestrator',
        identity: cloneIdentity(
          this.turnRoot.identity,
          `${this.turnRoot.identity.invocationId}:async:artifact`,
          this.turnRoot.identity.evidenceRefs,
        ),
      });
    }
    return this.artifactGroup;
  }

  private async execute(entry: JobEntry): Promise<void> {
    if (!this.tree.canCommit(entry.lease).accepted) {
      this.markCancelled(entry);
      this.tryFinalizeGroups();
      return;
    }
    entry.status.status = 'running';
    entry.status.startedAt = this.stamp();
    const adapter = this.adapters[entry.request.kind];
    const runContext: AsyncJobRunContext = {
      jobId: entry.request.jobId,
      kind: entry.request.kind,
      inputRef: entry.request.inputRef,
      identity: entry.lease.identity,
      signal: entry.lease.signal,
    };
    const runOutcome = await raceWithAbort(
      Promise.resolve().then(() => adapter.run(runContext)),
      entry.lease.signal,
    );
    if (runOutcome.kind === 'aborted') {
      this.markCancelled(entry);
      this.tryFinalizeGroups();
      return;
    }
    if (runOutcome.kind === 'error') {
      this.failOrCancel(entry, 'runner_failed');
      this.tryFinalizeGroups();
      return;
    }
    if (!isRunResult(runOutcome.value)) {
      this.failOrCancel(entry, 'invalid_run_result');
      this.tryFinalizeGroups();
      return;
    }
    if (!runOutcome.value.ok) {
      this.failOrCancel(entry, normalizeErrorCode(runOutcome.value.errorCode, 'runner_failed'));
      this.tryFinalizeGroups();
      return;
    }
    if (!this.tree.canCommit(entry.lease).accepted) {
      this.markCancelled(entry);
      this.tryFinalizeGroups();
      return;
    }

    let commitGateChecks = 0;
    const commitContext: AsyncJobCommitContext = {
      ...runContext,
      resultId: runOutcome.value.resultId,
      value: runOutcome.value.value,
      canCommit: () => {
        commitGateChecks += 1;
        return this.tree.canCommit(entry.lease);
      },
    };
    // Once a commit callback has started, cancellation cannot prove that the
    // external write did not happen. Wait for its explicit acknowledgement;
    // the public settle() remains bounded and reports this job as pending.
    const commitOutcome = await Promise.resolve()
      .then(() => adapter.commit(commitContext))
      .then<AsyncOutcome<AsyncJobCommitAck>, AsyncOutcome<AsyncJobCommitAck>>(
        value => ({ kind: 'value', value }),
        () => ({ kind: 'error' }),
      );
    const postCommitAcceptance = this.tree.canCommit(entry.lease);
    if (commitOutcome.kind === 'error') {
      if (!postCommitAcceptance.accepted) {
        this.markHardFailure(entry, 'commit_outcome_unknown_after_cancel');
      } else {
        this.failOrCancel(entry, 'commit_failed');
      }
      this.tryFinalizeGroups();
      return;
    }
    if (commitOutcome.kind === 'aborted') {
      // This branch is unreachable for commit, but retaining the exhaustive
      // check prevents a future helper refactor from silently treating an
      // unknown commit outcome as a safe cancellation.
      this.markHardFailure(entry, 'commit_outcome_unknown_after_cancel');
      this.tryFinalizeGroups();
      return;
    }
    if (commitOutcome.value !== 'COMMITTED' && commitOutcome.value !== 'DROPPED') {
      this.markHardFailure(entry, 'invalid_commit_ack');
      this.tryFinalizeGroups();
      return;
    }
    if (commitOutcome.value === 'COMMITTED' && !postCommitAcceptance.accepted) {
      this.markHardFailure(entry, 'late_commit_after_cancel');
      this.tryFinalizeGroups();
      return;
    }
    if (commitGateChecks === 0) {
      this.markHardFailure(entry, 'commit_gate_not_checked');
      this.tryFinalizeGroups();
      return;
    }
    if (commitOutcome.value === 'DROPPED') {
      if (!postCommitAcceptance.accepted) this.markCancelled(entry);
      else this.failOrCancel(entry, 'commit_dropped');
      this.tryFinalizeGroups();
      return;
    }
    if (!postCommitAcceptance.accepted) {
      this.markHardFailure(entry, 'late_commit_after_cancel');
      this.tryFinalizeGroups();
      return;
    }

    const completion = this.tree.complete(entry.lease);
    if (!completion.completed) {
      this.markCancelled(entry);
      this.tryFinalizeGroups();
      return;
    }
    entry.status.status = 'success';
    entry.status.resultId = runOutcome.value.resultId;
    entry.status.errorCode = null;
    entry.status.completedAt = this.stamp();
    this.tryFinalizeGroups();
  }

  private failOrCancel(entry: JobEntry, errorCode: string): void {
    if (!this.tree.canCommit(entry.lease).accepted) {
      this.markCancelled(entry);
      return;
    }
    const completion = this.tree.complete(entry.lease);
    if (!completion.completed) {
      this.markCancelled(entry);
      return;
    }
    entry.status.status = 'failed';
    entry.status.resultId = null;
    entry.status.errorCode = normalizeErrorCode(errorCode, 'unknown');
    entry.status.completedAt = this.stamp();
  }

  private failUnexpected(entry: JobEntry): void {
    if (isTerminal(entry.status.status)) return;
    this.failOrCancel(entry, 'unknown');
    this.tryFinalizeGroups();
  }

  private markHardFailure(entry: JobEntry, errorCode: string): void {
    if (entry.status.status === 'success') return;
    if (this.tree.canCommit(entry.lease).accepted) this.tree.complete(entry.lease);
    entry.status.status = 'failed';
    entry.status.resultId = null;
    entry.status.errorCode = normalizeErrorCode(errorCode, 'unknown');
    entry.status.completedAt = this.stamp();
  }

  private markCancelled(entry: JobEntry): void {
    if (isTerminal(entry.status.status)) return;
    entry.status.status = 'cancelled';
    entry.status.resultId = null;
    entry.status.errorCode = 'cancelled';
    entry.status.completedAt = this.stamp();
  }

  private tryFinalizeGroups(): void {
    if (!this.closed || [...this.jobs.values()].some(entry => !isTerminal(entry.status.status))) return;
    for (const group of [this.retentionGroup, this.artifactGroup]) {
      if (group && this.tree.accepts(group).accepted) this.tree.complete(group);
    }
  }

  private stamp(): string {
    const value = this.now();
    assertNonEmpty(value, 'now() result');
    return value;
  }
}

export function createTurnAsyncJobCoordinator(
  options: TurnAsyncJobCoordinatorOptions,
): TurnAsyncJobCoordinator {
  return new DefaultTurnAsyncJobCoordinator(options);
}
