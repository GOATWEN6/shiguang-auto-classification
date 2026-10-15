# G3 Fake Provider 与独立流式 ASR 报告

> 日期：2026-10-03
> 当前状态：`G3_local_gate_passed / independently_reviewed / real_wire_pending / paid_calls_disabled`
> 上游：[G2 访谈与 Life Memory 运行库报告](./G2_REPORT.md) · [模块化真实模型 Baseline 执行计划](../../../docs/execution/2026-10-02-live-model-baseline-execution-plan.md)
> 实现 commit：`c52aaf0 feat: add offline provider and streaming asr gate`

## 1. 本阶段解决什么问题

G3 只建立无费用、可重复的 provider 工程门：四类可注入 Fake、独立流式 ASR 合同、豆包薄 Adapter、重试/取消/迟到隔离和固定 8 例。它不证明真实豆包已经连接，也不证明识别准确率、延迟或老人体验。

现有 `src/lib/voice/realtime/` 使用 `volc.speech.dialog` 端到端对话协议，同时包含 ASR、LLM 和 TTS 语义。该路径保留为 legacy，不能改名或复用为独立 ASR 的完成证据。

## 2. Source Gate

结论：**PASS WITH CONDITIONS**。

| 来源 | 本轮使用方式 | License / 边界 | 决定 |
|---|---|---|---|
| [Doubao 双向流式 ASR 官方文档](https://docs.volcengine.com/docs/DoubaoVoice/bidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 协议、端点、鉴权、事件和分包事实 | 商业服务文档；demo zip 的独立 License/NOTICE 未核实 | 按文档事实自研薄 Adapter，不复制 demo |
| [Doubao 单向流式 ASR 官方文档](https://docs.volcengine.com/docs/DoubaoVoice/unidirectional-streaming-automatic-speech-recognition-websocket?lang=zh) | 区分非实时端点 | 商业服务文档 | 不作为当前交互式基线 |
| [LiveKit Agents `57b3227`](https://github.com/livekit/agents/tree/57b3227a7842697e6ad45b1275369cf9700bf161) | 学习 interim/final/usage、取消和 retry ownership | Apache-2.0 + NOTICE；turn detector 权重来源仍 blocked | 不复制、不加依赖 |
| [Pipecat `2967e1c`](https://github.com/pipecat-ai/pipecat/tree/2967e1c09ad484076089bc88427d305fe8f79fa9) | 学习分帧流水线、取消与 metrics | BSD-2-Clause；Smart Turn 权重来源仍 blocked | 不复制、不加依赖 |
| [Promptfoo `9110c25`](https://github.com/promptfoo/promptfoo/tree/9110c25c495de6f43b40c9b22c900e819555f27c) | 学习固定矩阵和确定性断言 | MIT；插件/provider 可执行外部代码 | 自建 fixture，不引入依赖 |
| [XState `fbee62e`](https://github.com/statelyai/xstate/tree/fbee62e7c1586315ed478c2fedf530d7e0ff5a3e) | 学习 state/event/guard 测试 | MIT | 状态较小，当前不新增依赖 |

已核实的协议事实：

- 独立双向实时端点为 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`；单向 `bigmodel_nostream` 不作为当前交互式主链；
- 官方建议单包及发包间隔约 100–200ms，当前首版冻结 PCM raw、16kHz、16bit、mono、200ms；
- 中间 `result.text` 可继续变化，不能视为 final；只有 `utterances[].definite=true` 可转成 `segment_final`，整流结束还要看 provider 的 last 标志；
- `payload_sequence` 只用于协议排序/去重，不能充当语义 final；
- 新控制台鉴权使用 `X-Api-Key`、`X-Api-Resource-Id`、`X-Api-Request-Id`。密钥只从服务端 secret storage 注入，不进入 fixture、日志或浏览器；
- 官方没有给出完整、当前、可机器执行的 provider error code → retryable 对照，G3 不把推测写成官方保证。

以下仍为 `UNKNOWN`，不阻塞离线 G3，但阻塞声称真实接入完成：demo zip License/NOTICE、完整错误重试分类、握手阶段 401/403/429/5xx 的实际响应形态、provider 是否真的会乱序/重复发包、账号实际 SKU/价格/配额。

## 3. Design Gate

### 3.1 文件与职责

```text
src/lib/provider-runtime/
  contracts.ts          provider-neutral 调用与事件合同
  scripted-fake.ts      确定性 Fake 和四类具名包装
  retry-runner.ts       唯一重试所有者，复用 G1 ledger/cancellation

src/lib/asr-runtime/
  contracts.ts          音频块、provider 事件、Evidence 合同
  audio-chunk-validator.ts  PCM 与 100–200ms/尾包校验
  stream-reducer.ts     identity、去重、乱序、final 与 usage 门
  doubao-protocol.ts    官方 JSON 语义到规范事件；保留 raw code
  doubao-streaming-adapter.ts 可注入 transport 的独立薄 Adapter
  index.ts              稳定公共入口
```

`TurnOrchestrator`、HTTP 和真实 Voice 接线属于 G5。G3 不改现有 dialogue route，也不让 Fake 直接写 Memory。

### 3.2 权威边界

1. G1 `ModelCallLedger` 是 attempt 与重试的唯一权威：首次调用加最多 3 次自动重试，共最多 4 attempts；
2. 只有 `network_transient/provider_429/provider_5xx/provider_503/incomplete_stream/retryable_timeout` 可自动重试；`invalid_schema/cancelled` 不重试；
3. G1 `GenerationCancellationRegistry` 是 generation/invocation/response/evidence 是否仍可投递的唯一权威；
4. partial 只具有 UI 字幕能力，不能创建 Evidence、调用 Interview/LLM、Memory 或 TTS；
5. accepted、schema-valid、当前 generation 的 segment final 才能形成 `TranscriptEvidence`；
6. provider VAD、静音秒数和 `segment_final` 不单独决定“老人已经说完”，该决定仍属于后续 Turn/Interview policy；
7. 底层 transport 不重试；重连必须产生新 attempt/requestId，旧连接迟到结果一律拒绝；
8. 第四次失败后立即返回结构化可见 fallback，清除 in-flight 状态，不允许 attempt 5 或无限等待。

### 3.3 音频与事件合同

- 非尾 PCM 块按实际字节数计算时长，只接受 100–200ms；不信任调用方填写的 `durationMs`；
- 首版生产默认 200ms。短尾块只允许显式 EOS，且必须为非空、最多 200ms；后续浏览器接线优先合并尾块；
- 本地 segment key 固定为 `{sessionEpoch, turnId, generationId, segmentIndex}`，provider segment ID 只作元数据；
- 相同 sequence/revision/text 为幂等 no-op；相同 sequence 或 revision 但内容冲突时 fail closed；
- 低 revision 与 final 后 partial 被忽略；乱序 segment final 先缓存，再按 segmentIndex 各输出一次；
- usage 对同一 attempt 只接收一次，重复相同值为 no-op，冲突或负值为 `invalid_schema`。

### 3.4 最终异常与并发收口

- `ProviderRetryRunner` 的正常完成若在账本写入前异常，`failInFlightAttempt` 会把 attempt 收敛为 `COMPLETED + UNBILLED`，保留冻结价格目录中的最坏费用，关闭 generation 与 pending 状态，并保留原始异常；
- 同一个 ASR session 的 `send/end` 使用单一串行队列，后一块音频不能越过尚未确认的前一块；取消会使当前和排队操作均以 `AbortError` 结束，底层 `cancel` 至多调用一次；
- 一个解码后的 provider packet 会产生稳定的 `providerPacketFingerprint`。同一 `providerSequence` 只能绑定一个 packet；复用 sequence 但 packet 不同会在第二批事件产生 partial、Evidence、usage 或 stream-final 副作用前 fail closed；
- fingerprint 当前是 FNV-1a 64 一致性 checksum，只用于本地重复/冲突检测，不是密码学认证，也不能代替真实 provider 签名。

## 4. 固定 8 例与停止条件

| Case | 主要覆盖 |
|---|---|
| G3-01 | 100/150/200ms、EOS 短尾、partial→final→usage |
| G3-02 | 两 segment 乱序、重复、final 后 partial、按 0→1 输出 |
| G3-03 | 断线重连、未确认音频重放、旧连接迟到 final |
| G3-04 | attempt 1 timeout、attempt 2 成功、输入/配置 hash 不变 |
| G3-05 | 429→503→成功、错误归一化和完整 attempt 审计 |
| G3-06 | 四次 retryable failure、一次 fallback、无 attempt 5 |
| G3-07 | HTTP 200 非法 Schema/负 usage，一次即停、无 Evidence |
| G3-08 | partial 后取消、旧 generation 迟到结果全丢弃、下一 generation 正常 |

任何 partial/取消后/旧 generation 结果进入 Evidence、Memory、TTS 或最终字幕；跨身份接受；重复 final 产生双份 Evidence；非法 Schema 被记成功；出现 attempt 5；第四次失败仍 loading；或测试必须依赖真实密钥/网络，均为 P0，立即停止晋级。

## 5. 本阶段验收与证据

- 固定 8/8，无删除失败案例；
- Fake timeout、429、5xx、invalid schema、cancel、late 和 usage 可确定复现；
- `partial → Memory calls = 0`、`stale accepted = 0`、`attempt 5 = 0`；
- G1/G2 与现有 Voice fixture 不退化；
- 全部测试使用虚构文本、合成字节和离线 transport；
- 预算暴露保持 `CNY 0`，`paidExecutionEnabled=false`。

已执行结果：

| 检查 | 结果 | 说明 |
|---|---:|---|
| G1 共用运行合同 | `15/15 PASS` | canonical lease、预算、取消、生命周期与恢复无退化 |
| G2 Interview/Memory | `38/38 PASS` | Policy、Reference Store 与检索边界无退化 |
| G3 Provider/ASR | `31/31 PASS` | ASR `18/18`、Provider `13/13` |
| 严格 TypeScript | `PASS` | `typecheck:g2`、`typecheck:g3` 均通过 |
| 独立 QA 反例 | `9/9 PASS` | 账本异常、并发/取消、packet fingerprint；临时探针未写入仓库 |
| 旧 Voice smoke | `147/147 PASS` | live Doubao 项为 `SKIP`，只证明本地合同无退化 |
| Source / artifact / manifest | `PASS` | 11 条来源、35 个冻结产物、60/45 元与 4 attempts 配置均通过 |
| 密钥扫描 | `PASS` | 未发现提交的 provider 凭据 |

独立 QA 结论为开放 `P0=0 / P1=0`，建议 `G3 local gate PASS`。

生产构建已完成当前主应用编译和 lint/type 阶段，但最终被本轮范围外、未跟踪的 `ai-frame-main/prototype/archive/v1.0-baseline/src/main.tsx` 阻塞：该旧原型缺少 `react-router-dom`。本轮没有为旧原型安装依赖或修改其代码，因此不能把根构建写成通过。

## 6. 当前证据边界

G3 已通过本地 Fake/injected-transport 工程门，可以进入 G4。它仍不证明真实豆包 WebSocket binary framing、gzip、鉴权、应用层 ACK、provider cancel、识别质量、设备音频、真实延迟、计费或老人体验；这些属于 G6/G7。账本当前是单进程内存模型，未来 durable Adapter 仍需数据库事务与崩溃恢复验证。真实威胁模型若把 provider payload 视为主动恶意输入，packet fingerprint 还需升级为 SHA-256/HMAC 或可信签名。
