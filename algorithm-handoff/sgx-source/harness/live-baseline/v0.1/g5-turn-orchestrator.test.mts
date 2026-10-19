import assert from 'node:assert/strict';
import test from 'node:test';

import type { RuntimeIdentity } from '../../../src/lib/algorithm-runtime/index.ts';
import {
  InMemoryReferenceStore,
  type MemoryCandidate,
} from '../../../src/lib/memory-runtime/index.ts';
import {
  createReferenceStoreRetentionGovernanceAdapter,
  InMemoryGovernedSessionStore,
  InMemoryTurnEvidenceStore,
  TurnOrchestrator,
  type AsyncJobAdapter,
  type AsyncJobRequest,
  type RetentionGovernanceAdapter,
  type TrustedSessionAuthority,
  type TurnPhase,
  type TurnProcessingAdapter,
  type TurnResponseResult,
} from '../../../src/lib/turn-orchestrator/index.ts';

const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-fiction-001',
  subjectId: 'elder-fiction-001',
  familySpaceId: 'family-fiction-001',
  authorizationVersion: 'auth-g5-v0.1',
  visibilityScope: ['elder_only'],
};

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function authority(overrides: Partial<TrustedSessionAuthority> = {}): TrustedSessionAuthority {
  return { ...structuredClone(AUTHORITY), ...overrides };
}

function successfulResponse(mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW'): TurnResponseResult {
  return {
    status: 'success',
    text: mode === 'DAILY_CHAT' ? '我们慢慢聊。' : '您愿意再说说当时的情形吗？',
    policyEngine: mode === 'DAILY_CHAT' ? 'DailyChatPolicy' : 'InterviewPolicyV0.2',
    action: mode === 'DAILY_CHAT' ? 'RESPOND' : 'FOLLOW_UP',
    questionCount: mode === 'DAILY_CHAT' ? 0 : 1,
    evidenceRefs: [],
    retentionIntent: 'DEFAULT',
    retentionScope: 'NONE',
    sessionControl: 'CONTINUE',
  };
}

interface FakeCounters {
  response: number;
  tts: number;
  planned: number;
  run: Record<'MEMORY' | 'STORY' | 'PROFILE', number>;
  commit: Record<'MEMORY' | 'STORY' | 'PROFILE', number>;
  modes: string[];
}

function fakeRuntime(options: {
  phaseHook?: (phase: TurnPhase) => Promise<void> | void;
  planJobs?: boolean;
  response?: (mode: 'DAILY_CHAT' | 'FORMAL_INTERVIEW') => TurnResponseResult;
  retentionGovernance?: RetentionGovernanceAdapter;
} = {}) {
  const counters: FakeCounters = {
    response: 0,
    tts: 0,
    planned: 0,
    run: { MEMORY: 0, STORY: 0, PROFILE: 0 },
    commit: { MEMORY: 0, STORY: 0, PROFILE: 0 },
    modes: [],
  };
  const processing: TurnProcessingAdapter = {
    async respond(request) {
      counters.response += 1;
      counters.modes.push(request.mode);
      if (request.signal.aborted) return { ...successfulResponse(request.mode), status: 'cancelled', text: '' };
      return (options.response ?? successfulResponse)(request.mode);
    },
    async synthesize(request) {
      counters.tts += 1;
      return request.signal.aborted
        ? { status: 'cancelled', audioChunkCount: 0 }
        : { status: 'success', audioChunkCount: 2 };
    },
    planAsyncJobs(request) {
      counters.planned += 1;
      if (options.planJobs === false) return [];
      return (['MEMORY', 'STORY', 'PROFILE'] as const).map(kind => ({
        jobId: `${kind.toLowerCase()}:${request.identity.turnId}`,
        kind,
        inputRef: `input:${request.identity.turnId}`,
        payloadFingerprint: `fp:${kind}:${request.identity.turnId}`,
        evidenceRefs: [...request.identity.evidenceRefs],
      } satisfies AsyncJobRequest));
    },
  };
  const adapter = (kind: 'MEMORY' | 'STORY' | 'PROFILE'): AsyncJobAdapter => ({
    async run(context) {
      counters.run[kind] += 1;
      return context.signal.aborted
        ? { ok: false, errorCode: 'cancelled' }
        : { ok: true, resultId: `result:${kind}:${context.jobId}`, value: { opaque: true } };
    },
    async commit(context) {
      counters.commit[kind] += 1;
      return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED';
    },
  });
  const ids = sequence('opaque');
  const sessions = new InMemoryGovernedSessionStore({
    idFactory: { next: kind => `${kind}:${ids()}` },
  });
  const evidenceStore = new InMemoryTurnEvidenceStore(sessions, {
    idFactory: { next: kind => `${kind}:${ids()}` },
  });
  const orchestrator = new TurnOrchestrator({
    sessions,
    evidenceStore,
    processing,
    asyncAdapters: {
      MEMORY: adapter('MEMORY'),
      STORY: adapter('STORY'),
      PROFILE: adapter('PROFILE'),
    },
    retentionGovernance: options.retentionGovernance,
    phaseHook: options.phaseHook ? phase => options.phaseHook?.(phase) : undefined,
    id: ids,
    asyncSettlementTimeoutMs: 200,
  });
  return { orchestrator, counters };
}

