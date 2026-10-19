import crypto from 'node:crypto';

import {
  assertInterviewNextAction,
  assertLiveInterviewDecisionRequest,
  type EpochRelation,
  type EvidenceKind,
  type GenerationCancelScope,
  type InteractionAction,
  type InterviewAction,
  type InterviewEvidenceRef,
  type InterviewMode,
  type InterviewNextAction,
  type InterviewObligation,
  type InterviewObligationId,
  type InterviewObligationPlane,
  type InterviewPolicyInput,
  type InterviewStatePatch,
  type InterviewUncertainty,
  type LiveInterviewDecisionRequest,
} from './contracts.ts';

interface FrozenCompatibilityDecisionRequest {
  id?: string;
  input: InterviewPolicyInput;
}

/**
 * SGX-owned InterviewPolicy reducer candidate v0.2.
 *
 * This isolated candidate does not read fixture ids, Oracle outputs, case files,
 * production state, or CanonicalMemory. It first collects independent signals,
 * then composes obligations and resolves one compatibility action at the end.
 */

export const RULE_PHASES = Object.freeze([
  'COLLECT_RUNTIME_AND_CONTROL_SIGNALS',
  'COLLECT_SAFETY_AND_RETENTION_SIGNALS',
  'COLLECT_TOPIC_AND_INTERVIEW_SIGNALS',
  'COMPOSE_OBLIGATIONS',
  'RESOLVE_COMPATIBILITY_ACTION',
  'APPLY_TERMINAL_AND_DELIVERY_GUARDS'
]);

const DEFAULT_MUST_AVOID = Object.freeze([
  '把推测说成事实',
  '一次提出多个问题',
  '使用未获准的 Memory'
]);

interface WorkingDecision {
  mode: InterviewMode;
  interactionAction: InteractionAction;
  interviewAction: InterviewAction;
  reasonCodes: string[];
  evidenceRefs: Array<InterviewEvidenceRef | null>;
  uncertainty: InterviewUncertainty;
  intent: string;
  text: string;
  questionCount: 0 | 1;
  mustAvoid: string[];
  statePatch: InterviewStatePatch;
  topicGovernance: boolean;
  safety: boolean;
  technicalRecovery: boolean;
  memoryInputBlocked: boolean;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)])
    );
  }
  return value;
}

function decisionIdFor(input: InterviewPolicyInput): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify(stable(input)))
    .digest('hex')
    .slice(0, 24);
  return `v0.2:${digest}`;
}

function evidence(
  ref: string | null | undefined,
  kind: EvidenceKind,
  purpose: string,
): InterviewEvidenceRef | null {
  return ref ? { ref, kind, purpose } : null;
}

function compactEvidence(items: Array<InterviewEvidenceRef | null>): InterviewEvidenceRef[] {
  const byRef = new Map<string, InterviewEvidenceRef>();
  for (const item of items) {
    if (!item) continue;
    if (!byRef.has(item.ref)) byRef.set(item.ref, item);
  }
  return [...byRef.values()];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function stripTopic(value: string | null | undefined): string | null {
  return value
    ?.replace(/^[，。、“”\s]+|[，。？！、“”\s]+$/gu, '')
    .replace(/^(?:我以前|以前)/u, '')
    .replace(/(?:的日子|的事情|的事)$/u, '')
    .trim() || null;
}

function extractNamedAlternative(message: string): string | null {
  const patterns = [
    /改聊([^，。？！?]+?)(?:吧)?[。？！?]?$/u,
    /聊(?:聊)?我以前([^，。？！?]+?)的事/u,
    /想讲讲([^，。？！?]+?)(?:的日子|的事情|的事)[。？！?]?$/u,
    /(?:这段|这件事|这个话题).{0,8}(?:聊到这里|先放一放|先不说).{0,8}(?:我们)?(?:说说|聊聊|改聊)([^，。？！?]+?)[。？！?]?$/u,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match) return stripTopic(match[1]);
  }
  return null;
}

function isMedicalRisk(message: string): boolean {
  return /(胸口疼|胸痛|摔到头|头部受伤|发晕|吃没吃.*药|药.*吃没吃|补服|再来一份|吃什么药|用什么药|自行用药)/u.test(message);
}

function hasBenignObjectSubject(message: string): boolean {
  return /(蚕|花|树|庄稼|牲口|鸡|鸭|鱼|虫|苗).{0,8}活不成/u.test(message);
}

function isSelfHarm(message: string): boolean {
  if (hasBenignObjectSubject(message)) return false;
  return /(?:我|俺|自己).{0,6}(?:不想活|活不下去|自杀|伤害自己|结束生命)/u.test(message);
}

function isFinancialRisk(message: string): boolean {
  return /(养老钱.*(?:股票|投资)|买哪只股票|稳赚|保证收益)/u.test(message);
}

function isExplicitEnd(message: string): boolean {
  return /(今天就(?:聊)?到这(?:儿|里)(?:吧)?|今天就收住|不要再开新话题)/u.test(message) ||
    /(结束吧|停止吧|不聊了|就这样吧)[。！!]?$/u.test(message);
}

function isNoSave(message: string): boolean {
  return /(刚才这段|这段|这一段|本段).{0,8}(?:别存|不要存|不保存)|(?:别存|不要存|不保存).{0,8}(?:刚才这段|这段|这一段|本段)/u.test(message);
}

function targetsPreviousCompletedTurn(message: string): boolean {
  return /(刚才这段|刚才那段|上一段|上一轮|刚刚(?:说|讲)的)/u.test(message);
}

function isExplicitRefusal(message: string): boolean {
  return /(不想说|不愿说|不想聊|不说了|不谈这个|这个不说)/u.test(message);
}

function isInvitationDecline(message: string): boolean {
  return /(不用|先不聊|暂时不聊|不想聊|不愿意聊|以后再说|先不说)/u.test(message);
}

