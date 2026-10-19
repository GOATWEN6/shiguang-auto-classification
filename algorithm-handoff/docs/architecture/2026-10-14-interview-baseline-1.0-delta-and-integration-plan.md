# SGX-INTERVIEW-BASELINE-1.0：现有架构差异与集成方案

日期：2026-10-14
状态：shadow_contract_implemented / policy_behavior_unchanged / real_shadow_disabled_by_default

本文是《SGX InterviewPolicy 原会话交接与技术映射 v0.1》与 SGX 当前算法运行时的工程映射。D-001～D-015 已由负责人批准，本文不重新讨论这些产品原则；交接文档中的字段、接口和实现建议仍视为技术草案，只有经过本项目代码和测试验证后才进入运行时。

## 1. 先给结论

当前主链路可以继续复用，不需要推倒重来：

    输入（文字或 ASR_FINAL）
      → Evidence / 会话身份 / 运行信号
      → 现有 InterviewPolicy v0.2（可信规则，决定本轮能不能做什么）
      → 现有 DailyChat / InterviewRealizer（LLM 只表达获准动作）
      → TTS、Memory 异步任务、故事/画像派生任务

这次增加的是旁路观察层：

    同一轮 Evidence
      ├─ 现有 Policy 主链：决定并执行实际动作
      └─ SemanticTurnProposal Shadow：分析意图、叙事线索、候选动作
           ├─ 来源和结构校验
           ├─ 记录 ACCEPTED / REJECTED / ERROR
           └─ 永远不改变主链、不写 CanonicalMemory

本轮已经完成：

- semantic-turn-proposal-v0.1 的来源约束校验继续保留；
- 新增 semantic-turn-shadow-v0.1，承载交接文档中的 IntentKind、NarrativeCue 和 ActionCandidate；
- 组合层加入可关闭的 shadow 接口，默认关闭；开启后以旁路异步调用运行，不阻塞用户回复；
- 会话 view 可查看 shadow 诊断，仍标明 policySideEffect: NONE；
- 新增覆盖正常、记不清、拒绝/不保存、来源拼接、越权字段、主链不受影响和非法 shadow 不阻塞的测试。

本轮没有完成、也没有宣称完成：

- 没有把 shadow 候选接管 InterviewPolicy；
- 没有打开真实服务的额外模型调用（SGX_SEMANTIC_TURN_SHADOW=0）；
- 没有打开正式 CanonicalMemory 持久化；
- 没有决定 Life Memory 的最终字段、保留期限、真实语音参数或老人真人测试标准。

## 2. 资料和版本边界

| 来源 | 本轮如何使用 | 权威程度 |
|---|---|---|
| D-001～D-015 | 作为产品行为基线，例如老人意愿优先、访谈同意不等于保存同意、拒绝后不重复邀请 | 产品权威 |
| 交接文档的 TurnContext、TurnAnalysis、PolicyDecision 草案 | 作为字段和映射参考，按现有 SGX 合同调整 | 技术草案 |
| InterviewPolicy v0.2、TurnOrchestrator、InterviewRealizer | 现有实际运行入口，继续复用 | 当前代码事实 |
| SemanticTurnProposal v0.1 | 已有来源绑定的语义候选合同 | 当前候选合同 |
| CanonicalMemoryRepository | 算法侧的稳定端口；当前仍 durable:false | 未开正式写入 |
| Voice / Life Memory 专项方案 | 只定义依赖接口，不在本轮越权冻结 | 待专项审批 |

## 3. 差异分析：已有、缺失与处理方式

