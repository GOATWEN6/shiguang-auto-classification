import assert from 'node:assert/strict';
import test from 'node:test';

import { InMemoryReferenceStore, type MemoryCandidate } from '../../../src/lib/memory-runtime/index.ts';
import {
  InMemoryGovernedSessionStore,
  InMemoryTurnEvidenceStore,
  TurnOrchestrator,
  createReferenceStoreRetentionGovernanceAdapter,
  type FinalTurnInput,
  type RetentionGovernanceAdapter,
  type TrustedSessionAuthority,
  type TurnResponseResult,
} from '../../../src/lib/turn-orchestrator/index.ts';

const START = '2026-10-09T08:00:00.000Z';
const FORTY_DAYS_MS = 40 * 24 * 60 * 60 * 1_000;
const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1', actorId: 'elder-test-actor',
  subjectId: 'elder-test', familySpaceId: 'family-test', authorizationVersion: 'auth-test-v1',
  visibilityScope: ['elder_only'],
};

function createRuntime(governance?: RetentionGovernanceAdapter) {
  let clock = START;
  let sequence = 0;
  let retentionScope: TurnResponseResult['retentionScope'] = 'NONE';
  const counters = { response: 0, tts: 0, jobs: 0 };
  const sessions = new InMemoryGovernedSessionStore({
    idFactory: { next: kind => `${kind}:${++sequence}` },
  });
  const evidenceStore = new InMemoryTurnEvidenceStore(sessions, {
    idFactory: { next: kind => `${kind}:${++sequence}` }, now: () => clock,
  });
  const noopAdapter = {
    async run() { throw new Error('unexpected async job'); },
    async commit() { return 'DROPPED' as const; },
  };
  const orchestrator = new TurnOrchestrator({
    sessions, evidenceStore, now: () => clock, id: () => `id-${++sequence}`,
    retentionGovernance: governance,
    processing: {
      async respond(request) {
        counters.response += 1;
        const raw = evidenceStore.get(request.identity.evidenceRefs[0]);
        assert.ok(raw);
        return {
          status: 'success', text: retentionScope === 'NONE' ? `承接：${raw.text}` : '已停止使用指定内容。',
          policyEngine: 'DailyChatPolicy', action: 'ACKNOWLEDGE', questionCount: 0,
          evidenceRefs: [...request.identity.evidenceRefs],
          retentionIntent: retentionScope === 'NONE' ? 'DEFAULT' : 'NO_SAVE',
          retentionScope, sessionControl: 'CONTINUE',
        };
      },
      async synthesize() { counters.tts += 1; return { status: 'success', audioChunkCount: 1 }; },
      planAsyncJobs() { counters.jobs += 1; return []; },
    },
    asyncAdapters: { MEMORY: noopAdapter, STORY: noopAdapter, PROFILE: noopAdapter },
  });
  return {
    orchestrator, evidenceStore, sessions, counters,
    clock(value: string) { clock = value; },
    scope(value: TurnResponseResult['retentionScope']) { retentionScope = value; },
  };
}

function start(orchestrator: TurnOrchestrator, token: string, authority = AUTHORITY) {
  return orchestrator.startSession({ schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: token, requestedMode: 'DAILY_CHAT' }, structuredClone(authority));
}

function input(token: string, text: string, receivedAt = START): FinalTurnInput {
  return { schemaVersion: 'orchestrated-turn-v0.1', idempotencyToken: token,
    source: 'TYPED_TEXT', text, receivedAt };
}

