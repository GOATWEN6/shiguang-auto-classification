import assert from 'node:assert/strict';
import test from 'node:test';

import {
  InMemoryGovernedSessionStore,
  InMemoryTurnEvidenceStore,
  type GovernedIdFactory,
  type GovernedTurnHandle,
  type TrustedSessionAuthority,
  type TurnEvidenceStoreSnapshot,
} from '../../../src/lib/turn-orchestrator/index.ts';

const START = '2026-10-19T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1_000;
const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-fiction-persistence',
  subjectId: 'elder-fiction-persistence',
  familySpaceId: 'family-fiction-persistence',
  authorizationVersion: 'auth-persistence-v1',
  visibilityScope: ['elder_only'],
};

function ids(prefix: string): GovernedIdFactory {
  let value = 0;
  return { next: kind => `${kind}:${prefix}:${++value}` };
}

function setup(clock: { now: string }) {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('session') });
  const session = sessions.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: 'start-persistence',
    requestedMode: 'DAILY_CHAT',
  }, AUTHORITY).session;
  const open = (token: string): GovernedTurnHandle => sessions.openTurn({
    schemaVersion: 'client-turn-open-v0.1',
    sessionId: session.sessionId,
    idempotencyToken: token,
  }).handle;
  return { sessions, session, open, now: () => clock.now };
}

function commit(
  store: InMemoryTurnEvidenceStore,
  handle: GovernedTurnHandle,
  token: string,
  text: string,
) {
  return store.commitTypedText(handle, {
    schemaVersion: 'typed-text-final-v0.1',
    idempotencyToken: token,
    text,
    receivedAt: START,
  });
}

test('snapshot restore preserves active evidence order for get/list without extending retention', () => {
  const clock = { now: START };
  const runtime = setup(clock);
  const store = new InMemoryTurnEvidenceStore(runtime.sessions, {
    idFactory: ids('evidence'),
    now: runtime.now,
  });
  const firstHandle = runtime.open('turn-1');
  const first = commit(store, firstHandle, 'commit-1', '我年轻时在纺织厂工作。');
  runtime.sessions.closeTurn(firstHandle);
  const secondHandle = runtime.open('turn-2');
  const second = commit(store, secondHandle, 'commit-2', '后来我负责机器检修。');

  const snapshot = store.exportSnapshot();
  const restored = InMemoryTurnEvidenceStore.restore(runtime.sessions, snapshot, {
    idFactory: ids('restored-evidence'),
    now: runtime.now,
  });

  assert.deepEqual(restored.get(first.evidence.evidenceId), first.evidence);
  assert.deepEqual(restored.get(second.evidence.evidenceId), second.evidence);
  assert.deepEqual(
    restored.listCompletedInSession(second.evidence.evidenceId).map(item => item.evidenceId),
    [first.evidence.evidenceId, second.evidence.evidenceId],
  );
  assert.equal(restored.getExpiresAt(first.evidence.evidenceId),
    new Date(Date.parse(START) + 40 * DAY_MS).toISOString());
});

test('restore after the 40-day deadline drops content and keeps a no-content replay guard', () => {
  const clock = { now: START };
  const runtime = setup(clock);
  const store = new InMemoryTurnEvidenceStore(runtime.sessions, {
    idFactory: ids('expiry'),
    now: runtime.now,
  });
  const handle = runtime.open('turn-expiry');
  const request = {
    schemaVersion: 'typed-text-final-v0.1' as const,
    idempotencyToken: 'commit-expiry',
    text: '这段原文到期后必须消失。',
    receivedAt: START,
  };
  const saved = store.commitTypedText(handle, request);
  const snapshot = store.exportSnapshot();

  clock.now = new Date(Date.parse(START) + 41 * DAY_MS).toISOString();
  const restored = InMemoryTurnEvidenceStore.restore(runtime.sessions, snapshot, {
    idFactory: ids('expiry-restored'),
    now: runtime.now,
  });

  assert.equal(restored.get(saved.evidence.evidenceId), null);
  assert.equal(restored.getInvalidation(saved.evidence.evidenceId)?.reasonCode,
    'RETENTION_40_DAY_EXPIRY');
  assert.equal(JSON.stringify(restored.exportSnapshot()).includes(request.text), false);
  assert.throws(() => restored.commitTypedText(handle, request), /invalidated/);
});