| 交接基线能力 | 当前已有实现 | 差异或风险 | 本轮处理 |
|---|---|---|---|
| 日常聊天与正式访谈分开 | InterviewMode=DAILY_CHAT/FORMAL_INTERVIEW，两个 Realizer 分开 | 交接基线还把邀请等待、访谈暂停作为更细状态 | 继续用 pendingModeOffer 与 sessionStatus=PAUSED 兼容；先在 shadow 输入记录，暂不改公共 v0.2 枚举 |
| 老人当前意愿优先 | Policy 已处理结束、换题、拒谈、不保存、暂停等 | 复杂表达、双重否定、方言仍需要语义帮助 | shadow 观察 IntentKind，不让模型越过 Policy |
| LLM 一次结构化分析 | 现有聊天/访谈/Memory 各有模型调用 | 没有统一的语义分析结果 | 新增 shadow envelope，后续可评估是否合并成一次调用；本轮不重复重构主链 |
| NarrativeCue | 现有 Memory 有来源片段，访谈有 evidence refs | 没有明确区分 EXPLICIT、UNANSWERED、MODEL_INFERENCE | shadow 合同增加 epistemic；不自动进入长期 Memory |
| NextAction 候选 | Policy 直接输出 InterviewAction | 模型候选与可信策略没有隔离 | shadow 候选只记录；未来由 Policy 做允许/拒绝/排序 |
| 主题规划 | DirectionPlan v0.1、主题账本纯规则入口已存在 | 真实候选排序、跨会话接续仍未完成 | shadow 输入带 current/selected topic；不新增排序规则 |
| Memory 来源约束 | SemanticTurnProposal、hybrid extractor、Reference Store 已有 | 语义分析与 Memory 提取尚未统一合同 | shadow 的 proposal 复用现有 source span 校验 |
| 证据片段定位 | 交接草案建议 evidenceRef + revision + start/end | 当前 Evidence 已有稳定 ref 和连续 quote，但没有统一字符偏移合同 | 本轮先复用 ref+quote，避免因偏移单位（字符/UTF-16/音频毫秒）不明确而改动主链；需要精确定位时再单独升级合同 |
| 派生故事/画像 | 只读获准来源，保留 provenance | 不应把叙事线索直接当权威事实 | 不改现有派生任务 |
| Voice 送达/打断 | 现有 Voice/Orchestrator 有取消和 generation | T-13/T-21 需要可靠送达回执，当前接口还不能证明 | 只保留依赖合同，先做文本 shadow |

### 3.1 状态映射

| 产品状态 | 当前代码映射 | 说明 |
|---|---|---|
| DAILY_CHAT | mode=DAILY_CHAT | 日常聊天，不因分享往事自动进入访谈 |
| INVITATION_PENDING | mode=DAILY_CHAT + pendingModeOffer=FORMAL_INTERVIEW | 只是等待明确回应，不能当作已同意 |
| INTERVIEW_ACTIVE | mode=FORMAL_INTERVIEW + sessionStatus=ACTIVE | 正式访谈已经由入口或明确同意触发 |
| INTERVIEW_PAUSED | mode=FORMAL_INTERVIEW + sessionStatus=PAUSED | 暂停访谈，可以保留聊天能力 |
| 聊天结束 | sessionStatus=ENDED | 是全局会话终态，不能接收迟到回复 |

这个映射先保证不破坏已有 HTTP v0.1。等 shadow 和 T-01～T-19 的状态证据稳定后，再决定是否新增 interactionState 公共字段；当前没有必要为字段命名提前重构主链路。

## 4. Shadow 数据契约

### 4.1 输入

shadow 每次只接收服务端已经绑定的最终 Evidence 和最小上下文：

    {
      "schemaVersion": "semantic-turn-shadow-input-v0.1",
      "evidenceRef": "evidence:...",
      "utterance": "老人本轮最终文本",
      "mode": "DAILY_CHAT",
      "sessionStatus": "ACTIVE",
      "currentTopic": "工作经历",
      "selectedTopic": null,
      "pendingModeOffer": null,
      "blockedTopics": [],
      "previousQuestions": [],
      "allowedEvidenceRefs": ["evidence:..."]
    }

输入中的 evidenceRef、会话主体、授权版本和禁谈范围由服务端提供；模型不能通过输入字段扩大权限。ASR partial 不进入本合同，只有经过最终确认的文本才进入 shadow。

### 4.2 输出

    {
      "schemaVersion": "0.1",
      "intentKind": "CONTINUE",
      "shareInterest": "EXPLICIT",
      "proposal": {
        "schemaVersion": "0.1",
        "userIntent": "CONTINUE_TOPIC",
        "topicId": "work-and-study",
        "observedFacets": ["EVENT", "PLACE"],
        "sourceSpans": [{"evidenceRef": "evidence:...", "quote": "以前在纺织厂工作"}],
        "memoryCandidates": [],
        "relatedMemoryQuery": null,
        "userUncertainty": "LOW",
        "needsClarification": false
      },
      "narrativeCues": [{
        "cueId": "cue-1",
        "kind": "EVENT_TURN",
        "epistemic": "EXPLICIT",
        "sourceEvidenceRefs": ["evidence:..."],
        "topicId": "work-and-study"
      }],
      "nextActionCandidates": [{
        "candidateId": "action-1",
        "action": "FOLLOW_UP",
        "topicId": "work-and-study",
        "premiseRefs": ["evidence:...", "cue-1"],
        "reasonCodes": ["NEW_EVENT_DETAIL"],
        "proposedQuestionIntent": "询问当时印象最深的人或事"
      }]
    }

