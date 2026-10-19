import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeIdentity } from '../../../src/lib/algorithm-runtime/contracts.ts';
import {
  GenerationLeaseTree,
  type OwnedGenerationLeaseHandle,
} from '../../../src/lib/algorithm-runtime/lease-tree.ts';
import {
  createTurnAsyncJobCoordinator,
  type AsyncJobAdapter,
  type AsyncJobKind,
  type AsyncJobRequest,
} from '../../../src/lib/turn-orchestrator/async-jobs.ts';

function identity(generationId: number, invocationId: string): RuntimeIdentity {
  return {
    sessionEpoch: 'g5-async-session',
    turnId: `g5-async-turn-${generationId}`,
    generationId,
    invocationId,
    evidenceRefs: [`evidence-${generationId}`, `photo-${generationId}`],
  };
}

function turnRoot(
  tree: GenerationLeaseTree,
  generationId: number,
  suffix: string,
): OwnedGenerationLeaseHandle {
  return tree.startRoot({
    taskId: `turn:${suffix}`,
    taskKind: 'TURN_ROOT',
    channel: 'orchestrator',
    identity: identity(generationId, `turn:${suffix}`),
  });
}

function request(
  kind: AsyncJobKind,
  generationId: number,
  suffix: string,
  overrides: Partial<AsyncJobRequest> = {},
): AsyncJobRequest {
  return {
    jobId: `${kind.toLowerCase()}:${suffix}`,
    kind,
    inputRef: `input:${suffix}`,
    payloadFingerprint: `sha256:${suffix}`,
    evidenceRefs: [`evidence-${generationId}`],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function adapters(
  overrides: Partial<Record<AsyncJobKind, AsyncJobAdapter>> = {},
): Record<AsyncJobKind, AsyncJobAdapter> {
  const make = (kind: AsyncJobKind): AsyncJobAdapter => ({
    async run(context) {
      return {
        ok: true,
        resultId: `result:${kind.toLowerCase()}:${context.jobId}`,
        value: { privateGeneratedContent: `secret-${kind}-${context.jobId}` },
      };
    },
    async commit(context) {
      return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
    },
  });
  return {
    MEMORY: overrides.MEMORY ?? make('MEMORY'),
    STORY: overrides.STORY ?? make('STORY'),
    PROFILE: overrides.PROFILE ?? make('PROFILE'),
  };
}

function monotonicNow(prefix: string): () => string {
  let tick = 0;
  return () => `${prefix}-${String(++tick).padStart(3, '0')}`;
}

test('Memory, Story and Profile run as independent children and persist only opaque control-plane status', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-success' });
  const root = turnRoot(tree, 1, 'success');
  const committed: string[] = [];
  const configured = adapters();
  for (const kind of ['MEMORY', 'STORY', 'PROFILE'] as const) {
    const base = configured[kind];
    configured[kind] = {
      run: base.run,
      async commit(context) {
        assert.deepEqual(context.canCommit(), { accepted: true });
        committed.push(`${kind}:${context.resultId}:${JSON.stringify(context.value)}`);
        return 'COMMITTED';
      },
    };
  }
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'success-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('success-time'),
  });

  assert.equal(coordinator.submit(request('MEMORY', 1, 'memory')).status, 'pending');
  assert.equal(coordinator.submit(request('STORY', 1, 'story')).status, 'pending');
  assert.equal(coordinator.submit(request('PROFILE', 1, 'profile')).status, 'pending');
  const settled = await coordinator.settle({ timeoutMs: 100 });

  assert.equal(settled.status, 'settled');
  assert.deepEqual(settled.pendingJobIds, []);
  assert.deepEqual(coordinator.list().map(item => [item.kind, item.status]), [
    ['MEMORY', 'success'], ['PROFILE', 'success'], ['STORY', 'success'],
  ]);
  assert.equal(committed.length, 3);

  const memory = coordinator.get('memory:memory');
  const story = coordinator.get('story:story');
  const profile = coordinator.get('profile:profile');
  assert.ok(memory && story && profile);
  assert.notEqual(memory.groupLeaseId, story.groupLeaseId);
  assert.equal(story.groupLeaseId, profile.groupLeaseId);
  assert.notEqual(memory.leaseId, story.leaseId);
  assert.equal(tree.acceptsLeaseId(memory.leaseId).accepted, false);
  assert.deepEqual(tree.complete(root), { completed: true });

  const serializedStatus = JSON.stringify(settled);
  assert.equal(serializedStatus.includes('privateGeneratedContent'), false);
  assert.equal(serializedStatus.includes('secret-MEMORY'), false);
  assert.equal(serializedStatus.includes('payloadFingerprint'), false);
  assert.deepEqual(Object.keys(memory).sort(), [
    'completedAt', 'errorCode', 'groupLeaseId', 'inputRef', 'jobId', 'kind',
    'leaseId', 'queuedAt', 'resultId', 'startedAt', 'status',
  ]);
});

