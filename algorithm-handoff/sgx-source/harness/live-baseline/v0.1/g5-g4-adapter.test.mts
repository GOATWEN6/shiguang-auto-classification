import assert from 'node:assert/strict';
import test from 'node:test';

import { GenerationCancellationRegistry } from '../../../src/lib/algorithm-runtime/index.ts';
import { createAuditedTtsRuntime } from '../../../src/lib/model-runtime/index.ts';
import {
  createDailyChatResponseRuntime,
  createInterviewRealizer,
  type InterviewGenerationPlan,
} from '../../../src/lib/response-runtime/index.ts';
import {
  createDailyChatAccessContextResolver,
  createDailyChatReferenceResolver,
  createG4TurnProcessingAdapter,
  createInterviewDecisionRequestResolver,
  InMemoryGovernedSessionStore,
  InMemoryTurnEvidenceStore,
  TurnOrchestrator,
  type AsyncJobAdapter,
  type TrustedSessionAuthority,
} from '../../../src/lib/turn-orchestrator/index.ts';

const AUTHORITY: TrustedSessionAuthority = {
  schemaVersion: 'trusted-session-authority-v0.1',
  actorId: 'actor-fiction-g4',
  subjectId: 'elder-fiction-g4',
  familySpaceId: 'family-fiction-g4',
  authorizationVersion: 'auth-g5-v0.1',
  visibilityScope: ['elder_only'],
};

function validInterviewOutput(plan: InterviewGenerationPlan) {
  return {
    schemaVersion: '0.1',
    decisionId: plan.decisionId,
    mode: plan.mode,
    action: plan.action,
    retentionIntent: plan.retentionIntent,
    questionCount: plan.questionCount,
    evidenceRefs: [...plan.evidenceRefs],
    topicId: plan.topicId,
    text: plan.frozenPolicyText,
    questions: [],
  };
}

function noopAsync(): AsyncJobAdapter {
  return {
    async run() { return { ok: false, errorCode: 'not_scheduled' }; },
    async commit(context) { return context.canCommit().accepted ? 'COMMITTED' : 'DROPPED'; },
  };
}

test('G5 bridge runs governed G4 Daily Chat, InterviewPolicy realizer, and TTS runtimes', async () => {
  let id = 0;
  const next = () => `g4-bridge-${++id}`;
  const sessions = new InMemoryGovernedSessionStore({
    idFactory: { next: kind => `${kind}:${next()}` },
  });
  const evidenceStore = new InMemoryTurnEvidenceStore(sessions, {
    idFactory: { next: kind => `${kind}:${next()}` },
  });
  const cancellationRegistry = new GenerationCancellationRegistry();
  const daily = createDailyChatResponseRuntime({
    cancellationRegistry,
    accessContextResolver: createDailyChatAccessContextResolver(sessions),
    referenceResolver: createDailyChatReferenceResolver(sessions, evidenceStore),
    async generate(request) {
      return {
        schemaVersion: '0.1',
        planId: request.plan.planId,
        mode: 'DAILY_CHAT',
        intent: request.plan.intent,
        text: '兰花很雅致，我们慢慢聊。',
        questions: [],
        evidenceRefs: [...request.plan.allowedEvidenceRefs],
      };
    },
  });
  const interview = createInterviewRealizer({
    cancellationRegistry,
    decisionRequestResolver: createInterviewDecisionRequestResolver(sessions, evidenceStore),
    async generate(request) {
      return validInterviewOutput(request.plan);
    },
  });
  let ttsProviderCalls = 0;
  const tts = createAuditedTtsRuntime({
    cancellationRegistry,
    billingVerifier: {
      verify(request) { return request.reportedCostCny === 0 ? { costCny: 0 } : null; },
    },
    transport: {
      async synthesize(request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          ttsProviderCalls += 1;
          await emit({
            kind: 'audio_chunk',
            identity: request.identity,
            audio: new Uint8Array([1, 2]),
          });
          return {
            usage: { inputCharacters: request.text.length, outputAudioMs: 120 },
            costCny: 0,
          };
        });
      },
    },
  });
  const processing = createG4TurnProcessingAdapter({
    cancellationRegistry,
    daily,
    interview,
    tts,
    planAsyncJobs: () => [],
  });
  const orchestrator = new TurnOrchestrator({
    sessions,
    evidenceStore,
    processing,
    asyncAdapters: { MEMORY: noopAsync(), STORY: noopAsync(), PROFILE: noopAsync() },
    id: next,
  });
  const started = orchestrator.startSession({
    schemaVersion: 'client-session-start-v0.1',
    idempotencyToken: 'g4-bridge-start',
    requestedMode: 'DAILY_CHAT',
  }, AUTHORITY);

  const dailyResult = await orchestrator.runFinalTurn(started.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: 'g4-bridge-daily',
    source: 'TYPED_TEXT',
    text: '我喜欢兰花。',
    receivedAt: '2026-10-03T09:00:00.000Z',
  });
  assert.equal(dailyResult.status, 'completed');
  assert.equal(dailyResult.response?.policyEngine, 'DailyChatPolicy');
  assert.equal(dailyResult.response?.text, '兰花很雅致，我们慢慢聊。');
  assert.equal(dailyResult.tts.status, 'success');

  const interviewResult = await orchestrator.runFinalTurn(started.opaqueSessionHandle, {
    schemaVersion: 'orchestrated-turn-v0.1',
    idempotencyToken: 'g4-bridge-interview',
    source: 'TYPED_TEXT',
    text: '我们聊聊以前在纺织厂的事吧。',
    receivedAt: '2026-10-03T09:01:00.000Z',
    uiAction: {
      type: 'MEMORY_TOPIC_CLICK',
      eventRef: 'ui:g4-bridge:interview',
      targetMode: 'FORMAL_INTERVIEW',
    },
  });
  assert.equal(interviewResult.status, 'completed');
  assert.equal(interviewResult.mode, 'FORMAL_INTERVIEW');
  assert.equal(interviewResult.response?.policyEngine, 'InterviewPolicyV0.2');
  assert.ok((interviewResult.response?.questionCount ?? 2) <= 1);
  assert.equal(interviewResult.tts.status, 'success');
  assert.equal(ttsProviderCalls, 2);
  assert.deepEqual(orchestrator.getMetrics(), {
    acceptedFinalTurns: 2,
    acceptedInterrupts: 0,
    networkCalls: 0,
    costCny: 0,
  });
});
