import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test, { after } from 'node:test';

import {
  GenerationCancellationRegistry,
  type RuntimeIdentity,
} from '../../../src/lib/algorithm-runtime/index.ts';
import {
  decideInterviewNextAction,
  type InterviewPolicyInput,
  type LiveInterviewDecisionRequest,
} from '../../../src/lib/interview-policy/index.ts';
import {
  composeSpokenText,
  createDailyChatResponseRuntime,
  createInterviewRealizer,
  hasUnsupportedEmotionAssertion,
  type DailyChatAccessContext,
  type DailyChatDecisionRequest,
  type InterviewGenerationPlan,
  type InterviewRealizerRequest,
  type TrustedDailyChatReference,
} from '../../../src/lib/response-runtime/index.ts';
import { createAuditedTextRuntime } from '../../../src/lib/model-runtime/index.ts';

type FrozenCase = { id: string; input: InterviewPolicyInput };
const original = JSON.parse(readFileSync(
  new URL('../../oss-p0/interview/cases.json', import.meta.url), 'utf8',
)).cases as FrozenCase[];
const heldOut = JSON.parse(readFileSync(
  new URL('../../oss-p0/interview/held-out/cases.json', import.meta.url), 'utf8',
)).cases as FrozenCase[];

const expectedExecutedIds = [
  'D01-NORMAL-CHAT',
  'D02-MODE-ISOLATION',
  'D03-PURPOSE-ISOLATION',
  'I01-ACKNOWLEDGE',
  'I02-ONE-FOLLOW-UP',
  'I03-MULTI-QUESTION-OVERREACH',
  'I04-BLOCKED-TOPIC',
  'I05-NO-SAVE',
  'I06-TERMINAL-SUPPRESS',
  'I07-STALE-CANCEL',
  'I08-SCHEMA-FAILURE-FALLBACK',
  'X01-TEXT-FAILURE',
] as const;
const executedIds = new Set<string>();

after(() => {
  assert.deepEqual([...executedIds].sort(), [...expectedExecutedIds].sort());
});

function mark(id: typeof expectedExecutedIds[number]): void {
  assert.equal(executedIds.has(id), false, `${id} executed more than once`);
  executedIds.add(id);
}

test('one spokenText is shared by subtitles and TTS without duplicate questions', () => {
  assert.equal(composeSpokenText({
    text: '我听到了。',
    question: '后来发生了什么？',
    expectedQuestionCount: 1,
  }), '我听到了。 后来发生了什么？');
  assert.throws(() => composeSpokenText({
    text: '后来发生了什么？',
    question: '后来发生了什么？',
    expectedQuestionCount: 1,
  }), /must not contain a question|must not duplicate/);
  assert.throws(() => composeSpokenText({
    text: '好，我们先停在这里。',
    question: '还要继续吗？',
    expectedQuestionCount: 0,
  }), /expectedQuestionCount is 0/);
});

test('unsupported emotional certainty is rejected while elder-stated emotion remains usable', () => {
  assert.equal(
    hasUnsupportedEmotionAssertion('那段旧时光一定很温暖。', '我以前在苏州住过。'),
    true,
  );
  assert.equal(
    hasUnsupportedEmotionAssertion('那段旧时光一定很暖。', '我以前在苏州住过。'),
    true,
  );
  assert.equal(
    hasUnsupportedEmotionAssertion('想必您在那里有不少难忘的经历。', '我以前在苏州住过。'),
    false,
  );
  assert.equal(
    hasUnsupportedEmotionAssertion('苏州的日子一定留下了不少值得念想的过往。', '我今天有点想念以前住在苏州的日子。'),
    false,
  );
  assert.equal(
    hasUnsupportedEmotionAssertion('听起来那时你很开心。', '那时候我很开心。'),
    false,
  );
  assert.equal(
    hasUnsupportedEmotionAssertion('你愿意说说当时的感受吗？', '我以前在苏州住过。'),
    false,
  );
});

function frozenInput(id: string): InterviewPolicyInput {
  const found = [...original, ...heldOut].find(item => item.id === id);
  assert.ok(found, `missing frozen Interview case ${id}`);
  return structuredClone(found.input);
}

