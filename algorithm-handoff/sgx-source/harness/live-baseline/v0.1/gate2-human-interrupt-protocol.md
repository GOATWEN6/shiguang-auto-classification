# Gate 2：真人智能打断验收协议

> 版本：`v0.2` · 修订日期：2026-10-09
> 适用范围：SGX 算法侧 Voice → ASR → Interview/Daily Chat → Memory/故事/画像 → TTS 模块链
> 测试性质：内部成年人、真实麦克风、真实扬声器、真实 Provider；不是老人临床或科研试验
> 固定分母：10 次“助手正在播放时，真人自然插话”
> 历史协议：[v0.1 原文](./gate2-human-interrupt-protocol-v0.1.md)；真人前任务及放行：[10/09 计划](../../../docs/execution/2026-10-09-pre-human-verification-plan.md)

v0.2 澄清首试与重试计分、结束意图的终态分支、参与者与角色映射、时间测量及迟到内容的计数。尚未执行真人正式结果，不重写历史运行记录。

## 1. 本协议要证明什么

本轮不是只检查页面上的声音是否停了，而是证明一次真人插话会使整条旧回复失效：

```text
真人重新开口
  → VAD 检测说话
  → 客户端停止旧音频
  → 服务端按 sessionEpoch + turnId + generationId 接受 interrupt
  → 取消旧 LLM / TTS / Memory / 故事 / 画像任务
  → 拒绝所有迟到的旧字幕、音频和写入
  → 接收真人的新话，按意愿继续、暂停或结束
```

通过本协议只能说明第一轮真实设备打断可用，不能说明对所有老人、方言、助听设备和噪声环境都已成熟。

## 2. 测试人员与材料

- 至少由 **2 名内部成年人**实际说话；建议 3 人分别扮演健谈、慢答和容易疲劳的虚构老人。
- 矩阵的A/B/C表示三种角色条件。若只有两名测试者，在运行前固定A/C由同一人扮演、B由另一人扮演，并记录实际 `participantCode` 与角色映射；不能报告成三名独立参与者。角色描述不构成测试者健康或认知标签。
- 测试者只能使用虚构身份和虚构经历。禁止说出真实身份证号、电话号码、地址、病历、账户、密码和真实家庭冲突。
- 测试者开始前知晓会录制测试音频。音频、转写和模型输出最多保留 40 天；本人撤回后立即停止使用，24 小时内删除内容，只留无内容审计记录。
- 使用实际准备交给产品的浏览器入口、电脑或移动设备麦克风和扬声器；耳机不能替代扬声器回声场景。
- 测试前固定并记录算法版本、Prompt 版本、Provider/模型、浏览器、设备、麦克风、扬声器、网络类型和房间条件。

## 3. 开始条件

以下条件全部满足才开始计入10次正式结果：

1. 麦克风权限有效，页面能显示 `listening/user_speaking/thinking/assistant_speaking/interrupted/recovering` 等状态。
2. TTS 正在真实扬声器播放；播放完整录音文件不算流式链路证据，必须记录实际使用的播放方式。
3. 服务端日志可用 `sessionEpoch + turnId + generationId` 唯一关联本次旧回复及 interrupt。
4. 能检查旧 generation 的字幕、音频 chunk、Memory、故事和画像任务是否在取消后继续提交。
5. 已创建本轮 `runId` 和去标识化 `participantCode`，不在日志中保存测试者姓名。
6. 每次正式试验前只做一次音量检查。首次试验计入10次正式分母；只有明确技术失败可补诊断重试，最多3次总尝试，所有尝试保留。质量不佳不能靠重新说一遍覆盖首试；版本修复后的复验另记runId。

## 4. 单次测试步骤

每次严格按以下顺序执行：

1. 选择测试矩阵中的一项，载入对应虚构身份和前置上下文。
2. 真人用自然语速说出“触发助手回复”的话，不朗读标点或技术词。
3. 等待助手进入 `assistant_speaking`，确认扬声器确实发出声音。
4. 按该项规定的时机和条件自然插话。插话内容应表达真实意图，如纠正、补充、换题、拒绝保存或结束；不要只喊固定唤醒词。
5. 继续说完新表达，不因旧声音刚停止就立刻闭嘴。
6. 等系统接收新表达：继续意图应给下一轮可理解回复或清楚的降级提示；结束意图应进入终态、不再追问或持续收音；暂停意图按暂停状态处理。
7. 检查并记录：旧声音是否停止、旧字幕是否继续、服务端是否取消正确 generation、旧 Memory/故事/画像是否新增提交，以及当前意图是否得到正确恢复或终态处理。
8. 测试者给“打断是否自然”和“是否愿意继续说”各打1～5分，并写一句简短原因。

