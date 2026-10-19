# G4 LLM、TTS、访谈表达、故事与画像本地门禁报告

> 日期：2026-10-03
> 状态：`local_gate_closed / independently_reviewed / paid_calls_disabled`
> 上游：[G3 Fake Provider 与独立流式 ASR 报告](./G3_REPORT.md) · [模块化真实模型 Baseline 执行计划](../../../docs/execution/2026-10-02-live-model-baseline-execution-plan.md)

## 1. 结论

G4 已在不连接真实 Provider、不读取密钥、不产生费用的条件下完成三个可导入运行模块：

1. `model-runtime-v0.1`：统一文本模型与 TTS 的一次运行门、流式输出、取消、usage、计费声明和输出提交；
2. `response-runtime-v0.1`：分离日常聊天与正式访谈，正式访谈必须先由 `InterviewPolicy` 决策，再由 LLM 生成受约束话术；
3. `derived-artifact-runtime-v0.1`：只从当前用途获准的 Reference Store 记录生成带逐项来源的故事草稿和基础画像草稿。

本地自动化结果为 G1 `15/15`、G2 `38/38`、G3 `31/31`、G4 `72/72`，严格 TypeScript 检查通过。G4 的 `72` 项由 **44 个冻结行为编号**和 **28 个额外对抗/回归探针**组成，不代表 72 个真人或产品场景。

这些结果证明本地合同、拒绝路径和模块内取消语义可运行；不证明真实豆包模型质量、一次物理 HTTP 请求、真实费用、端到端故障隔离、老人体验或生产可用。

## 2. Source Gate