function livePolicyRequest(
  id: string,
  generationId: number,
  mutate?: (input: InterviewPolicyInput) => void,
): LiveInterviewDecisionRequest {
  const input = frozenInput(id);
  mutate?.(input);
  const sessionEpoch = `g4-live-session-${generationId}`;
  input.sessionEpoch = sessionEpoch;
  input.runtime.sessionEpoch = sessionEpoch;
  input.runtime.generationId = generationId;
  if (input.asr.status !== 'NONE' && !input.asr.ref) input.asr.ref = `asr-ref-${generationId}`;
  const runtimeNeedsRef = input.runtime.network === 'OFFLINE'
    || input.runtime.provider === 'TIMEOUT'
    || input.runtime.vad === 'SPEAKING'
    || input.runtime.tts === 'PLAYING'
    || input.runtime.silenceSeconds !== undefined
    || input.runtime.waitPreferenceSeconds !== undefined;
  if (runtimeNeedsRef && !input.runtime.ref) input.runtime.ref = `runtime-ref-${generationId}`;
  if (input.incomingEvent) {
    input.incomingEvent.sessionEpoch = sessionEpoch;
    input.incomingEvent.generationId = generationId;
  }
  const evidenceRefs = [
    input.asr.ref,
    input.runtime.ref,
    input.uiEvent?.ref,
    input.incomingEvent?.ref,
    input.previousCompletedUserEvidenceRef,
    ...input.memoryRefs.map(item => item.ref),
  ].filter((ref): ref is string => typeof ref === 'string' && ref.length > 0);
  return {
    input: input as LiveInterviewDecisionRequest['input'],
    identity: {
      sessionEpoch,
      turnId: `g4-live-turn-${generationId}`,
      generationId,
      invocationId: `g4-live-invocation-${generationId}`,
      evidenceRefs: [...new Set(evidenceRefs)],
    },
  };
}

test('cross-turn NO_SAVE targets the trusted previous completed evidence instead of the command turn', () => {
  const previousRef = 'evidence:previous-completed-turn';
  const request = livePolicyRequest('IH-002', 115, input => {
    input.previousCompletedUserEvidenceRef = previousRef;
  });
  const decision = decideInterviewNextAction(request);
  assert.deepEqual(decision.retentionControl, {
    intent: 'NO_SAVE',
    scope: 'PREVIOUS_COMPLETED_TURN',
    sourceRefs: [previousRef],
    cancelPendingExtraction: true,
  });
  assert.ok(decision.obligations.some(obligation => (
    obligation.id === 'RETENTION_NO_SAVE'
    && obligation.operation === 'NO_SAVE_PREVIOUS_COMPLETED_TURN'
    && obligation.sourceRefs.includes(previousRef)
  )));
});

function dailyIdentity(generationId: number, evidenceRefs: string[]): RuntimeIdentity {
  return {
    sessionEpoch: `g4-daily-session-${generationId}`,
    turnId: `g4-daily-turn-${generationId}`,
    generationId,
    invocationId: `g4-daily-invocation-${generationId}`,
    evidenceRefs,
  };
}

function dailyDecision(generationId: number, evidenceRefs = ['daily-ref-1']): DailyChatDecisionRequest {
  return {
    schemaVersion: 'daily-chat-decision-v0.1',
    identity: dailyIdentity(generationId, evidenceRefs),
    intent: 'ACKNOWLEDGE',
  };
}

const DAILY_ACCESS_CONTEXT: DailyChatAccessContext = {
  subjectId: 'elder-fiction-001',
  familySpaceId: 'family-fiction-001',
  authorizationVersion: 'auth-v1',
  visibilityScope: ['elder_only'],
};

function accessContextResolver(context: DailyChatAccessContext | null = DAILY_ACCESS_CONTEXT) {
  return {
    async resolve() {
      return structuredClone(context);
    },
  };
}

function dailyReference(
  ref: string,
  text: string,
  purpose: TrustedDailyChatReference['purpose'] = 'daily_chat',
  overrides: Partial<TrustedDailyChatReference> = {},
): TrustedDailyChatReference {
  return {
    ref,
    text,
    purpose,
    ...structuredClone(DAILY_ACCESS_CONTEXT),
    ...overrides,
  };
}

function resolver(records: readonly TrustedDailyChatReference[]) {
  const byRef = new Map(records.map(item => [item.ref, item]));
  return {
    async resolve(ref: string) {
      return structuredClone(byRef.get(ref) ?? null);
    },
  };
}

