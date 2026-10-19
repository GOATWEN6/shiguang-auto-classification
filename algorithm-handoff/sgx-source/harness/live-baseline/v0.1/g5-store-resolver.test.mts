import assert from 'node:assert/strict';
import test from 'node:test';

import type { TranscriptEvidence } from '../../../src/lib/asr-runtime/contracts.ts';
import {
  InMemoryGovernedSessionStore,
} from '../../../src/lib/turn-orchestrator/session-store.ts';
import {
  InMemoryTurnEvidenceStore,
} from '../../../src/lib/turn-orchestrator/evidence-store.ts';
import {
  createDailyChatAccessContextResolver,
  createDailyChatReferenceResolver,
  createInterviewDecisionRequestResolver,
} from '../../../src/lib/turn-orchestrator/resolvers.ts';
import type {
  GovernedIdFactory,
  TrustedSessionAuthority,
} from '../../../src/lib/turn-orchestrator/contracts.ts';

function ids(prefix: string): GovernedIdFactory {
  let sequence = 0;
  return { next(kind) { sequence += 1; return `${prefix}-${kind}-${sequence}`; } };
}

const AUTHORITY_A: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-a',
  subjectId: 'elder-a',
  familySpaceId: 'family-a',
  authorizationVersion: 'auth-a-v1',
  visibilityScope: ['elder_only'],
};

const AUTHORITY_B: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-b',
  subjectId: 'elder-b',
  familySpaceId: 'family-b',
  authorizationVersion: 'auth-b-v1',
  visibilityScope: ['family_shared'],
};

function start(
  store: InMemoryGovernedSessionStore,
  token: string,
  mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW',
  authority: TrustedSessionAuthority = AUTHORITY_A,
) {
  return store.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: token,
    requestedMode: mode,
  }, authority);
}

function open(store: InMemoryGovernedSessionStore, sessionId: string, token: string) {
  return store.openTurn({
    schemaVersion: 'client-turn-open-v0.1',
    sessionId,
    idempotencyToken: token,
  });
}

test('client requests are exact-key and all authority plus runtime identity is server-derived', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s1') });
  assert.throws(() => sessions.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: 'start-1',
    requestedMode: 'DAILY_CHAT',
    actorId: 'forged',
  } as any, AUTHORITY_A), /actorId is not allowed/);

  const started = start(sessions, 'start-1', 'DAILY_CHAT');
  assert.equal(started.replayed, false);
  assert.equal(started.session.actorId, AUTHORITY_A.actorId);
  assert.equal(started.session.subjectId, AUTHORITY_A.subjectId);
  assert.equal(started.session.familySpaceId, AUTHORITY_A.familySpaceId);
  assert.notEqual(started.session.sessionEpoch, 'client-epoch');

  assert.throws(() => sessions.openTurn({
    schemaVersion: 'client-turn-open-v0.1',
    sessionId: started.session.sessionId,
    idempotencyToken: 'turn-1',
    generationId: 999,
  } as any), /generationId is not allowed/);
  const opened = open(sessions, started.session.sessionId, 'turn-1');
  assert.equal(opened.handle.identity.sessionEpoch, started.session.sessionEpoch);
  assert.equal(opened.handle.identity.generationId, 1);
  assert.equal(opened.handle.identity.evidenceRefs.length, 0);
  assert.ok(opened.handle.identity.turnId.startsWith('s1-turn-'));
  assert.ok(opened.handle.identity.invocationId.startsWith('s1-invocation-'));
  assert.ok(opened.handle.identity.responseId?.startsWith('s1-response-'));
});

test('session start, turn open, and state CAS are idempotent and reject conflicting replay or stale version', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s2') });
  const first = start(sessions, 'start-idem', 'DAILY_CHAT');
  const replay = start(sessions, 'start-idem', 'DAILY_CHAT');
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.session, first.session);
  assert.throws(
    () => start(sessions, 'start-idem', 'FORMAL_INTERVIEW'),
    /idempotencyToken reused with a different payload/,
  );

  const opened = open(sessions, first.session.sessionId, 'turn-idem');
  const openedReplay = open(sessions, first.session.sessionId, 'turn-idem');
  assert.equal(openedReplay.replayed, true);
  assert.deepEqual(openedReplay.handle.identity, opened.handle.identity);

  const expectedStateVersion = sessions.getSession(first.session.sessionId)!.stateVersion;
  const updated = sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1',
    sessionId: first.session.sessionId,
    expectedStateVersion,
    operationId: 'cas-1',
    patch: { status: 'RECOVERING' },
  });
  assert.equal(updated.status, 'RECOVERING');
  assert.equal(updated.stateVersion, expectedStateVersion + 1);
  assert.deepEqual(sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1',
    sessionId: first.session.sessionId,
    expectedStateVersion,
    operationId: 'cas-1',
    patch: { status: 'RECOVERING' },
  }), updated);
  assert.throws(() => sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1',
    sessionId: first.session.sessionId,
    expectedStateVersion,
    operationId: 'cas-stale',
    patch: { status: 'ACTIVE' },
  }), /state version mismatch/);
  assert.throws(() => sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1',
    sessionId: first.session.sessionId,
    expectedStateVersion: updated.stateVersion,
    operationId: 'cas-forged',
    patch: { actorId: 'forged' } as any,
  }), /actorId is not allowed/);
});

