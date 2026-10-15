import {
  assertRuntimeIdentity,
  cancellationCleanupTimeout,
  settleWithCancellationCleanup,
  type BorrowedGenerationExecutionPermit,
  type CancellationCleanupStatus,
  type GenerationExecutionLease,
  type RuntimeChannel,
  type RuntimeIdentity,
} from '../algorithm-runtime/index.ts';
import {
  decideInterviewNextAction,
  decideInterviewNextActionWithContinuation,
  type InterviewNextAction,
  type InterviewRetentionControl,
  type LiveInterviewDecisionRequest,
} from '../interview-policy/index.ts';
import type {
  CreateDailyChatResponseRuntimeOptions,
  CreateInterviewRealizerOptions,
  DailyChatAccessContext,
  DailyChatGenerationPlan,
  DailyChatIntent,
  DailyChatResponseRuntime,
  DailyChatRuntimeResult,
  InterviewGenerationPlan,
  InterviewRealizer,
  InterviewRuntimeResult,
  TrustedDailyChatReference,
} from './contracts.ts';
import {
  assertDailyChatDecisionRequest,
  assertExactLivePolicyRequest,
  assertInterviewRealizerRequest,
  knownIdentity,
  sameExactIdentity,
  validateDailyChatAccessContext,
  validateDailyChatOutput,
  validateInterviewOutput,
  validateTrustedDailyChatReference,
} from './validators.ts';

const DAILY_FALLBACK = Object.freeze({
  ACKNOWLEDGE: '我在听，我们慢慢聊。',
  RESPOND: '我现在没能好好回答，我们稍后再试。',
} as const);

function cloneRetention(control: InterviewRetentionControl): InterviewRetentionControl {
  return { ...control, sourceRefs: [...control.sourceRefs] };
}

function acquireRuntimeLease(
  registry: CreateDailyChatResponseRuntimeOptions['cancellationRegistry'],
  identity: RuntimeIdentity,
  channel: RuntimeChannel,
): GenerationExecutionLease {
  const signal = registry.begin(identity, channel);
  const lease = registry.acquireLease(identity, channel);
  if (!lease || lease.signal !== signal) {
    registry.finalize(identity, channel);
    throw new Error('failed to acquire the canonical generation lease');
  }
  return lease;
}

function isDeliverable(lease: GenerationExecutionLease): boolean {
  return !lease.signal.aborted && lease.accepts().accepted;
}

function borrowRuntimeLease(
  registry: CreateDailyChatResponseRuntimeOptions['cancellationRegistry'],
  lease: GenerationExecutionLease,
): BorrowedGenerationExecutionPermit {
  const permit = registry.borrowLease(lease);
  if (!permit) throw new Error('failed to borrow the canonical generation lease');
  return permit;
}

function combinedCancellationCleanup(
  taskStatus: Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'>,
  permit: BorrowedGenerationExecutionPermit,
): Exclude<CancellationCleanupStatus, 'NOT_REQUIRED'> {
  const nestedStatus = permit.cleanupStatus();
  if (taskStatus === 'FAILED' || nestedStatus === 'FAILED') return 'FAILED';
  return taskStatus === 'TIMED_OUT'
    || nestedStatus === 'TIMED_OUT'
    || nestedStatus === 'PENDING'
    ? 'TIMED_OUT'
    : 'JOINED';
}

function dailyPlan(
  intent: DailyChatIntent,
  identity: RuntimeIdentity,
  allowedEvidenceRefs: string[],
  allowLightFollowUp = false,
): DailyChatGenerationPlan {
  return {
    schemaVersion: '0.1',
    planId: `daily:${identity.sessionEpoch}:${identity.turnId}:${identity.generationId}:${identity.invocationId}`,
    mode: 'DAILY_CHAT',
    promptId: allowLightFollowUp ? 'daily-chat-v0.2' : 'daily-chat-v0.1',
    schemaId: 'daily-chat-response-v0.1',
    purpose: 'daily_chat',
    intent,
    maxQuestions: allowLightFollowUp && intent === 'RESPOND' ? 1 : 0,
    suggestedText: DAILY_FALLBACK[intent],
    allowedEvidenceRefs,
  };
}

function dailyResult(
  plan: DailyChatGenerationPlan,
  status: DailyChatRuntimeResult['status'],
  text: string,
  evidenceRefs: string[],
  cancellationCleanupStatus: CancellationCleanupStatus = 'NOT_REQUIRED',
  questionCount: 0 | 1 = 0,
): DailyChatRuntimeResult {
  return {
    status,
    planId: plan.planId,
    mode: 'DAILY_CHAT',
    intent: plan.intent,
    text,
    questionCount,
    evidenceRefs,
    fallbackUsed: status === 'fallback',
    cancellationCleanupStatus,
  };
}

