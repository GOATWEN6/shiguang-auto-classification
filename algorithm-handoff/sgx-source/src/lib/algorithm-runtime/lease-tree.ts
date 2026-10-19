import { assertRuntimeIdentity } from './contracts.ts';
import type { RuntimeChannel, RuntimeIdentity } from './contracts.ts';

export type LeaseTaskKind =
  | 'SESSION_ROOT'
  | 'TURN_ROOT'
  | 'RESPONSE'
  | 'TTS'
  | 'RETENTION'
  | 'MEMORY_CANDIDATE'
  | 'ARTIFACT'
  | 'STORY_DRAFT'
  | 'PROFILE_DRAFT'
  | 'PROVIDER_OPERATION';

export type LeaseTerminalStatus = 'COMPLETED' | 'CANCELLED';

export type LeaseRejectionReason =
  | 'invalid_handle'
  | 'unknown_lease'
  | 'restored_invalidated'
  | 'completed'
  | 'cancelled'
  | 'ancestor_not_active'
  | 'borrow_released'
  | 'attempt_completed';

export type LeaseAcceptance =
  | { accepted: true }
  | { accepted: false; reason: LeaseRejectionReason };

export interface LeaseTreeOptions {
  /** Stable namespace used only to make opaque lease identifiers collision-safe. */
  treeId: string;
}

export interface RootLeaseSpec {
  taskId: string;
  taskKind: Extract<LeaseTaskKind, 'SESSION_ROOT' | 'TURN_ROOT'>;
  channel: RuntimeChannel;
  identity: RuntimeIdentity;
}

export interface ChildLeaseSpec {
  taskId: string;
  taskKind: Exclude<LeaseTaskKind, 'SESSION_ROOT' | 'TURN_ROOT'>;
  channel: RuntimeChannel;
  identity: RuntimeIdentity;
}

export interface OwnedGenerationLeaseHandle {
  readonly kind: 'OWNED_GENERATION_LEASE';
  readonly leaseId: string;
  readonly parentLeaseId: string | null;
  readonly taskId: string;
  readonly taskKind: LeaseTaskKind;
  readonly channel: RuntimeChannel;
  readonly identity: RuntimeIdentity;
  readonly signal: AbortSignal;
  accepts(): LeaseAcceptance;
}

export interface BorrowedGenerationLeasePermit {
  readonly kind: 'BORROWED_GENERATION_LEASE';
  readonly borrowId: string;
  readonly ownerLeaseId: string;
  readonly purpose: string;
  readonly channel: RuntimeChannel;
  readonly identity: RuntimeIdentity;
  readonly signal: AbortSignal;
  accepts(): LeaseAcceptance;
}

export interface RetryAttemptHandle {
  readonly kind: 'RETRY_ATTEMPT';
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly operationLeaseId: string;
  readonly identity: RuntimeIdentity;
  readonly signal: AbortSignal;
  accepts(): LeaseAcceptance;
}

export interface RetryAttemptSpec {
  attemptId: string;
  attemptIndex: number;
}

export type LeaseCompletionResult =
  | { completed: true }
  | {
      completed: false;
      reason:
        | 'invalid_handle'
        | 'not_active'
        | 'ancestor_not_active'
        | 'active_children'
        | 'active_borrows'
        | 'active_attempts';
      blockingLeaseIds?: string[];
      blockingBorrowIds?: string[];
      blockingAttemptIds?: string[];
    };

export type LeaseCancellationResult =
  | { cancelled: true; cancelledLeaseIds: string[] }
  | { cancelled: false; cancelledLeaseIds: [] };

interface SerializedLeaseNode {
  leaseId: string;
  parentLeaseId: string | null;
  taskId: string;
  taskKind: LeaseTaskKind;
  channel: RuntimeChannel;
  identity: RuntimeIdentity;
  status: 'ACTIVE' | LeaseTerminalStatus;
}