test('trusted CAS requires bound elder evidence for mode change and supports PAUSED to ACTIVE recovery', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s2b') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e2b') });
  const session = start(sessions, 'start', 'DAILY_CHAT').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;
  const committed = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'explicit-mode-request',
    text: '我想正式聊聊小时候的事。', receivedAt: '2026-10-03T00:30:00.000Z',
  });
  const beforeSwitch = sessions.getSession(session.sessionId)!;
  assert.throws(() => sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: beforeSwitch.stateVersion, operationId: 'switch-without-evidence',
    patch: { mode: 'FORMAL_INTERVIEW' } as any,
  }), /mode and modeChangeEvidenceRef must be provided together/);
  assert.throws(() => sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: beforeSwitch.stateVersion, operationId: 'switch-forged-evidence',
    patch: { mode: 'FORMAL_INTERVIEW', modeChangeEvidenceRef: 'forged-ref' },
  }), /requires evidence bound to the active turn/);

  const switched = sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: beforeSwitch.stateVersion, operationId: 'switch-valid',
    patch: {
      mode: 'FORMAL_INTERVIEW',
      modeChangeEvidenceRef: committed.evidence.evidenceId,
    },
  });
  assert.equal(switched.mode, 'FORMAL_INTERVIEW');
  const paused = sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: switched.stateVersion, operationId: 'pause',
    patch: { status: 'PAUSED' },
  });
  const resumed = sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: paused.stateVersion, operationId: 'resume',
    patch: { status: 'ACTIVE' },
  });
  assert.equal(resumed.status, 'ACTIVE');
  const formalTurn = open(sessions, session.sessionId, 'formal-turn').handle;
  assert.equal(formalTurn.mode, 'FORMAL_INTERVIEW');
  const formalCommit = evidence.commitTypedText(formalTurn, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'formal-input',
    text: '我小时候住在河边。', receivedAt: '2026-10-03T00:31:00.000Z',
  });
  const resolved = createInterviewDecisionRequestResolver(sessions, evidence)
    .resolve(formalCommit.boundTurn.identity);
  assert.equal(resolved.input.mode, 'FORMAL_INTERVIEW');
  assert.equal(resolved.input.asr.text, '我小时候住在河边。');
});

test('terminal sessions cannot be reopened through trusted CAS', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s2c') });
  const session = start(sessions, 'start', 'DAILY_CHAT').session;
  const ended = sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: session.stateVersion, operationId: 'end',
    patch: { status: 'ENDED' },
  });
  assert.throws(() => sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: ended.stateVersion, operationId: 'forged-reopen',
    patch: { status: 'ACTIVE' },
  }), /ENDED session cannot transition/);
});

test('ASR partial remains ephemeral while typed final becomes immutable bound evidence', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s3') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e3') });
  const session = start(sessions, 'start', 'DAILY_CHAT').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;

  const partial = evidence.observeAsrPartial(turn, {
    schemaVersion: 'asr-partial-observation-v0.1',
    partialId: 'partial-provider-ref',
    text: '今天天',
    receivedAt: '2026-10-03T01:00:00.000Z',
  });
  assert.deepEqual(partial, { status: 'WAIT' });
  assert.equal(evidence.get('partial-provider-ref'), null);
  assert.equal(sessions.resolveBoundTurn(turn.identity), null);

  const committed = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1',
    idempotencyToken: 'typed-event-1',
    text: '今天天气很好。',
    receivedAt: '2026-10-03T01:00:01.000Z',
  });
  assert.equal(committed.evidence.source, 'TYPED_TEXT');
  assert.equal(committed.evidence.text, '今天天气很好。');
  assert.deepEqual(committed.boundTurn.identity.evidenceRefs, [committed.evidence.evidenceId]);
  assert.equal(committed.boundTurn.identity.responseId, turn.identity.responseId);

  const replay = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1',
    idempotencyToken: 'typed-event-1',
    text: '今天天气很好。',
    receivedAt: '2026-10-03T01:00:01.000Z',
  });
  assert.deepEqual(replay, committed);
  assert.throws(() => evidence.commitTypedText(structuredClone(turn) as any, {
    schemaVersion: 'typed-text-final-v0.1',
    idempotencyToken: 'typed-event-1',
    text: '今天天气很好。',
    receivedAt: '2026-10-03T01:00:01.000Z',
  }), /turn handle was not issued by this store/);
  assert.throws(() => evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1',
    idempotencyToken: 'typed-event-1',
    text: '篡改后的文本',
    receivedAt: '2026-10-03T01:00:01.000Z',
  }), /idempotencyToken reused with a different payload/);
});