async function resolveDailyContext(
  options: CreateDailyChatResponseRuntimeOptions,
  identity: RuntimeIdentity,
): Promise<{ accessContext: DailyChatAccessContext; context: TrustedDailyChatReference[] }> {
  const accessContext = validateDailyChatAccessContext(
    await options.accessContextResolver.resolve(knownIdentity(identity)),
  );
  const refs = [...new Set(identity.evidenceRefs)];
  const resolved = await Promise.all(refs.map(async ref => {
    const value = await options.referenceResolver.resolve(
      ref,
      { ...accessContext, visibilityScope: [...accessContext.visibilityScope] },
      knownIdentity(identity),
    );
    return validateTrustedDailyChatReference(value, ref);
  }));
  const context = resolved.filter((item): item is TrustedDailyChatReference => {
    if (item === null || item.purpose !== 'daily_chat') return false;
    if (item.subjectId !== accessContext.subjectId) return false;
    if (item.familySpaceId !== accessContext.familySpaceId) return false;
    if (item.authorizationVersion !== accessContext.authorizationVersion) return false;
    return item.visibilityScope.includes('*')
      || accessContext.visibilityScope.every(scope => item.visibilityScope.includes(scope));
  });
  return { accessContext, context };
}

export function createDailyChatResponseRuntime(
  options: CreateDailyChatResponseRuntimeOptions,
): DailyChatResponseRuntime {
  if (typeof options?.generate !== 'function') throw new TypeError('generate must be a function');
  if (!options.cancellationRegistry) throw new TypeError('cancellationRegistry is required');
  if (!options.accessContextResolver || typeof options.accessContextResolver.resolve !== 'function') {
    throw new TypeError('accessContextResolver.resolve must be a function');
  }
  if (!options.referenceResolver || typeof options.referenceResolver.resolve !== 'function') {
    throw new TypeError('referenceResolver.resolve must be a function');
  }
  const cleanupTimeoutMs = cancellationCleanupTimeout(options.cancellationCleanupTimeoutMs);

  return {
    async run(request) {
      assertDailyChatDecisionRequest(request);
      const decisionRequest = structuredClone(request);
      assertDailyChatDecisionRequest(decisionRequest);
      const identity = knownIdentity(assertRuntimeIdentity(decisionRequest.identity));
      const intent = decisionRequest.intent;
      const lease = acquireRuntimeLease(options.cancellationRegistry, identity, 'daily_chat');
      const signal = lease.signal;
      let plan = dailyPlan(intent, lease.identity, [], options.allowLightFollowUp);
      try {
        const executionPermit = borrowRuntimeLease(options.cancellationRegistry, lease);
        if (!isDeliverable(lease)) {
          return dailyResult(plan, 'cancelled', '', []);
        }
        const outcome = await settleWithCancellationCleanup((async () => {
          const { accessContext, context } = await resolveDailyContext(options, lease.identity);
          plan = dailyPlan(intent, lease.identity, context.map(item => item.ref), options.allowLightFollowUp);
          if (!isDeliverable(lease)) return { output: null, context };
          const output = await options.generate({
            identity: knownIdentity(lease.identity),
            signal,
            executionPermit,
            plan: { ...plan, allowedEvidenceRefs: [...plan.allowedEvidenceRefs] },
            accessContext: { ...accessContext, visibilityScope: [...accessContext.visibilityScope] },
            context: context.map(item => ({ ...item, visibilityScope: [...item.visibilityScope] })),
          });
          return { output, context };
        })(), signal, cleanupTimeoutMs);
        if (outcome.kind === 'cancelled') {
          return dailyResult(
            plan,
            'cancelled',
            '',
            [],
            combinedCancellationCleanup(outcome.cleanupStatus, executionPermit),
          );
        }
        if (!isDeliverable(lease)) {
          return dailyResult(
            plan,
            'cancelled',
            '',
            [],
            combinedCancellationCleanup('JOINED', executionPermit),
          );
        }
        if (outcome.kind === 'error') {
          return dailyResult(plan, 'fallback', plan.suggestedText, []);
        }
        const output = validateDailyChatOutput(outcome.value.output, plan);
        if (!output) return dailyResult(plan, 'fallback', plan.suggestedText, []);
        return dailyResult(plan, 'success', output.text, output.evidenceRefs, 'NOT_REQUIRED', output.questionCount);
      } finally {
        lease.finalize();
      }
    },
  };
}