## 5. 十次固定试验矩阵

| ID | 真人与环境 | 插话时机 | 自然插话示例 | 本项额外关注 |
|---|---|---|---|---|
| INT-01 | 参与者A，安静房间，正常音量 | 播放开始后约0.5～1秒 | “等一下，我还没说完。” | 早期打断、下一轮继续 |
| INT-02 | 参与者A，安静房间，正常音量 | 助手说到句中 | “不是这个意思，我说的是一九六八年。” | 日期纠正覆盖旧回复 |
| INT-03 | 参与者B，距麦克风约1米，较低音量 | 播放开始后约1秒 | “我再补一句。” | 低音量漏检 |
| INT-04 | 参与者B，先停顿2～3秒再插话 | 助手因停顿开始回复后 | “我刚才是在想，后面还有一件事。” | 长停顿不等于结束 |
| INT-05 | 参与者A，扬声器外放且麦克风可收到回声 | 助手音量正常时 | “先停一下，让我说完。” | 回声不能自触发；真人应能触发 |
| INT-06 | 参与者C，固定轻度室内背景声 | 播放中段 | “我们换个话题，聊聊花园吧。” | 背景声误触与主动换题 |
| INT-07 | 参与者A，正常音量 | 助手复述人物时 | “照片里那位不是我姐姐，是我表妹。” | 人物纠正；旧派生任务不得提交 |
| INT-08 | 参与者C，正常音量 | 助手开始回应敏感内容后 | “刚才那段不要存，也不要写进故事里。” | 精确撤回、候选与派生内容取消 |
| INT-09 | 参与者B，略慢语速 | 助手追问时 | “这个我不想谈，改聊我修收音机的事。” | 拒谈、换题、禁止旧话题回流 |
| INT-10 | 参与者C，疲劳语气但表达清楚 | 助手开始新问题时 | “今天就到这里吧，不要再问了。” | 结束、旧输出停止、会话终态 |

矩阵中的话是语义示例，测试者应按虚构人物自然改述，避免十次使用同一句关键词。

## 6. 每次必须记录的字段

| 字段组 | 字段 |
|---|---|
| 标识 | `runId`、`trialId`、`participantCode`、`personaId`、`startedAt`、`algorithmVersion`、`promptVersion` |
| 设备环境 | `device`、`browserVersion`、`microphone`、`speaker`、`network`、`roomCondition`、`distanceMeters`、`backgroundCondition` |
| 旧回复身份 | `sessionEpoch`、`oldTurnId`、`oldGenerationId`、`oldResponseId` |
| 插话输入 | `bargeInIntent`、`spokenText`、`asrFinalText`、`vadDetected`、`vadDetectedAt`、`asrFinalAt` |
| 时延 | `speechStartAt`、`localAudioStoppedAt`、`serverInterruptAcceptedAt`、`listeningRestoredAt`、`audioStopLatencyMs`、`serverAcceptLatencyMs`、`recoveryLatencyMs` |
| 迟到隔离 | `lateReceivedEventCount`、`lateDroppedEventCount`、`lateAudioChunkCount`、`lateSubtitleUpdateCount`、`lateMemoryCommitCount`、`lateStoryCommitCount`、`lateProfileCommitCount` |
| 新意图与状态 | `expectedStateAfterIntent`、`observedStateAfterIntent`、`terminalReached`、`nextTurnApplicable`、`nextTurnAccepted`、`nextTurnResponseUnderstandable`、`nextTurnFailureCode` |
| 人工感受 | `interruptNaturalness1to5`、`willingnessToContinue1to5`、`testerNote` |
| 证据与结论 | `artifactRefs`、`attemptIndex`、`attemptCount`、`firstAttemptFunctionalPass`、`functionalPass`、`failureReasons`、`safetyStopTriggered` |

