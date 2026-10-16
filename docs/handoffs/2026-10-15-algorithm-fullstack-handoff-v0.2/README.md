# SGX 算法接口候选交接文档 v0.2

> 状态：`candidate/pre-human`
>
> 更新：2026-10-16；直接随仓库维护，不再生成 ZIP。
>
> 面向：全栈、后端、产品和测试

## 1. 这份包是做什么的

这份包把 SGX 当前算法侧已经形成的 HTTP 接口、字段含义、状态变化、错误处理和测试方式整理给全栈团队。全栈可以先用 Fake 模式打通页面和后端，再切换到算法侧的真实模型测试服务。

这不是生产发布包，也不是最终真人验收结论。当前 Memory 结果仍是进程内的候选/派生结果，不能直接当作生产 `CanonicalMemory` 持久化。Shadow 只用于观察模型的语义理解，不改变正式访谈策略。

## 2. 当前状态

| 部分 | 当前状态 |
|---|---|
| 日常聊天 | 已接入真实文本模型基线，可通过 HTTP 调用 |
| 正式访谈 | 由 `InterviewPolicy` 决定等待、承接、追问、换题、暂停和结束 |
| Memory | 真实模型候选抽取和来源校验已运行；当前不写生产 CanonicalMemory |
| 故事草稿 | 可作为派生任务生成，和 Memory 独立失败、独立查看 |
| 基础画像 | 可作为派生任务生成，和故事草稿独立失败、独立查看 |
| ASR | 支持 PCM16 和独立 ASR 流；浏览器不能接触 provider key |
| TTS | 服务端生成音频并通过结果/事件返回；取消和打断由服务端处理。当前采用模块化 TTS，不使用端到端实时语音模型 |
| SemanticTurnProposal Shadow | 历史付费 24 轮已执行；修复后 24/24 离线归一化；未运行第二次付费整批 |
| CanonicalMemory | 当前服务明确 `canonicalWriteCapability=false` |

## 3. 全栈如何使用

建议按下面顺序接入：

1. 先调用 `/health` 和 `/version`，确认服务状态、接口版本和 build ID。
2. 用 Fake 模式联调文字、状态、事件、取消和结束；语音识别、可播放音频和设备打断另用真实 provider 验证。
3. 用 `view` 展示 Memory 候选、故事草稿、基础画像和当前 Shadow 诊断。
4. 用固定样例运行错误、重试、幂等和版本回滚测试。
5. 在服务端配置模型与累计预算后，进入 `REAL_INTERNAL` 做内部真实模型体验；正式发布须经过反馈修复与版本冻结。

算法服务不要求前端直接理解 provider、模型密钥或内部主体 ID。前端只保存服务返回的 `opaqueSessionHandle`，并把它作为后续请求路径的一部分。

## 4. 重要边界

- 浏览器和小程序不得携带 ASR、TTS 或文本模型 API Key。
- `opaqueSessionHandle` 是不透明句柄，不能自行拼接或解码。
- `evidenceId`、`turnId`、`generationId`、`invocationId` 等服务端字段不能由客户端写入。
- `semanticTurnShadow` 里的 `narrativeCues` 和 `nextActionCandidates` 只是模型观察和候选，不是执行命令。
- 当前 `Memory` 是候选/派生视图，不写生产长期记忆。后续持久化由可信策略执行：已预授权的低风险白名单可自动保存，敏感或高影响内容需要明确确认；模型不能自行扩张授权。
- 敏感、健康、财产、家庭冲突等内容必须按产品确认规则处理。
- 失败时显示可理解的状态并允许重试，不要让老人无限等待，也不要让模型声称“已经保存”。
- `/api/algorithm/v0.1/health` 返回的是机器 JSON，团队体验请打开算法工作台页面，而不是把健康接口当产品页面。

## 5. 文档目录