function selectedAction(action: InterviewNextAction): InterviewGenerationPlan['action'] {
  const selected = action.interactionAction === 'NONE'
    ? action.interviewAction
    : action.interactionAction;
  if (selected === 'NONE') throw new Error('InterviewNextAction must select an action');
  return selected;
}

function currentTopic(request: LiveInterviewDecisionRequest, action: InterviewNextAction): string | null {
  if (Object.prototype.hasOwnProperty.call(action.statePatch, 'currentTopic')) {
    return action.statePatch.currentTopic ?? null;
  }
  return request.input.selectedTopic ?? request.input.currentTopic;
}

function blockedTopics(request: LiveInterviewDecisionRequest, action: InterviewNextAction): string[] {
  return [...new Set([
    ...request.input.blockedTopics,
    ...(action.statePatch.blockedTopicsAdd ?? []),
  ])];
}

function normalized(value: string): string {
  return value.normalize('NFKC').replace(/\s+/gu, '').toLocaleLowerCase('zh-CN');
}

function safePolicyText(action: InterviewNextAction, blocked: readonly string[]): string {
  const text = action.utterancePlan.suggestedText;
  const normalizedText = normalized(text);
  if (!blocked.some(topic => normalizedText.includes(normalized(topic)))) return text;
  if (action.retentionControl.intent === 'NO_SAVE') return '好，这一段不保存，我们先停在这里。';
  if (action.interactionAction === 'END') return '好，今天就聊到这里。';
  if (action.interactionAction === 'PAUSE') return '好，您先休息，我们以后再聊。';
  if (action.interactionAction === 'SAFE_RESPONSE') {
    return '我先停止普通访谈。请及时联系身边可信的人或当地紧急求助服务。';
  }
  return '好，这个话题先不谈，我们先停在这里。';
}

function interviewBase(
  action: InterviewNextAction,
  topicId: string | null,
): Omit<InterviewRuntimeResult, 'status' | 'text' | 'fallbackUsed' | 'cancellationCleanupStatus'> {
  return {
    decisionId: action.decisionId,
    mode: 'FORMAL_INTERVIEW',
    action: selectedAction(action),
    retentionControl: cloneRetention(action.retentionControl),
    questionCount: action.utterancePlan.questionCount,
    evidenceRefs: action.evidenceRefs.map(item => item.ref),
    topicId,
  };
}

function modelEligible(action: InterviewNextAction, blocked: readonly string[], naturalizeQuestions = false): boolean {
  return action.runtimeControl.delivery.mode === 'EMIT'
    && action.interactionAction === 'NONE'
    && (action.interviewAction === 'ACKNOWLEDGE'
      || (naturalizeQuestions && ['FOLLOW_UP', 'CLARIFY', 'OFFER_TOPIC'].includes(action.interviewAction)))
    && (action.utterancePlan.questionCount === 0 || naturalizeQuestions)
    && action.retentionControl.intent === 'DEFAULT'
    && action.statePatch.sessionStatus !== 'ENDED'
    && action.statePatch.sessionStatus !== 'PAUSED'
    && blocked.length === 0;
}

function interviewPlan(
  action: InterviewNextAction,
  topicId: string | null,
  frozenPolicyText: string,
  naturalizeQuestions: boolean,
  ordinaryNarrativeContinuation = false,
): InterviewGenerationPlan {
  return {
    schemaVersion: '0.1',
    promptId: ordinaryNarrativeContinuation ? 'interview-realizer-v0.3'
      : naturalizeQuestions ? 'interview-realizer-v0.2' : 'interview-realizer-v0.1',
    schemaId: 'interview-response-v0.1',
    decisionId: action.decisionId,
    mode: 'FORMAL_INTERVIEW',
    action: selectedAction(action),
    retentionIntent: 'DEFAULT',
    questionCount: action.utterancePlan.questionCount,
    evidenceRefs: action.evidenceRefs.map(item => item.ref),
    topicId,
    intent: action.utterancePlan.intent,
    mustAvoid: [...action.utterancePlan.mustAvoid],
    frozenPolicyText,
  };
}