function candidate(claimId: string, evidenceRef: string, content: string): MemoryCandidate {
  return {
    claimId, proposalId: `proposal:${claimId}`, subjectId: AUTHORITY.subjectId,
    familySpaceId: AUTHORITY.familySpaceId, purpose: 'daily_chat',
    authorizationVersion: AUTHORITY.authorizationVersion,
    contentType: 'interaction_preference', normalizedClaim: content, evidenceRefs: [evidenceRef],
    sourceActor: { actorId: AUTHORITY.actorId, actorRole: 'elder' },
    eventTime: null, validFrom: null, validTo: null, authorityState: 'ELDER_SELF_REPORT',
    conflictState: 'NONE', handlingProfile: 'ordinary', retentionPolicy: 'LONG_TERM',
    importanceReasons: ['interaction_preference'], sensitivityLevel: 'S0', sensitivityCategories: [],
    disposition: 'AUTO_WRITE', confirmationBasis: 'explicit_item', allowedUses: ['daily_chat'],
    forbiddenUses: [], visibilityScope: ['elder_only'], reviewTrigger: 'elder_correction',
    expiryOrSupersedeRule: 'supersede_on_explicit_correction', mustNotHappen: ['silent_scope_expansion'],
    policyVersion: 'test-policy-v1', algorithmVersion: 'test-runtime-v1', temporalState: 'CURRENT',
    usageStatus: 'ACTIVE_CANDIDATE', relationships: [], reasonCodes: ['ELDER_EXPLICIT_CORRECTION'],
    writeEligibility: 'ELIGIBLE_FOR_BUSINESS_GATE', canonicalWritePerformed: false,
  };
}

function approve(store: InMemoryReferenceStore, claim: MemoryCandidate, id: string) {
  const record = store.submitCandidate(claim, { operationId: `submit:${id}`, submittedAt: START });
  return store.approveAutoWrite(record.recordId, {
    decisionId: `activate:${id}`, approved: true, deterministic: true,
    policyVersion: claim.policyVersion, reasonCodes: ['TEST'], decidedAt: START,
  });
}

test('withdrawal rejects old-key response and audio replay without additional work; unrelated evidence stays usable', async () => {
  const runtime = createRuntime();
  const session = start(runtime.orchestrator, 'replay-session');
  const untouchedInput = input('untouched', '我喜欢散步。');
  const untouched = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, untouchedInput);
  const originalInput = input('original', '我喜欢听评弹。');
  const original = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, originalInput);
  runtime.scope('PREVIOUS_COMPLETED_TURN');
  const withdrawal = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle,
    input('withdraw', '刚才那段请撤回。'));
  assert.equal(withdrawal.retentionEffect?.scope, 'PREVIOUS_COMPLETED_TURN');
  const counters = structuredClone(runtime.counters);
  const replay = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, originalInput);
  assert.equal(replay.errorCode, 'evidence_unavailable');
  assert.equal(replay.response, null);
  assert.deepEqual(replay.tts, { status: 'skipped', audioChunkCount: 0 });
  assert.deepEqual(replay.asyncJobs, []);
  assert.equal(runtime.orchestrator.isEvidenceUsable(original.evidenceId), false);
  assert.equal(runtime.orchestrator.isEvidenceUsable(untouched.evidenceId), true);
  assert.deepEqual(runtime.counters, counters);
  assert.equal((await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, untouchedInput)).response?.text,
    untouched.response?.text);
  assert.equal(JSON.stringify(runtime.orchestrator.getAuditRecords()).includes('评弹'), false);
});

test('CURRENT_SESSION withdraws all matching turns and preserves another subject/family session', async () => {
  const runtime = createRuntime();
  const session = start(runtime.orchestrator, 'whole-session');
  const first = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, input('one', '我以前种花。'));
  const second = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, input('two', '我也喜欢书法。'));
  const otherSession = start(runtime.orchestrator, 'other-session', {
    ...AUTHORITY, subjectId: 'elder-other', actorId: 'actor-other', familySpaceId: 'family-other',
  });
  const other = await runtime.orchestrator.runFinalTurn(otherSession.opaqueSessionHandle, input('other', '我喜欢读报。'));
  runtime.scope('CURRENT_SESSION');
  const result = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle,
    input('withdraw-all', '这次会话都不要保存。'));
  assert.equal(result.retentionEffect?.scope, 'CURRENT_SESSION');
  assert.equal(result.retentionEffect?.targetEvidenceRefHashes.length, 3);
  for (const id of [first.evidenceId, second.evidenceId, result.evidenceId]) assert.equal(runtime.evidenceStore.get(id), null);
  assert.ok(runtime.evidenceStore.get(other.evidenceId));
});