test('ASR final aggregates trusted segment evidence and rejects same-ref text tampering', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s4') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e4') });
  const session = start(sessions, 'start', 'FORMAL_INTERVIEW').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;
  const segment = (evidenceId: string, segmentIndex: number, text: string): TranscriptEvidence => ({
    kind: 'transcript_final', evidenceId, segmentKey: `segment-${segmentIndex}`,
    identity: structuredClone(turn.identity), attemptId: 'attempt-1', connectionId: 'connection-1',
    receivedAt: '2026-10-03T02:00:00.000Z', providerSequence: segmentIndex + 1,
    segmentIndex, revision: 1, text,
  });
  const segments = [segment('asr-segment-0', 0, '我年轻时'), segment('asr-segment-1', 1, '住在苏州。')];
  const committed = evidence.commitAsrFinal(turn, {
    schemaVersion: 'asr-turn-final-v0.1',
    idempotencyToken: 'asr-final-1',
    receivedAt: '2026-10-03T02:00:01.000Z',
    segments,
  });
  assert.equal(committed.evidence.source, 'ASR_FINAL');
  assert.equal(committed.evidence.text, '我年轻时住在苏州。');
  assert.deepEqual(committed.evidence.sourceRefs, ['asr-segment-0', 'asr-segment-1']);

  const second = open(sessions, session.sessionId, 'turn-2').handle;
  const forged = segment('asr-segment-0', 0, '同一个 ref 的篡改文本');
  forged.identity = structuredClone(second.identity);
  assert.throws(() => evidence.commitAsrFinal(second, {
    schemaVersion: 'asr-turn-final-v0.1',
    idempotencyToken: 'asr-final-2',
    receivedAt: '2026-10-03T02:00:02.000Z',
    segments: [forged],
  }), /ASR evidence ref reused with a different payload/);
});

test('DailyChat resolvers expose only exact-bound evidence in the authoritative family and scope', async () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s5') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e5') });
  const session = start(sessions, 'start', 'DAILY_CHAT').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;
  const committed = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'typed-1',
    text: '今天看见一盆兰花。', receivedAt: '2026-10-03T03:00:00.000Z',
  });
  const accessResolver = createDailyChatAccessContextResolver(sessions);
  const referenceResolver = createDailyChatReferenceResolver(sessions, evidence);
  const access = await accessResolver.resolve(committed.boundTurn.identity);
  assert.deepEqual(access, {
    subjectId: AUTHORITY_A.subjectId,
    familySpaceId: AUTHORITY_A.familySpaceId,
    authorizationVersion: AUTHORITY_A.authorizationVersion,
    visibilityScope: AUTHORITY_A.visibilityScope,
  });
  assert.deepEqual(
    await referenceResolver.resolve(committed.evidence.evidenceId, access!, committed.boundTurn.identity),
    {
      ref: committed.evidence.evidenceId,
      text: '今天看见一盆兰花。',
      purpose: 'daily_chat',
      subjectId: AUTHORITY_A.subjectId,
      familySpaceId: AUTHORITY_A.familySpaceId,
      authorizationVersion: AUTHORITY_A.authorizationVersion,
      visibilityScope: AUTHORITY_A.visibilityScope,
    },
  );
  assert.equal(await referenceResolver.resolve(committed.evidence.evidenceId, {
    ...access!, familySpaceId: AUTHORITY_B.familySpaceId,
  }, committed.boundTurn.identity), null);

  assert.equal(await accessResolver.resolve({
    ...committed.boundTurn.identity,
    responseId: 'forged-response',
  }), null);
  await assert.rejects(async () => accessResolver.resolve({
    ...committed.boundTurn.identity,
    actorId: 'forged',
  } as any), /actorId is not allowed/);
});

