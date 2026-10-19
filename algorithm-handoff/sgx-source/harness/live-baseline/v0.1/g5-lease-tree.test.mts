import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeIdentity } from '../../../src/lib/algorithm-runtime/contracts.ts';
import {
  GenerationLeaseTree,
  type OwnedGenerationLeaseHandle,
} from '../../../src/lib/algorithm-runtime/lease-tree.ts';

function identity(
  generationId: number,
  invocationId: string,
  evidenceRefs: readonly string[] = [`evidence-${generationId}`],
): RuntimeIdentity {
  return {
    sessionEpoch: 'g5-session',
    turnId: `g5-turn-${generationId}`,
    generationId,
    invocationId,
    evidenceRefs,
  };
}

function rootFor(
  tree: GenerationLeaseTree,
  generationId: number,
  suffix: string,
): OwnedGenerationLeaseHandle {
  return tree.startRoot({
    taskId: `turn:${suffix}`,
    taskKind: 'TURN_ROOT',
    channel: 'orchestrator',
    identity: identity(generationId, `root:${suffix}`, [
      `evidence-${generationId}`,
      `photo-${generationId}`,
    ]),
  });
}

test('root owns children; child completion leaves its parent and sibling active', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-ownership' });
  const root = rootFor(tree, 1, 'ownership');
  const response = tree.spawnChild(root, {
    taskId: 'response:1',
    taskKind: 'RESPONSE',
    channel: 'daily_chat',
    identity: identity(1, 'response:1'),
  });
  const tts = tree.spawnChild(root, {
    taskId: 'tts:1',
    taskKind: 'TTS',
    channel: 'tts',
    identity: identity(1, 'tts:1'),
  });

  assert.deepEqual(tree.complete(response), { completed: true });
  assert.equal(response.signal.aborted, true);
  assert.deepEqual(root.accepts(), { accepted: true });
  assert.deepEqual(tts.accepts(), { accepted: true });
  assert.equal(root.signal.aborted, false);
  assert.equal(tts.signal.aborted, false);

  const blocked = tree.complete(root);
  assert.equal(blocked.completed, false);
  assert.equal(blocked.reason, 'active_children');
  assert.deepEqual(blocked.blockingLeaseIds, [tts.leaseId]);
  assert.deepEqual(root.accepts(), { accepted: true });

  assert.deepEqual(tree.complete(tts), { completed: true });
  assert.deepEqual(tree.complete(root), { completed: true });
  assert.equal(root.signal.aborted, true);
});

test('parent cancellation synchronously propagates to every descendant and blocks delivery and commit', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-cascade' });
  const root = rootFor(tree, 2, 'cascade');
  const response = tree.spawnChild(root, {
    taskId: 'response:2', taskKind: 'RESPONSE', channel: 'formal_interview',
    identity: identity(2, 'response:2'),
  });
  const provider = tree.spawnChild(response, {
    taskId: 'provider:2', taskKind: 'PROVIDER_OPERATION', channel: 'formal_interview',
    identity: identity(2, 'provider:2'),
  });
  const memory = tree.spawnChild(root, {
    taskId: 'memory:2', taskKind: 'MEMORY_CANDIDATE', channel: 'memory',
    identity: identity(2, 'memory:2'),
  });

  const cancelled = tree.cancel(root, 'user_interrupted');
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(new Set(cancelled.cancelledLeaseIds), new Set([
    root.leaseId, response.leaseId, provider.leaseId, memory.leaseId,
  ]));
  for (const lease of [root, response, provider, memory]) {
    assert.equal(lease.signal.aborted, true);
    assert.deepEqual(lease.accepts(), { accepted: false, reason: 'cancelled' });
    assert.deepEqual(tree.canCommit(lease), { accepted: false, reason: 'cancelled' });
  }
  assert.throws(() => tree.spawnChild(root, {
    taskId: 'late:2', taskKind: 'TTS', channel: 'tts', identity: identity(2, 'late:2'),
  }), /active parent lease/);
});

test('terminal child cannot spawn work and cancelling one child leaves siblings active', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-child-isolation' });
  const root = rootFor(tree, 3, 'child-isolation');
  const response = tree.spawnChild(root, {
    taskId: 'response:3', taskKind: 'RESPONSE', channel: 'daily_chat',
    identity: identity(3, 'response:3'),
  });
  const tts = tree.spawnChild(root, {
    taskId: 'tts:3', taskKind: 'TTS', channel: 'tts', identity: identity(3, 'tts:3'),
  });

  assert.equal(tree.cancel(response, 'response_failed').cancelled, true);
  assert.deepEqual(tts.accepts(), { accepted: true });
  assert.deepEqual(root.accepts(), { accepted: true });
  assert.throws(() => tree.spawnChild(response, {
    taskId: 'late-child:3', taskKind: 'PROVIDER_OPERATION', channel: 'daily_chat',
    identity: identity(3, 'late-child:3'),
  }), /active parent lease/);
});