test('Memory failure does not affect Story, Profile, or an existing response branch', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-isolation' });
  const root = turnRoot(tree, 2, 'isolation');
  const response = tree.spawnChild(root, {
    taskId: 'response:isolation', taskKind: 'RESPONSE', channel: 'formal_interview',
    identity: { ...root.identity, invocationId: 'response:isolation', evidenceRefs: ['evidence-2'] },
  });
  const configured = adapters({
    MEMORY: {
      async run() { return { ok: false, errorCode: 'memory_extract_failed' }; },
      async commit() { throw new Error('memory commit must not run'); },
    },
  });
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'isolation-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('isolation-time'),
  });

  coordinator.submit(request('MEMORY', 2, 'memory-failure'));
  coordinator.submit(request('STORY', 2, 'story-failure'));
  coordinator.submit(request('PROFILE', 2, 'profile-success'));
  const settled = await coordinator.settle({ timeoutMs: 100 });

  assert.equal(settled.status, 'settled');
  assert.deepEqual(coordinator.list().map(item => [item.kind, item.status, item.errorCode]), [
    ['MEMORY', 'failed', 'memory_extract_failed'],
    ['PROFILE', 'success', null],
    ['STORY', 'success', null],
  ]);
  assert.deepEqual(response.accepts(), { accepted: true });
  tree.cancel(root, 'test_cleanup');
});

test('Story failure is isolated from Profile and error messages never enter ordinary status', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-artifact-isolation' });
  const root = turnRoot(tree, 21, 'artifact-isolation');
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'artifact-isolation-coordinator', tree, turnRoot: root,
    adapters: adapters({
      STORY: {
        async run() { throw new Error('raw private story must never enter status'); },
        async commit() { throw new Error('story commit must not run'); },
      },
    }),
    now: monotonicNow('artifact-isolation-time'),
  });

  coordinator.submit(request('STORY', 21, 'story-failure'));
  coordinator.submit(request('PROFILE', 21, 'profile-success'));
  const settled = await coordinator.settle({ timeoutMs: 100 });

  assert.equal(settled.status, 'settled');
  assert.deepEqual(coordinator.list().map(item => [item.kind, item.status, item.errorCode]), [
    ['PROFILE', 'success', null],
    ['STORY', 'failed', 'runner_failed'],
  ]);
  assert.equal(JSON.stringify(settled).includes('raw private story'), false);
  assert.deepEqual(tree.complete(root), { completed: true });
});

