import { assertRuntimeIdentity } from './contracts.ts';
import type {
  CancellationCleanupStatus,
  RuntimeChannel,
  RuntimeIdentity,
} from './contracts.ts';

export type OutputRejectionReason =
  | 'no_active_generation'
  | 'generation_mismatch'
  | 'response_id_missing'
  | 'response_id_mismatch'
  | 'evidence_mismatch'
  | 'cancelled'
  | 'finalized';

export type OutputAcceptance =
  | { accepted: true }
  | { accepted: false; reason: OutputRejectionReason };

export interface GenerationExecutionLease {
  readonly identity: RuntimeIdentity;
  readonly channel: RuntimeChannel;
  readonly signal: AbortSignal;
  accepts(): OutputAcceptance;
  cancel(reason: string): boolean;
  finalize(): boolean;
}

/**
 * A branded, read-only view of an owner lease for a nested runtime. It carries
 * cancellation and acceptance state but cannot cancel or finalize the owner.
 */
export interface BorrowedGenerationExecutionPermit {
  readonly identity: RuntimeIdentity;
  readonly channel: RuntimeChannel;
  readonly signal: AbortSignal;
  accepts(): OutputAcceptance;
  cleanupStatus(): CancellationCleanupStatus | 'PENDING';
}

interface BorrowedExecutionState {
  phase: 'ISSUED' | 'ACTIVE' | 'SETTLED';
  cleanupStatus: CancellationCleanupStatus;
}

interface ActiveGeneration {
  identity: RuntimeIdentity;
  controller: AbortController;
  status: 'ACTIVE' | 'CANCELLED';
}

export interface GenerationCancellationState {
  schemaVersion: 'generation-cancellation-v0.1';
  active: Array<{ identity: RuntimeIdentity; channel: RuntimeChannel }>;
  finalizedInvocationKeys: string[];
}

function scopeKey(sessionEpoch: string, channel: RuntimeChannel): string {
  return JSON.stringify([sessionEpoch, channel]);
}

function invocationKey(identity: RuntimeIdentity, channel: RuntimeChannel): string {
  return JSON.stringify([
    identity.sessionEpoch,
    channel,
    identity.turnId,
    identity.generationId,
    identity.invocationId,
  ]);
}

function sameInvocation(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionEpoch === right.sessionEpoch
    && left.turnId === right.turnId
    && left.generationId === right.generationId
    && left.invocationId === right.invocationId;
}

function sameEvidence(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.evidenceRefs.length === right.evidenceRefs.length
    && left.evidenceRefs.every((value, index) => value === right.evidenceRefs[index]);
}

function sameExactIdentity(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return sameInvocation(left, right)
    && left.responseId === right.responseId
    && sameEvidence(left, right);
}

export class GenerationCancellationRegistry {
  private readonly activeByScope = new Map<string, ActiveGeneration>();
  private readonly finalizedInvocations = new Set<string>();
  private readonly finalizedOrder: string[] = [];
  private readonly issuedLeases = new WeakSet<object>();
  private readonly issuedBorrowedPermits = new WeakSet<object>();
  private readonly borrowedExecutionStates = new WeakMap<object, BorrowedExecutionState>();

  static restore(state: GenerationCancellationState): GenerationCancellationRegistry {
    if (state.schemaVersion !== 'generation-cancellation-v0.1') {
      throw new Error('unsupported cancellation registry state');
    }
    const registry = new GenerationCancellationRegistry();
    for (const key of state.finalizedInvocationKeys) registry.rememberFinalized(key);
    // A restarted process cannot prove that a prior provider task stopped. Mark
    // every previously active invocation finalized so late callbacks are denied.
    for (const item of state.active) {
      registry.rememberFinalized(invocationKey(item.identity, item.channel));
    }
    return registry;
  }

  exportState(): GenerationCancellationState {
    const active: GenerationCancellationState['active'] = [];
    for (const [key, value] of this.activeByScope.entries()) {
      const parsed = JSON.parse(key) as [string, RuntimeChannel];
      active.push({
        identity: { ...value.identity, evidenceRefs: [...value.identity.evidenceRefs] },
        channel: parsed[1],
      });
    }
    return {
      schemaVersion: 'generation-cancellation-v0.1',
      active,
      finalizedInvocationKeys: [...this.finalizedOrder],
    };
  }