function interviewRunRequest(request: LiveInterviewDecisionRequest): InterviewRealizerRequest {
  return {
    schemaVersion: 'interview-realizer-request-v0.1',
    identity: structuredClone(request.identity),
  };
}

function decisionRequestResolver(request: LiveInterviewDecisionRequest) {
  return {
    resolve() {
      return structuredClone(request);
    },
  };
}

function validDailyOutput(plan: any, text = '兰花很雅致，我们慢慢聊。', questions: string[] = []) {
  return {
    schemaVersion: '0.1', planId: plan.planId, mode: 'DAILY_CHAT', intent: plan.intent,
    text, questions, evidenceRefs: [...plan.allowedEvidenceRefs],
  };
}

function validInterviewOutput(plan: InterviewGenerationPlan, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: '0.1', decisionId: plan.decisionId, mode: plan.mode, action: plan.action,
    retentionIntent: plan.retentionIntent, questionCount: plan.questionCount,
    evidenceRefs: [...plan.evidenceRefs], topicId: plan.topicId,
    text: plan.frozenPolicyText, questions: [], ...overrides,
  };
}

function auditedJsonRuntime(
  registry: GenerationCancellationRegistry,
  payload: () => string,
  sinkAcknowledgementTimeoutMs?: number,
) {
  return createAuditedTextRuntime({
    cancellationRegistry: registry,
    sinkAcknowledgementTimeoutMs,
    billingVerifier: {
      verify(request) {
        return request.reportedCostCny === 0 ? { costCny: 0 } : null;
      },
    },
    transport: {
      async invoke(request, emit, executeRuntimeRequest) {
        return executeRuntimeRequest(async () => {
          await emit({ kind: 'text_delta', identity: request.identity, text: payload() });
          return {
            usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 },
            costCny: 0,
          };
        });
      },
    },
  });
}

test('D01-NORMAL-CHAT: DailyChat constructs its own plan and resolves only identity evidence', async () => {
  const registry = new GenerationCancellationRegistry();
  let generatedRequest: any;
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: {
      async resolve(ref, accessContext) {
        assert.equal(ref, 'daily-ref-1');
        assert.deepEqual(accessContext, DAILY_ACCESS_CONTEXT);
        return dailyReference('daily-ref-1', '喜欢兰花');
      },
    },
    async generate(request) {
      const lease = registry.acquireLease(request.identity, 'daily_chat');
      assert.ok(lease);
      assert.equal(request.signal, lease.signal);
      const { executionPermit: _permit, ...cloneableRequest } = request;
      generatedRequest = structuredClone(cloneableRequest);
      return validDailyOutput(request.plan);
    },
  });
  const result = await runtime.run(dailyDecision(1));
  assert.equal(result.status, 'success');
  assert.equal(result.fallbackUsed, false);
  assert.equal(generatedRequest.plan.promptId, 'daily-chat-v0.1');
  assert.equal(generatedRequest.plan.schemaId, 'daily-chat-response-v0.1');
  assert.deepEqual(generatedRequest.accessContext, DAILY_ACCESS_CONTEXT);
  assert.deepEqual(generatedRequest.context.map((item: any) => item.ref), ['daily-ref-1']);
  mark('D01-NORMAL-CHAT');
});

test('DailyChat v0.2 accepts one light question without changing mode or authority', async () => {
  let promptId: string | undefined;
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: new GenerationCancellationRegistry(),
    allowLightFollowUp: true,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([dailyReference('daily-ref-1', '我平时喜欢听京剧。')]),
    async generate(request) {
      promptId = request.plan.promptId;
      assert.equal(request.plan.maxQuestions, 1);
      return validDailyOutput(request.plan, '听京剧很有意思。您喜欢哪个选段？', ['您喜欢哪个选段？']);
    },
  });
  const result = await runtime.run({ ...dailyDecision(110), intent: 'RESPOND' });
  assert.equal(promptId, 'daily-chat-v0.2');
  assert.equal(result.status, 'success');
  assert.equal(result.mode, 'DAILY_CHAT');
  assert.equal(result.intent, 'RESPOND');
  assert.equal(result.questionCount, 1);
  assert.equal('retentionControl' in result, false);
  assert.deepEqual(result.evidenceRefs, ['daily-ref-1']);
});

