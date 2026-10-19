# G2 访谈与 Life Memory 纯算法运行库报告

> 状态：`local_synthetic_gate_passed / paid_calls_disabled`
> 日期：2026-10-03
> 上游：[模块化真实模型 Baseline 执行计划](../../../docs/execution/2026-10-02-live-model-baseline-execution-plan.md)
> 前置：[G1 共用运行合同报告](./G1_REPORT.md)

## 1. G2 要解决的问题

此前可用的 Interview v0.2、Memory hybrid-v0.2 和 M2 policy 主要位于实验 harness。它们可以证明冻结案例上的机制，却不能直接作为真实模型链路的生产导入边界。G2 将其中已确认的纯算法部分提升为严格 TypeScript 运行库，并建立一个无模型直写权的 Reference Store，使后续 Fake Provider、真实 Adapter 和 HTTP 编排有明确的输入、输出与权限边界。

G2 不调用真实模型，不接收真实老人或家庭数据，也不把旧产品入口切到新运行库。

## 2. 已实现内容

### 2.1 InterviewPolicy 与 DirectionPlan

- `src/lib/interview-policy/contracts.ts`：定义逐轮决策、运行身份、证据引用、取消、留存和状态补丁合同；
- `src/lib/interview-policy/reducer.ts`：把冻结的 InterviewPolicy v0.2 提升为运行库；兼容入口保留冻结行为，真实入口强制校验 `sessionEpoch`、`turnId`、`generationId` 和 `invocationId`；
- `src/lib/interview-policy/direction-plan.ts`：建立 `InterviewProgram → SessionPlan → PlanState → DirectionPlan` 最小合同，默认 `FOLLOW_USER`，显式记录老人同意、主题状态、作用范围和不确定性；
- 老人明确结束、跳过或换题优先于普通主题候选；`SKIPPED / DEFERRED / BLOCKED` 主题不会进入当前计划；
- DirectionPlan 只能提出主题，无权保存 Memory、结束会话或生成自然语言话术。
- 公共 API 只暴露带 live identity 校验的 Interview creator、经过 Program/Session/State 校验的 DirectionPlan creator 和只读类型；冻结 compatibility reducer、普通 hash 和 assertion helpers 只保留在 test-only internal 入口。

DirectionPlan 当前只负责验证并过滤上游明确提供的候选顺序，不进行自由主题排序。这避免在主题本体和真实体验尚未验证前，把模型偏好误写成产品方向。

### 2.2 Memory candidate、policy 与 Reference Store

- `src/lib/memory-runtime/policy.ts`：提升冻结 M2 policy；
- `src/lib/memory-runtime/hybrid-extractor.ts`：提升 must-extract＋semantic proposal 合并边界，semantic proposal 必须能回指已验证 `sourceSpans`；
- 模型或外部框架不能伪造来源角色、明确同意、敏感性降级或 canonical write；凭据内容不能进入普通 Memory；
- `src/lib/memory-runtime/reference-store.ts`：实现候选登记、确定性业务门、C2/C3 确认、分源接受、纠正新版本、冲突保留、撤回、删除、证据撤回、用途与权限检索；
- 非老人确认必须提供 `authorityRef`；冲突内容默认不进入普通检索，只有带 `reviewAuthorityRef` 的 REVIEW 模式可读；
- 检索独立检查 subject、family、purpose、authorization version、visibility 和 `asOf`；任一空 scope 都 fail closed；
- 删除任一版本会 tombstone 同一 logical memory 的全部版本，恢复快照后仍不返回内容；
- `src/lib/memory-runtime/retrieval-gate.ts`：向量或搜索索引只作为候选提示，每次使用前必须按当前 Store 状态重新授权。

Reference Store 元数据固定为：

```json
{
  "canonicalWriteCapability": false,
  "decisionGatedActivationCapability": true,
  "durable": false
}
```