  begin(identity: RuntimeIdentity, channel: RuntimeChannel): AbortSignal {
    assertRuntimeIdentity(identity);
    const invocation = invocationKey(identity, channel);
    if (this.finalizedInvocations.has(invocation)) {
      throw new Error('cannot restart a finalized invocationId');
    }
    const key = scopeKey(identity.sessionEpoch, channel);
    const previous = this.activeByScope.get(key);
    if (previous && sameInvocation(previous.identity, identity)) {
      throw new Error('the same invocationId is already active');
    }
    if (previous) {
      if (!previous.controller.signal.aborted) previous.controller.abort('superseded');
      this.rememberFinalized(invocationKey(previous.identity, channel));
    }

    const controller = new AbortController();
    this.activeByScope.set(key, {
      identity: { ...identity, evidenceRefs: [...identity.evidenceRefs] },
      controller,
      status: 'ACTIVE',
    });
    return controller.signal;
  }

  bindResponse(
    identity: RuntimeIdentity,
    channel: RuntimeChannel,
    responseId: string
  ): RuntimeIdentity {
    if (responseId.trim().length === 0) throw new Error('responseId must be a non-empty string');
    const active = this.activeByScope.get(scopeKey(identity.sessionEpoch, channel));
    assertRuntimeIdentity(identity);
    if (!active || !sameInvocation(active.identity, identity) || !sameEvidence(active.identity, identity)) {
      throw new Error('cannot bind a response to an inactive invocation');
    }
    if (active.status !== 'ACTIVE' || active.controller.signal.aborted) {
      throw new Error('cannot bind a response to a cancelled invocation');
    }
    if (active.identity.responseId && active.identity.responseId !== responseId) {
      throw new Error('cannot rebind an invocation to a different responseId');
    }

    active.identity = { ...active.identity, responseId };
    return { ...active.identity, evidenceRefs: [...active.identity.evidenceRefs] };
  }

  cancel(identity: RuntimeIdentity, channel: RuntimeChannel, reason: string): boolean {
    const active = this.activeByScope.get(scopeKey(identity.sessionEpoch, channel));
    if (!active || !sameExactIdentity(active.identity, identity)) return false;
    if (active.status === 'ACTIVE') {
      active.status = 'CANCELLED';
      if (!active.controller.signal.aborted) active.controller.abort(reason);
    }
    return true;
  }

  finalize(identity: RuntimeIdentity, channel: RuntimeChannel): boolean {
    const key = scopeKey(identity.sessionEpoch, channel);
    const active = this.activeByScope.get(key);
    if (!active || !sameExactIdentity(active.identity, identity)) return false;
    if (!active.controller.signal.aborted) active.controller.abort('finalized');
    this.activeByScope.delete(key);
    this.rememberFinalized(invocationKey(active.identity, channel));
    return true;
  }

  acquireLease(
    identity: RuntimeIdentity,
    channel: RuntimeChannel,
  ): GenerationExecutionLease | null {
    assertRuntimeIdentity(identity);
    const active = this.activeByScope.get(scopeKey(identity.sessionEpoch, channel));
    if (!active || !sameExactIdentity(active.identity, identity)) return null;
    const leasedIdentity: RuntimeIdentity = Object.freeze({
      ...active.identity,
      evidenceRefs: Object.freeze([...active.identity.evidenceRefs]),
    });
    const signal = active.controller.signal;
    const lease: GenerationExecutionLease = Object.freeze({
      identity: leasedIdentity,
      channel,
      signal,
      accepts: () => this.accepts(leasedIdentity, channel),
      cancel: (reason: string) => this.cancel(leasedIdentity, channel, reason),
      finalize: () => this.finalize(leasedIdentity, channel),
    });
    this.issuedLeases.add(lease);
    return lease;
  }

  borrowLease(
    lease: GenerationExecutionLease,
  ): BorrowedGenerationExecutionPermit | null {
    if (!lease || typeof lease !== 'object' || !this.issuedLeases.has(lease)) return null;
    const active = this.activeByScope.get(scopeKey(lease.identity.sessionEpoch, lease.channel));
    if (
      !active
      || !sameExactIdentity(active.identity, lease.identity)
      || active.controller.signal !== lease.signal
      || active.status !== 'ACTIVE'
      || active.controller.signal.aborted
    ) return null;

    const borrowedIdentity: RuntimeIdentity = Object.freeze({
      ...active.identity,
      evidenceRefs: Object.freeze([...active.identity.evidenceRefs]),
    });
    const state: BorrowedExecutionState = {
      phase: 'ISSUED',
      cleanupStatus: 'NOT_REQUIRED',
    };
    const permit: BorrowedGenerationExecutionPermit = Object.freeze({
      identity: borrowedIdentity,
      channel: lease.channel,
      signal: active.controller.signal,
      accepts: () => this.accepts(borrowedIdentity, lease.channel),
      cleanupStatus: () => state.phase === 'ACTIVE' ? 'PENDING' : state.cleanupStatus,
    });
    this.issuedBorrowedPermits.add(permit);
    this.borrowedExecutionStates.set(permit, state);
    return permit;
  }