test('DailyChat light questions cannot bypass question limits, ACKNOWLEDGE or mode isolation', async () => {
  const cases = [
    { intent: 'RESPOND' as const, text: '您喜欢哪段？常听谁唱？', questions: ['您喜欢哪段？', '常听谁唱？'] },
    { intent: 'ACKNOWLEDGE' as const, text: '您喜欢哪段？', questions: ['您喜欢哪段？'] },
    { intent: 'RESPOND' as const, text: '您喜欢哪段？', questions: [] },
    { intent: 'RESPOND' as const, text: '您喜欢哪段？', questions: ['您喜欢哪段？'], mode: 'FORMAL_INTERVIEW' },
  ];
  for (const [index, value] of cases.entries()) {
    const runtime = createDailyChatResponseRuntime({
      cancellationRegistry: new GenerationCancellationRegistry(),
      allowLightFollowUp: true,
      accessContextResolver: accessContextResolver(),
      referenceResolver: resolver([]),
      async generate(request) {
        assert.equal(request.plan.maxQuestions, value.intent === 'ACKNOWLEDGE' ? 0 : 1);
        return { ...validDailyOutput(request.plan, value.text, value.questions),
          ...(value.mode ? { mode: value.mode } : {}) };
      },
    });
    const result = await runtime.run({ ...dailyDecision(111 + index, []), intent: value.intent });
    assert.equal(result.status, 'fallback');
    assert.equal(result.mode, 'DAILY_CHAT');
    assert.equal(result.questionCount, 0);
  }
});

test('DailyChat lends its owner lease to AuditedTextRuntime without premature finalization', async () => {
  const registry = new GenerationCancellationRegistry();
  let payload = '';
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const request = dailyDecision(101, []);
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    async generate(generation) {
      payload = JSON.stringify(validDailyOutput(generation.plan, '我们继续慢慢聊。'));
      const result = await modelRuntime.runBorrowed({
        module: 'daily_chat',
        identity: generation.identity,
        attemptId: 'nested-daily-attempt',
        requestId: 'nested-daily-request',
        prompt: 'render daily response',
      }, generation.executionPermit);
      assert.equal(result.status, 'success');
      return JSON.parse(result.text);
    },
  });

  const result = await runtime.run(request);
  assert.equal(result.status, 'success');
  assert.equal(result.text, '我们继续慢慢聊。');
  assert.deepEqual(registry.accepts(request.identity, 'daily_chat'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('DailyChat cancellation joins an already-entered model sink before finalizing its owner', async () => {
  const registry = new GenerationCancellationRegistry();
  let payload = '';
  let markSinkEntered!: () => void;
  let releaseSink!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const sinkRelease = new Promise<void>(resolve => { releaseSink = resolve; });
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const request = dailyDecision(102, []);
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    cancellationCleanupTimeoutMs: 200,
    async generate(generation) {
      payload = JSON.stringify(validDailyOutput(generation.plan, '不应提交的迟到回复'));
      const result = await modelRuntime.runBorrowed({
        module: 'daily_chat', identity: generation.identity,
        attemptId: 'nested-daily-cancel-attempt', requestId: 'nested-daily-cancel-request',
        prompt: 'render daily response',
        async onVisibleText(_text, context) {
          markSinkEntered();
          await sinkRelease;
          return context.signal.aborted ? 'DROPPED' : 'COMMITTED';
        },
      }, generation.executionPermit);
      assert.equal(result.status, 'cancelled');
      return validDailyOutput(generation.plan);
    },
  });

  const running = runtime.run(request);
  let outerSettled = false;
  void running.then(() => { outerSettled = true; }, () => { outerSettled = true; });
  await sinkEntered;
  assert.equal(registry.cancel(request.identity, 'daily_chat', 'user_interrupt'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(outerSettled, false);
  releaseSink();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'JOINED');
  assert.equal(result.text, '');
});

test('DailyChat propagates a model sink that committed after cancellation as failed cleanup', async () => {
  const registry = new GenerationCancellationRegistry();
  let payload = '';
  let markSinkEntered!: () => void;
  let releaseSink!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const sinkRelease = new Promise<void>(resolve => { releaseSink = resolve; });
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const request = dailyDecision(104, []);
  let staleCommitObserved = false;
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    cancellationCleanupTimeoutMs: 200,
    async generate(generation) {
      payload = JSON.stringify(validDailyOutput(generation.plan));
      const result = await modelRuntime.runBorrowed({
        module: 'daily_chat', identity: generation.identity,
        attemptId: 'nested-daily-failed-cleanup-attempt',
        requestId: 'nested-daily-failed-cleanup-request',
        prompt: 'render daily response',
        async onVisibleText() {
          markSinkEntered();
          await sinkRelease;
          staleCommitObserved = true;
          return 'COMMITTED' as const;
        },
      }, generation.executionPermit);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.telemetry.cancellationCleanupStatus, 'FAILED');
      return validDailyOutput(generation.plan);
    },
  });

  const running = runtime.run(request);
  await sinkEntered;
  assert.equal(registry.cancel(request.identity, 'daily_chat', 'user_interrupt'), true);
  releaseSink();
  const result = await running;
  assert.equal(staleCommitObserved, true);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'FAILED');
  assert.equal(result.text, '');
});