function eligiblePreferenceCandidate(
  evidenceRef: string,
  suffix: string,
): MemoryCandidate {
  return {
    claimId: `claim-${suffix}`,
    proposalId: `proposal-${suffix}`,
    subjectId: AUTHORITY.subjectId,
    familySpaceId: AUTHORITY.familySpaceId,
    purpose: 'daily_chat',
    authorizationVersion: AUTHORITY.authorizationVersion,
    contentType: 'interaction_preference',
    normalizedClaim: suffix === 'target' ? '老人喜欢兰花。' : '老人喜欢听越剧。',
    evidenceRefs: [evidenceRef],
    sourceActor: { actorId: AUTHORITY.actorId, actorRole: 'elder' },
    eventTime: null,
    validFrom: null,
    validTo: null,
    authorityState: 'ELDER_SELF_REPORT',
    conflictState: 'NONE',
    handlingProfile: 'ordinary',
    retentionPolicy: 'LONG_TERM',
    importanceReasons: ['interaction_preference'],
    sensitivityLevel: 'S0',
    sensitivityCategories: [],
    disposition: 'AUTO_WRITE',
    confirmationBasis: 'explicit_item',
    allowedUses: ['daily_chat'],
    forbiddenUses: [],
    visibilityScope: [...AUTHORITY.visibilityScope],
    reviewTrigger: 'elder_correction',
    expiryOrSupersedeRule: 'supersede_on_explicit_correction',
    mustNotHappen: ['silent_scope_expansion'],
    policyVersion: 'memory-policy-test-v1',
    algorithmVersion: 'memory-runtime-test-v1',
    temporalState: 'CURRENT',
    usageStatus: 'ACTIVE_CANDIDATE',
    relationships: [],
    reasonCodes: ['ELDER_EXPLICIT_PREFERENCE'],
    writeEligibility: 'ELIGIBLE_FOR_BUSINESS_GATE',
    canonicalWritePerformed: false,
  };
}

function start(orchestrator: TurnOrchestrator, token = 'start-1') {
  return orchestrator.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: token,
    requestedMode: 'DAILY_CHAT',
  }, authority());
}

function finalRequest(token: string, text = '我喜欢兰花。') {
  return {
    schemaVersion: 'orchestrated-turn-v0.1' as const,
    idempotencyToken: token,
    source: 'TYPED_TEXT' as const,
    text,
    receivedAt: '2026-10-03T08:00:00.000Z',
  };
}