test('NO_SAVE cancels pending retention and artifact jobs; late results cannot commit', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-no-save' });
  const root = turnRoot(tree, 3, 'no-save');
  const response = tree.spawnChild(root, {
    taskId: 'response:no-save', taskKind: 'RESPONSE', channel: 'formal_interview',
    identity: { ...root.identity, invocationId: 'response:no-save', evidenceRefs: ['evidence-3'] },
  });
  const barriers = {
    MEMORY: deferred<ReturnType<AsyncJobAdapter['run']> extends Promise<infer T> ? T : never>(),
    STORY: deferred<ReturnType<AsyncJobAdapter['run']> extends Promise<infer T> ? T : never>(),
    PROFILE: deferred<ReturnType<AsyncJobAdapter['run']> extends Promise<infer T> ? T : never>(),
  };
  const started = {
    MEMORY: deferred<void>(), STORY: deferred<void>(), PROFILE: deferred<void>(),
  };
  let commitCalls = 0;
  const configured = {} as Record<AsyncJobKind, AsyncJobAdapter>;
  for (const kind of ['MEMORY', 'STORY', 'PROFILE'] as const) {
    configured[kind] = {
      async run() { started[kind].resolve(); return barriers[kind].promise; },
      async commit(context) {
        commitCalls += 1;
        return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
      },
    };
  }
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'no-save-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('no-save-time'),
  });
  const requests = [
    request('MEMORY', 3, 'late-memory'),
    request('STORY', 3, 'late-story'),
    request('PROFILE', 3, 'late-profile'),
  ] as const;
  requests.forEach(item => coordinator.submit(item));
  await Promise.all(Object.values(started).map(item => item.promise));

  const cancelledLeaseIds = coordinator.applyNoSave('elder_no_save');
  assert.ok(cancelledLeaseIds.length >= 5);
  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  assert.deepEqual(coordinator.list().map(item => item.status), ['cancelled', 'cancelled', 'cancelled']);
  assert.equal(commitCalls, 0);
  assert.deepEqual(response.accepts(), { accepted: true });

  barriers.MEMORY.resolve({ ok: true, resultId: 'late-memory-result', value: { content: 'late-memory' } });
  barriers.STORY.resolve({ ok: true, resultId: 'late-story-result', value: { content: 'late-story' } });
  barriers.PROFILE.resolve({ ok: true, resultId: 'late-profile-result', value: { content: 'late-profile' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(commitCalls, 0);
  assert.deepEqual(coordinator.list().map(item => item.status), ['cancelled', 'cancelled', 'cancelled']);

  assert.equal(coordinator.submit(requests[0]).status, 'cancelled');
  assert.throws(() => coordinator.submit(request('MEMORY', 3, 'new-after-no-save')), /closed/);
  tree.cancel(root, 'test_cleanup');
});

test('parent cancellation settles promptly and rejects a late successful runner result', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-parent-cancel' });
  const root = turnRoot(tree, 4, 'parent-cancel');
  const barrier = deferred<{ ok: true; resultId: string; value: unknown }>();
  const started = deferred<void>();
  let commitCalls = 0;
  const configured = adapters({
    PROFILE: {
      async run() { started.resolve(); return barrier.promise; },
      async commit(context) {
        commitCalls += 1;
        return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
      },
    },
  });
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'parent-cancel-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('parent-cancel-time'),
  });
  coordinator.submit(request('PROFILE', 4, 'parent-cancel'));
  await started.promise;

  tree.cancel(root, 'session_ended');
  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  assert.equal(coordinator.get('profile:parent-cancel')?.status, 'cancelled');
  assert.equal(commitCalls, 0);

  barrier.resolve({ ok: true, resultId: 'late-profile-result', value: { content: 'late' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(commitCalls, 0);
  assert.equal(coordinator.get('profile:parent-cancel')?.status, 'cancelled');
});

test('same jobId and payload is idempotent while conflicting payload fails closed', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-idempotency' });
  const root = turnRoot(tree, 5, 'idempotency');
  let runs = 0;
  const configured = adapters({
    MEMORY: {
      async run() {
        runs += 1;
        return { ok: true, resultId: 'result:idempotent', value: { content: 'one-run' } };
      },
      async commit(context) {
        return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
      },
    },
  });
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'idempotency-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('idempotency-time'),
  });
  const original = request('MEMORY', 5, 'idempotent');

  assert.deepEqual(coordinator.submit(original), coordinator.submit(structuredClone(original)));
  assert.throws(() => coordinator.submit({
    ...original, payloadFingerprint: 'sha256:conflicting-payload',
  }), /jobId.*conflicting payload/);
  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  assert.equal(runs, 1);
  assert.equal(coordinator.list().length, 1);
});