test('DailyChat exposes a nested sink cleanup timeout instead of reporting a joined cancellation', async () => {
  const registry = new GenerationCancellationRegistry();
  let payload = '';
  let markSinkEntered!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const never = new Promise<never>(() => {});
  const modelRuntime = auditedJsonRuntime(registry, () => payload, 10);
  const request = dailyDecision(103, []);
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    cancellationCleanupTimeoutMs: 100,
    async generate(generation) {
      payload = JSON.stringify(validDailyOutput(generation.plan));
      const result = await modelRuntime.runBorrowed({
        module: 'daily_chat', identity: generation.identity,
        attemptId: 'nested-daily-timeout-attempt', requestId: 'nested-daily-timeout-request',
        prompt: 'render daily response',
        onVisibleText() { markSinkEntered(); return never; },
      }, generation.executionPermit);
      assert.equal(result.status, 'cancelled');
      assert.equal(result.telemetry.cancellationCleanupStatus, 'TIMED_OUT');
      return validDailyOutput(generation.plan);
    },
  });

  const running = runtime.run(request);
  await sinkEntered;
  assert.equal(registry.cancel(request.identity, 'daily_chat', 'user_interrupt'), true);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'TIMED_OUT');
});

test('D02-MODE-ISOLATION: DailyChat rejects interview fields and uses a runtime-owned fallback', async () => {
  const registry = new GenerationCancellationRegistry();
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    async generate(request) {
      return { ...validDailyOutput(request.plan, '我要开始正式采访。'), interviewAction: 'FOLLOW_UP' };
    },
  });
  const result = await runtime.run(dailyDecision(2, []));
  assert.equal(result.status, 'fallback');
  assert.equal(result.text, '我在听，我们慢慢聊。');
  assert.deepEqual(result.evidenceRefs, []);
  assert.equal('interviewAction' in result, false);
  mark('D02-MODE-ISOLATION');
});

test('D03-PURPOSE-ISOLATION: a caller cannot relabel formal Interview evidence as DailyChat context', async () => {
  const registry = new GenerationCancellationRegistry();
  let seenContext: TrustedDailyChatReference[] = [];
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([
      dailyReference('daily-ref-1', '喜欢兰花'),
      dailyReference('formal-secret', '正式访谈私密内容', 'formal_interview'),
    ]),
    async generate(request) {
      seenContext = structuredClone(request.context);
      return validDailyOutput(request.plan, '好的。');
    },
  });
  const result = await runtime.run(dailyDecision(3, ['daily-ref-1', 'formal-secret']));
  assert.equal(result.status, 'success');
  assert.deepEqual(seenContext.map(item => item.ref), ['daily-ref-1']);
  mark('D03-PURPOSE-ISOLATION');
});

test('additional DailyChat regression: cross-subject, cross-family, stale authorization and visibility are filtered', async () => {
  const registry = new GenerationCancellationRegistry();
  let seenContext: TrustedDailyChatReference[] = [];
  const evidenceRefs = ['allowed', 'other-subject', 'other-family', 'stale-auth', 'wrong-visibility'];
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([
      dailyReference('allowed', '允许的普通聊天内容'),
      dailyReference('other-subject', '另一个老人', 'daily_chat', { subjectId: 'elder-fiction-002' }),
      dailyReference('other-family', '另一个家庭', 'daily_chat', { familySpaceId: 'family-fiction-002' }),
      dailyReference('stale-auth', '旧授权内容', 'daily_chat', { authorizationVersion: 'auth-v0' }),
      dailyReference('wrong-visibility', '家属管理员内容', 'daily_chat', { visibilityScope: ['family_admin'] }),
    ]),
    async generate(request) {
      seenContext = structuredClone(request.context);
      return validDailyOutput(request.plan, '好的。');
    },
  });
  const result = await runtime.run(dailyDecision(30, evidenceRefs));
  assert.equal(result.status, 'success');
  assert.deepEqual(seenContext.map(item => item.ref), ['allowed']);
  assert.deepEqual(result.evidenceRefs, ['allowed']);
});