  isBorrowedPermitCurrent(
    permit: BorrowedGenerationExecutionPermit,
    identity: RuntimeIdentity,
    channel: RuntimeChannel,
  ): boolean {
    if (!permit || typeof permit !== 'object' || !this.issuedBorrowedPermits.has(permit)) {
      return false;
    }
    if (permit.channel !== channel || !sameExactIdentity(permit.identity, identity)) return false;
    const active = this.activeByScope.get(scopeKey(identity.sessionEpoch, channel));
    return Boolean(
      active
      && sameExactIdentity(active.identity, identity)
      && active.controller.signal === permit.signal
      && active.status === 'ACTIVE'
      && !active.controller.signal.aborted,
    );
  }

  consumeBorrowedPermit(
    permit: BorrowedGenerationExecutionPermit,
    identity: RuntimeIdentity,
    channel: RuntimeChannel,
  ): boolean {
    if (!this.isBorrowedPermitCurrent(permit, identity, channel)) return false;
    const state = this.borrowedExecutionStates.get(permit);
    if (!state || state.phase !== 'ISSUED') return false;
    state.phase = 'ACTIVE';
    this.issuedBorrowedPermits.delete(permit);
    return true;
  }

  completeBorrowedPermit(
    permit: BorrowedGenerationExecutionPermit,
    cleanupStatus: CancellationCleanupStatus,
  ): boolean {
    const state = this.borrowedExecutionStates.get(permit);
    if (!state || state.phase !== 'ACTIVE') return false;
    state.phase = 'SETTLED';
    state.cleanupStatus = cleanupStatus;
    return true;
  }

  cancelSession(sessionEpoch: string, reason: string): number {
    let cancelled = 0;
    for (const active of this.activeByScope.values()) {
      if (active.identity.sessionEpoch !== sessionEpoch || active.status !== 'ACTIVE') continue;
      active.status = 'CANCELLED';
      active.controller.abort(reason);
      cancelled += 1;
    }
    return cancelled;
  }

  finalizeSession(sessionEpoch: string): number {
    let finalized = 0;
    for (const [key, active] of [...this.activeByScope.entries()]) {
      if (active.identity.sessionEpoch !== sessionEpoch) continue;
      if (!active.controller.signal.aborted) active.controller.abort('session_finalized');
      this.activeByScope.delete(key);
      const parsed = JSON.parse(key) as [string, RuntimeChannel];
      this.rememberFinalized(invocationKey(active.identity, parsed[1]));
      finalized += 1;
    }
    return finalized;
  }

  accepts(identity: RuntimeIdentity, channel: RuntimeChannel): OutputAcceptance {
    const invocation = invocationKey(identity, channel);
    const active = this.activeByScope.get(scopeKey(identity.sessionEpoch, channel));
    if (!active) {
      return this.finalizedInvocations.has(invocation)
        ? { accepted: false, reason: 'finalized' }
        : { accepted: false, reason: 'no_active_generation' };
    }
    if (!sameInvocation(active.identity, identity)) {
      return { accepted: false, reason: 'generation_mismatch' };
    }
    if (active.status === 'CANCELLED' || active.controller.signal.aborted) {
      return { accepted: false, reason: 'cancelled' };
    }
    if (!sameEvidence(active.identity, identity)) {
      return { accepted: false, reason: 'evidence_mismatch' };
    }
    if (active.identity.responseId && !identity.responseId) {
      return { accepted: false, reason: 'response_id_missing' };
    }
    if (active.identity.responseId !== identity.responseId) {
      return { accepted: false, reason: 'response_id_mismatch' };
    }
    return { accepted: true };
  }

  private rememberFinalized(key: string): void {
    if (this.finalizedInvocations.has(key)) return;
    this.finalizedInvocations.add(key);
    this.finalizedOrder.push(key);
  }
}