test('withdrawn evidence cannot be revived after snapshot restore or tombstone purge', () => {
  const clock = { now: START };
  const runtime = setup(clock);
  const store = new InMemoryTurnEvidenceStore(runtime.sessions, {
    idFactory: ids('withdrawal'),
    now: runtime.now,
  });
  const handle = runtime.open('turn-withdrawal');
  const request = {
    schemaVersion: 'typed-text-final-v0.1' as const,
    idempotencyToken: 'commit-withdrawal',
    text: '老人要求撤回的私密原文。',
    receivedAt: START,
  };
  const saved = store.commitTypedText(handle, request);
  store.invalidateEvidence(saved.evidence.evidenceId, {
    actionId: 'withdraw-action',
    actorId: AUTHORITY.actorId,
    occurredAt: START,
    reasonCode: 'ELDER_WITHDRAWN',
  });
  const snapshot = store.exportSnapshot();
  assert.equal(JSON.stringify(snapshot).includes(request.text), false);

  const restored = InMemoryTurnEvidenceStore.restore(runtime.sessions, snapshot, {
    idFactory: ids('withdrawal-restored'),
    now: runtime.now,
  });
  assert.equal(restored.get(saved.evidence.evidenceId), null);
  assert.equal(restored.getInvalidation(saved.evidence.evidenceId)?.reasonCode, 'ELDER_WITHDRAWN');
  assert.throws(() => restored.commitTypedText(handle, request), /invalidated/);

  clock.now = new Date(Date.parse(START) + DAY_MS).toISOString();
  assert.deepEqual(restored.purgeInvalidatedDue(clock.now), [saved.evidence.evidenceId]);
  const afterPurge = InMemoryTurnEvidenceStore.restore(
    runtime.sessions,
    restored.exportSnapshot(),
    { idFactory: ids('withdrawal-purged'), now: runtime.now },
  );
  assert.throws(() => afterPurge.commitTypedText(handle, request), /invalidated/);
});

test('damaged snapshots fail closed before any state is restored', () => {
  const clock = { now: START };
  const runtime = setup(clock);
  const store = new InMemoryTurnEvidenceStore(runtime.sessions, {
    idFactory: ids('damaged'),
    now: runtime.now,
  });
  const handle = runtime.open('turn-damaged');
  commit(store, handle, 'commit-damaged', '合法原文。');
  const valid = store.exportSnapshot();
  const variants: unknown[] = [
    { ...structuredClone(valid), unexpected: true },
    (() => {
      const value = structuredClone(valid);
      value.operations[0]!.fingerprint = '合法原文。';
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.issuedEvidenceIds = [];
      return value;
    })(),
    (() => {
      const value = structuredClone(valid);
      value.operations[0]!.status = 'INVALIDATED';
      return value;
    })(),
  ];
  for (const damaged of variants) {
    assert.throws(() => InMemoryTurnEvidenceStore.restore(
      runtime.sessions,
      damaged as TurnEvidenceStoreSnapshot,
      { idFactory: ids('rejected'), now: runtime.now },
    ));
  }
});

test('onMutation emits durable snapshots only for mutations; ASR partial remains ephemeral', () => {
  const clock = { now: START };
  const runtime = setup(clock);
  const snapshots: TurnEvidenceStoreSnapshot[] = [];
  const store = new InMemoryTurnEvidenceStore(runtime.sessions, {
    idFactory: ids('callback'),
    now: runtime.now,
    onMutation: snapshot => snapshots.push(snapshot),
  });
  const handle = runtime.open('turn-callback');
  store.observeAsrPartial(handle, {
    schemaVersion: 'asr-partial-observation-v0.1',
    partialId: 'partial-secret',
    text: '未完成的识别内容',
    receivedAt: START,
  });
  assert.equal(snapshots.length, 0);

  const saved = commit(store, handle, 'commit-callback', '最终文本。');
  assert.equal(snapshots.length, 1);
  assert.equal(JSON.stringify(snapshots[0]).includes('未完成的识别内容'), false);
  assert.equal(JSON.stringify(snapshots[0]).includes('partial-secret'), false);

  store.invalidateEvidence(saved.evidence.evidenceId, {
    actionId: 'withdraw-callback',
    actorId: AUTHORITY.actorId,
    occurredAt: START,
    reasonCode: 'ELDER_WITHDRAWN',
  });
  assert.equal(snapshots.length, 2);
  assert.equal(JSON.stringify(snapshots[1]).includes('最终文本。'), false);
  assert.deepEqual(store.purgeInvalidatedDue(START), []);
  assert.equal(snapshots.length, 2);

  clock.now = new Date(Date.parse(START) + DAY_MS).toISOString();
  assert.deepEqual(store.purgeInvalidatedDue(clock.now), [saved.evidence.evidenceId]);
  assert.equal(snapshots.length, 3);
});