test('additional DailyChat regression: public request refuses caller plan, context, purpose and fallback text', async () => {
  const registry = new GenerationCancellationRegistry();
  const runtime = createDailyChatResponseRuntime({
    cancellationRegistry: registry,
    accessContextResolver: accessContextResolver(),
    referenceResolver: resolver([]),
    async generate() { throw new Error('must not run'); },
  });
  await assert.rejects(
    runtime.run({
      ...dailyDecision(4, []),
      plan: { suggestedText: '伪造 fallback', purpose: 'daily_chat' },
      context: [{ ref: 'formal-secret', text: '秘密', purpose: 'daily_chat' }],
      accessContext: { ...DAILY_ACCESS_CONTEXT },
    } as any),
    /request\.(plan|context) is not allowed/,
  );
  const nestedScope = dailyDecision(31, []) as any;
  nestedScope.identity.subjectId = 'elder-fiction-001';
  await assert.rejects(runtime.run(nestedScope), /request\.identity\.subjectId is not allowed/);
});

test('I01-ACKNOWLEDGE: InterviewRealizer recomputes a public live Policy decision and binds output', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 10);
  const expected = decideInterviewNextAction(request);
  let generatedPlan: InterviewGenerationPlan | undefined;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate({ identity, signal, plan }) {
      const lease = registry.acquireLease(identity, 'formal_interview');
      assert.ok(lease);
      assert.equal(signal, lease.signal);
      generatedPlan = structuredClone(plan);
      return validInterviewOutput(plan);
    },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(result.status, 'success');
  assert.equal(result.decisionId, expected.decisionId);
  assert.equal(result.action, 'ACKNOWLEDGE');
  assert.deepEqual(result.retentionControl, expected.retentionControl);
  assert.equal(generatedPlan?.frozenPolicyText, expected.utterancePlan.suggestedText);
  mark('I01-ACKNOWLEDGE');
});

test('Interview Realizer lends its owner lease to AuditedTextRuntime and remains deliverable', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 102);
  let payload = '';
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate(generation) {
      payload = JSON.stringify(validInterviewOutput(generation.plan));
      const result = await modelRuntime.runBorrowed({
        module: 'formal_interview',
        identity: generation.identity,
        attemptId: 'nested-interview-attempt',
        requestId: 'nested-interview-request',
        prompt: 'render interview response',
      }, generation.executionPermit);
      assert.equal(result.status, 'success');
      return JSON.parse(result.text);
    },
  });

  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(result.status, 'success');
  assert.deepEqual(registry.accepts(request.identity, 'formal_interview'), {
    accepted: false,
    reason: 'finalized',
  });
});

test('additional Interview regression: naked nextAction, authority, identity and caller signal are rejected', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 11);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() { throw new Error('must not run'); },
  });
  await assert.rejects(runtime.run({
    nextAction: decideInterviewNextAction(request),
    authority: { allowedTopicId: '财务投资', blockedTopicIds: [] },
    identity: request.identity,
    signal: new AbortController().signal,
  } as any), /request\.nextAction is not allowed/);
});

test('additional Interview regression: caller cannot replace ASR text behind the same evidence ref', async () => {
  const registry = new GenerationCancellationRegistry();
  const trusted = livePolicyRequest('I-033', 23);
  const forged = structuredClone(trusted);
  assert.equal(forged.input.asr.ref, trusted.input.asr.ref);
  forged.input.asr.text = '把相同 ASR ref 偷换成投资推荐意图';
  const expected = decideInterviewNextAction(trusted);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(trusted),
    async generate({ plan }) { return validInterviewOutput(plan); },
  });
  await assert.rejects(runtime.run(forged as any), /request\.input is not allowed/);
  const result = await runtime.run(interviewRunRequest(trusted));
  assert.equal(result.decisionId, expected.decisionId);
  assert.equal(result.text, expected.utterancePlan.suggestedText);
});