| 来源 | 借鉴内容 | License / 使用边界 | 本轮决定 |
|---|---|---|---|
| [Ark Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=zh) | 流式文本、终端 usage、JSON Schema | 商业 API 文档 | G6 Adapter 再对真实 wire 做验证 |
| [Ark streaming output](https://docs.volcengine.com/docs/ark/streaming-output?lang=zh) | 流式事件与时延记录 | 商业 API 文档 | 首个可见文本才算首输出 |
| [Ark SDK examples](https://docs.volcengine.com/docs/ark/sdk-common-examples?lang=en) | SDK 调用与 request-id | 商业 API 文档 | Adapter 必须关闭 SDK 隐藏重试 |
| [Ark error codes](https://docs.volcengine.com/docs/ark/error-codes?lang=zh&redirect=1) | 错误分类 | 商业 API 文档 | 保留原始 provider code，不把所有 429 一律重试 |
| [OpenAI Node v4.104.0](https://github.com/openai/openai-node/tree/v4.104.0) | `AbortSignal`、禁用默认重试 | Apache-2.0 | 仅借鉴已安装 SDK 的控制方式，不复制实现 |
| [Doubao TTS V3](https://docs.volcengine.com/docs/DoubaoVoice/WebSocketBidirectionalStreaming-V3?lang=zh) | 双向流式 session、文本/音频 chunk | 商业协议文档 | 作为 G6 强打断主候选 |
| [Doubao HTTP TTS](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-text-to-speech-http?lang=zh) | 单向流式与 usage | 商业协议文档 | 只作整段朗读候选 |
| [LlamaIndex citation query engine](https://github.com/run-llama/llama_index/blob/main/llama-index-core/llama_index/core/query_engine/citation_query_engine.py) | 来源节点与引用编号 | MIT | 只借鉴来源合同，不引入框架 |
| [Graphiti](https://github.com/getzep/graphiti) | 来源 episode、事实版本和失效时间 | Apache-2.0 | 不引入图数据库，不允许自主写入 |
| [LangMem conceptual guide](https://github.com/langchain-ai/langmem/blob/main/docs/docs/concepts/conceptual_guide.md) | profile/collection 分离与 patch | MIT | 不采用 agent 自主存储，不新增生产依赖 |

本轮没有复制第三方代码或增加生产依赖。明确排除 SDK 隐藏重试、prompt-only citation、模型自主写 `CanonicalMemory`、自动 reask，以及把本地停止播放写成 provider 已停止计费。

## 3. 最终设计

```text
DailyChatPolicy ───────────────────────┐
                                      ├─> Response Runtime ─> AuditedTextRuntime ─> text
DirectionPlan ─> InterviewPolicy ─────┘                              │
                                                                      └─> AuditedTtsRuntime ─> audio

Reference Store ─> live retrieval gate ─┬─> Story Draft Runtime
                                         └─> Profile Draft Runtime
```

### 3.1 Model/TTS Runtime

- 每个运行使用注册表签发的 canonical `GenerationExecutionLease`；伪造相同字段的 identity 不能取得投递权。
- 外层运行是唯一 lease owner；同一逻辑节点内的模型/TTS 只能使用注册表签发的 branded borrowed permit。permit 没有取消/finalize 权，伪造副本会被拒绝。
- 取消会中止挂起 transport，并等待已经进入输出 sink 的任务给出确认；只有明确 `DROPPED` 才算安全清理，取消后返回 `COMMITTED` 会记为 `FAILED`。迟到文本、音频和 fallback 均不得继续提交。
- sink acknowledgement 默认最多等待 1 秒，可在 1–30000ms 内配置；不配合取消的 sink 不再使调用无限挂起。
- Response/Derived 外层取消会有界等待已经启动的内层 generator；结果用 `NOT_REQUIRED/JOINED/TIMED_OUT/FAILED` 区分无需清理、已安全清理、等待超时和已发生不安全确认。内层模型/TTS 的 sink 超时或取消后迟到 `COMMITTED` 会通过 branded permit 传播，不能被外层误报为 `JOINED`。
- 文本 usage 必须是非负整数且 `totalTokens=inputTokens+outputTokens`；TTS usage 同样拒绝负数和小数。
- transport 只能提供未经信任的 provider 计费声明；只有注入的 `ProviderBillingVerifier` 能把调用标为 `VALIDATED`。价格目录异常时返回 `pricing_catalog_invalid`。
- telemetry 中的 `runtimeGateExecutionCount=1` 只说明本地一次运行门执行一次。任意 JavaScript transport 仍可能在内部发出多次网络请求；G6 必须用封闭真实 Adapter、transport spy 和 provider request-id 证明一个 attempt 对应一次物理请求。

### 3.2 Daily Chat 与 Interview Realizer

- 日常聊天调用方只提交最小运行 identity 和意图；可信 `accessContextResolver` 从内部状态解析 `subjectId/familySpaceId/authorizationVersion/visibilityScope`。
- 引用在进入模型前按主体、家庭、授权版本、可见范围和用途重新过滤，跨家庭或过期授权不能只凭调用方字段进入 Prompt。
- 正式访谈调用方也只能提交最小 identity。可信 `decisionRequestResolver` 读取完整 `LiveInterviewDecisionRequest`，运行时 exact compare identity/evidence/responseId 并重新执行 `InterviewPolicy`。
- LLM 只能表达 Policy 决定的动作、问题数、禁谈、`NO_SAVE`、暂停/结束和来源；无权改变访谈方向或保存决定。失败时仅在当前 generation 仍有效时使用 Policy 的 `suggestedText`。
- 两个 resolver 是内部可信边界，不是公开 HTTP 权威。G5 必须由 Session/Evidence/Reference Store 实现，并防止客户端直接提交 resolver 结果。

### 3.3 Story/Profile Draft Runtime

- 输入只包含 `ACTIVE`、S0、无开放冲突、精确用途和当前可见范围内的记录；健康、认知、心理、财务、家庭冲突、诊断和凭据类信息在进入模型前剔除。
- protected-content 检查会做 NFKC、Unicode 空白/分隔符/标点和格式控制字符归一化，阻断以全角斜杠、破折号、零宽字符等方式伪装的敏感字段。
- 模型不能声明来源主体；runtime 根据获准记录生成结构化 attribution。故事逐句、画像逐字段保存 `recordIds/evidenceRefs`。
- 历史区间不能被压平成当前偏好；`temporalScope` 与来源的 `temporalState` 保守对齐。
- source bundle 在运行开始时冻结。运行过程中新增且未暴露的合法来源不使当前任务失败；本次已暴露来源若被纠正、撤回、删除或授权失效，则禁止提交。
- 故事和画像是 `derived-artifact-v0.3` 草稿，不能反向写 Life Memory，也不能自动变成家庭可见内容。

## 4. 固定分母与实际测试

冻结分母见 [`g4-fixtures.json`](./g4-fixtures.json)：

| 组 | 冻结行为数 | 重点 |
|---|---:|---|
| Daily chat | 8 | 模式/用途/身份/授权隔离、取消、usage、运行门 |
| Formal interview | 8 | 承接、一问、禁谈、no-save、终止、迟到、fallback |
| TTS | 8 | chunk、取消、迟到、四次失败、usage、禁隐藏重试 |
| Story draft | 8 | 来源、未知时间、冲突、no-save、撤回/删除 |
| Profile draft | 8 | 字段来源、关系、历史偏好、protected、冲突/删除 |
| Isolation | 4 | Text/TTS/Story/Profile 的局部失败预期 |

测试文件额外加入 28 个针对审查问题的回归探针，因此实际 Node 测试为 `72/72`：

- `g4-model-runtime.test.mts`：`20/20`；
- `g4-response-runtime.test.mts`：`23/23`；
- `g4-derived-artifact-runtime.test.mts`：`29/29`。

执行 `npm run check:g4` 同时重放 G1–G3 并运行严格 TypeScript 检查。`X01/X03/X04` 当前是模块局部单元证据；它们还没有证明完整 Turn Orchestrator 中一处失败不会扩散，端到端隔离必须在 G5 固定会话中验证。

## 5. 审查后修复

独立审查曾发现并已进入回归的主要问题包括：

- Unicode/全角/零宽字符可绕过 protected-content 检查；
- 日常聊天可能接受跨家庭引用；访谈调用方可能用相同 evidence ref 伪造 evidence 文本；
- 模型可通过自由文本清洗来源主体；历史偏好可能被压成当前画像；
- transport 可自报合法费用，usage 可接受不一致或小数值；
- 输出 callback 已开始后，取消可能在 callback 完成前返回；
- 新增未暴露来源会误伤当前快照；
- “一次运行门”被过度表述成“一次物理 provider 请求”。
- variation selector、组合附加符和繁体高风险别名可绕过 protected-content 过滤；
- Response/Derived 与内层模型共同 finalize 同一个 lease，导致内层成功后外层被判取消；
- 不响应取消的输出 sink 可使调用永久悬挂。
- 外层 Response/Derived 可在内层 sink 尚未返回 `DROPPED` 时提前 finalize，并把嵌套清理超时误报为已完成。
- sink 在取消后仍返回 `COMMITTED`、抛错或给出非法确认时，单看 Promise settle 会把已发生的迟到提交误报为安全清理。

当前实现用可信 resolver、结构化 attribution、严格 usage/billing verifier、Unicode 安全 skeleton、单次 branded borrowed permit、有界 sink acknowledgement、外层 bounded cleanup join 和明确的 snapshot 语义关闭上述旁路。DailyChat、Interview、Story、Profile 均已加入与 `AuditedTextRuntime` 的真实组合取消回归；永久挂起和内层 sink 超时会明确返回 `TIMED_OUT`，取消后迟到提交会返回 `FAILED`。

最终独立只读复核为 `P0=0 / P1=0 / P2=0`，另建 10 个对抗探针并全部通过。复核覆盖四模块的 `DROPPED/JOINED`、永久挂起 `TIMED_OUT`、取消后 `COMMITTED/FAILED`、Text sink 抛错、TTS 非法确认，以及 permit 冻结、并发单次消费和重放拒绝。由此关闭 G4 Local Gate；结论仍只适用于离线本地工程门禁。

## 6. 尚未完成与 G5 进入条件

G4 已用 borrowed permit 解决同一逻辑节点内的 lease 所有权冲突。G5 仍需实现更高一层的父子生命周期：Turn Orchestrator root 下的 Response、TTS、Memory、Story 和 Profile 是兄弟/子任务；子任务完成不能终止父级或兄弟，父级取消必须递归停止后代，且父级完成时不能留下未声明的孤儿任务。单纯增加 channel 名称不能替代该关系。

G5 还必须完成：Session/Evidence/Reference Store-backed resolvers、父子 lease/NO_SAVE/证据撤回传播、Turn Orchestrator、HTTP/Fake、3 个固定 session、24 轮、10 次打断、健康/版本/错误/日志、跨模块故障隔离及回滚说明。

## 7. 结论边界与预算

- 已证明：本地运行合同、策略先于 LLM、引用/权限过滤、派生物来源、取消与迟到拒绝、严格 schema/usage 和模块内 fallback。
- 未证明：真实豆包协议、真实 ASR/TTS/LLM 质量、语义蕴含、一次物理请求、真实费用、产品 HTTP 安全、真人体验和生产稳定性。
- 当前费用与预留均为 `CNY 0`；`paidExecutionEnabled=false`。
- 预算规则保持：总上限 `CNY 60`；累计预留达到 `CNY 45`，或余额不足以覆盖下一阶段时，必须暂停并提交已用/预留费用、失败、剩余工作和新增预算理由。