核心限制：

- sourceSpans.quote 必须是本轮原话的连续片段；拼接句、模型补写和不在原文的引用直接拒绝；
- NarrativeCue 的 epistemic=MODEL_INFERENCE 仍只是推测，不能成为事实前提；
- nextActionCandidates 只是候选，不能直接改模式、邀请访谈、保存、撤回或删除；
- 不允许 canPersistMemory、authorization、save、share、delete 等越权字段；
- UNKNOWN、高不确定性和空候选是合法结果，不能为了“有输出”而编造结论。

### 4.3 主链执行顺序

    Evidence
      ├─ 先进入 InterviewPolicy：读取可信状态、权限、拒绝和运行信号
      ├─ 旁路进入 Semantic Shadow：分析意图、线索、候选动作并校验来源
      ├─ Policy 将允许的动作交给 LLM Realizer
      └─ Memory 仍只按既有异步政策处理

shadow 与主链并行，但当前实现让主链不等待 shadow；shadow 超时或格式错误只形成诊断。

## 5. 访谈与日常聊天的状态机

### 5.1 规则边界

1. DAILY_CHAT 中自然分享往事，不自动升级为 FORMAL_INTERVIEW；只有老人点击入口或明确接受邀请才进入。
2. INVITATION_PENDING 中的模糊“嗯”不等于接受；需要澄清或等待送达完成。
3. INTERVIEW_ACTIVE 中老人可以继续、记不清、换题、拒谈、暂停或结束；不把记不清当拒绝。
4. 拒绝某个主题只阻断该主题的追问和复用，不形成永久心理画像；会话内重复邀请仍受限制。
5. 离开访谈可以回到日常聊天；结束访谈不等于结束全局会话。
6. 访谈同意不等于保存同意；shadow cue 和问题价值都不能触发长期记忆写入。

### 5.2 状态转移表

| 当前状态 | 事件 | 前置条件 | 结果 | 领域事件 |
|---|---|---|---|---|
| 日常聊天 | 点击“聊往事” | UI 事件可信、版本未过期 | 进入正式访谈或显示入口确认 | INTERVIEW_ENTRY_REQUESTED |
| 日常聊天 | 模型发现分享兴趣 | 只有语义候选，没有老人明确接受 | 保持日常聊天，可提出一次轻量邀请 | 无自动切换 |
| 邀请等待 | 明确接受 | 邀请仍有效、回应归属匹配 | 进入访谈 | INTERVIEW_ACCEPTED |
| 邀请等待 | 明确拒绝 | 同一会话 | 保持日常聊天，禁止再次说服 | INTERVIEW_DECLINED |
| 邀请等待 | 模糊回应/未送达 | 无明确接受 | 澄清或等待，不切换 | INTERVIEW_ACCEPTANCE_UNRESOLVED |
| 访谈中 | 主动换题 | 目标主题可用且未被禁谈 | 更新当前主题，旧主题记为延后/跳过 | TOPIC_CHANGED |
| 访谈中 | “我想想/记不清” | 无明确拒绝 | WAIT/承接/保留不确定性 | INTERVIEW_WAITING |
| 访谈中 | 明确拒谈 | 主题范围可识别 | 当前主题阻断，不再逼问 | TOPIC_DECLINED |
| 访谈中 | 暂停 | 明确暂停或运行保护 | INTERVIEW_PAUSED，不结束聊天 | INTERVIEW_PAUSED |
| 访谈中 | 结束访谈 | 明确结束 | 回日常聊天 | INTERVIEW_ENDED |
| 任意状态 | 迟到回复 | epoch/generation 过期 | 抑制回复并取消旧任务 | STALE_RESPONSE_SUPPRESSED |

## 6. 与现有模块的接线边界

### 6.1 InterviewPolicy

当前 decideInterviewNextActionWithContinuation 仍是实际执行者。shadow 的候选不得直接排序或覆盖以下字段：

- interactionAction、interviewAction；
- retentionControl、statePatch、runtimeControl；
- obligations、blockedTopics、generation 取消；
- 模式进入、暂停、结束和任何权限变化。