test('authorization rotation invalidates already-bound DailyChat evidence and resolver output', async () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s6') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e6') });
  const session = start(sessions, 'start', 'DAILY_CHAT').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;
  const committed = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'typed-1',
    text: '只在旧授权下可见。', receivedAt: '2026-10-03T04:00:00.000Z',
  });
  const current = sessions.getSession(session.sessionId)!;
  sessions.compareAndSwap({
    schemaVersion: 'trusted-session-cas-v0.1', sessionId: session.sessionId,
    expectedStateVersion: current.stateVersion, operationId: 'rotate-auth',
    patch: { authorizationVersion: 'auth-a-v2' },
  });
  const accessResolver = createDailyChatAccessContextResolver(sessions);
  const referenceResolver = createDailyChatReferenceResolver(sessions, evidence);
  assert.equal(await accessResolver.resolve(committed.boundTurn.identity), null);
  assert.equal(await referenceResolver.resolve(committed.evidence.evidenceId, {
    subjectId: AUTHORITY_A.subjectId, familySpaceId: AUTHORITY_A.familySpaceId,
    authorizationVersion: 'auth-a-v2', visibilityScope: [...AUTHORITY_A.visibilityScope],
  }, committed.boundTurn.identity), null);
});

test('Interview resolver constructs policy from trusted state and immutable evidence only', () => {
  const sessions = new InMemoryGovernedSessionStore({
    idFactory: ids('s7'),
    interviewStateFactory: () => ({
      currentTopic: 'childhood-home', selectedTopic: 'childhood-home',
      pendingModeOffer: null, followUpDepth: 1, blockedTopics: ['family-conflict'],
    }),
  });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e7') });
  const session = start(sessions, 'start', 'FORMAL_INTERVIEW').session;
  const turn = open(sessions, session.sessionId, 'turn').handle;
  const committed = evidence.commitTypedText(turn, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'typed-1',
    text: '我小时候住在河边。', receivedAt: '2026-10-03T05:00:00.000Z',
  });
  const resolver = createInterviewDecisionRequestResolver(sessions, evidence);
  const request = resolver.resolve(committed.boundTurn.identity);
  assert.equal(request.input.mode, 'FORMAL_INTERVIEW');
  assert.equal(request.input.sessionEpoch, committed.boundTurn.identity.sessionEpoch);
  assert.equal(request.input.runtime.generationId, committed.boundTurn.identity.generationId);
  assert.deepEqual(request.input.asr, {
    status: 'FINAL', text: '我小时候住在河边。', ref: committed.evidence.evidenceId,
  });
  assert.equal(request.input.currentTopic, 'childhood-home');
  assert.deepEqual(request.input.blockedTopics, ['family-conflict']);
  assert.deepEqual(request.identity, committed.boundTurn.identity);

  request.input.asr.text = '调用方本地篡改';
  assert.equal(resolver.resolve(committed.boundTurn.identity).input.asr.text, '我小时候住在河边。');
  assert.throws(() => resolver.resolve({
    ...committed.boundTurn.identity,
    evidenceRefs: ['forged-evidence'],
  }), /no exact bound turn/);
  assert.throws(() => resolver.resolve({
    ...committed.boundTurn.identity,
    responseId: undefined,
  }), /no exact bound turn/);
});

test('evidence and identity cannot be rebound across sessions or families', () => {
  const sessions = new InMemoryGovernedSessionStore({ idFactory: ids('s8') });
  const evidence = new InMemoryTurnEvidenceStore(sessions, { idFactory: ids('e8') });
  const sessionA = start(sessions, 'start-a', 'DAILY_CHAT', AUTHORITY_A).session;
  const sessionB = start(sessions, 'start-b', 'DAILY_CHAT', AUTHORITY_B).session;
  const turnA = open(sessions, sessionA.sessionId, 'turn-a').handle;
  const turnB = open(sessions, sessionB.sessionId, 'turn-b').handle;
  const committedA = evidence.commitTypedText(turnA, {
    schemaVersion: 'typed-text-final-v0.1', idempotencyToken: 'typed-a',
    text: '家庭 A 的内容', receivedAt: '2026-10-03T06:00:00.000Z',
  });
  const resolver = createDailyChatReferenceResolver(sessions, evidence);
  assert.equal(resolver.resolve(committedA.evidence.evidenceId, {
    subjectId: AUTHORITY_B.subjectId,
    familySpaceId: AUTHORITY_B.familySpaceId,
    authorizationVersion: AUTHORITY_B.authorizationVersion,
    visibilityScope: [...AUTHORITY_B.visibilityScope],
  }, turnB.identity), null);
});
