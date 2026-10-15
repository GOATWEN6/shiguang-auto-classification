import { createHash } from 'node:crypto';

import {
  assertInterviewNextAction, assertLiveInterviewDecisionRequest,
  type InterviewNextAction, type LiveInterviewDecisionRequest,
} from './contracts.ts';
import { decideInterviewNextAction } from './reducer.ts';

/** Algorithm v0.3; the public action wire contract remains schema 0.2. */
export const INTERVIEW_CONTINUATION_POLICY_VERSION = 'interview-policy-v0.3.4' as const;

/**
 * Keep every v0.2 control decision. Only its ordinary default acknowledgement
 * becomes one low-pressure continuation; character count is not engagement.
 * No case IDs, evaluation answers or ungoverned context enter this decision.
 */
export function decideInterviewNextActionWithContinuation(
  request: LiveInterviewDecisionRequest,
): InterviewNextAction {
  const valid = assertLiveInterviewDecisionRequest(request);
  const original = decideInterviewNextAction(valid);
  const text = valid.input.asr.text?.trim() ?? '';
  const ordinaryActive = original.mode === 'FORMAL_INTERVIEW'
    && valid.input.sessionStatus === 'ACTIVE' && original.interactionAction === 'NONE'
    && original.retentionControl.intent === 'DEFAULT'
    && original.runtimeControl.delivery.mode === 'EMIT' && valid.input.asr.status === 'FINAL';
  const explicitSwitch = /(?:换(?:个|一个|一种)(?:轻松|简单|别的|其他)?话题|换个话题|改聊)/u.test(text)
    || /(?:这段|这件事|这个话题).{0,8}(?:聊到这里|先放一放|先不说).{0,8}(?:说说|聊聊)/u.test(text);
  const canSwitch = original.reasonCodes.every(code =>
    ['DEFAULT_ACKNOWLEDGE', 'ORDINARY_NARRATIVE_CONTINUATION', 'FOLLOW_UP_LIMIT_REACHED',
      // Explicit topic intent precedes the base reducer's ordinary length/depth
      // heuristics. Safety, privacy and interaction controls remain excluded.
      'LONG_ENGAGED_RESPONSE', 'CLEAR_SHORT_ANSWER',
      'EXPLICIT_SWITCH_TOPIC', 'USER_NAMED_ALTERNATIVE'].includes(code));
  if (ordinaryActive && explicitSwitch && canSwitch) {
    const alternative = /(?:改聊|聊聊|想聊|(?:这段|这件事|这个话题).{0,8}(?:聊到这里|先放一放|先不说).{0,8}(?:说说|聊聊))\s*([^，。！？!?；;]{1,60})/u.exec(text)?.[1]
      ?.replace(/(?:的事情|的事|吧)$/u, '').trim() || null;
    const next = structuredClone(original);
    next.decisionId = `v0.2:${createHash('sha256')
      .update(`${INTERVIEW_CONTINUATION_POLICY_VERSION}:switch:${original.decisionId}`).digest('hex').slice(0, 24)}`;
    next.interviewAction = 'SWITCH_TOPIC';
    next.reasonCodes = ['EXPLICIT_SWITCH_TOPIC', ...(alternative ? ['USER_NAMED_ALTERNATIVE'] : [])];
    if (alternative) next.statePatch.currentTopic = alternative;
    next.utterancePlan = { intent: '尊重本人明确换题，沿本人指定的新线索继续',
      suggestedText: alternative ? `好，我们聊${alternative}。您最先想到的是哪一件小事？`
        : '好，这段先放一放。您想聊哪个话题？',
      questionCount: 1, mustAvoid: [...next.utterancePlan.mustAvoid, '继续追问旧话题', '把一次换题升级为永久禁谈'] };
    next.obligations = next.obligations.filter(item => item.id !== 'INTERVIEW_MOVE' && item.id !== 'TOPIC_GOVERNANCE');
    const refs = valid.input.asr.ref ? [valid.input.asr.ref] : [];
    next.obligations.push({ id: 'TOPIC_GOVERNANCE', plane: 'TOPIC', operation: 'APPLY_TOPIC_SCOPE', sourceRefs: refs },
      { id: 'INTERVIEW_MOVE', plane: 'INTERVIEW', operation: 'SWITCH_TOPIC', sourceRefs: refs });
    return assertInterviewNextAction(next);
  }
  if (original.mode !== 'FORMAL_INTERVIEW' || valid.input.sessionStatus !== 'ACTIVE'
    || original.interactionAction !== 'NONE' || original.interviewAction !== 'ACKNOWLEDGE'
    || original.reasonCodes.length !== 1 || original.reasonCodes[0] !== 'DEFAULT_ACKNOWLEDGE'
    || original.retentionControl.intent !== 'DEFAULT'
    || original.runtimeControl.delivery.mode !== 'EMIT'
    || valid.input.asr.status !== 'FINAL' || !text
    || (valid.input.followUpDepth ?? 0) >= 2
    || /(?:谢谢|多谢|不用问|不要问)|(?:写|生成|整理).*(?:故事|画像|回忆)/u.test(text)) {
    return original;
  }
  const next = structuredClone(original);
  const digest = createHash('sha256').update(`${INTERVIEW_CONTINUATION_POLICY_VERSION}:${original.decisionId}`)
    .digest('hex').slice(0, 24);
  // decisionId retains the schema's prefix; policy version is separately recorded.
  next.decisionId = `v0.2:${digest}`;
  next.interviewAction = 'FOLLOW_UP';
  next.reasonCodes = ['ORDINARY_NARRATIVE_CONTINUATION'];
  next.utterancePlan = {
    intent: '沿本人刚提供的一个线索继续，不按字数判断参与程度',
    suggestedText: '关于这段经历，您最想接着讲哪个片段？',
    questionCount: 1,
    mustAvoid: [...next.utterancePlan.mustAvoid, '按回答长短推断状态', '重复已经回答的问题'],
  };
  next.obligations = next.obligations.map(item => item.id === 'INTERVIEW_MOVE'
    ? { ...item, operation: 'FOLLOW_UP' } : item);
  return assertInterviewNextAction(next);
}