后续若要把语义候选用于策略，必须新增“候选适配器”：先将候选映射为可信输入，再由 Policy 重新核验；不能让模型返回的 INVITE_INTERVIEW 直接执行。

### 6.2 Life Memory

当前只做以下依赖：

    Evidence → SemanticTurnProposal.sourceSpans → Memory 候选 → 既有 Memory Policy

NarrativeCue 仍是临时观察。只有经过现有白名单、敏感性、来源、用途和确认门的 Memory 候选，才可能进入当前 Reference Store；正式 CanonicalMemory 尚未打开。故事和画像继续只读获准来源，不读取未经授权的 shadow 推测。

### 6.3 Voice

Voice 只负责采集最终 ASR、VAD/打断、TTS 和送达/取消信号；它不决定访谈语义和保存。T-13（TTS 尚未播完时的模糊回应）和 T-21（迟到的邀请接受）需要 Voice 提供可信的 deliveryRef、generationId 和取消结果，当前先保留接口依赖，不把尚未批准的具体协议写入 InterviewPolicy。

## 7. 接口、错误与控制事件

| 接口/事件 | 当前处理 | 失败行为 |
|---|---|---|
| SemanticTurnShadowProposal | validateSemanticTurnShadowProposal | 记录 REJECTED，当前轮继续由 Policy/Realizer 完成 |
| 语义模型超时/网络失败 | semantic_turn_shadow 旁路调用 | 记录 ERROR，不影响用户回复，不重试主链 |
| 来源被撤回/过期 | providerJson 来源检查失败 | shadow 记录错误；不保留模型输出，不进入 view |
| 过期 epoch/generation | 现有 TurnOrchestrator 处理 | 抑制回复、取消旧任务、记录审计 |
| NO_SAVING | 由可信 Policy 处理 | 取消或丢弃相应 Memory 异步任务；shadow 不得自行执行 |
| PAUSE/END | 由可信 Policy 和会话状态机处理 | 使用已有安全文本和控制事件 |
| INVITE_INTERVIEW | 当前只作为 shadow 候选 | 没有明确老人同意时不得切换 |

Shadow 不把异常转成“模型说得不好”这种不可定位描述，而记录结构、来源、网络等可区分原因。

## 8. T-01～T-19 验收转换

下面是与交接文档一一对应的可执行口径。T-01～T-19 与 T-20～T-25 的离线状态、权限、来源和异常门禁已经完成；这仍然不是对真实模型语义质量或真人语音体验的宣称。

| ID | 场景 | 必须验证 | 目前执行层 |
|---|---|---|---|
| T-01 | 主动换题 | 跟随新话题，不强拉旧主题 | Policy + 真实/fixture |
| T-02 | “我想想” | WAIT，不当作拒绝 | Policy + shadow |
| T-03 | 年份记不清 | 保留不确定性，不逼精确年份 | Realizer + shadow |
| T-04 | 家庭原因不说 | 停止追问，不因价值保存 | Policy + Memory |
| T-05 | 模型猜“像父亲” | 推断不能作事实前提或权威记忆 | Shadow validator + response guard |
| T-06 | 正在主动讲述 | 不因计划覆盖打断 | DirectionPlan + Policy |
| T-07 | “他一定很爱您吧” | BLOCK/REWRITE，去掉无依据情绪断言 | response guard |
| T-08 | “不说儿子了/一言难尽” | 前者停方向，后者降低追问；不生成永久画像 | Policy + Memory |
| T-09 | 被拒主题高收益 | DENY 不被排序反转 | Policy |
| T-10 | 闲聊提工作/明确想讲过去 | 前者不主动邀；后者仅候选邀约 | Policy + shadow |
| T-11 | 主动进入/明确接受 | 进入访谈，但不授予保存/分享权 | Orchestrator + Memory |
| T-12 | 同会话拒邀后说服 | 不重复邀请 | Policy |
| T-13 | 邀请未播完时“嗯” | 不切换，必要时澄清 | Voice contract + Policy |
| T-14 | 暂缓后主动再讲 | 可恢复，不当永久拒谈 | Session/Policy |
| T-15 | 拒谈且无接续权限 | 不列必问，不泄露接续内容 | Retrieval gate |
| T-16 | “以后别再邀请” | 停止自动邀请；长期偏好另走授权机制 | Policy + account boundary |
| T-17 | 公共扬声器请求私密接续 | 不泄露，改从公开话题开始 | Retrieval gate + Voice |
| T-18 | 覆盖率 vs 拒谈 | 服从拒谈优先于覆盖率 | Evaluator |
| T-19 | 结束访谈后闲聊 | 回日常聊天，不删除合法旧记忆 | State machine |