export function createInterviewRealizer(
  options: CreateInterviewRealizerOptions,
): InterviewRealizer {
  if (typeof options?.generate !== 'function') throw new TypeError('generate must be a function');
  if (!options.cancellationRegistry) throw new TypeError('cancellationRegistry is required');
  if (!options.decisionRequestResolver || typeof options.decisionRequestResolver.resolve !== 'function') {
    throw new TypeError('decisionRequestResolver.resolve must be a function');
  }
  const cleanupTimeoutMs = cancellationCleanupTimeout(options.cancellationCleanupTimeoutMs);

  return {
    async run(request) {
      assertInterviewRealizerRequest(request);
      const runtimeRequest = structuredClone(request);
      assertInterviewRealizerRequest(runtimeRequest);
      const identity = knownIdentity(assertRuntimeIdentity(runtimeRequest.identity));
      const resolved = options.decisionRequestResolver.resolve(knownIdentity(identity));
      const policyRequest = structuredClone(resolved);
      assertExactLivePolicyRequest(policyRequest);
      const policyIdentity = knownIdentity(assertRuntimeIdentity(policyRequest.identity));
      if (!sameExactIdentity(identity, policyIdentity)) {
        throw new TypeError('resolved policy request identity must exactly match runtime request identity');
      }
      const action = options.ordinaryNarrativeContinuation
        ? decideInterviewNextActionWithContinuation(policyRequest) : decideInterviewNextAction(policyRequest);
      if (action.mode !== 'FORMAL_INTERVIEW') {
        throw new TypeError('InterviewRealizer requires FORMAL_INTERVIEW mode');
      }
      const topicId = currentTopic(policyRequest, action);
      const blocked = blockedTopics(policyRequest, action);
      const policyText = safePolicyText(action, blocked);
      const lease = acquireRuntimeLease(options.cancellationRegistry, identity, 'formal_interview');
      const signal = lease.signal;
      try {
        const executionPermit = borrowRuntimeLease(options.cancellationRegistry, lease);
        if (!isDeliverable(lease)) {
          return {
            status: 'cancelled', ...interviewBase(action, topicId), text: '', fallbackUsed: false,
            cancellationCleanupStatus: 'NOT_REQUIRED',
          };
        }
        if (action.runtimeControl.delivery.mode === 'SUPPRESS') {
          return {
            status: 'suppressed', ...interviewBase(action, topicId), text: '', fallbackUsed: false,
            cancellationCleanupStatus: 'NOT_REQUIRED',
          };
        }
        if (!modelEligible(action, blocked, options.naturalizeQuestions)) {
          return {
            status: 'policy_direct', ...interviewBase(action, topicId), text: policyText, fallbackUsed: false,
            cancellationCleanupStatus: 'NOT_REQUIRED',
          };
        }

        const plan = interviewPlan(action, topicId, policyText, options.naturalizeQuestions === true,
          options.ordinaryNarrativeContinuation === true);
        const outcome = await settleWithCancellationCleanup(
          Promise.resolve().then(() => options.generate({
            identity: knownIdentity(lease.identity),
            signal,
            executionPermit,
            plan: {
              ...plan,
              evidenceRefs: [...plan.evidenceRefs],
              mustAvoid: [...plan.mustAvoid],
            },
          })),
          signal,
          cleanupTimeoutMs,
        );
        if (outcome.kind === 'cancelled') {
          return {
            status: 'cancelled', ...interviewBase(action, topicId), text: '', fallbackUsed: false,
            cancellationCleanupStatus: combinedCancellationCleanup(
              outcome.cleanupStatus,
              executionPermit,
            ),
          };
        }
        if (!isDeliverable(lease)) {
          return {
            status: 'cancelled', ...interviewBase(action, topicId), text: '', fallbackUsed: false,
            cancellationCleanupStatus: combinedCancellationCleanup('JOINED', executionPermit),
          };
        }
        if (outcome.kind === 'error') {
          return {
            status: 'fallback', ...interviewBase(action, topicId), text: policyText, fallbackUsed: true,
            cancellationCleanupStatus: 'NOT_REQUIRED',
          };
        }
        const output = validateInterviewOutput(outcome.value, plan);
        if (!output) {
          return {
            status: 'fallback', ...interviewBase(action, topicId), text: policyText, fallbackUsed: true,
            cancellationCleanupStatus: 'NOT_REQUIRED',
          };
        }
        return {
          status: 'success', ...interviewBase(action, topicId), text: output.text, fallbackUsed: false,
          cancellationCleanupStatus: 'NOT_REQUIRED',
        };
      } finally {
        lease.finalize();
      }
    },
  };
}