test('CURRENT_SESSION listing does not cross changed authorization or visibility scopes', async () => {
  const runtime = createRuntime();
  const session = start(runtime.orchestrator, 'scope-session');
  const first = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, input('private', '私人一段。'));
  const snapshot = runtime.orchestrator.getSessionSnapshot(session.opaqueSessionHandle);
  runtime.sessions.compareAndSwap({ schemaVersion: 'trusted-session-cas-v0.1', sessionId: snapshot.sessionId,
    expectedStateVersion: snapshot.stateVersion, operationId: 'change-authority',
    patch: { authorizationVersion: 'auth-test-v2', visibilityScope: ['family_shared'] } });
  runtime.scope('CURRENT_SESSION');
  const second = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle,
    input('shared-withdraw', '这次会话不要存。'));
  assert.equal(second.retentionEffect?.targetEvidenceRefHashes.length, 1);
  assert.ok(runtime.evidenceStore.get(first.evidenceId));
  assert.equal(runtime.evidenceStore.get(second.evidenceId), null);
  // Old content may still be retained under its original scope, but cannot be
  // replayed through the session after its authorization/visibility changed.
  assert.equal(runtime.orchestrator.isEvidenceUsable(first.evidenceId), false);
  const oldReplay = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle,
    input('private', '私人一段。'));
  assert.equal(oldReplay.response, null);
});

test('CURRENT_TOPIC without topic evidence fails explicitly and never silently deletes another scope', async () => {
  const runtime = createRuntime();
  const session = start(runtime.orchestrator, 'topic-session');
  const first = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, input('topic-one', '以前教过木工。'));
  runtime.scope('CURRENT_TOPIC');
  const second = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle,
    input('topic-withdraw', '这个话题不要存。'));
  assert.equal(second.status, 'error');
  assert.equal(second.errorCode, 'retention_scope_unresolved');
  assert.equal(second.retentionEffect, null);
  assert.equal(second.response?.status, 'fallback');
  assert.ok(runtime.evidenceStore.get(first.evidenceId));
  assert.ok(runtime.evidenceStore.get(second.evidenceId));
});

test('40-day server-clock expiry blocks replay at boundary and propagates deletion once', async () => {
  const batches: string[][] = [];
  const runtime = createRuntime({ async withdraw(request) {
    batches.push([...request.evidenceRefs]);
    return { status: 'APPLIED', evidenceRefHashes: [], withdrawnRecordIds: ['record:expired'],
      invalidatedArtifactRefs: ['story:expired'] };
  } });
  const session = start(runtime.orchestrator, 'expiry-session');
  // A future client timestamp does not extend retention.
  const request = input('expiry-turn', '我爱修收音机。', '2099-01-01T00:00:00.000Z');
  const result = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, request);
  runtime.clock(new Date(Date.parse(START) + FORTY_DAYS_MS - 1).toISOString());
  assert.ok(runtime.evidenceStore.get(result.evidenceId));
  runtime.clock(new Date(Date.parse(START) + FORTY_DAYS_MS).toISOString());
  assert.equal(runtime.evidenceStore.get(result.evidenceId), null);
  const counters = structuredClone(runtime.counters);
  const replay = await runtime.orchestrator.runFinalTurn(session.opaqueSessionHandle, request);
  assert.equal(replay.response, null);
  assert.deepEqual(runtime.counters, counters);
  const sweep = await runtime.orchestrator.sweepExpiredEvidence();
  assert.equal(sweep.status, 'APPLIED');
  assert.equal(sweep.withdrawnRecordCount, 1);
  assert.equal(sweep.invalidatedArtifactCount, 1);
  assert.deepEqual(batches, [[result.evidenceId]]);
  const again = await runtime.orchestrator.sweepExpiredEvidence();
  assert.equal(again.evidenceRefHashes.length, 0);
  assert.equal(batches.length, 1);
});