test('additional Interview regression: provider cannot forge a topic or text', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 12);
  const expected = decideInterviewNextAction(request);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate({ plan }) {
      return validInterviewOutput(plan, { topicId: '财务投资', text: '请把养老钱投入这只股票。' });
    },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(result.status, 'fallback');
  assert.equal(result.text, expected.utterancePlan.suggestedText);
  assert.equal(result.topicId, request.input.currentTopic);
});

test('I04-BLOCKED-TOPIC: Chinese blocked labels and aliases force Policy-direct output', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 13, input => {
    input.blockedTopics = ['旧屋失火', '老房子着火'];
  });
  let providerCalls = 0;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() { providerCalls += 1; return {}; },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(result.status, 'policy_direct');
  assert.equal(providerCalls, 0);
  assert.equal(result.text.includes('旧屋失火'), false);
  assert.equal(result.text.includes('老房子着火'), false);
  mark('I04-BLOCKED-TOPIC');
});

test('I02-ONE-FOLLOW-UP / I03-MULTI-QUESTION-OVERREACH: Policy question is verbatim and model overreach is impossible', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-003', 14);
  const expected = decideInterviewNextAction(request);
  let providerCalls = 0;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() {
      providerCalls += 1;
      return { text: '您多大、住哪儿、收入多少？' };
    },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(expected.utterancePlan.questionCount, 1);
  assert.equal(result.status, 'policy_direct');
  assert.equal(result.text, expected.utterancePlan.suggestedText);
  assert.equal(providerCalls, 0);
  mark('I02-ONE-FOLLOW-UP');
  mark('I03-MULTI-QUESTION-OVERREACH');
});

test('I05-NO-SAVE: NO_SAVE and safety response are Policy-direct and preserve full retention control', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('IH-002', 15);
  const expected = decideInterviewNextAction(request);
  let providerCalls = 0;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() { providerCalls += 1; return { text: '我会替您留档。' }; },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(expected.retentionControl.intent, 'NO_SAVE');
  assert.equal(result.status, 'policy_direct');
  assert.equal(providerCalls, 0);
  assert.deepEqual(result.retentionControl, expected.retentionControl);
  assert.equal(result.text.includes('留档'), false);
  mark('I05-NO-SAVE');
});

test('I06-TERMINAL-SUPPRESS: SUPPRESS skips generation and emits neither provider text nor fallback', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('IH-005', 16);
  let providerCalls = 0;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() { providerCalls += 1; return {}; },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(decideInterviewNextAction(request).runtimeControl.delivery.mode, 'SUPPRESS');
  assert.equal(result.status, 'suppressed');
  assert.equal(result.text, '');
  assert.equal(result.fallbackUsed, false);
  assert.equal(providerCalls, 0);
  mark('I06-TERMINAL-SUPPRESS');
});

test('additional Interview regression: an EMIT terminal action cannot be reopened by provider text', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-029', 17);
  let providerCalls = 0;
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate() { providerCalls += 1; return { text: '我们继续聊旧话题。' }; },
  });
  const result = await runtime.run(interviewRunRequest(request));
  assert.equal(result.action, 'END');
  assert.equal(result.status, 'policy_direct');
  assert.equal(providerCalls, 0);
  assert.notEqual(result.text, '我们继续聊旧话题。');
});

test('I07-STALE-CANCEL: cancellation races a hanging generator and never emits fallback', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 18);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    cancellationCleanupTimeoutMs: 10,
    async generate() { return new Promise(() => {}); },
  });
  const running = runtime.run(interviewRunRequest(request));
  await Promise.resolve();
  assert.equal(registry.cancel(request.identity, 'formal_interview', 'user_interrupt'), true);
  const result = await Promise.race([
    running,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('cancel did not settle')), 100)),
  ]);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.text, '');
  assert.equal(result.fallbackUsed, false);
  assert.equal(result.cancellationCleanupStatus, 'TIMED_OUT');
  assert.equal(registry.accepts(request.identity, 'formal_interview').accepted, false);
  mark('I07-STALE-CANCEL');
});