离线执行记录：`harness/live-baseline/v0.1/interview-baseline-offline-acceptance.test.mts`，25/25 通过。T-13/T-21 是不依赖真实播放的 Voice 送达契约测试；T-19 使用结束后的新日常会话验证可用路径。

### 8.1 必要异常扩展

- T-20：模型误把“记不清”识别为拒绝；预期允许澄清，不强迫确定；
- T-21：邀请送达未完成，迟到接受到达；预期按 delivery/generation 版本拒绝过期事件；
- T-22：NarrativeCue 无有效来源却被拿来提问；预期拦截；
- T-23：日常聊天分享往事但未接受访谈；预期保持日常聊天；
- T-24：同会话拒邀后老人主动点击入口；预期允许有效主动进入；
- T-25：“停访谈但继续聊天”；预期只结束访谈，不结束全局会话。

## 9. 本轮实现文件与验证

实现文件：

- src/lib/algorithm-service/semantic-turn-shadow.ts：shadow 数据结构、严格校验、提示词和诊断摘要；
- src/lib/algorithm-service/composition.ts：可选旁路接线、异步结果和 session view；
- src/lib/algorithm-service/index.ts：导出新合同；
- src/app/api/algorithm/v0.1/_shared/runtime.ts：SGX_SEMANTIC_TURN_SHADOW=1 配置接线，默认关闭；
- harness/live-baseline/v0.1/semantic-turn-shadow.test.mts：多场景合同与主链隔离测试；
- harness/live-baseline/v0.1/semantic-turn-proposal.test.mts：原有来源绑定测试。

已运行：

    node --experimental-strip-types --test \
      harness/live-baseline/v0.1/semantic-turn-shadow.test.mts \
      harness/live-baseline/v0.1/semantic-turn-proposal.test.mts
    npx tsc --noEmit --incremental false
    git diff --check

结果：shadow 与原有 semantic 合同测试全部通过（12/12），TypeScript 类型检查通过，差异检查通过。测试使用 fixture provider，没有产生付费模型调用。

## 10. 下一步与需要负责人知情的点

### 可以直接继续执行的工作

1. 离线 T-01～T-25 门禁已完成，不改变产品原则；
2. 在负责人给出轮数/费用上限后，才开启非常小的真实 Shadow，比较 ACCEPTED/REJECTED/ERROR 和候选与 Policy 的差异；
3. 对真实 Shadow 中重复出现的模型误判补充语义标注和提示词样例，再决定是否升级合同版本；
4. 将 Shadow 诊断接入内部工作台的“算法观察”面板，但不展示为用户可见回复。

### 需要负责人后续判断、当前不自动替你决定的点

1. 邀请状态是否要在 HTTP v0.2 显式公开 INVITATION_PENDING：当前用 pendingModeOffer 兼容，足以 shadow；只有前端需要单独显示状态时才值得升级公共合同。
2. 是否把 NarrativeCue 与 Memory 抽取合并为同一次 LLM 调用：合并可降成本和延迟，但输出合同更复杂；拆开便于隔离失败。当前先保持 shadow 独立，不影响主链。
3. 候选动作何时进入 Policy：必须先有 T-01～T-19 的模型/规则一致性证据，再设计候选适配器，不能因为 shadow 有结果就自动启用。
4. 真实 shadow 试跑的调用上限：开启 SGX_SEMANTIC_TURN_SHADOW=1 会让每个最终轮次额外调用一次文本模型；需要你指定本轮允许的轮次数或费用上限后再打开生产测试服务。
5. Voice 送达信号：T-13/T-21 在没有可靠 deliveryRef 前只能做文本 contract test，不能宣称实时邀请体验已验收。
6. 证据定位精度：当前先使用稳定 evidenceRef + 连续 quote；如果后续需要把文字片段精确映射到 ASR revision 或音频时间段，需要负责人确认优先采用字符偏移、UTF-16 偏移还是音频毫秒，并单独升级 Evidence 合同。

这些是工程集成边界，不是对 D-001～D-015 的重新讨论。当前最安全的推进顺序是：先完成离线 T-01～T-25 门禁 → 再做有上限的真实 shadow → 再评估候选适配器 → 最后才考虑进入真人访谈前的语音体验。