test('settle is bounded and reports pending until the injected runner completes', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-bounded' });
  const root = turnRoot(tree, 6, 'bounded');
  const barrier = deferred<{ ok: true; resultId: string; value: unknown }>();
  const started = deferred<void>();
  const configured = adapters({
    STORY: {
      async run() { started.resolve(); return barrier.promise; },
      async commit(context) {
        return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
      },
    },
  });
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'bounded-coordinator', tree, turnRoot: root, adapters: configured,
    now: monotonicNow('bounded-time'),
  });
  coordinator.submit(request('STORY', 6, 'bounded'));
  await started.promise;

  const pending = await coordinator.settle({ timeoutMs: 5 });
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.pendingJobIds, ['story:bounded']);
  assert.ok(['pending', 'running'].includes(coordinator.get('story:bounded')?.status ?? ''));

  barrier.resolve({ ok: true, resultId: 'result:bounded', value: { content: 'ephemeral' } });
  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  assert.deepEqual(settled.pendingJobIds, []);
  assert.equal(coordinator.get('story:bounded')?.resultId, 'result:bounded');
  assert.deepEqual(tree.complete(root), { completed: true });
});

test('COMMITTED after cancellation is a hard late-commit failure rather than a safe cancellation', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-late-commit' });
  const root = turnRoot(tree, 7, 'late-commit');
  const commitStarted = deferred<void>();
  const releaseCommit = deferred<void>();
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'late-commit-coordinator', tree, turnRoot: root,
    adapters: adapters({
      MEMORY: {
        async run() {
          return { ok: true, resultId: 'result:late-commit', value: { content: 'ephemeral' } };
        },
        async commit(context) {
          assert.deepEqual(context.canCommit(), { accepted: true });
          commitStarted.resolve();
          await releaseCommit.promise;
          return 'COMMITTED';
        },
      },
    }),
    now: monotonicNow('late-commit-time'),
  });
  coordinator.submit(request('MEMORY', 7, 'late-commit'));
  await commitStarted.promise;

  tree.cancel(root, 'no_save_arrived_during_commit');
  const pending = await coordinator.settle({ timeoutMs: 5 });
  assert.equal(pending.status, 'pending');
  assert.deepEqual(pending.pendingJobIds, ['memory:late-commit']);

  releaseCommit.resolve();
  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  const finalStatus = coordinator.get('memory:late-commit');
  assert.ok(finalStatus);
  assert.equal(finalStatus.status, 'failed');
  assert.equal(finalStatus.resultId, null);
  assert.equal(finalStatus.errorCode, 'late_commit_after_cancel');
});

test('COMMITTED without an in-transaction canCommit check fails closed', async () => {
  const tree = new GenerationLeaseTree({ treeId: 'g5-async-missing-commit-gate' });
  const root = turnRoot(tree, 8, 'missing-commit-gate');
  const coordinator = createTurnAsyncJobCoordinator({
    coordinatorId: 'missing-commit-gate-coordinator', tree, turnRoot: root,
    adapters: adapters({
      PROFILE: {
        async run() {
          return { ok: true, resultId: 'result:unchecked-commit', value: { content: 'ephemeral' } };
        },
        async commit() { return 'COMMITTED'; },
      },
    }),
    now: monotonicNow('missing-commit-gate-time'),
  });
  coordinator.submit(request('PROFILE', 8, 'missing-commit-gate'));

  const settled = await coordinator.settle({ timeoutMs: 100 });
  assert.equal(settled.status, 'settled');
  assert.equal(coordinator.get('profile:missing-commit-gate')?.status, 'failed');
  assert.equal(coordinator.get('profile:missing-commit-gate')?.errorCode, 'commit_gate_not_checked');
  assert.equal(coordinator.get('profile:missing-commit-gate')?.resultId, null);
  assert.deepEqual(tree.complete(root), { completed: true });
});