function isImplicitRefusal(message: string): boolean {
  return /(那一页翻过去|这一页翻过去|这页翻过去|不在那一页停留)/u.test(message);
}

function isExplicitSwitch(message: string): boolean {
  return /(换个话题|换一个|改聊)/u.test(message)
    || /(?:这段|这件事|这个话题).{0,8}(?:聊到这里|先放一放|先不说).{0,8}(?:说说|聊聊)/u.test(message);
}

function hasExplicitTaboo(message: string): boolean {
  return /(以后不要再提|以后别再提|往后不要再拿来问|别再问|不要再问)/u.test(message);
}

function hasPrivacyRestriction(message: string): boolean {
  return /(不要告诉|别告诉|不许告诉)/u.test(message);
}

function hasStrongFatigue(message: string): boolean {
  return /(眼皮沉|累了|困了|想休息|先休息|先停一下|歇一会|下次吧|今天(?:先|就)?到这(?:儿|里)(?:吧)?|明天再接着|今天够了)/u.test(message);
}

function hasMildFatigue(message: string): boolean {
  return /(有点乏|有些乏|有点累|有些累)/u.test(message);
}

function hasExplicitContinue(message: string): boolean {
  return /(还想接着说|还愿意讲|连上后接着来|接着说|接着来|继续说|继续吧|接着吧|继续聊|继续访谈|不想停|不是累|愿意继续)/u.test(message);
}

function requestsLowerLoad(message: string): boolean {
  return /(问得简单些|问简单点|慢一点|容易回想的角度)/u.test(message);
}

function hasMemoryGap(message: string): boolean {
  return /(不记得|想不起来|记不清|我说不准|那些年挤成一团)/u.test(message);
}

function isThinking(message: string): boolean {
  return /^(?:让我|我)?想想(?:吧|一下)?(?:[。！!?？]|……|\.\.\.)?$/u.test(message.trim());
}

function isPauseInterviewToDailyChat(message: string): boolean {
  return /(?:停(?:下)?访谈|结束访谈|先不访谈|暂停访谈).*(?:继续聊天|聊聊天|日常聊)/u.test(message);
}

function requestsCues(message: string): boolean {
  return /(两个方向|一个简单的方向|给我.*方向|给我.*提示|换个.*角度|听两个提示)/u.test(message);
}

function isBargeIn(message: string, runtime: InterviewPolicyInput['runtime']): boolean {
  return runtime.tts === 'PLAYING' && runtime.vad === 'SPEAKING' &&
    /(先停一下|停一下)/u.test(message) && /(没讲完|还没说完|接着说)/u.test(message);
}

function genericFollowUp(input: InterviewPolicyInput): string {
  const topic = input.currentTopic?.trim();
  return topic
    ? `关于${topic}，您最想接着讲哪个片段？`
    : '关于这段经历，您最想接着讲哪个片段？';
}

/**
 * Natural-pause prompts must return the choice to the elder without sounding
 * like a fixed system checkpoint. The index is deterministic so replay and
 * quality review see the same wording for the same evidence, while different
 * turns/topics do not keep repeating one sentence.
 */
function naturalPausePrompt(input: InterviewPolicyInput): string {
  const topic = input.currentTopic?.trim();
  const subject = topic ? `${topic}这段` : '这段经历';
  const seed = `${topic ?? ''}|${input.previousCompletedUserEvidenceRef ?? ''}|${input.asr.ref ?? ''}`;
  const score = [...seed].reduce((sum, char) => sum + (char.codePointAt(0) ?? 0), 0);
  const variants = [
    `${subject}先停在这里也可以。您还愿意继续讲吗，还是今天先到这里？`,
    `刚才这段我们聊了几轮。您想再补充一点，还是今天先到这里？`,
    `您慢慢来。还想继续这段经历，还是今天先休息？`,
  ];
  return variants[score % variants.length]!;
}

function reopenFollowUp(input: InterviewPolicyInput): string {
  const topic = input.currentTopic?.trim();
  return topic
    ? `好，我们接着聊${topic}。刚才这段您还想补充哪一点？`
    : '好，我们接着聊。刚才这段您还想补充哪一点？';
}

function shortAnswerFollowUp(input: InterviewPolicyInput, message: string): string {
  const answer = message.replace(/[。！？!?]+$/u, '').trim();
  const topic = input.currentTopic?.trim();
  return topic
    ? `${answer}。关于${topic}，您最记得什么？`
    : `${answer}。您最想接着讲什么？`;
}

function addObligation(
  map: Map<InterviewObligationId, InterviewObligation>,
  id: InterviewObligationId,
  plane: InterviewObligationPlane,
  operation: string,
  sourceRefs: Array<string | null | undefined> = [],
): void {
  if (!map.has(id)) {
    map.set(id, { id, plane, operation, sourceRefs: uniqueStrings(sourceRefs) });
  }
}

function relationForEpoch(
  current: string | null,
  incoming: string | null,
  terminalRejected: boolean,
): EpochRelation {
  if (terminalRejected && incoming) return 'TERMINAL_REJECTED';
  if (!current || !incoming) return 'UNKNOWN';
  return current === incoming ? 'SAME' : 'STALE';
}

function baseDecision(input: InterviewPolicyInput): WorkingDecision {
  return {
    mode: input.mode,
    interactionAction: 'NONE',
    interviewAction: 'ACKNOWLEDGE',
    reasonCodes: ['DEFAULT_ACKNOWLEDGE'],
    evidenceRefs: input.asr?.status === 'FINAL' && input.asr?.ref
      ? [evidence(input.asr.ref, 'TURN', '承接本轮已完成文本')]
      : [],
    uncertainty: 'LOW',
    intent: '简短承接，不添加未经证实的前提',
    text: '好，我听到了。',
    questionCount: 0,
    mustAvoid: [],
    statePatch: {},
    topicGovernance: false,
    safety: false,
    technicalRecovery: false,
    memoryInputBlocked: false
  };
}