这里的 `ACTIVE` 表示候选经过确定性业务门或相应确认后，可作为后续本地检索的结构化参考；它不等于模型直接写入数据库，也不表示当前内存实现已成为正式持久化 `CanonicalMemory`。

## 3. 验证结果

| 检查 | 结果 | 能说明什么 |
|---|---:|---|
| `npm run test:algorithm-runtime` | 15/15 PASS | G1 identity、canonical lease、取消、预算、尝试账和生命周期合同未回归 |
| Interview 冻结 parity | 36 original＋16 known held-out＋2 runtime probes 全部一致 | 运行库没有改变冻结 v0.2 行为 |
| M2 policy parity | 30 cases / 40 proposals 全部一致 | 运行库没有改变冻结 policy 结果 |
| M2 hard gates | 16 类 gate 无错误 | 固定合成材料上的来源、权限、冲突、敏感性和幂等规则仍成立 |
| Memory hybrid | 冻结 13 个机制案例及新增攻击/边界回归通过 | source span、must-extract、合并和禁写边界可重复 |
| Reference Store | 11 个聚焦测试通过 | 确认、纠正、冲突、撤回、删除、检索与 stale-index gate 可重复 |
| `npm run test:g2` | 38/38 PASS | G2 聚焦测试全部通过；38 是测试条目数，不替代上述固定案例分母 |
| `npm run typecheck:g2` | PASS | G1/G2 目标文件通过 strict TypeScript 检查 |
| Source/artifact lock | 11 条 P0 来源、35 个冻结产物 PASS | 已采用材料未漂移；3 个既有 license 未决候选仍保持阻断 |
| Manifest/secret scan | PASS | 付费开关仍为 false，目标目录未发现凭据 |

旧 `src/app/api/chat/route.ts`、`src/lib/memory/index.ts` 和 `src/lib/memory-extractor/index.ts` 在本轮没有改动；六个既有 OSS 结果文件及 `package-lock.json` 的前后 SHA-256 一致。

独立 QA 曾发现两个真实问题并已加入回归：Node 22 的 TypeScript ESM 公共导入需要显式 `.ts`；C2/C3 经确认的记录最初仍不可检索。随后独立 Interview 复核发现 active session 旧响应、无 identity compatibility 入口、来源未完全绑定、Program 权限未执行、老人方向缺少当前轮证据、TopicLedger scope 未参与决策，以及 forged-plan、空 ref 和 public validator 等旁路。它们均已转成 fail-closed 合同或从公共 API 移除，并加入回归。最终独立复测的 58 个自建绕过探针全部通过，未再发现开放 P0/P1。

上述验证环境为 Node.js 22.22.1；尚未验证 Node 18/20 兼容性。

## 4. 证据边界

G2 只证明：在固定虚构/合成输入下，新 TypeScript 运行库保持冻结算法行为，并能执行当前定义的结构、权限和失效规则。

G2 不能证明：

- 豆包真实 ASR、文本模型或 TTS 可用；
- 方言、噪声、真实老人表达或长时间多轮体验质量；
- semantic provider 的真实抽取准确率；
- Reference Store 的数据库事务、并发、备份或删除调度可靠性；
- 故事草稿、基础画像或真人体验已通过；
- 全栈产品已经接入。

## 5. 下一 Gate

下一步是 G3：实现可注入故障的 Fake Provider 与独立流式 ASR Adapter，验证 partial/final、重复/乱序、超时、重试、取消、迟到丢弃和可见兜底。G3 继续使用合成音频/虚构文本且保持付费调用关闭。

只有完成 G3–G5、重新核验 provider 数据条款与价格、具备 durable governance repository、删除执行器和冻结 runner 后，才能进入 G6 的真实模型 canary。

预算仍为 CNY 60 硬上限；费用暴露达到 CNY 45 或余款不足下一阶段时暂停并提交费用、失败、剩余工作和追加预算理由。当前累计实际费用与预留费用均为 CNY 0。