test('partial stays ephemeral; final drives isolated response, TTS, and async jobs exactly once', async () => {
  const { orchestrator, counters } = fakeRuntime();
  const session = start(orchestrator);
  const partial = orchestrator.observePartial(session.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-partial-v0.1',
    idempotencyToken: 'partial-1',
    partialId: 'partial-a',
    text: '我喜欢',
    receivedAt: '2026-10-03T08:00:00.000Z',
  });
  assert.equal(partial.status, 'WAIT');
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 0, acceptedInterrupts: 0, networkCalls: 0, costCny: 0,
  });
  assert.deepEqual(counters, {
    response: 0, tts: 0, planned: 0,
    run: { MEMORY: 0, STORY: 0, PROFILE: 0 },
    commit: { MEMORY: 0, STORY: 0, PROFILE: 0 }, modes: [],
  });

  const interrupted = orchestrator.interrupt(session.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-interrupt-v0.1',
    idempotencyToken: 'interrupt-partial-1',
    targetHandle: partial.targetHandle,
    reason: 'user_restart_utterance',
  });
  assert.equal(interrupted.accepted, true);
  const replayedInterrupt = orchestrator.interrupt(session.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-interrupt-v0.1',
    idempotencyToken: 'interrupt-partial-1',
    targetHandle: partial.targetHandle,
    reason: 'user_restart_utterance',
  });
  assert.equal(replayedInterrupt.replayed, true);
  assert.equal(replayedInterrupt.interruptId, interrupted.interruptId);

  const request = finalRequest('final-1');
  const result = await orchestrator.runFinalTurn(session.opaqueSessionHandle, request);
  assert.equal(result.status, 'completed');
  assert.equal(result.mode, 'DAILY_CHAT');
  assert.equal(result.canonicalWriteCount, 0);
  assert.equal(result.tts.status, 'success');
  assert.deepEqual(result.asyncJobs.map(item => [item.kind, item.status]), [
    ['MEMORY', 'success'], ['PROFILE', 'success'], ['STORY', 'success'],
  ]);
  assert.deepEqual(counters.run, { MEMORY: 1, STORY: 1, PROFILE: 1 });
  assert.deepEqual(counters.commit, { MEMORY: 1, STORY: 1, PROFILE: 1 });

  const replay = await orchestrator.runFinalTurn(session.opaqueSessionHandle, request);
  assert.deepEqual(replay, result);
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 1, acceptedInterrupts: 1, networkCalls: 0, costCny: 0,
  });
  assert.equal(JSON.stringify(orchestrator.getAuditRecords()).includes(request.text), false);
  assert.throws(() => orchestrator.runFinalTurn(
    session.opaqueSessionHandle,
    finalRequest('final-1', '冲突内容'),
  ), /different final payload/);
});

test('explicit governed UI action switches the next turn into formal Interview mode', async () => {
  const { orchestrator, counters } = fakeRuntime({ planJobs: false });
  const session = start(orchestrator);
  await orchestrator.runFinalTurn(session.opaqueSessionHandle, finalRequest('daily-1'));

  const result = await orchestrator.runFinalTurn(session.opaqueSessionHandle, {
    ...finalRequest('interview-1', '我们聊聊以前在纺织厂的事吧。'),
    uiAction: {
      type: 'MEMORY_TOPIC_CLICK',
      eventRef: 'ui:fictional:interview-1',
      targetMode: 'FORMAL_INTERVIEW',
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.mode, 'FORMAL_INTERVIEW');
  assert.deepEqual(counters.modes, ['DAILY_CHAT', 'FORMAL_INTERVIEW']);
  assert.equal(result.response?.policyEngine, 'InterviewPolicyV0.2');

  assert.throws(() => orchestrator.runFinalTurn(session.opaqueSessionHandle, {
    ...finalRequest('forged-ui'),
    uiAction: {
      type: 'MEMORY_TOPIC_CLICK', eventRef: 'ui:bad', targetMode: 'FORMAL_INTERVIEW',
      authorizationVersion: 'attacker',
    },
  } as any), /authorizationVersion is not allowed/);
});

test('interrupt at model pending recursively cancels before response, TTS, or async work', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { orchestrator, counters } = fakeRuntime({
    async phaseHook(phase) {
      if (phase === 'MODEL_PENDING') {
        entered();
        await gate;
      }
    },
  });
  const session = start(orchestrator);
  const run = orchestrator.runFinalTurn(session.opaqueSessionHandle, finalRequest('cancel-model'));
  await waiting;
  const target = orchestrator.getCurrentTarget(session.opaqueSessionHandle);
  assert.ok(target);
  const first = orchestrator.interrupt(session.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-interrupt-v0.1', idempotencyToken: 'int-model',
    targetHandle: target, reason: 'explicit_cancel',
  });
  assert.equal(first.accepted, true);
  release();
  const result = await run;
  assert.equal(result.status, 'interrupted');
  assert.equal(counters.response, 0);
  assert.equal(counters.tts, 0);
  assert.equal(counters.planned, 0);
  assert.deepEqual(counters.run, { MEMORY: 0, STORY: 0, PROFILE: 0 });
});