test('Interview cancellation joins an already-entered model sink before finalizing its owner', async () => {
  const registry = new GenerationCancellationRegistry();
  const request = livePolicyRequest('I-033', 118);
  let payload = '';
  let markSinkEntered!: () => void;
  let releaseSink!: () => void;
  const sinkEntered = new Promise<void>(resolve => { markSinkEntered = resolve; });
  const sinkRelease = new Promise<void>(resolve => { releaseSink = resolve; });
  const modelRuntime = auditedJsonRuntime(registry, () => payload);
  const runtime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    cancellationCleanupTimeoutMs: 200,
    async generate(generation) {
      payload = JSON.stringify(validInterviewOutput(generation.plan));
      const result = await modelRuntime.runBorrowed({
        module: 'formal_interview', identity: generation.identity,
        attemptId: 'nested-interview-cancel-attempt', requestId: 'nested-interview-cancel-request',
        prompt: 'render interview response',
        async onVisibleText(_text, context) {
          markSinkEntered();
          await sinkRelease;
          return context.signal.aborted ? 'DROPPED' : 'COMMITTED';
        },
      }, generation.executionPermit);
      assert.equal(result.status, 'cancelled');
      return validInterviewOutput(generation.plan);
    },
  });

  const running = runtime.run(interviewRunRequest(request));
  let outerSettled = false;
  void running.then(() => { outerSettled = true; }, () => { outerSettled = true; });
  await sinkEntered;
  assert.equal(registry.cancel(request.identity, 'formal_interview', 'user_interrupt'), true);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(outerSettled, false);
  releaseSink();
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancellationCleanupStatus, 'JOINED');
  assert.equal(result.text, '');
});

test('I08-SCHEMA-FAILURE-FALLBACK / X01-TEXT-FAILURE: failure is frozen, local and side-effect free', async () => {
  const requestA = livePolicyRequest('I-033', 19);
  const expectedA = decideInterviewNextAction(requestA);
  let memoryWrites = 0;
  let ttsStarts = 0;
  const failureOptions = {
    cancellationRegistry: new GenerationCancellationRegistry(),
    decisionRequestResolver: decisionRequestResolver(requestA),
    async generate() { throw new Error('offline injected failure'); },
    onMemoryWrite() { memoryWrites += 1; },
    startTts() { ttsStarts += 1; },
  };
  const runtimeA = createInterviewRealizer(failureOptions);
  const failed = await runtimeA.run(interviewRunRequest(requestA));
  assert.equal(failed.status, 'fallback');
  assert.equal(failed.text, expectedA.utterancePlan.suggestedText);
  assert.equal(memoryWrites, 0);
  assert.equal(ttsStarts, 0);

  const requestB = livePolicyRequest('I-033', 20);
  const expectedB = decideInterviewNextAction(requestB);
  const runtimeB = createInterviewRealizer({
    cancellationRegistry: new GenerationCancellationRegistry(),
    decisionRequestResolver: decisionRequestResolver(requestB),
    async generate({ plan }) { return { ...validInterviewOutput(plan), saveCommand: true }; },
  });
  const invalid = await runtimeB.run(interviewRunRequest(requestB));
  assert.equal(invalid.status, 'fallback');
  assert.equal(invalid.text, expectedB.utterancePlan.suggestedText);
  mark('I08-SCHEMA-FAILURE-FALLBACK');
  mark('X01-TEXT-FAILURE');
});

test('additional regression: resolver identity mismatch and finalized invocation replay are rejected', async () => {
  const trusted = livePolicyRequest('I-033', 21);
  const mismatched = interviewRunRequest(trusted);
  mismatched.identity.sessionEpoch = 'stale-session';
  const mismatchRuntime = createInterviewRealizer({
    cancellationRegistry: new GenerationCancellationRegistry(),
    decisionRequestResolver: decisionRequestResolver(trusted),
    async generate() { return {}; },
  });
  await assert.rejects(mismatchRuntime.run(mismatched), /identity/);

  const request = livePolicyRequest('I-033', 22);
  const registry = new GenerationCancellationRegistry();
  const replayRuntime = createInterviewRealizer({
    cancellationRegistry: registry,
    decisionRequestResolver: decisionRequestResolver(request),
    async generate({ plan }) { return validInterviewOutput(plan); },
  });
  const runtimeRequest = interviewRunRequest(request);
  assert.equal((await replayRuntime.run(runtimeRequest)).status, 'success');
  await assert.rejects(replayRuntime.run(runtimeRequest), /finalized invocationId/);
});