interface SerializedRetryAttempt {
  attemptId: string;
  attemptIndex: number;
  operationLeaseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

export interface GenerationLeaseTreeState {
  schemaVersion: 'generation-lease-tree-v0.1';
  treeId: string;
  nextLeaseSequence: number;
  nextBorrowSequence: number;
  nodes: SerializedLeaseNode[];
  attempts: SerializedRetryAttempt[];
  invalidatedLeaseIds: string[];
  usedTaskIds: string[];
  usedAttemptIds: string[];
}

interface LeaseNode {
  leaseId: string;
  parentLeaseId: string | null;
  taskId: string;
  taskKind: LeaseTaskKind;
  channel: RuntimeChannel;
  identity: RuntimeIdentity;
  controller: AbortController;
  status: 'ACTIVE' | LeaseTerminalStatus;
  children: Set<string>;
  activeBorrowIds: Set<string>;
  activeAttemptIds: Set<string>;
  lastAttemptIndex: number;
}

interface BorrowState {
  borrowId: string;
  ownerLeaseId: string;
  status: 'ACTIVE' | 'RELEASED' | 'CANCELLED';
}

interface AttemptState {
  attemptId: string;
  attemptIndex: number;
  operationLeaseId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
}

const ROOT_TASK_KINDS = new Set<LeaseTaskKind>(['SESSION_ROOT', 'TURN_ROOT']);
const CHILD_TASK_KINDS = new Set<LeaseTaskKind>([
  'RESPONSE',
  'TTS',
  'RETENTION',
  'MEMORY_CANDIDATE',
  'ARTIFACT',
  'STORY_DRAFT',
  'PROFILE_DRAFT',
  'PROVIDER_OPERATION',
]);
const NO_SAVE_TASK_KINDS = new Set<LeaseTaskKind>([
  'RETENTION',
  'MEMORY_CANDIDATE',
  'ARTIFACT',
  'STORY_DRAFT',
  'PROFILE_DRAFT',
]);

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new TypeError(`${field} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
}

function cloneIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  assertRuntimeIdentity(identity);
  return Object.freeze({
    ...identity,
    evidenceRefs: Object.freeze([...identity.evidenceRefs]),
  });
}

function cloneSerializedIdentity(identity: RuntimeIdentity): RuntimeIdentity {
  return { ...identity, evidenceRefs: [...identity.evidenceRefs] };
}

function sameTurnScope(parent: RuntimeIdentity, child: RuntimeIdentity): boolean {
  return parent.sessionEpoch === child.sessionEpoch
    && parent.turnId === child.turnId
    && parent.generationId === child.generationId;
}

function evidenceIsSubset(parent: RuntimeIdentity, child: RuntimeIdentity): boolean {
  const allowed = new Set(parent.evidenceRefs);
  return child.evidenceRefs.every(ref => allowed.has(ref));
}

function terminalReason(status: LeaseNode['status']): Extract<LeaseRejectionReason, 'completed' | 'cancelled'> {
  return status === 'COMPLETED' ? 'completed' : 'cancelled';
}

function validateTaskKind(value: unknown, allowed: ReadonlySet<LeaseTaskKind>, field: string): void {
  if (typeof value !== 'string' || !allowed.has(value as LeaseTaskKind)) {
    throw new TypeError(`${field} is not allowed here`);
  }
}

/**
 * Capability-based ownership tree for one local runtime process.
 *
 * Handles are opaque capabilities: mutation APIs accept only the exact object
 * issued by this instance. A copied object can carry data but no authority.
 */
export class GenerationLeaseTree {
  private readonly treeId: string;
  private nextLeaseSequence = 0;
  private nextBorrowSequence = 0;
  private readonly nodes = new Map<string, LeaseNode>();
  private readonly invalidatedLeaseIds = new Set<string>();
  private readonly usedTaskIds = new Set<string>();
  private readonly usedAttemptIds = new Set<string>();
  private readonly borrowStates = new Map<string, BorrowState>();
  private readonly attemptStates = new Map<string, AttemptState>();
  private readonly ownerNodes = new WeakMap<object, LeaseNode>();
  private readonly borrowHandles = new WeakMap<object, BorrowState>();
  private readonly attemptHandles = new WeakMap<object, AttemptState>();

  constructor(options: LeaseTreeOptions) {
    assertNonEmpty(options?.treeId, 'treeId');
    this.treeId = options.treeId;
  }

  static restore(state: GenerationLeaseTreeState): GenerationLeaseTree {
    GenerationLeaseTree.assertSnapshot(state);
    const tree = new GenerationLeaseTree({ treeId: state.treeId });
    tree.nextLeaseSequence = state.nextLeaseSequence;
    tree.nextBorrowSequence = state.nextBorrowSequence;

    for (const leaseId of state.invalidatedLeaseIds) tree.invalidatedLeaseIds.add(leaseId);
    for (const node of state.nodes) tree.invalidatedLeaseIds.add(node.leaseId);
    for (const taskId of state.usedTaskIds) tree.usedTaskIds.add(taskId);
    for (const node of state.nodes) tree.usedTaskIds.add(node.taskId);
    for (const attemptId of state.usedAttemptIds) tree.usedAttemptIds.add(attemptId);
    for (const attempt of state.attempts) tree.usedAttemptIds.add(attempt.attemptId);
    return tree;
  }

  startRoot(spec: RootLeaseSpec): OwnedGenerationLeaseHandle {
    validateTaskKind(spec?.taskKind, ROOT_TASK_KINDS, 'root taskKind');
    return this.createNode(null, spec);
  }

  spawnChild(
    parentHandle: OwnedGenerationLeaseHandle,
    spec: ChildLeaseSpec,
  ): OwnedGenerationLeaseHandle {
    const parent = this.ownerNodes.get(parentHandle as object);
    if (!parent) throw new Error('spawnChild requires an issued owner lease');
    if (!this.nodeAndAncestorsActive(parent)) {
      throw new Error('spawnChild requires an active parent lease');
    }
    validateTaskKind(spec?.taskKind, CHILD_TASK_KINDS, 'child taskKind');
    const childIdentity = cloneIdentity(spec.identity);
    if (!sameTurnScope(parent.identity, childIdentity)) {
      throw new Error('child must remain in the parent session, turn, and generation');
    }
    if (!evidenceIsSubset(parent.identity, childIdentity)) {
      throw new Error('child identity evidenceRefs must be a subset of parent evidenceRefs');
    }
    return this.createNode(parent, { ...spec, identity: childIdentity });
  }

  borrow(
    ownerHandle: OwnedGenerationLeaseHandle,
    purpose: string,
  ): BorrowedGenerationLeasePermit {
    const owner = this.requireActiveOwner(ownerHandle, 'borrow');
    assertNonEmpty(purpose, 'purpose');
    const borrowId = this.nextOpaqueId('borrow', ++this.nextBorrowSequence);
    const state: BorrowState = {
      borrowId,
      ownerLeaseId: owner.leaseId,
      status: 'ACTIVE',
    };
    this.borrowStates.set(borrowId, state);
    owner.activeBorrowIds.add(borrowId);

    let handle!: BorrowedGenerationLeasePermit;
    handle = Object.freeze({
      kind: 'BORROWED_GENERATION_LEASE' as const,
      borrowId,
      ownerLeaseId: owner.leaseId,
      purpose,
      channel: owner.channel,
      identity: owner.identity,
      signal: owner.controller.signal,
      accepts: (): LeaseAcceptance => this.accepts(handle),
    });
    this.borrowHandles.set(handle, state);
    return handle;
  }

  releaseBorrow(permit: BorrowedGenerationLeasePermit): boolean {
    const state = this.borrowHandles.get(permit as object);
    if (!state) return false;
    if (state.status === 'ACTIVE') {
      state.status = 'RELEASED';
      this.nodes.get(state.ownerLeaseId)?.activeBorrowIds.delete(state.borrowId);
    }
    return true;
  }

  beginRetryAttempt(
    operationHandle: OwnedGenerationLeaseHandle,
    spec: RetryAttemptSpec,
  ): RetryAttemptHandle {
    const operation = this.requireActiveOwner(operationHandle, 'beginRetryAttempt');
    if (operation.taskKind !== 'PROVIDER_OPERATION') {
      throw new Error('retry attempts require an active provider operation child');
    }
    assertNonEmpty(spec?.attemptId, 'attemptId');
    assertPositiveInteger(spec?.attemptIndex, 'attemptIndex');
    if (this.usedAttemptIds.has(spec.attemptId)) throw new Error('attemptId was already used');
    if (operation.activeAttemptIds.size > 0) throw new Error('provider operation already has an active retry attempt');
    if (spec.attemptIndex !== operation.lastAttemptIndex + 1) {
      throw new Error('attemptIndex must increase sequentially within its provider operation');
    }

    const state: AttemptState = {
      attemptId: spec.attemptId,
      attemptIndex: spec.attemptIndex,
      operationLeaseId: operation.leaseId,
      status: 'ACTIVE',
    };
    this.usedAttemptIds.add(spec.attemptId);
    this.attemptStates.set(spec.attemptId, state);
    operation.activeAttemptIds.add(spec.attemptId);
    operation.lastAttemptIndex = spec.attemptIndex;

    let handle!: RetryAttemptHandle;
    handle = Object.freeze({
      kind: 'RETRY_ATTEMPT' as const,
      attemptId: spec.attemptId,
      attemptIndex: spec.attemptIndex,
      operationLeaseId: operation.leaseId,
      identity: operation.identity,
      signal: operation.controller.signal,
      accepts: (): LeaseAcceptance => this.accepts(handle),
    });
    this.attemptHandles.set(handle, state);
    return handle;
  }

  completeRetryAttempt(attemptHandle: RetryAttemptHandle): boolean {
    const state = this.attemptHandles.get(attemptHandle as object);
    if (!state) return false;
    if (state.status === 'COMPLETED') return true;
    if (state.status !== 'ACTIVE') return false;
    state.status = 'COMPLETED';
    this.nodes.get(state.operationLeaseId)?.activeAttemptIds.delete(state.attemptId);
    return true;
  }

  complete(ownerHandle: OwnedGenerationLeaseHandle): LeaseCompletionResult {
    const node = this.ownerNodes.get(ownerHandle as object);
    if (!node) return { completed: false, reason: 'invalid_handle' };
    if (node.status !== 'ACTIVE') return { completed: false, reason: 'not_active' };
    if (!this.ancestorsActive(node)) return { completed: false, reason: 'ancestor_not_active' };

    const activeChildren = [...node.children]
      .filter(leaseId => this.nodes.get(leaseId)?.status === 'ACTIVE')
      .sort();
    if (activeChildren.length > 0) {
      return { completed: false, reason: 'active_children', blockingLeaseIds: activeChildren };
    }
    const activeBorrows = [...node.activeBorrowIds]
      .filter(borrowId => this.borrowStates.get(borrowId)?.status === 'ACTIVE')
      .sort();
    if (activeBorrows.length > 0) {
      return { completed: false, reason: 'active_borrows', blockingBorrowIds: activeBorrows };
    }
    const activeAttempts = [...node.activeAttemptIds]
      .filter(attemptId => this.attemptStates.get(attemptId)?.status === 'ACTIVE')
      .sort();
    if (activeAttempts.length > 0) {
      return { completed: false, reason: 'active_attempts', blockingAttemptIds: activeAttempts };
    }

    node.status = 'COMPLETED';
    if (!node.controller.signal.aborted) node.controller.abort('completed');
    return { completed: true };
  }

  cancel(ownerHandle: OwnedGenerationLeaseHandle, reason: string): LeaseCancellationResult {
    const node = this.ownerNodes.get(ownerHandle as object);
    if (!node || node.status !== 'ACTIVE') return { cancelled: false, cancelledLeaseIds: [] };
    assertNonEmpty(reason, 'reason');
    const cancelledLeaseIds = this.cancelNodesAtomically([node], reason);
    return cancelledLeaseIds.length > 0
      ? { cancelled: true, cancelledLeaseIds }
      : { cancelled: false, cancelledLeaseIds: [] };
  }

  cancelForNoSave(ownerHandle: OwnedGenerationLeaseHandle, reason = 'no_save'): string[] {
    const scope = this.ownerNodes.get(ownerHandle as object);
    if (!scope) throw new Error('cancelForNoSave requires an issued owner lease');
    if (!this.nodeAndAncestorsActive(scope)) return [];
    assertNonEmpty(reason, 'reason');

    const candidates = this.collectSubtree(scope)
      .filter(node => node.status === 'ACTIVE' && NO_SAVE_TASK_KINDS.has(node.taskKind));
    const candidateIds = new Set(candidates.map(node => node.leaseId));
    const roots = candidates.filter(node => {
      let parentLeaseId = node.parentLeaseId;
      while (parentLeaseId) {
        if (candidateIds.has(parentLeaseId)) return false;
        if (parentLeaseId === scope.parentLeaseId) break;
        parentLeaseId = this.nodes.get(parentLeaseId)?.parentLeaseId ?? null;
      }
      return true;
    });
    return this.cancelNodesAtomically(roots, reason);
  }

  accepts(handle: unknown): LeaseAcceptance {
    if (!handle || typeof handle !== 'object') return { accepted: false, reason: 'invalid_handle' };

    const owner = this.ownerNodes.get(handle);
    if (owner) return this.acceptsNode(owner);

    const borrow = this.borrowHandles.get(handle);
    if (borrow) {
      if (borrow.status === 'RELEASED') return { accepted: false, reason: 'borrow_released' };
      if (borrow.status === 'CANCELLED') return { accepted: false, reason: 'cancelled' };
      const ownerNode = this.nodes.get(borrow.ownerLeaseId);
      return ownerNode ? this.acceptsNode(ownerNode) : { accepted: false, reason: 'invalid_handle' };
    }

    const attempt = this.attemptHandles.get(handle);
    if (attempt) {
      if (attempt.status === 'COMPLETED') return { accepted: false, reason: 'attempt_completed' };
      if (attempt.status === 'CANCELLED') return { accepted: false, reason: 'cancelled' };
      const operation = this.nodes.get(attempt.operationLeaseId);
      return operation ? this.acceptsNode(operation) : { accepted: false, reason: 'invalid_handle' };
    }

    return { accepted: false, reason: 'invalid_handle' };
  }

  /** Same gate as output acceptance; named separately for irreversible side effects. */
  canCommit(handle: OwnedGenerationLeaseHandle | BorrowedGenerationLeasePermit | RetryAttemptHandle): LeaseAcceptance {
    return this.accepts(handle);
  }

  /** Diagnostic lookup only. Product commits must present a branded handle. */
  acceptsLeaseId(leaseId: string): LeaseAcceptance {
    if (this.invalidatedLeaseIds.has(leaseId)) {
      return { accepted: false, reason: 'restored_invalidated' };
    }
    const node = this.nodes.get(leaseId);
    return node ? this.acceptsNode(node) : { accepted: false, reason: 'unknown_lease' };
  }

  exportState(): GenerationLeaseTreeState {
    return {
      schemaVersion: 'generation-lease-tree-v0.1',
      treeId: this.treeId,
      nextLeaseSequence: this.nextLeaseSequence,
      nextBorrowSequence: this.nextBorrowSequence,
      nodes: [...this.nodes.values()].map(node => ({
        leaseId: node.leaseId,
        parentLeaseId: node.parentLeaseId,
        taskId: node.taskId,
        taskKind: node.taskKind,
        channel: node.channel,
        identity: cloneSerializedIdentity(node.identity),
        status: node.status,
      })),
      attempts: [...this.attemptStates.values()].map(attempt => ({ ...attempt })),
      invalidatedLeaseIds: [...this.invalidatedLeaseIds].sort(),
      usedTaskIds: [...this.usedTaskIds].sort(),
      usedAttemptIds: [...this.usedAttemptIds].sort(),
    };
  }

  private createNode(
    parent: LeaseNode | null,
    spec: RootLeaseSpec | ChildLeaseSpec,
  ): OwnedGenerationLeaseHandle {
    assertNonEmpty(spec?.taskId, 'taskId');
    assertNonEmpty(spec?.channel, 'channel');
    if (this.usedTaskIds.has(spec.taskId)) throw new Error(`taskId ${spec.taskId} was already used`);
    const frozenIdentity = cloneIdentity(spec.identity);
    const leaseId = this.nextLeaseId();
    const node: LeaseNode = {
      leaseId,
      parentLeaseId: parent?.leaseId ?? null,
      taskId: spec.taskId,
      taskKind: spec.taskKind,
      channel: spec.channel,
      identity: frozenIdentity,
      controller: new AbortController(),
      status: 'ACTIVE',
      children: new Set(),
      activeBorrowIds: new Set(),
      activeAttemptIds: new Set(),
      lastAttemptIndex: 0,
    };
    this.nodes.set(leaseId, node);
    this.usedTaskIds.add(spec.taskId);
    parent?.children.add(leaseId);

    let handle!: OwnedGenerationLeaseHandle;
    handle = Object.freeze({
      kind: 'OWNED_GENERATION_LEASE' as const,
      leaseId,
      parentLeaseId: node.parentLeaseId,
      taskId: node.taskId,
      taskKind: node.taskKind,
      channel: node.channel,
      identity: node.identity,
      signal: node.controller.signal,
      accepts: (): LeaseAcceptance => this.accepts(handle),
    });
    this.ownerNodes.set(handle, node);
    return handle;
  }

  private requireActiveOwner(
    handle: OwnedGenerationLeaseHandle,
    operation: string,
  ): LeaseNode {
    const node = this.ownerNodes.get(handle as object);
    if (!node) throw new Error(`${operation} requires an issued owner lease`);
    if (!this.nodeAndAncestorsActive(node)) {
      throw new Error(`${operation} requires an active provider operation or parent lease`);
    }
    return node;
  }

  private nextLeaseId(): string {
    let leaseId: string;
    do {
      this.nextLeaseSequence += 1;
      leaseId = this.nextOpaqueId('lease', this.nextLeaseSequence);
    } while (this.nodes.has(leaseId) || this.invalidatedLeaseIds.has(leaseId));
    return leaseId;
  }

  private nextOpaqueId(kind: 'lease' | 'borrow', sequence: number): string {
    return `${kind}:${encodeURIComponent(this.treeId)}:${sequence}`;
  }

  private acceptsNode(node: LeaseNode): LeaseAcceptance {
    if (node.status !== 'ACTIVE') return { accepted: false, reason: terminalReason(node.status) };
    if (!this.ancestorsActive(node)) return { accepted: false, reason: 'ancestor_not_active' };
    return { accepted: true };
  }

  private ancestorsActive(node: LeaseNode): boolean {
    let parentLeaseId = node.parentLeaseId;
    while (parentLeaseId) {
      const parent = this.nodes.get(parentLeaseId);
      if (!parent || parent.status !== 'ACTIVE') return false;
      parentLeaseId = parent.parentLeaseId;
    }
    return true;
  }

  private nodeAndAncestorsActive(node: LeaseNode): boolean {
    return node.status === 'ACTIVE' && this.ancestorsActive(node);
  }

  private collectSubtree(root: LeaseNode): LeaseNode[] {
    const result: LeaseNode[] = [];
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      result.push(current);
      const children = [...current.children]
        .map(leaseId => this.nodes.get(leaseId))
        .filter((node): node is LeaseNode => node !== undefined)
        .reverse();
      stack.push(...children);
    }
    return result;
  }

  private cancelNodesAtomically(roots: LeaseNode[], reason: string): string[] {
    const byId = new Map<string, LeaseNode>();
    for (const root of roots) {
      for (const node of this.collectSubtree(root)) {
        if (node.status === 'ACTIVE') byId.set(node.leaseId, node);
      }
    }
    const nodes = [...byId.values()];

    // Mark every node and nested unit before firing any AbortSignal listener.
    // A listener therefore cannot enqueue new work into a sibling that is
    // already selected for the same cancellation transaction.
    for (const node of nodes) {
      node.status = 'CANCELLED';
      for (const borrowId of node.activeBorrowIds) {
        const borrow = this.borrowStates.get(borrowId);
        if (borrow?.status === 'ACTIVE') borrow.status = 'CANCELLED';
      }
      node.activeBorrowIds.clear();
      for (const attemptId of node.activeAttemptIds) {
        const attempt = this.attemptStates.get(attemptId);
        if (attempt?.status === 'ACTIVE') attempt.status = 'CANCELLED';
      }
      node.activeAttemptIds.clear();
    }
    for (const node of nodes) {
      if (!node.controller.signal.aborted) node.controller.abort(reason);
    }
    return nodes.map(node => node.leaseId);
  }

  private static assertSnapshot(state: GenerationLeaseTreeState): void {
    if (!state || state.schemaVersion !== 'generation-lease-tree-v0.1') {
      throw new Error('unsupported generation lease tree state');
    }
    assertNonEmpty(state.treeId, 'state.treeId');
    assertNonNegativeInteger(state.nextLeaseSequence, 'state.nextLeaseSequence');
    assertNonNegativeInteger(state.nextBorrowSequence, 'state.nextBorrowSequence');
    if (
      !Array.isArray(state.nodes)
      || !Array.isArray(state.attempts)
      || !Array.isArray(state.invalidatedLeaseIds)
      || !Array.isArray(state.usedTaskIds)
      || !Array.isArray(state.usedAttemptIds)
    ) {
      throw new TypeError('generation lease tree state arrays are required');
    }

    const leaseIds = new Set<string>();
    for (const node of state.nodes) {
      assertNonEmpty(node.leaseId, 'state.nodes[].leaseId');
      assertNonEmpty(node.taskId, 'state.nodes[].taskId');
      assertNonEmpty(node.channel, 'state.nodes[].channel');
      validateTaskKind(node.taskKind, new Set([...ROOT_TASK_KINDS, ...CHILD_TASK_KINDS]), 'state.nodes[].taskKind');
      cloneIdentity(node.identity);
      if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(node.status)) {
        throw new TypeError('state.nodes[].status is invalid');
      }
      if (leaseIds.has(node.leaseId)) throw new Error('duplicate leaseId in generation lease tree state');
      leaseIds.add(node.leaseId);
    }
    for (const value of state.invalidatedLeaseIds) assertNonEmpty(value, 'state.invalidatedLeaseIds[]');
    for (const value of state.usedTaskIds) assertNonEmpty(value, 'state.usedTaskIds[]');
    for (const value of state.usedAttemptIds) assertNonEmpty(value, 'state.usedAttemptIds[]');
    for (const attempt of state.attempts) {
      assertNonEmpty(attempt.attemptId, 'state.attempts[].attemptId');
      assertNonEmpty(attempt.operationLeaseId, 'state.attempts[].operationLeaseId');
      assertPositiveInteger(attempt.attemptIndex, 'state.attempts[].attemptIndex');
      if (!['ACTIVE', 'COMPLETED', 'CANCELLED'].includes(attempt.status)) {
        throw new TypeError('state.attempts[].status is invalid');
      }
    }
  }
}