test('Evidence commit keys stay no-content guards after withdrawal and 24-hour purge', () => {
  const runtime = createRuntime();
  const session = start(runtime.orchestrator, 'raw-idempotency-session');
  const snapshot = runtime.orchestrator.getSessionSnapshot(session.opaqueSessionHandle);
  const opened = runtime.sessions.openTurn({ schemaVersion: 'client-turn-open-v0.1',
    sessionId: snapshot.sessionId, idempotencyToken: 'raw-turn' });
  const request = { schemaVersion: 'typed-text-final-v0.1' as const,
    idempotencyToken: 'raw-evidence', text: '必须删除的原文。', receivedAt: START };
  const commit = runtime.evidenceStore.commitTypedText(opened.handle, request);
  const tombstone = runtime.evidenceStore.invalidateEvidence(commit.evidence.evidenceId, {
    actionId: 'raw-withdraw', actorId: AUTHORITY.actorId, occurredAt: START, reasonCode: 'ELDER_WITHDRAWN',
  });
  assert.ok(tombstone);
  assert.equal('text' in tombstone, false);
  assert.throws(() => runtime.evidenceStore.commitTypedText(opened.handle, request), /invalidated/);
  const purgeAt = new Date(Date.parse(START) + 24 * 60 * 60 * 1_000).toISOString();
  assert.deepEqual(runtime.evidenceStore.purgeInvalidatedDue(purgeAt), [commit.evidence.evidenceId]);
  assert.throws(() => runtime.evidenceStore.commitTypedText(opened.handle, request), /invalidated/);
  assert.deepEqual(runtime.evidenceStore.purgeInvalidatedDue(purgeAt), []);
});

test('Reference withdrawal removes all affected logical versions and leaves unrelated content usable', async () => {
  const store = new InMemoryReferenceStore();
  const first = approve(store, candidate('claim-same', 'evidence:shared', '我喜欢兰花。'), 'first');
  const correctedCandidate = candidate('claim-corrected', 'evidence:shared', '我喜欢荷花。');
  const corrected = store.correct(first.recordId, correctedCandidate, {
    decisionId: 'correct-decision', approved: true, deterministic: true, policyVersion: correctedCandidate.policyVersion,
    reasonCodes: ['TEST'], decidedAt: START,
  }, { operationId: 'correct-operation', submittedAt: START });
  const unrelated = approve(store, candidate('claim-other', 'evidence:other', '我喜欢听越剧。'), 'other');
  const adapter = createReferenceStoreRetentionGovernanceAdapter({ referenceStore: store });
  const result = await adapter.withdraw({ actionId: 'withdraw-shared', actorId: AUTHORITY.actorId,
    occurredAt: START, reasonCode: 'ELDER_WITHDRAWN', evidenceRefs: ['evidence:shared'] });
  assert.deepEqual(result.withdrawnRecordIds, [first.recordId, corrected.recordId]);
  for (const id of [first.recordId, corrected.recordId]) {
    const record = store.get(id);
    assert.equal(record?.status, 'DELETED');
    assert.equal(record && 'candidate' in record, false);
  }
  assert.equal(store.get(unrelated.recordId)?.status, 'ACTIVE');
  const restored = InMemoryReferenceStore.restore(store.exportSnapshot());
  assert.equal(restored.get(first.recordId)?.status, 'DELETED');
  assert.equal(restored.get(unrelated.recordId)?.status, 'ACTIVE');
});

test('withdrawing an old source deletes its obsolete version and preserves independently corrected evidence', async () => {
  const store = new InMemoryReferenceStore();
  const old = approve(store, candidate('claim-updated', 'evidence:old', '我以前喜欢跳舞。'), 'old');
  const newCandidate = candidate('claim-new', 'evidence:new', '我现在喜欢散步。');
  const current = store.correct(old.recordId, newCandidate, {
    decisionId: 'independent-correction', approved: true, deterministic: true,
    policyVersion: newCandidate.policyVersion, reasonCodes: ['TEST'], decidedAt: START,
  }, { operationId: 'independent-correction-operation', submittedAt: START });
  const adapter = createReferenceStoreRetentionGovernanceAdapter({ referenceStore: store });
  await adapter.withdraw({ actionId: 'withdraw-old', actorId: AUTHORITY.actorId, occurredAt: START,
    reasonCode: 'ELDER_WITHDRAWN', evidenceRefs: ['evidence:old'] });
  const oldAfter = store.get(old.recordId);
  assert.equal(oldAfter?.status, 'DELETED');
  assert.equal(oldAfter && 'candidate' in oldAfter, false);
  assert.equal(store.get(current.recordId)?.status, 'ACTIVE');
  const retrieved = store.retrieve({ subjectId: AUTHORITY.subjectId, familySpaceId: AUTHORITY.familySpaceId,
    authorizationVersion: AUTHORITY.authorizationVersion, visibilityScope: ['elder_only'], purpose: 'daily_chat' });
  assert.deepEqual(retrieved.map(record => record.recordId), [current.recordId]);
});