客户端时延使用同一客户端单调时钟，服务端处理时延使用同一服务端单调时钟。两端时间戳必须标明时钟来源，不能直接相减得出网络/端到端时延；无法可靠测量的值写 `null` 并说明原因。日志中不得出现密钥。

`lateReceivedEventCount`记录网络中迟到到达的旧事件，`lateDroppedEventCount`记录已被拒绝的事件；迟到但未生效不等于泄漏。`lateAudioChunkCount`等原五个字段只计取消后的实际播放/展示/新增提交，须为0。打断取消在途旧任务，不自动删除先前已合法保存的材料；只有no-save、撤回或删除意图触发对应失效。

## 7. 单次成功与失败判定

一次试验只有同时满足下列条件才记为 `functionalPass=true`：

1. VAD 由真人语音触发，不是扬声器回声或背景声误触。
2. 客户端停止旧回复，且检测到真人开口后旧声音不持续超过1秒；实际毫秒数必须保留，后续再根据 baseline 收紧质量阈值。
3. 服务端接受的 interrupt 精确绑定旧 `sessionEpoch + turnId + generationId`。
4. 取消后旧 generation 的新增音频、字幕、Memory、故事和画像提交数全部为0。
5. 真人的新话获得final ASR，按其意图满足相应分支：继续交流时恢复listening并有可理解回复或清楚降级；暂停时进入可恢复暂停；INT-10结束时进入ended、不再追问或持续监听。结束项 `nextTurnApplicable=false`，下一轮和恢复listening字段填null，不判为失败。
6. 对拒绝、撤回、换题或结束类插话，后续行为与表达一致，没有重新追问被拒主题或复活已撤回内容。

以下任一情况发生即为失败：只停止本地声音但后台仍提交旧结果；取消了错误generation；旧字幕继续增长；旧Memory/故事/画像迟到写入；新话没有被接收；应继续时卡在interrupted/recovering；应结束时仍收音/追问；靠刷新页面才恢复。正确ended不属于恢复失败。

## 8. Gate 级放行规则

- 固定分母为10次，按**首次试验**至少9次通过；未运行或因前置失败被阻塞的项保留在10项表中，不能缩小分母。另报技术重试后完成情况，不用最佳次或最后一次替代首试。
- `lateAudioChunkCount`、`lateSubtitleUpdateCount`、`lateMemoryCommitCount`、`lateStoryCommitCount`、`lateProfileCommitCount`任一大于0，Gate立即不通过，不能用其余成功次数抵消。
- 会话串线、撤回内容复活或结束后继续提交属于阻塞问题，修复后只复测相关试验及一项正常对照。
- 1～5分用于体验比较，不在首轮预设平均分门槛；完成真实 baseline 后，由负责人确定下一版本阈值。
- 通过后结论写作：`10次真人真实设备智能打断中，首次 x/10 功能通过，技术重试另报`，注明继续/暂停/结束项数，不得写成“所有老人环境均已验证”。

## 9. 安全停止条件

出现以下任一情况，立即停止当前试验并停止继续扩量：

- 测试者出现不适、听觉不舒服、焦虑或明确要求停止。
- 测试者或旁观者意外说出真实敏感信息；立即标记不可用并进入24小时删除流程。
- 出现真实健康急症、自伤、诈骗或人身安全风险；结束角色扮演，按现实情况寻求人工帮助，不能继续把它当测试对话。
- 音频、字幕或 Memory 串到其他会话、家庭或参与者。
- 已撤回、已结束或已取消 generation 的内容进入 Memory、故事、画像或继续播放。
- 日志意外包含 API Key、Token、密码或可直接识别个人的资料。
- 系统连续3次无法恢复 listening，或需要反复刷新才能继续。

## 10. 测试结束产物

每轮保留一份结构化记录、必要的音频/转写、客户端事件、服务端 interrupt/cancel 事件和 Memory/派生任务审计。汇总只回答四件事：

1. 10次中多少次完整通过；
2. 失败发生在 VAD、客户端播放、服务端取消、迟到隔离还是恢复阶段；
3. 哪些声音/环境/表达会误触或漏触；
4. 下一轮只需要修什么，哪些已经稳定且不必重复测试。