test('NO_SAVE cancels retention and artifact task-kind subtrees without stopping response or TTS', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-no-save' });
  const root = rootFor(tree, 4, 'no-save');
  const response = tree.spawnChild(root, {
    taskId: 'response:4', taskKind: 'RESPONSE', channel: 'formal_interview',
    identity: identity(4, 'response:4'),
  });
  const tts = tree.spawnChild(root, {
    taskId: 'tts:4', taskKind: 'TTS', channel: 'tts', identity: identity(4, 'tts:4'),
  });
  const retention = tree.spawnChild(root, {
    taskId: 'retention:4', taskKind: 'RETENTION', channel: 'memory',
    identity: identity(4, 'retention:4'),
  });
  const memory = tree.spawnChild(retention, {
    taskId: 'memory:4', taskKind: 'MEMORY_CANDIDATE', channel: 'memory',
    identity: identity(4, 'memory:4'),
  });
  const memoryProvider = tree.spawnChild(memory, {
    taskId: 'memory-provider:4', taskKind: 'PROVIDER_OPERATION', channel: 'memory',
    identity: identity(4, 'memory-provider:4'),
  });
  const artifact = tree.spawnChild(root, {
    taskId: 'artifact:4', taskKind: 'ARTIFACT', channel: 'story_draft',
    identity: identity(4, 'artifact:4'),
  });
  const story = tree.spawnChild(artifact, {
    taskId: 'story:4', taskKind: 'STORY_DRAFT', channel: 'story_draft',
    identity: identity(4, 'story:4'),
  });
  const profile = tree.spawnChild(artifact, {
    taskId: 'profile:4', taskKind: 'PROFILE_DRAFT', channel: 'profile_draft',
    identity: identity(4, 'profile:4'),
  });

  const cancelled = tree.cancelForNoSave(root, 'elder_no_save');
  assert.deepEqual(new Set(cancelled), new Set([
    retention.leaseId, memory.leaseId, memoryProvider.leaseId,
    artifact.leaseId, story.leaseId, profile.leaseId,
  ]));
  assert.deepEqual(response.accepts(), { accepted: true });
  assert.deepEqual(tts.accepts(), { accepted: true });
  assert.deepEqual(root.accepts(), { accepted: true });
  assert.deepEqual(memory.accepts(), { accepted: false, reason: 'cancelled' });
  assert.deepEqual(story.accepts(), { accepted: false, reason: 'cancelled' });
  assert.deepEqual(profile.accepts(), { accepted: false, reason: 'cancelled' });
});

test('a retry attempt is attached to one provider operation and never owns a generation lease', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-retry' });
  const root = rootFor(tree, 5, 'retry');
  const operation = tree.spawnChild(root, {
    taskId: 'provider-operation:5', taskKind: 'PROVIDER_OPERATION', channel: 'daily_chat',
    identity: identity(5, 'provider-operation:5'),
  });
  const attempt1 = tree.beginRetryAttempt(operation, { attemptId: 'attempt:5:1', attemptIndex: 1 });

  assert.equal(attempt1.operationLeaseId, operation.leaseId);
  assert.equal(attempt1.signal, operation.signal);
  assert.deepEqual(attempt1.accepts(), { accepted: true });
  const blocked = tree.complete(operation);
  assert.equal(blocked.completed, false);
  assert.equal(blocked.reason, 'active_attempts');
  assert.deepEqual(blocked.blockingAttemptIds, ['attempt:5:1']);
  assert.equal(tree.completeRetryAttempt({ ...attempt1 } as typeof attempt1), false);
  assert.equal(tree.completeRetryAttempt(attempt1), true);
  assert.equal(tree.completeRetryAttempt(attempt1), true);

  const attempt2 = tree.beginRetryAttempt(operation, { attemptId: 'attempt:5:2', attemptIndex: 2 });
  assert.deepEqual(attempt2.accepts(), { accepted: true });
  assert.throws(
    () => tree.beginRetryAttempt(operation, { attemptId: 'attempt:5:3', attemptIndex: 3 }),
    /active retry attempt/,
  );
  tree.cancel(root, 'session_ended');
  assert.deepEqual(attempt2.accepts(), { accepted: false, reason: 'cancelled' });
  assert.throws(
    () => tree.beginRetryAttempt(operation, { attemptId: 'attempt:5:3', attemptIndex: 3 }),
    /active provider operation/,
  );
});