- [HTTP 接口合同](./http-contract-v0.2.md)
- [给全栈的候选接口交接说明](./docs/fullstack-candidate-handoff-note.md)
- [字段、结果和状态说明](./docs/result-and-state-guide.md)
- [负责人真实体验案例](./docs/owner-real-model-smoke-cases.md)
- [C1～C12 真实体验与定向复验记录](./docs/owner-c1-c12-real-smoke-report.md)
- [负责人反馈表](./docs/owner-feedback-form.md)
- [错误、重试、版本和回滚](./docs/testing-retry-version-rollback.md)
- [算法与全栈责任边界](./docs/ownership-and-review.md)
- [当前候选版本补充说明](./docs/current-candidate-overlay.md)
- [同 IP/会话/轮次成本表](./docs/ip-session-round-cost-table.md)
- [公网访问与持久运行边界](./docs/public-access-and-persistence-plan.md)
- [拾光长河访谈主题优化大纲](./docs/interview-theme-outline-v0.1.md)
- [示例请求](./examples/)
- [交接清单](./handoff-manifest.json)

## 6. 与当前代码的对应关系

以下模块的脱敏源码已随仓库放在 `algorithm-handoff/sgx-source/`，本目录提供契约和示例：

- `src/app/api/algorithm/v0.1/`
- `src/lib/turn-orchestrator/`
- `src/lib/algorithm-service/composition.ts`
- `src/lib/algorithm-service/semantic-turn-shadow.ts`
- `src/lib/memory-runtime/`
- `src/lib/voice/tts/`（当前模块化 TTS 路径）
- `src/lib/asr-runtime/`
- `harness/live-baseline/v0.1/`

完整的脱敏源码快照随本次交接提交在 `algorithm-handoff/sgx-source/`。其中不包含 `.env.local`、密钥、原始音频、付费运行目录或生产数据。旧的 `src/lib/voice/realtime/` 端到端候选没有接入当前模块化链路，也不应由全栈启用。

## 7. 交接完成标准

全栈完成以下内容后，才算“接口接入完成”：

- Fake 模式完成创建会话、文字、事件、取消与结束；真实内部模式完成语音输入、音频播放和设备打断；
- 对 `WAIT`、`FOLLOW_UP`、`SWITCH_TOPIC`、`PAUSE`、`END` 和失败状态有清晰展示；
- 能查看一轮结束后的 Memory 候选、调用过的 Memory、故事草稿和基础画像；
- 能区分 `candidate/pre-human` 和正式发布版本；
- 服务异常、超时、重复请求和旧版本结果不会覆盖新结果；
- 不会把任何密钥、原始 provider 错误或内部权限字段返回给浏览器。

## 8. 三段式执行顺序

本包对应第一段“候选接口交接”，不代表正式发布。后续按固定顺序执行：

1. **候选接入**：全栈用 Fake 和脱敏示例接通页面、事件、错误、Memory/故事/画像展示；算法侧保留 Shadow 旁路，不让它接管策略。
2. **负责人真实体验**：用 `docs/owner-real-model-smoke-cases.md` 的固定用例体验当前真实模型，记录原话、回复、等待、音频、打断和 Memory/草稿结果。当前 C1～C12 机器记录和暂停/换题定向复验见 `docs/owner-c1-c12-real-smoke-report.md`；真人听感和故事/画像质量仍由负责人决定是否需要修复。
3. **正式冻结交付**：根据反馈修复并定向复验，冻结 build、合同和回滚提交；直接更新并合并同一仓库分支。

当前包的状态是 `candidate/pre-human`。它可以让全栈并行开发，但不能被标成正式算法版本，也不能用当前临时 Memory 结果替代生产 `CanonicalMemory`。

## 9. 2026-10-16 当前覆盖

请先阅读 [当前补充说明](./docs/current-candidate-overlay.md) 和 [本轮分发验证](./docs/reviews/2026-10-16-distribution-validation.md)。历史真实模型证据绑定 v23；本轮启动分发为 `v23-gitee.1`，74/74 聚焦测试、类型检查和构建通过，新增付费调用 0 次。400 元是累计上限，335.24 元是 10 月 15 日预留快照而非实际账单。当前仍是 `candidate/pre-human`，不包含可直接生产部署的 `CanonicalMemory` 后端。