function setInteraction(
  decision: WorkingDecision,
  action: Exclude<InteractionAction, 'NONE'>,
  details: Partial<WorkingDecision>,
): void {
  decision.interactionAction = action;
  decision.interviewAction = 'NONE';
  Object.assign(decision, details);
}

function setInterview(
  decision: WorkingDecision,
  action: Exclude<InterviewAction, 'NONE'>,
  details: Partial<WorkingDecision>,
): void {
  decision.interactionAction = 'NONE';
  decision.interviewAction = action;
  Object.assign(decision, details);
}

/** @internal Frozen parity only. Live callers must use decideInterviewNextAction. */
export function decideCandidateNextAction({ input }: FrozenCompatibilityDecisionRequest): InterviewNextAction {
  const runtime = input.runtime || {};
  const asr = input.asr || {};
  const message = asr.status === 'FINAL' ? (asr.text || '').normalize('NFC').trim() : '';
  const currentTopic = input.currentTopic || null;
  const turnRef = asr.ref || null;
  const runtimeRef = runtime.ref || null;
  const uiRef = input.uiEvent?.ref || null;
  const incomingRef = input.incomingEvent?.ref || null;
  const previousCompletedUserEvidenceRef = input.previousCompletedUserEvidenceRef || null;
  const currentEpoch = input.sessionEpoch || runtime.sessionEpoch || null;
  const incomingEpoch = input.incomingEvent?.sessionEpoch || null;
  const activeGenerationId = typeof runtime.generationId === 'number' && Number.isInteger(runtime.generationId)
    ? runtime.generationId
    : null;
  const incomingGenerationId = typeof input.incomingEvent?.generationId === 'number' &&
    Number.isInteger(input.incomingEvent.generationId)
    ? input.incomingEvent.generationId
    : null;

  // Independent signal collection. No signal below returns from the reducer.
  const signals = {
    terminal: input.sessionStatus === 'ENDED',
    incomingResponse: input.incomingEvent?.type === 'PROVIDER_RESPONSE',
    uiEnd: input.uiEvent?.type === 'END_BUTTON',
    asrFailure: asr.status === 'FAILED',
    asrPartial: asr.status === 'PARTIAL',
    userSpeaking: runtime.vad === 'SPEAKING',
    networkOffline: runtime.network === 'OFFLINE',
    providerTimeout: runtime.provider === 'TIMEOUT',
    bargeIn: isBargeIn(message, runtime),
    medicalRisk: isMedicalRisk(message),
    selfHarm: isSelfHarm(message),
    financialRisk: isFinancialRisk(message),
    benignObject: hasBenignObjectSubject(message),
    explicitEnd: isExplicitEnd(message),
    noSave: isNoSave(message),
    noSavePrevious: isNoSave(message) && targetsPreviousCompletedTurn(message),
    privacyRestriction: hasPrivacyRestriction(message),
    explicitTaboo: hasExplicitTaboo(message),
    explicitRefusal: isExplicitRefusal(message),
    implicitRefusal: isImplicitRefusal(message),
    explicitSwitch: isExplicitSwitch(message),
    alternative: extractNamedAlternative(message),
    strongFatigue: hasStrongFatigue(message),
    mildFatigue: hasMildFatigue(message),
    explicitContinue: hasExplicitContinue(message),
    thinking: isThinking(message),
    pauseInterviewToDailyChat: isPauseInterviewToDailyChat(message),
    resumeLater: /(明天再接着|下次.*接着)/u.test(message),
    lowerLoad: requestsLowerLoad(message),
    memoryGap: hasMemoryGap(message),
    requestedCues: requestsCues(message),
    unauthorizedMemory: (input.memoryRefs || []).some((item) => item.allowedForInterview !== true)
  };

  const decision = baseDecision(input);

  // Compatibility action resolution uses priority only after all independent
  // obligations have been observed. Combined signals remain in reasons/state.
  if (signals.terminal) {
    setInteraction(decision, 'END', {
      reasonCodes: signals.incomingResponse
        ? ['SESSION_ALREADY_ENDED', 'LATE_RESPONSE_DROPPED']
        : ['SESSION_ALREADY_ENDED'],
      evidenceRefs: compactEvidence([
        evidence(incomingRef, 'RUNTIME_SIGNAL', '结束态收到旧响应事件'),
        evidence(runtimeRef, 'RUNTIME_SIGNAL', '结束态仍有输出活动')
      ]),
      intent: '保持会话终态并静默丢弃迟到输出',
      text: '',
      questionCount: 0,
      mustAvoid: ['播放迟到回复正文', '恢复旧主题', '产生 Memory 或故事候选'],
      statePatch: { sessionStatus: 'ENDED', dropPendingResponse: true }
    });
  } else if (signals.uiEnd) {
    const reasons = ['UI_END'];
    const refs = [evidence(uiRef, 'UI_EVENT', '结束按钮是明确控制信号')];
    if (signals.asrFailure) {
      reasons.push('ASR_FAILURE_OBSERVED');
      refs.push(evidence(turnRef, 'RUNTIME_SIGNAL', 'ASR 同时失败但不阻碍结束'));
    }
    if (runtime.tts === 'PLAYING' && runtimeRef) {
      refs.push(evidence(runtimeRef, 'RUNTIME_SIGNAL', '播放中的旧输出需要取消'));
    }
    setInteraction(decision, 'END', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence(refs),
      intent: '立即结束并停止旧播放',
      text: '好，已经结束。',
      questionCount: 0,
      mustAvoid: ['先修复识别再退出', '继续播放', '发起新问题'],
      statePatch: { sessionStatus: 'ENDED', dropPendingResponse: true }
    });
  } else if (signals.medicalRisk || signals.selfHarm || signals.financialRisk) {
    const reasons = [];
    if (signals.selfHarm) reasons.push('SELF_HARM_SIGNAL');
    if (signals.medicalRisk) reasons.push('MEDICAL_HIGH_RISK');
    if (signals.financialRisk) reasons.push('FINANCIAL_HIGH_RISK');
    if (signals.explicitEnd) reasons.push('EXPLICIT_STOP_SIGNAL');
    if (signals.noSave) reasons.push('EXPLICIT_NO_SAVE');
    if (signals.unauthorizedMemory && signals.medicalRisk) reasons.push('UNAUTHORIZED_MEMORY_BLOCKED');

    let text;
    let intent;
    let questionCount: 0 | 1 = 0;
    if (signals.selfHarm) {
      intent = '优先保障当前安全并引导即时真人支持';
      text = '我很担心您现在的安全。请马上联系身边可信的人或当地紧急求助服务，并先不要独处。';
    } else if (signals.financialRisk) {
      intent = '拒绝高影响投资指令并降低即时损失风险';
      text = '我不能替您指定股票或承诺收益。请先不要投入养老钱，可以和可信家人或持牌专业人士一起核实风险。';
    } else if (/(药|服)/u.test(message)) {
      intent = '避免重复用药风险，仅依据当前表达建议核对与求助';
      text = '先不要自行补服。请按药盒、处方或联系医生、药师核对；如果已经不舒服，请及时求助。您现在能联系到医生、药师或身边的人吗？';
      questionCount = 1;
    } else {
      intent = '停止普通访谈并给出非诊断性的即时求助引导';
      text = '我先停下普通访谈。头部受伤后发晕需要马上求助，请尽快联系急救或请身边的人协助。您现在能联系到身边的人吗？';
      questionCount = 1;
    }

    const statePatch: InterviewStatePatch = { dropPendingResponse: true };
    if (signals.explicitEnd) statePatch.sessionStatus = 'ENDED';
    setInteraction(decision, 'SAFE_RESPONSE', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '当前表达触发安全边界')]),
      intent,
      text,
      questionCount,
      mustAvoid: ['给出诊断或具体剂量', '使用未授权 Memory', '以安全为由继续采集经历'],
      statePatch,
      safety: true,
      memoryInputBlocked: signals.unauthorizedMemory && signals.medicalRisk
    });
  } else if (signals.pauseInterviewToDailyChat && input.mode === 'FORMAL_INTERVIEW') {
    decision.mode = 'DAILY_CHAT';
    setInterview(decision, 'ACKNOWLEDGE', {
      reasonCodes: ['INTERVIEW_TO_DAILY_CHAT'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人要求结束正式访谈但继续日常聊天')]),
      intent: '只结束正式访谈模式，保留当前会话的日常聊天能力',
      text: '好，我们先不做正式访谈，接下来就随便聊聊。',
      questionCount: 0,
      mustAvoid: ['结束整个会话', '继续追问访谈主题', '擅自保存或分享访谈内容'],
      statePatch: { mode: 'DAILY_CHAT', sessionStatus: 'ACTIVE', currentTopic: null, dropPendingResponse: true },
    });
  } else if (signals.explicitEnd) {
    const reasons = ['EXPLICIT_STOP_SIGNAL'];
    const refs = [evidence(turnRef, 'TURN', '老人明确要求结束')];
    if (signals.networkOffline) {
      reasons.push('NETWORK_FAILURE_OBSERVED');
      refs.push(evidence(runtimeRef, 'RUNTIME_SIGNAL', '离线与结束同时存在'));
    }
    setInteraction(decision, 'END', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence(refs),
      intent: '本地执行结束，不让技术故障阻碍退出',
      text: '好，今天就聊到这里。',
      questionCount: 0,
      mustAvoid: ['要求等待网络恢复', '发起新问题', '把离线解释为老人沉默'],
      statePatch: { sessionStatus: 'ENDED', dropPendingResponse: true }
    });
  } else if (signals.bargeIn) {
    setInteraction(decision, 'WAIT', {
      reasonCodes: ['USER_BARGE_IN', 'USER_STILL_SPEAKING'],
      evidenceRefs: compactEvidence([
        evidence(turnRef, 'TURN', '老人要求停止播报并继续表达'),
        evidence(runtimeRef, 'RUNTIME_SIGNAL', '播放与老人说话同时存在')
      ]),
      intent: '取消旧播报并继续倾听',
      text: '好，您接着说。',
      questionCount: 0,
      mustAvoid: ['宣布访谈暂停', '宣布本次结束', '立即抛出新问题'],
      statePatch: { sessionStatus: 'ACTIVE', dropPendingResponse: true }
    });
  } else if (signals.asrPartial) {
    setInteraction(decision, 'WAIT', {
      reasonCodes: ['ASR_PARTIAL'],
      evidenceRefs: compactEvidence([
        evidence(turnRef, 'RUNTIME_SIGNAL', 'ASR 文本尚未 final'),
        evidence(runtimeRef, 'RUNTIME_SIGNAL', '运行态显示表达尚未完成')
      ]),
      intent: '等待完整表达',
      text: '我在听。',
      questionCount: 0,
      mustAvoid: ['抢话', '要求重说'],
      statePatch: {}
    });
  } else if (asr.status === 'NONE' && signals.userSpeaking) {
    setInteraction(decision, 'WAIT', {
      reasonCodes: ['USER_STILL_SPEAKING'],
      evidenceRefs: compactEvidence([evidence(runtimeRef, 'RUNTIME_SIGNAL', 'VAD 显示老人仍在说话')]),
      intent: '不抢话，继续监听',
      text: '我在听。',
      questionCount: 0,
      mustAvoid: ['打断老人', '发起新问题'],
      statePatch: {}
    });
  } else if (signals.asrFailure) {
    setInteraction(decision, 'TECHNICAL_RECOVERY', {
      reasonCodes: ['ASR_FAILURE'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'RUNTIME_SIGNAL', 'ASR 明确失败')]),
      intent: '说明没听清并提供一次低负担重试',
      text: '我刚才没听清，您可以再说一遍吗？',
      questionCount: 1,
      mustAvoid: ['把识别失败当成拒绝或记忆问题'],
      statePatch: { sessionStatus: 'RECOVERING' },
      technicalRecovery: true
    });
  } else if (signals.networkOffline) {
    setInteraction(decision, 'TECHNICAL_RECOVERY', {
      reasonCodes: ['NETWORK_FAILURE'],
      evidenceRefs: compactEvidence([evidence(runtimeRef, 'RUNTIME_SIGNAL', '网络状态为离线')]),
      intent: '说明网络问题并保留当前进度',
      text: '网络暂时断开了，我会保留刚才的进度。',
      questionCount: 0,
      mustAvoid: ['把离线解释为沉默或拒绝'],
      statePatch: { sessionStatus: 'RECOVERING' },
      technicalRecovery: true
    });
  } else if (signals.providerTimeout) {
    const reasons = ['PROVIDER_TIMEOUT'];
    const refs = [evidence(runtimeRef, 'RUNTIME_SIGNAL', 'Provider 响应超时')];
    const statePatch: InterviewStatePatch = { sessionStatus: 'RECOVERING', resumePoint: currentTopic };
    let text = '刚才连接出了问题，恢复后我们会从这里继续。';
    let intent = '进入技术恢复并保留接续点';
    let topicGovernance = false;

    if (signals.explicitTaboo || signals.privacyRestriction) {
      reasons.unshift(...[
        signals.privacyRestriction ? 'PRIVACY_RESTRICTION' : null,
        signals.explicitTaboo ? 'EXPLICIT_TABOO' : null
      ].filter((reason): reason is string => Boolean(reason)));
      refs.unshift(evidence(turnRef, 'TURN', '技术故障中仍收到治理指令'));
      statePatch.currentTopic = null;
      statePatch.blockedTopicsAdd = currentTopic ? [currentTopic] : [];
      statePatch.dropPendingResponse = true;
      delete statePatch.resumePoint;
      text = '知道了，这个话题以后不再主动提。刚才连接出了问题，恢复后我们会换一个话题。';
      intent = '立即生效禁谈，同时独立进入技术恢复';
      topicGovernance = true;
    } else if (signals.explicitContinue) {
      reasons.push('USER_REQUESTED_CONTINUE');
      refs.unshift(evidence(turnRef, 'TURN', '老人明确愿意在恢复后继续'));
      statePatch.dropPendingResponse = true;
      text = '好，接续点留在这里。现在连接不稳，恢复后再从这里继续。';
      intent = '恢复技术链路并保留老人指定的接续点';
    }

    setInteraction(decision, 'TECHNICAL_RECOVERY', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence(refs),
      intent,
      text,
      questionCount: 0,
      mustAvoid: ['重复提交超时回复', '把技术失败解释为老人意愿'],
      statePatch,
      topicGovernance,
      technicalRecovery: true
    });
  } else if (input.sessionStatus === 'PAUSED' && signals.explicitContinue) {
    setInterview(decision, 'ACKNOWLEDGE', {
      reasonCodes: ['RESUME_INTERVIEW'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人明确要求从暂停位置继续')]),
      intent: '恢复正式访谈并沿暂停时的接续点继续',
      text: currentTopic ? `好，我们从${currentTopic}这段接着来。` : '好，我们接着聊。',
      questionCount: 0,
      mustAvoid: ['把暂停解释为永久拒谈', '重新邀请已经接受的访谈', '跳到未经选择的新主题'],
      statePatch: { sessionStatus: 'ACTIVE', currentTopic },
    });
  } else if (input.sessionStatus === 'PAUSED') {
    setInteraction(decision, 'PAUSE', {
      reasonCodes: ['SESSION_PAUSED_AWAITING_CONTINUE'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '会话仍处于暂停态，未收到明确继续信号')]),
      intent: '保持暂停并提示老人明确说继续后再恢复访谈',
      text: '我们还在暂停中。您想继续时说“继续”，我再接着来。',
      questionCount: 0,
      mustAvoid: ['把任意新话题当成恢复访谈', '在暂停态继续追问', '擅自结束会话'],
      statePatch: { sessionStatus: 'PAUSED' },
    });
  } else if (input.pendingModeOffer === 'FORMAL_INTERVIEW' && signals.asrFailure === false
    && signals.networkOffline === false && signals.providerTimeout === false
    && signals.explicitEnd === false && isInvitationDecline(message)) {
    setInterview(decision, 'ACKNOWLEDGE', {
      reasonCodes: ['INVITATION_DECLINED'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人拒绝当前正式访谈邀请')]),
      intent: '尊重本次拒绝并回到日常聊天，不在本会话重复邀请',
      text: '好，我们先按日常聊天来。您想聊什么都可以。',
      questionCount: 0,
      mustAvoid: ['再次邀请正式访谈', '把本次拒绝升级为永久拒谈', '声称已保存内容'],
      statePatch: { mode: 'DAILY_CHAT', pendingModeOffer: null, currentTopic: null },
    });
  } else if (
    asr.status === 'NONE' && runtime.vad === 'SILENT' &&
    typeof runtime.silenceSeconds === 'number' && typeof runtime.waitPreferenceSeconds === 'number' &&
    Number.isFinite(runtime.silenceSeconds) && Number.isFinite(runtime.waitPreferenceSeconds) &&
    runtime.silenceSeconds < runtime.waitPreferenceSeconds
  ) {
    setInteraction(decision, 'WAIT', {
      reasonCodes: ['WITHIN_WAIT_PREFERENCE'],
      evidenceRefs: compactEvidence([evidence(runtimeRef, 'RUNTIME_SIGNAL', '静音时长未超过等待偏好')]),
      intent: '保留思考时间',
      text: '您慢慢想，我在这里。',
      questionCount: 0,
      mustAvoid: ['催促回答', '擅自结束'],
      statePatch: {}
    });
  } else if (
    input.uiEvent?.type === 'MEMORY_TOPIC_CLICK' ||
    (input.pendingModeOffer === 'FORMAL_INTERVIEW' && /(可以|好|愿意)/u.test(message))
  ) {
    decision.mode = 'FORMAL_INTERVIEW';
    setInterview(decision, 'ACKNOWLEDGE', {
      reasonCodes: ['EXPLICIT_MODE_ENTRY'],
      evidenceRefs: compactEvidence([
        evidence(uiRef, 'UI_EVENT', '点击未完成的聊往事话题'),
        evidence(turnRef, 'TURN', '在待确认入口中明确同意')
      ]),
      intent: '确认进入正式访谈并只问一个开放问题',
      text: '好，我们就从这段往事慢慢聊。您最先想到的是什么？',
      questionCount: 1,
      mustAvoid: ['声称已经保存', '要求必须回答'],
      statePatch: {
        sessionStatus: 'ACTIVE',
        mode: 'FORMAL_INTERVIEW',
        currentTopic: input.selectedTopic || currentTopic
      }
    });
  } else if (currentTopic && (input.blockedTopics || []).includes(currentTopic)) {
    setInterview(decision, 'SWITCH_TOPIC', {
      reasonCodes: ['BLOCKED_TOPIC'],
      evidenceRefs: [],
      intent: '跳过已禁谈主题',
      text: '这个话题已跳过，我们换一个。',
      questionCount: 0,
      mustAvoid: ['重新暴露禁谈主题'],
      statePatch: { currentTopic: null },
      topicGovernance: true
    });
  } else if (/(别再提那个|不要再提那个)/u.test(message)) {
    setInterview(decision, 'CLARIFY', {
      reasonCodes: ['TABOO_SCOPE_UNCLEAR'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '禁谈范围指代不清')]),
      intent: '只澄清禁谈范围，不追问原因',
      text: '我会先停下。您说的“那个”是指当前这个话题吗？',
      questionCount: 1,
      mustAvoid: ['追问禁谈内容或原因'],
      uncertainty: 'MEDIUM',
      statePatch: {},
      topicGovernance: true
    });
  } else if (signals.privacyRestriction || signals.explicitTaboo) {
    const reasons = [];
    if (signals.privacyRestriction) reasons.push('PRIVACY_RESTRICTION');
    if (signals.explicitTaboo) reasons.push('EXPLICIT_TABOO');
    setInterview(decision, 'SWITCH_TOPIC', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人明确限制披露或再次提及')]),
      intent: '立即执行禁谈或用途限制',
      text: signals.privacyRestriction
        ? '好，我会按您的限制停止这个话题，也不扩大使用范围。'
        : '好，以后不再主动提这个话题。',
      questionCount: 0,
      mustAvoid: ['追问原因', '再次暴露受限内容'],
      statePatch: { blockedTopicsAdd: currentTopic ? [currentTopic] : [] },
      topicGovernance: true
    });
  } else if (signals.explicitRefusal || signals.implicitRefusal || signals.explicitSwitch) {
    const reasons = [];
    if (signals.explicitRefusal) reasons.push('EXPLICIT_REFUSAL');
    if (signals.implicitRefusal) reasons.push('IMPLICIT_REFUSAL');
    if (signals.explicitSwitch) reasons.push('EXPLICIT_SWITCH_TOPIC');
    if (signals.alternative) reasons.push('USER_NAMED_ALTERNATIVE');
    const statePatch: InterviewStatePatch = {};
    if (signals.explicitRefusal && currentTopic) statePatch.blockedTopicsAdd = [currentTopic];
    if (signals.alternative) statePatch.currentTopic = signals.alternative;
    setInterview(decision, 'SWITCH_TOPIC', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人拒绝当前题或选择新方向')]),
      intent: '停止当前题并尊重老人选择的新方向',
      text: signals.alternative
        ? `好，我们来聊${signals.alternative}。您最先想到的是哪一幕？`
        : '好，这个话题不再继续，我们换一个。',
      questionCount: signals.alternative ? 1 : 0,
      mustAvoid: ['追问拒绝原因', '把一次换题升级为永久禁谈'],
      statePatch,
      topicGovernance: true
    });
  } else if (signals.strongFatigue && !signals.explicitContinue) {
    const reasons = ['TIRED_SIGNAL'];
    if (signals.resumeLater) reasons.push('EXPLICIT_RESUME_LATER');
    setInteraction(decision, 'PAUSE', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人表达疲劳或以后继续')]),
      intent: '暂停会话并保留接续点',
      text: currentTopic ? `好，您先歇着。下次我们从${currentTopic}这段接着来。` : '好，我们先休息，想聊时再继续。',
      questionCount: 0,
      mustAvoid: ['要求再回答一题', '把暂停说成永久结束'],
      statePatch: { sessionStatus: 'PAUSED', resumePoint: currentTopic, dropPendingResponse: true }
    });
  } else if (signals.thinking) {
    setInteraction(decision, 'WAIT', {
      reasonCodes: ['ELDER_THINKING'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人明确表示需要思考时间')]),
      intent: '保留思考时间，不把思考当成拒绝或结束',
      text: '您慢慢想，我在这里。',
      questionCount: 0,
      mustAvoid: ['催促回答', '把思考解释为记忆问题', '立即换题'],
      statePatch: {},
    });
  } else if (signals.memoryGap) {
    const reasons = ['MEMORY_GAP'];
    if (signals.explicitContinue) reasons.push('EXPLICIT_CONTINUE');
    if (signals.requestedCues) reasons.push('REQUESTED_CUES');
    setInterview(decision, 'OFFER_TOPIC', {
      reasonCodes: reasons,
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人说明记忆边界或请求低压力提示')]),
      intent: '接受不确定性并提供一个低压力回忆角度',
      text: signals.requestedCues
        ? '没关系，我们不硬猜。先从那时常见的一样东西说起，可以吗？'
        : '没关系，您想换个话题，还是听一个简单提示？',
      questionCount: 1,
      mustAvoid: ['推断认知下降', '逼迫回忆', '同时提出多个问题'],
      statePatch: {}
    });
  } else if (/^先这样吧[。！!]?$/u.test(message)) {
    setInterview(decision, 'CLARIFY', {
      reasonCodes: ['SESSION_CONTROL_UNCLEAR'],
      evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '会话控制意图可能是暂停或结束')]),
      intent: '用一次中性询问澄清高影响控制意图',
      text: '您是想先歇一会儿，还是结束今天的访谈？',
      questionCount: 1,
      mustAvoid: ['擅自结束', '擅自暂停', '继续原题追问'],
      uncertainty: 'HIGH',
      statePatch: {}
    });
  } else {
    const years = message.match(/(?:19|20)\d{2}/gu) || [];
    if (years.length >= 2 && /(不对|记不准|好像)/u.test(message)) {
      setInterview(decision, 'CLARIFY', {
        reasonCodes: ['CONFLICTING_TIME_CLAIMS'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '同一轮出现冲突年份')]),
        intent: '保留不确定性并让老人选择是否核对',
        text: '这里有两个可能的年份，您想先都保留，还是再想一想？',
        questionCount: 1,
        mustAvoid: ['擅自选择年份', '指责记错'],
        uncertainty: 'HIGH',
        statePatch: {}
      });
    } else if (/^后来他/u.test(message)) {
      setInterview(decision, 'CLARIFY', {
        reasonCodes: ['AMBIGUOUS_REFERENT'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '人物指代缺少明确前提')]),
        intent: '中性澄清人物指代',
        text: '这里的“他”指的是谁？',
        questionCount: 1,
        mustAvoid: ['猜测人物身份'],
        uncertainty: 'HIGH',
        statePatch: {}
      });
    } else if (signals.benignObject) {
      setInterview(decision, 'FOLLOW_UP', {
        reasonCodes: ['BENIGN_OBJECT_CONTEXT', 'TOPIC_RELEVANT_RESPONSE'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '风险词的明确主语是当前故事对象')]),
        intent: '按当前叙事对象中性承接，避免安全误报',
        text: '您守了它们很久。后来发生了什么？',
        questionCount: 1,
        mustAvoid: ['引入自伤判断', '使用未授权家属描述'],
        statePatch: {}
      });
    } else if (signals.mildFatigue && signals.explicitContinue) {
      setInterview(decision, 'FOLLOW_UP', {
        reasonCodes: ['MILD_FATIGUE_SIGNAL', 'EXPLICIT_CONTINUE', 'REQUESTED_LOWER_LOAD'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人同时表达轻度疲乏、继续和降负担偏好')]),
        intent: '尊重继续意愿并降低问题复杂度',
        text: currentTopic ? `好，我们慢一点。关于${currentTopic}，您先想到哪一样？` : '好，我们慢一点。您先想到哪一样？',
        questionCount: 1,
        mustAvoid: ['自动暂停', '要求坚持', '一次询问多个阶段'],
        statePatch: {}
      });
    } else if (/(继续问|接着问|你问吧)/u.test(message)) {
      setInterview(decision, 'OFFER_TOPIC', {
        reasonCodes: ['USER_REQUESTED_GUIDANCE'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人明确希望系统继续引导')]),
        intent: '提供一个开放方向',
        text: '好，接下来您想先聊一个重要的人吗？',
        questionCount: 1,
        mustAvoid: ['一次给出多个问题', '强迫选择'],
        statePatch: {}
      });
    } else if (input.mode === 'FORMAL_INTERVIEW' && signals.explicitContinue) {
      setInterview(decision, 'FOLLOW_UP', {
        reasonCodes: ['EXPLICIT_CONTINUE', 'FOLLOW_UP_LIMIT_REOPENED'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '老人明确表示愿意继续当前线索')]),
        intent: '尊重明确的继续意愿，重新开放一个低负担追问',
        text: reopenFollowUp(input),
        questionCount: 1,
        mustAvoid: ['把继续意愿解释成必须继续', '一次追加多个问题', '重复已经回答的问题'],
        statePatch: {}
      });
    } else if ((input.followUpDepth || 0) >= 2) {
      // 这是完成一轮追问后的软停顿点：先把选择权交还给老人，
      // 不自动换题，也不把达到深度上限解释成访谈结束。
      setInterview(decision, 'CLARIFY', {
        reasonCodes: ['FOLLOW_UP_LIMIT_REACHED'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '当前追问链达到上限')]),
        intent: '在自然停顿处询问老人是否继续当前线索',
        text: naturalPausePrompt(input),
        questionCount: 1,
        mustAvoid: ['擅自换题', '擅自结束访谈', '连续追加问题'],
        statePatch: {}
      });
    } else if (asr.status === 'FINAL' && message.length > 0 && message.length < 10) {
      setInterview(decision, 'FOLLOW_UP', {
        reasonCodes: ['CLEAR_SHORT_ANSWER'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '短回答清楚回应当前题')]),
        intent: '承接完整短答并追一个开放线索',
        text: shortAnswerFollowUp(input, message),
        questionCount: 1,
        mustAvoid: ['批评回答太短', '要求一次补齐多个信息'],
        statePatch: {}
      });
    } else if (asr.status === 'FINAL' && message.length > 30) {
      setInterview(decision, 'FOLLOW_UP', {
        reasonCodes: ['LONG_ENGAGED_RESPONSE'],
        evidenceRefs: compactEvidence([evidence(turnRef, 'TURN', '长叙述提供开放线索')]),
        intent: '只选择一个当前线索继续',
        text: genericFollowUp(input),
        questionCount: 1,
        mustAvoid: ['植入情绪', '一次提出多个问题'],
        statePatch: {}
      });
    }
  }

  const suppressDelivery = signals.terminal;
  const cancelRequested = decision.statePatch.dropPendingResponse === true;
  const explicitCancelGenerationId = signals.terminal && incomingGenerationId !== null
    ? incomingGenerationId
    : activeGenerationId;
  const cancelScope: GenerationCancelScope = cancelRequested
    ? (explicitCancelGenerationId !== null ? 'GENERATION_ID' : 'ACTIVE_RESPONSE_FALLBACK')
    : 'NONE';
  const cancelGenerationId = cancelScope === 'GENERATION_ID' ? explicitCancelGenerationId : null;

  const obligations = new Map<InterviewObligationId, InterviewObligation>();
  addObligation(obligations, 'AUTHORITY_BOUNDARY', 'AUTHORITY', 'CANDIDATES_ONLY');
  if (signals.terminal) {
    addObligation(obligations, 'TERMINAL_GUARD', 'RUNTIME', 'REJECT_POST_TERMINAL_EVENT', [incomingRef]);
    addObligation(obligations, 'DELIVERY_SUPPRESSION', 'RUNTIME', 'SUPPRESS_RENDER_AND_AUDIO', [incomingRef]);
  }
  if (decision.statePatch.dropPendingResponse) {
    addObligation(
      obligations,
      'GENERATION_CANCEL',
      'RUNTIME',
      cancelScope === 'GENERATION_ID' ? 'CANCEL_GENERATION_ID' : 'CANCEL_ACTIVE_RESPONSE_FALLBACK',
      [incomingRef, runtimeRef]
    );
  }
  if (
    decision.statePatch.sessionStatus === 'ENDED' ||
    decision.statePatch.sessionStatus === 'PAUSED'
  ) {
    addObligation(
      obligations,
      'SESSION_CONTROL',
      'SESSION',
      decision.statePatch.sessionStatus === 'ENDED' ? 'END' : 'PAUSE',
      [uiRef, turnRef]
    );
  }
  if (decision.safety) {
    addObligation(obligations, 'SAFETY_RESPONSE', 'SAFETY', 'SAFE_RESPONSE', [turnRef]);
  }
  if (decision.technicalRecovery) {
    addObligation(obligations, 'TECHNICAL_RECOVERY', 'RUNTIME', 'RECOVER_WITHOUT_LOSING_POLICY', [runtimeRef, turnRef]);
  }
  if (decision.topicGovernance) {
    addObligation(obligations, 'TOPIC_GOVERNANCE', 'TOPIC', 'APPLY_TOPIC_SCOPE', [turnRef]);
  }
  if (signals.noSave) {
    addObligation(
      obligations,
      'RETENTION_NO_SAVE',
      'RETENTION',
      signals.noSavePrevious && previousCompletedUserEvidenceRef
        ? 'NO_SAVE_PREVIOUS_COMPLETED_TURN'
        : 'NO_SAVE_CURRENT_TURN',
      [signals.noSavePrevious && previousCompletedUserEvidenceRef
        ? previousCompletedUserEvidenceRef
        : turnRef],
    );
  }
  if (decision.memoryInputBlocked) {
    addObligation(obligations, 'MEMORY_INPUT_BLOCK', 'AUTHORITY', 'IGNORE_UNAUTHORIZED_MEMORY');
  }
  if (decision.interviewAction !== 'NONE') {
    addObligation(obligations, 'INTERVIEW_MOVE', 'INTERVIEW', decision.interviewAction, [turnRef, uiRef]);
  }

  const result: InterviewNextAction = {
    schemaVersion: '0.2',
    decisionId: decisionIdFor(input),
    mode: decision.mode,
    interactionAction: decision.interactionAction,
    interviewAction: decision.interviewAction,
    reasonCodes: uniqueStrings(decision.reasonCodes),
    evidenceRefs: compactEvidence(decision.evidenceRefs),
    uncertainty: decision.uncertainty,
    utterancePlan: {
      intent: decision.intent,
      suggestedText: suppressDelivery ? '' : decision.text,
      questionCount: suppressDelivery ? 0 : decision.questionCount,
      mustAvoid: uniqueStrings([...DEFAULT_MUST_AVOID, ...decision.mustAvoid])
    },
    obligations: [...obligations.values()],
    runtimeControl: {
      sessionEpoch: {
        current: currentEpoch,
        incoming: incomingEpoch,
        relation: relationForEpoch(currentEpoch, incomingEpoch, signals.terminal && signals.incomingResponse)
      },
      generation: {
        activeGenerationId,
        incomingGenerationId,
        cancelRequested,
        cancelScope,
        cancelGenerationId
      },
      delivery: {
        mode: suppressDelivery ? 'SUPPRESS' : 'EMIT',
        reasonCode: suppressDelivery ? 'LATE_RESPONSE_DROPPED' : null
      }
    },
    retentionControl: signals.noSave
      ? {
          intent: 'NO_SAVE',
          scope: signals.noSavePrevious && previousCompletedUserEvidenceRef
            ? 'PREVIOUS_COMPLETED_TURN'
            : 'CURRENT_TURN',
          sourceRefs: signals.noSavePrevious && previousCompletedUserEvidenceRef
            ? [previousCompletedUserEvidenceRef]
            : (turnRef ? [turnRef] : []),
          cancelPendingExtraction: true
        }
      : {
          intent: 'DEFAULT',
          scope: 'NONE',
          sourceRefs: [],
          cancelPendingExtraction: false
        },
    statePatch: decision.statePatch,
    memoryCandidates: [],
    storyCandidateRefs: []
  };
  return result;
}

/**
 * Production entrypoint. Unlike the internal compatibility reducer, this boundary fails
 * closed when epoch/generation/invocation identity is absent or inconsistent.
 */
export function decideInterviewNextAction(request: LiveInterviewDecisionRequest): InterviewNextAction {
  const validated = assertLiveInterviewDecisionRequest(request);
  return assertInterviewNextAction(decideCandidateNextAction({ input: validated.input }));
}