test('borrowed permits cannot finish their owner and owner completion waits for release', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-borrow' });
  const root = rootFor(tree, 6, 'borrow');
  const response = tree.spawnChild(root, {
    taskId: 'response:6', taskKind: 'RESPONSE', channel: 'daily_chat',
    identity: identity(6, 'response:6'),
  });
  const borrowed = tree.borrow(response, 'audited_text');

  assert.equal('complete' in borrowed, false);
  assert.equal('cancel' in borrowed, false);
  assert.deepEqual(borrowed.accepts(), { accepted: true });
  const blocked = tree.complete(response);
  assert.equal(blocked.completed, false);
  assert.equal(blocked.reason, 'active_borrows');
  assert.deepEqual(blocked.blockingBorrowIds, [borrowed.borrowId]);
  assert.equal(tree.releaseBorrow({ ...borrowed } as typeof borrowed), false);
  assert.equal(tree.releaseBorrow(borrowed), true);
  assert.equal(tree.releaseBorrow(borrowed), true);
  assert.deepEqual(tree.complete(response), { completed: true });
  assert.deepEqual(root.accepts(), { accepted: true });
});

test('child identity stays in the parent session/turn/generation and cannot widen evidence', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-scope' });
  const root = rootFor(tree, 7, 'scope');
  const child = tree.spawnChild(root, {
    taskId: 'scoped-child:7', taskKind: 'MEMORY_CANDIDATE', channel: 'memory',
    identity: identity(7, 'scoped-child:7', ['evidence-7']),
  });
  assert.deepEqual(child.identity.evidenceRefs, ['evidence-7']);

  assert.throws(() => tree.spawnChild(root, {
    taskId: 'wide-child:7', taskKind: 'MEMORY_CANDIDATE', channel: 'memory',
    identity: identity(7, 'wide-child:7', ['evidence-7', 'untrusted-evidence']),
  }), /evidenceRefs.*subset/);
  assert.throws(() => tree.spawnChild(root, {
    taskId: 'other-turn:7', taskKind: 'RESPONSE', channel: 'daily_chat',
    identity: { ...identity(7, 'other-turn:7'), turnId: 'other-turn' },
  }), /session, turn, and generation/);
});

test('restoring a snapshot tombstones all prior active work and permits only new task identities', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-restore' });
  const root = rootFor(tree, 8, 'restore');
  const operation = tree.spawnChild(root, {
    taskId: 'provider-operation:8', taskKind: 'PROVIDER_OPERATION', channel: 'formal_interview',
    identity: identity(8, 'provider-operation:8'),
  });
  const attempt = tree.beginRetryAttempt(operation, { attemptId: 'attempt:8:1', attemptIndex: 1 });
  const restored = GenerationLeaseTree.restore(tree.exportState());

  assert.deepEqual(restored.accepts(root), { accepted: false, reason: 'invalid_handle' });
  assert.deepEqual(restored.acceptsLeaseId(root.leaseId), {
    accepted: false, reason: 'restored_invalidated',
  });
  assert.deepEqual(restored.acceptsLeaseId(operation.leaseId), {
    accepted: false, reason: 'restored_invalidated',
  });
  assert.equal(restored.completeRetryAttempt(attempt), false);
  assert.throws(() => restored.startRoot({
    taskId: root.taskId,
    taskKind: 'TURN_ROOT',
    channel: 'orchestrator',
    identity: identity(8, 'replacement'),
  }), /taskId.*already used/);

  const replacement = restored.startRoot({
    taskId: 'turn:restore:replacement',
    taskKind: 'TURN_ROOT',
    channel: 'orchestrator',
    identity: identity(9, 'replacement'),
  });
  assert.notEqual(replacement.leaseId, root.leaseId);
  assert.deepEqual(replacement.accepts(), { accepted: true });
});

test('forged owner, borrow, and attempt handles have no mutation authority', () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-forgery' });
  const root = rootFor(tree, 10, 'forgery');
  const operation = tree.spawnChild(root, {
    taskId: 'provider-operation:10', taskKind: 'PROVIDER_OPERATION', channel: 'daily_chat',
    identity: identity(10, 'provider-operation:10'),
  });
  const borrowed = tree.borrow(operation, 'provider_adapter');
  const attempt = tree.beginRetryAttempt(operation, { attemptId: 'attempt:10:1', attemptIndex: 1 });
  const forgedOwner = { ...operation } as typeof operation;

  assert.deepEqual(tree.accepts(forgedOwner), { accepted: false, reason: 'invalid_handle' });
  assert.equal(tree.cancel(forgedOwner, 'forged').cancelled, false);
  assert.equal(tree.complete(forgedOwner).completed, false);
  assert.throws(() => tree.spawnChild(forgedOwner, {
    taskId: 'forged-child:10', taskKind: 'TTS', channel: 'tts',
    identity: identity(10, 'forged-child:10'),
  }), /issued owner lease/);
  assert.equal(tree.releaseBorrow({ ...borrowed } as typeof borrowed), false);
  assert.equal(tree.completeRetryAttempt({ ...attempt } as typeof attempt), false);
  assert.deepEqual(operation.accepts(), { accepted: true });
});