test('TTS interruption preserves committed text and rejects audio generation', async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { orchestrator, counters } = fakeRuntime({
    async phaseHook(phase) {
      if (phase === 'TTS_STREAMING') {
        entered();
        await gate;
      }
    },
  });
  const session = start(orchestrator);
  const run = orchestrator.runFinalTurn(session.opaqueSessionHandle, finalRequest('cancel-tts'));
  await waiting;
  const target = orchestrator.getCurrentTarget(session.opaqueSessionHandle);
  assert.ok(target);
  assert.equal(orchestrator.interrupt(session.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-interrupt-v0.1', idempotencyToken: 'int-tts',
    targetHandle: target, reason: 'user_speech',
  }).accepted, true);
  release();
  const result = await run;
  assert.equal(result.status, 'interrupted');
  assert.equal(result.response?.text, '我们慢慢聊。');
  assert.equal(result.tts.audioChunkCount, 0);
  assert.equal(counters.response, 1);
  assert.equal(counters.tts, 0);
  assert.equal(counters.planned, 0);
});

test('cross-turn NO_SAVE invalidates only the previous user evidence and propagates to Memory and artifacts', async () => {
  const referenceStore = new InMemoryReferenceStore();
  const invalidatedArtifactRefs: string[] = [];
  const retentionGovernance = createReferenceStoreRetentionGovernanceAdapter({
    referenceStore,
    invalidateArtifacts(evidenceRefs) {
      assert.equal(evidenceRefs.length, 1);
      invalidatedArtifactRefs.push('story:target', 'profile:target');
      return invalidatedArtifactRefs;
    },
  });
  let responseCount = 0;
  const { orchestrator } = fakeRuntime({
    retentionGovernance,
    response(mode) {
      responseCount += 1;
      if (responseCount === 1) return successfulResponse(mode);
      return {
        ...successfulResponse(mode),
        text: '好，刚才那段不再保存或使用。',
        action: 'ACKNOWLEDGE',
        retentionIntent: 'NO_SAVE',
        retentionScope: 'PREVIOUS_COMPLETED_TURN',
      };
    },
  });
  const session = start(orchestrator, 'cross-turn-no-save-start');
  const first = await orchestrator.runFinalTurn(
    session.opaqueSessionHandle,
    finalRequest('cross-turn-first', '我一直很喜欢兰花。'),
  );
  assert.equal(first.status, 'completed');

  const targetCandidate = eligiblePreferenceCandidate(first.evidenceId, 'target');
  const targetRecord = referenceStore.submitCandidate(targetCandidate, {
    operationId: 'submit-target', submittedAt: '2026-10-03T08:00:01.000Z',
  });
  referenceStore.approveAutoWrite(targetRecord.recordId, {
    decisionId: 'approve-target', approved: true, deterministic: true,
    policyVersion: targetCandidate.policyVersion,
    reasonCodes: ['FIXED_TEST_BUSINESS_GATE'],
    decidedAt: '2026-10-03T08:00:02.000Z',
  });
  const unrelatedCandidate = eligiblePreferenceCandidate('evidence:unrelated', 'unrelated');
  const unrelatedRecord = referenceStore.submitCandidate(unrelatedCandidate, {
    operationId: 'submit-unrelated', submittedAt: '2026-10-03T08:00:03.000Z',
  });
  referenceStore.approveAutoWrite(unrelatedRecord.recordId, {
    decisionId: 'approve-unrelated', approved: true, deterministic: true,
    policyVersion: unrelatedCandidate.policyVersion,
    reasonCodes: ['FIXED_TEST_BUSINESS_GATE'],
    decidedAt: '2026-10-03T08:00:04.000Z',
  });

  const second = await orchestrator.runFinalTurn(
    session.opaqueSessionHandle,
    finalRequest('cross-turn-second', '刚才那段不要存，也不要写进故事。'),
  );
  assert.equal(second.status, 'completed');
  assert.equal(orchestrator.evidenceStore.get(first.evidenceId), null);
  assert.ok(orchestrator.evidenceStore.get(second.evidenceId));
  assert.equal(referenceStore.get(targetRecord.recordId)?.status, 'DELETED');
  assert.equal(referenceStore.get(unrelatedRecord.recordId)?.status, 'ACTIVE');
  assert.deepEqual(invalidatedArtifactRefs, ['story:target', 'profile:target']);
  assert.deepEqual(second.retentionEffect && {
    status: second.retentionEffect.status,
    scope: second.retentionEffect.scope,
    rawEvidenceInvalidated: second.retentionEffect.rawEvidenceInvalidated,
    downstreamStatus: second.retentionEffect.downstreamStatus,
    withdrawnRecordCount: second.retentionEffect.withdrawnRecordCount,
    invalidatedArtifactCount: second.retentionEffect.invalidatedArtifactCount,
  }, {
    status: 'APPLIED',
    scope: 'PREVIOUS_COMPLETED_TURN',
    rawEvidenceInvalidated: true,
    downstreamStatus: 'APPLIED',
    withdrawnRecordCount: 1,
    invalidatedArtifactCount: 2,
  });
  const usable = referenceStore.retrieve({
    subjectId: AUTHORITY.subjectId,
    familySpaceId: AUTHORITY.familySpaceId,
    purpose: 'daily_chat',
    authorizationVersion: AUTHORITY.authorizationVersion,
    visibilityScope: [...AUTHORITY.visibilityScope],
  });
  assert.deepEqual(usable.map(record => record.recordId), [unrelatedRecord.recordId]);
  assert.equal(JSON.stringify(orchestrator.getAuditRecords()).includes('我一直很喜欢兰花'), false);
});

test('NO_SAVE and END suppress TTS and all derived jobs before ending the session', async () => {
  const { orchestrator, counters } = fakeRuntime({
    response(mode) {
      return {
        ...successfulResponse(mode),
        text: '好，这一段不保存，我们先结束。',
        action: 'END',
        retentionIntent: 'NO_SAVE',
        retentionScope: 'CURRENT_SESSION',
        sessionControl: 'END',
      };
    },
  });
  const session = start(orchestrator);
  const result = await orchestrator.runFinalTurn(
    session.opaqueSessionHandle,
    finalRequest('end-no-save', '结束，而且刚才这段别存。'),
  );
  assert.equal(result.status, 'completed');
  assert.equal(result.tts.status, 'skipped');
  assert.deepEqual(result.asyncJobs, []);
  assert.equal(counters.tts, 0);
  assert.equal(counters.planned, 0);
  assert.deepEqual(counters.run, { MEMORY: 0, STORY: 0, PROFILE: 0 });
  await assert.rejects(
    orchestrator.runFinalTurn(session.opaqueSessionHandle, finalRequest('after-end')),
    /session is ENDED/,
  );
});
