# 2026-10-15 执行记录：400 元预算、本机候选服务与全栈接入边界

> 阅读口径：第 1～7 节记录本轮开始时的静态核验快照；负责人随后通过工作台进行了真实模型体验，最新运行状态、预算和 build 以第 8～11 节为准。

## 1. 本轮目标

本轮围绕三个问题核实当前是否可以进入全栈真实接入：

1. 将真实模型测试累计硬上限提高到 400 元，并确认运行时使用新的账本；
2. 让算法工作台以可复现的候选服务方式运行，并判断是否已经达到“持久化公网服务”；
3. 判断现有算法是否可以直接作为正式产品代码推送给全栈，以及还缺哪些门禁。

本轮没有发起真实模型调用，也没有写入正式 `CanonicalMemory`。

## 2. 已完成的核验

### 2.1 预算已经切换到 400 元

当前账本文件：`harness/live-baseline/v0.1/.local-runs/http-current/budget.json`

| 项目 | 当前值 | 含义 |
|---|---:|---|
| 程序累计硬上限 | 400 元 | 负责人已批准的新上限 |
| 当前批次上限 | 364.48 元 | 400 - 历史暴露 35.52 |
| 当前批次已预留 | 214.40 元 | 调用前预留上限，不是最终账单 |
| 累计预留 | 249.92 元 | 历史暴露 + 当前批次预留 |
| 当前可继续预留 | 150.08 元 | 达到硬上限前的余额 |
| 汇报节点 | 120 元 | 保持不变，已触发 |
| 账单状态 | `PENDING` | 供应商最终账单尚未结算 |
| 正式记忆写入次数 | 0 | 当前仍不写正式 `CanonicalMemory` |

源代码策略为 `owner-budget-2026-10-14-v0.3`。提高上限只扩大允许的测试额度，不等于批准重复整批测试、生产发布或真人老人测试。

### 2.2 本机候选服务已用生产构建启动

用 `next build` 构建通过后，以以下配置启动了本机候选服务：

```text
SGX_ALGORITHM_MODE=real
SGX_INTERNAL_BATCH_CAP_CNY=364.48
SGX_INTERNAL_PRIOR_EXPOSURE_CNY=35.52
SGX_ALGORITHM_BUILD_ID=pre-human-2026-10-15-candidate-v21
```

只读 `/health` 和 `/version` 的结果：

| 项目 | 结果 |
|---|---|
| 运行模式 | `REAL_INTERNAL` |
| 服务版本 | `g5-real-internal-v0.18` |
| InterviewPolicy | `interview-policy-v0.3.4` |
| 构建标识 | `pre-human-2026-10-15-candidate-v21` |
| Provider 配置 | 已发现 |
| 预算门禁 | 已授权 |
| 组件健康 | session、lease、evidence、policy、TTS、async jobs 均 ready |
| 本轮网络调用 | 0 |
| 存储状态 | `process_memory_fictional_only` |
| 正式 `CanonicalMemory` 写入 | 关闭 |

这证明“当前候选代码能够启动并通过健康检查”，不证明它已经是多实例、跨重启可恢复的生产服务。

### 2.3 构建与类型检查

- `npm run build`：通过。存在 VAD/`onnxruntime` 的构建警告和一个 React ref 清理警告，未阻断构建。
- `npx tsc --noEmit --incremental false`：通过。
- `git diff --check`：通过。
- 本轮没有为验证而增加付费调用。

## 3. 当前能否交给全栈

可以交给全栈做 **candidate/pre-human 的接口接入和内部 staging 联调**，但还不能把它称为“整个算法已经正式接入产品”或“生产版本”。原因如下：

| 项目 | 当前状态 | 影响 |
|---|---|---|
| HTTP 算法接口 | 已有 v0.1 合同、Fake 和 REAL_INTERNAL 运行方式 | 全栈可以先接入页面、状态、错误、Memory/故事/画像展示 |
| 访谈策略 | `InterviewPolicy v0.3.4` 已在候选服务中 | 仍需负责人真实体验确认追问、停顿、换题和等待 |
| Memory 候选与派生物 | 可抽取、校验、展示 | 只在进程内参考存储中运行，不能当成家庭长期记忆 |
| `CanonicalMemory` | 只有算法侧端口和 `InMemoryReferenceStore` | 缺少后端数据库、事务、角色权限、撤回/删除 worker、跨进程检索 |
| 成本统计 | 新增 `/api/algorithm/v0.1/costs` 和 IP/会话/轮次脱敏账本 | 需要纳入新版交接包，旧包没有此接口 |
| 公网访问 | 只有 loopback + Basic Auth 临时网关 | 旧 Quick Tunnel 会随进程停止而失效，不能作为持久在线服务 |
| GitHub 交付 | 旧分支只同步了文档包 | 当前代码、成本账本、400 元策略和 v0.3.4 尚未形成干净候选提交 |

所以正确的说法是：**算法接口已经达到“可交给全栈并行接入”的候选状态；正式生产接入仍需全栈持久化和部署门禁。**

## 4. 持久化和公网的真实边界

### 4.1 本机持久运行

`next dev` 不适合作为长期服务。候选运行应采用：

```text
npm run build
npm run start -- -H 127.0.0.1 -p 3100
```

再由 macOS `launchd`、Linux `systemd` 或受控进程管理器负责自动拉起、日志轮换和异常重启。

但进程守护只能保证“服务进程自动回来”，不能保证会话和正式 Memory 不丢失。当前会话、ASR 流、响应缓存、主体绑定和 Reference Store 仍是进程内状态；重启后需要重新建立会话，正式 `CanonicalMemory` 仍未写入。

### 4.2 在线访问

现有 `scripts/public-test-gateway.mjs` 只适合临时内部测试：

```text
团队浏览器 → HTTPS 隧道 → Basic Auth 网关 → 127.0.0.1:3100
```

它没有请求体上限、速率限制、并发配额、代理超时、WebSocket Upgrade、凭据轮换和完整审计。因此可以用于短期内测，不能直接作为持久在线或生产入口。

持久在线至少需要：

1. 固定主机或云服务、域名和 TLS；
2. 反向代理/WAF、身份认证、速率与并发限制、请求体和超时限制；
3. Provider 密钥只在服务端保存；
4. 全栈业务认证把家庭主体、角色和用途传入后端，算法服务不能接收浏览器自造的主体 ID；
5. PostgreSQL/对象存储/队列或 outbox，以及可恢复的会话、Memory、删除和审计数据；
6. 灰度发布、健康探针、版本回滚和预算熔断。

## 5. 下一阶段最短执行顺序

### A. 先做候选交接（现在可以执行）

生成 `candidate/pre-human` v0.2 交接包，包含：

- 当前 HTTP 合同和脱敏请求/响应示例；
- `/health`、`/version`、`/costs` 的字段说明；
- `InterviewPolicy v0.3.4`、`g5-real-internal-v0.18` 和本轮 build 指纹；
- 当前 400 元账本口径和同 IP/会话/轮次成本表；
- 62/62 离线验证、暂停/换题 5/5 定向复验和 Shadow 24 轮“修复后仅离线复验”的边界；
- `CanonicalMemory` 端口、`durable=false` 和后端 C2-C4 待接入清单；
- Fake → internal staging → 真人体验的接入与回滚步骤；
- 明确排除 `.env.local`、密钥、原始音频、`.local-runs` 和生产数据。

### B. 全栈内部 staging 接入

全栈先使用 Fake 和候选 REAL_INTERNAL 服务，完成：

- 创建会话、文字/语音输入、流式回复、TTS 播放和服务端打断；
- 展示访谈状态、Memory 候选、调用过的 Memory、短/长期分层、故事草稿、画像草稿和反馈；
- 处理 `WAIT/FOLLOW_UP/SWITCH_TOPIC/PAUSE/END`、超时、重试和旧结果隔离；
- 把业务认证、家庭角色和权限放在后端，不让浏览器直接拿 Provider 密钥。

### C. 负责人真实模型体验

在 staging 页面稳定后，再使用剩余 150.08 元进行小批量真实体验，重点看：

- 追问是否有价值、是否重复；
- 等待和失败提示是否可接受；
- ASR 文本是否可修改；
- TTS 音色和实际播放是否稳定；
- Memory 来源是否准确，故事/画像是否忠实；
- 打断是否真的取消服务端旧响应；
- 反馈包和成本表是否能复盘每一轮。

### D. 正式产品接入和持久化

只有 C 阶段反馈通过后，才由全栈完成正式 `CanonicalMemory` Adapter、数据库事务、权限、版本、撤回、删除、索引和部署。该阶段完成后才能讨论固定公网域名和正式发布。

## 6. 需要负责人确认的两个外部选择

当前代码、构建和本机候选服务不需要负责人再配置。真正会改变外部结果的只有：

1. **GitHub 目标**：已确认使用 `GOATWEN6/shiguang-auto-classification`，分支为 `codex/sgx-algorithm-candidate-2026-10-15`。本地交接提交已经完成，远端推送仍等待 GitHub 账号重新认证。
2. **公网范围**：先要一个带临时密码的内部测试 URL，还是直接准备固定域名/云主机的 staging？前者可以快速验证，后者需要主机、域名、TLS、认证和持久化存储配置。

在这两个选择确认前，继续做代码静态检查、候选包整理和本机内部 staging 不会白做，也不会触发新的模型费用。

## 7. 本轮新增交付物

- 候选交接文档目录：[2026-10-15-algorithm-fullstack-handoff-v0.2](../2026-10-15-algorithm-fullstack-handoff-v0.2/)
- 历史交接 ZIP：[2026-10-15-algorithm-fullstack-handoff-v0.2.zip](../../../docs/handoffs/2026-10-15-algorithm-fullstack-handoff-v0.2.zip)。该文件仅保留历史，10 月 16 日起直接更新仓库源码和文档。
- ZIP SHA-256：`060d1387e218b44fec093c20ddfc320f10f5bb5ed80b70dd704e2581056c4dc4`
- JSON 解析、ZIP 完整性和脱敏扫描均通过。

## 8. 2026-10-15 后续产品体验修复

负责人在工作台体验中指出三个问题，本轮已完成算法/UI 侧最小修复：

1. **访谈自然停顿措辞**：旧模板包含“把这段经历收住”，容易被老人理解成“收住精力”。`naturalPausePrompt` 现在只使用“这段经历先停在这里”“您还愿意继续讲吗，还是今天先到这里”等直接表达；换题兜底也改成“这段先放一放”。历史回归样例保留为历史证据，不改写旧批次。
2. **慢语速和句中停顿**：浏览器 ASR 默认静默缓冲从 1.2 秒调整为 1.8 秒；以逗号、连接词或未完结表达结尾，最多延长到 2.6 秒。实时 Doubao PCM 链路仍由服务端按真实音频流处理，未把 VAD 认知判断混入 ASR 文本整理。
3. **语音发送一致性**：工作台新增“语音发原音频 / 语音转文字”输入链路切换，以及“语音自动发文字 / 语音先看文字”确认方式切换。默认自动发送转写文字，不再把已发送文本残留在输入框；选择先看文字时，转写只进入输入框，用户检查后手动发送。实时 PCM 模式继续发送原始音频到服务端；浏览器兼容模式会明确显示只能转写文字，不把原始音频发送能力假装成已实现。
   文字输入框支持桌面和手机键盘的回车发送；按 Shift+Enter 才保留换行。
4. **助手名称**：当前活动代码中的助手名称统一为“小叙”；历史测试报告中的旧名称不改写。
5. **人生主题**：新增[拾光长河访谈主题优化大纲 v0.1](../2026-10-15-algorithm-fullstack-handoff-v0.2/docs/interview-theme-outline-v0.1.md)。图片可核验的 7 个主题全部保留，并提出第 8 个候选“人生转折与告别”，标记为 `PROPOSED`，在负责人确认前不作为强制主题接线。

## 9. 本轮验证

- `node scripts/voice-realtime-smoke.mjs`：160/160 通过；新增慢语速缓冲、原始音频/转写选择、语音发送模式、回车发送和“小叙”相关静态检查通过。
- `node --experimental-strip-types --test harness/live-baseline/v0.1/algorithm-composition.test.mts harness/live-baseline/v0.1/interview-baseline-offline-acceptance.test.mts harness/live-baseline/v0.1/g5-turn-orchestrator.test.mts`：62/62 通过。
- `npx tsc --noEmit --incremental false`：通过。
- `npm run build`：通过；仅保留既有 ONNX、Browserslist 和 `<img>` 警告。

## 10. 尚未能自动完成的外部配置

- 豆包“男孩/小猪佩奇”音色必须使用控制台实际提供的 `speaker ID`。当前代码保持服务端环境变量可切换，没有猜写一个未经验证的 ID；控制台音色 ID 确认后再做一次真实 TTS 小样本复验。
- 临时公网链接仍需明确允许将本机测试工作台交给第三方隧道服务；Cloudflare Quick Tunnel 的提权审批曾因第三方暴露风险被自动拒绝，未绕过该门禁。

## 11. 当前服务复核（2026-10-15）

上一轮复核时本机候选服务和 Basic Auth 网关均返回 200；本次只读核查时 `127.0.0.1:3100` 已不可达，未在本次核查中发起模型调用。上一轮重启后的健康结果为 `REAL_INTERNAL / ready`，当时进程 `networkCalls=0`（重启会清零进程计数），存储仍为 `process_memory_fictional_only`，正式 `CanonicalMemory` 写入计数为 0；累计账本仍为 295.76 元预留。

负责人通过工作台进行了新的真实模型体验，最新账本为：程序硬上限 400 元、累计预留 295.76 元、剩余 104.24 元、账单 `PENDING`。在没有新授权和反馈前，不再主动扩大付费调用批次。

重建并重启后 `/version` 报告 `pre-human-2026-10-15-candidate-v23`、`g5-real-internal-v0.18`、`interview-policy-v0.3.4`；服务端实际 TTS 仍是 `zh_female_vv_uranus_bigtts`，男孩/小猪佩奇音色需要控制台 Speaker ID 后再切换和复验。

该包仍是候选交接资料，不是生产部署包；源代码需要在目标 Git 分支按 `docs/source-manifest.json` 选择性提交，不能从当前脏工作树执行 `git add .`。

## 12. 费用与模型链路核查（2026-10-15）

负责人提出费用偏高且不使用端到端实时语音。本次核查得到以下结论：

| 项目 | 当前实际配置 | 本阶段是否使用 | 说明 |
|---|---|---:|---|
| 文本模型 | Volcengine Ark，`doubao-seed-2-0-lite-260428` | 是 | 日常聊天、访谈、Memory、故事草稿、画像草稿使用；通过 OpenAI-compatible HTTP 调用。 |
| 独立 ASR | 豆包语音识别 2.0，`volc.seedasr.sauc.duration` | 是 | 只负责把语音转文字；不是端到端实时语音模型。 |
| 独立 TTS | 豆包语音合成 2.0，`seed-tts-2.0` | 是 | 目前音色仍是 `zh_female_vv_uranus_bigtts`；男孩/小猪佩奇 Speaker ID 待负责人提供。 |
| VAD/停顿/打断 | 浏览器采集、停顿计时、服务端状态机和取消旧响应 | 是 | 不是实时大模型；不产生端到端实时语音费用。 |
| 端到端 Realtime | `volc.speech.dialog` | **否** | `.env.local` 中 `DOUBAO_REALTIME_ENABLED=false`，二进制转发也为 `false`；当前账本没有 `realtime` 模块记录。 |

### 为什么账本看起来很贵

当前算法服务的 `reservedCny` 是**调用前的内部预留上限**，不是供应商已经结算的金额。预算实现按模块粗粒度预留：ASR/TTS 每次预留 0.60 元，文本类模块每次预留 0.12 元。它的作用是测试中途遇到重试或账单延迟时仍然有止损边界，所以会明显高估短文本、短音频的实际费用。

当前 `http-current` 账本显示：程序上限 400 元；当前批次预留 260.24 元；既有暴露 35.52 元；累计预留 295.76 元；`actualCostCny=null`、`billingState=PENDING`。因此 295.76 元**不能当作已扣款**。供应商实际账单尚未回填，必须以豆包/火山控制台的用量和账单为准。当前尝试记录中的文本 token 粗略估算合计约 1.42 元，但它标记为 `UNKNOWN`，也不能替代供应商账单；ASR/TTS 的本地估算为空。

当前 `reservations.jsonl` 按模块可追溯的预留上限约为：TTS 143.40 元、ASR 45.00 元、Memory 27.48 元、正式访谈 10.08 元、日常聊天 14.76 元，其余为 Shadow/故事/画像等小额预留，合计 247.32 元。预算文件另外包含 12.80 元的早期音频/ASR 供应商预留和 0.12 元补充诊断记账，所以当前批次显示 260.24 元。高金额主要来自测试轮数和 ASR/TTS 的固定预留，不是端到端实时语音造成的。

后续默认只走模块化链路；不开启 `DOUBAO_REALTIME_ENABLED`，不运行 realtime smoke，不为 realtime 预留费用。若将来需要研究实时模型，必须先由负责人单独批准新的预算和开关。

## 13. 交给全栈前的完成度审计（2026-10-15）

负责人希望把当前真实算法接入产品。当前结论是：**可以交给全栈开始内部 staging 联调，但还不能称为正式产品部署完成。**

### 已完成，可以直接交接

- 本机 `REAL_INTERNAL` 候选服务通过只读健康检查，组件状态为 `ready`，当前 build 为 `pre-human-2026-10-15-candidate-v23`。
- 独立 ASR、文本模型、独立 TTS、访谈策略、Memory 候选、故事草稿、画像草稿和错误/重试语义已经有 HTTP 合同。
- `160/160` 语音契约静态检查、`62/62` 聚焦离线测试、TypeScript 检查和构建已通过。
- 全栈候选阅读包和 ZIP 已生成，当前 ZIP SHA-256 为 `060d1387e218b44fec093c20ddfc320f10f5bb5ed80b70dd704e2581056c4dc4`。

### 还没有完成，不能标记为正式上线

1. **GitHub 远端交付**：交接分支已成功推送，远端分支指向 `5707958`；Pull Request 尚未创建，原因是 GitHub CLI 的 API token 已失效。分支内容已在远端，不需要重新生成或重复上传。
2. **产品后端接入**：全栈尚未完成业务鉴权、家庭/社区角色、会话主体绑定、幂等、限流、超时、错误展示和回滚接线。
3. **正式 Memory**：当前 `storage=process_memory_fictional_only`、`canonicalWriteCount=0`、`canonicalWriteCapability=false`。事务数据库、版本链、权限、撤回/删除、索引和 outbox 仍需全栈实现。
4. **持久部署**：当前本机进程和临时 Basic Auth 网关不是固定 staging；没有固定域名、TLS、进程守护、监控、日志轮换和稳定回滚环境。
5. **临时公网 URL**：尚未拿到可供团队使用的 Cloudflare Quick Tunnel 地址；已有网关未认证访问会返回 401，这是保护行为，不是公网部署完成。
6. **男孩/小猪佩奇音色**：仍等待负责人提供控制台的真实 Speaker ID；当前候选仍使用 `zh_female_vv_uranus_bigtts`。
7. **真人体验门禁**：固定虚构案例的真实模型验证已完成一部分，但内部成年人真人的麦克风、听感、实际打断和 Memory/文章/画像体验尚未完成。

### 推荐交接顺序

```text
候选 HTTP 包交给全栈
  → Fake 联调和页面状态接入
  → REAL_INTERNAL staging 联调
  → 负责人/内部成年人真实体验
  → 按反馈修复并冻结 build/合同
  → CanonicalMemory durable Adapter 与权限联调
  → 固定 staging、监控、回滚
  → 正式发布评审
```

全栈现在可以开始前两步，算法侧不需要等正式 `CanonicalMemory` 完成才开始接口联调；但在第 5～7 项完成前，不应把系统交给真实老人或称为生产版本。

## 14. 访谈与 Memory 算法收口、源码交接（2026-10-15）

本轮完成了算法侧可以独立完成的收口工作，并把源码和文档整理成全栈可审查的隔离快照：

- `npm run check:g4` 通过；该命令串行覆盖 G2/G3/G4，包含访谈策略、Memory 来源/权限/撤回删除、ASR、TTS、故事/画像派生、响应取消和 HTTP 编排测试；进程退出码为 0。
- 修正了 G2 中 I-034 的版本断言：旧 v0.2 话术继续作为冻结对照，当前 `interview-policy-v0.3.4` 使用“您还愿意继续讲吗，还是今天先到这里？”。这记录的是已确认的行为升级，不是回滚或静默改写历史结果。
- 交接目录新增 `algorithm-handoff/sgx-source/`，包含 90 个脱敏源码/离线契约文件，约 1.1 MB；不包含 `.env.local`、API key、原始音频、付费运行目录、生产数据或旧端到端实时语音会话代码。模块化路径是独立 ASR → 文本模型 → 模块化 TTS。
- 组合交接包为 `algorithm-handoff/sgx-algorithm-fullstack-handoff-v0.3.zip`；其 SHA-256 以仓库中的实际文件为准，目标分支的 `git diff --check` 和脱敏扫描均通过。
- 目标分支 `codex/sgx-algorithm-candidate-2026-10-15` 已连续提交 `cfcb851`、`8972d0d`、`7b0993c`、`ccd2f7a`、`5707958`，并已通过 SSH 推送到远端。当前只缺 Pull Request 页面创建；分支本身已完成上传。

这次交付仍是 `candidate/pre-human`。算法侧的 `CanonicalMemoryRepository` 只是后端接入契约，服务运行时仍为 `canonicalWriteCapability=false`、`canonicalWriteCount=0`；数据库事务、家庭/社区权限、持久化、撤回删除、部署和真人体验门禁由全栈与负责人后续完成。


## 15. 算法侧 C1～C12 当前候选复验准备（2026-10-15）

本轮只推进算法侧，不承担前端、数据库、公网和生产运维工作。目标是用当前候选版本重新执行一次固定的 C1～C12 真实模型案例，记录 ASR、智能打断、追问、Memory、故事草稿和基础画像结果，随后根据质量反馈修复并冻结候选版本。

- 运行器：`harness/live-baseline/v0.1/live-canary/run-owner-c1-c12.mjs`
- 运行器版本门禁已更新为：`g5-real-internal-v0.18`、`algorithm-http-v0.1`、`interview-policy-v0.3.4`、`pre-human-2026-10-15-candidate-v23`
- 固定案例：C1～C12，共 13 个子行；仍使用虚构身份和固定输入，不写入正式 `CanonicalMemory`
- 当前预算账本：程序硬上限 400 元；当前批次上限 364.48 元；已预留 260.24 元；账单仍为 `PENDING`
- `node --check harness/live-baseline/v0.1/live-canary/run-owner-c1-c12.mjs`：通过

本机 3100 服务需要提权监听。当前沙箱自动审批连续因模型容量不足未执行启动命令，因此本轮尚未发起新的真实模型调用，也没有把历史 v19 结果冒充为 v23 结果。服务恢复后，按以下顺序执行：只读 `/health`、`/version` → 运行 C1～C12 → 保存每轮原话、回复、等待、Memory、故事/画像、打断和费用记录 → 质量评审 → 定向修复 → 冻结版本。

## 16. Gitee 交付目标确认

负责人确认 Gitee 沿用 `aicreate369/shiguang-auto-classification`。本地全栈交接 checkout 已添加 `gitee` 远端，但本轮尚未推送中间版本；推送将放在当前候选完成 C1～C12、修复、复验并冻结后一次性执行。Gitee 与 GitHub 账号名称相同不等于本机已具备 Gitee 推送凭据，推送前仍需验证远端登录状态。

## 17. 控制轮与故事/画像定向复验（2026-10-15）

### 17.1 本轮目的

上一轮真实模型定向复验已经证明故事和画像可以生成，但暴露了两个需要收口的问题：

1. 进入访谈、换题、暂停后继续等控制语句仍会无必要地触发 Memory 模型；即使后置治理会把候选变成会话级，也会增加成本和失败噪声。
2. 测试记录器用“最后一条 Memory 诊断”填写没有 Memory 任务的轮次，导致把上一轮来源误挂到换题/继续轮，产生来源纯度误报。

本轮只修复这两个边界，不改变已确认的 InterviewPolicy 行为，不把模型输出写入正式 `CanonicalMemory`。

### 17.2 实现与离线验证

- `src/lib/derived-artifact-runtime/runtime.ts`：将 `life_event_detail` 纳入故事普通来源资格。模型把具体访谈细节标成此类型时，可以进入故事草稿；它仍不会因此自动进入基础画像。
- `src/lib/algorithm-service/composition.ts`：增加纯控制语句识别。纯进入访谈、换题、继续语句直接跳过 Memory 调用；混合了真实事实或明确故事/画像请求的输入仍按原链路处理。
- `src/app/api/algorithm/v0.1/_shared/runtime.ts`：运行时缓存版本从 V24 升到 V25，保证 Next 开发服务热加载后使用新组合实例。
- `harness/live-baseline/v0.1/live-canary/run-owner-control-memory-revalidation.mjs`：Memory 诊断按当前 `evidenceId` 关联，避免复用上一轮结果。
- 新增 `ST01B-LIFE-EVENT-DETAIL` 派生来源回归测试，并补充控制轮不产生异步 Memory 任务的断言。

验证命令及结果：

```text
node --experimental-strip-types --test \
  harness/live-baseline/v0.1/algorithm-composition.test.mts \
  harness/live-baseline/v0.1/g2-real-provider-regressions.test.mts \
  harness/live-baseline/v0.1/g4-derived-artifact-runtime.test.mts
74/74 passed
npx tsc --noEmit --incremental false                 passed
git diff --check                                      passed
```

### 17.3 最新真实模型证据

运行目录：

`harness/live-baseline/v0.1/.local-runs/owner-control-memory-2026-10-15T11-42-58.814Z-5ee064c2`

这是负责人定向复验，不是独立质量评估；使用固定虚构身份和固定文本，不包含真人麦克风输入。

| 轮次 | 结果 | 关键证据 |
|---|---|---|
| T1 进入访谈 | 完成，TTS 成功 | 无 Memory 任务、无持久候选 |
| T2 人生事实 | 完成，TTS 成功 | 1 条事实候选提交并激活，来源为本轮原话 |
| T3 换题 | 完成，Policy 直接回复 | 无 Memory 任务、无控制内容沉淀 |
| T4 暂停后继续 | 完成，TTS 成功 | 无 Memory 任务、无控制内容沉淀 |
| T5 稳定偏好 | 完成，TTS 成功 | 2 条偏好候选提交并激活 |
| T6 故事+画像请求 | 完成，TTS 成功 | STORY 与 PROFILE 均成功；故事只引用工作事实，画像只引用两个明确偏好 |

自动检查为 `TARGETED_CHECKS_PASS_REVIEW_PENDING`，其中 `storyAndProfileProduced=true`、`derivedSourcesExcludeControls=true`、`canonicalWriteCount=0`。T6 的可见回复仍是达到追问深度后的自然停顿确认；故事和画像在工作台异步结果中分别展示，不能把这轮理解为真人体验结论。

### 17.4 费用与当前边界

本轮后健康账本显示：程序硬上限 400 元，累计预留 335.24 元，剩余 64.76 元，`actualCostCny=null`、账单仍为 `PENDING`。预留额是内部止损上限，不是供应商已结算金额；正式 `CanonicalMemory` 仍未写入。

此前完整 C1～C12 真实模型基线为 12 场景、13 子项执行，不等于 13 次模型成功；本轮变更只影响 Memory 计划与派生来源资格，因此采用影响范围定向复验，没有重复整批调用。ASR 合成输入、TTS、生成前取消、幂等和结束会话沿用完整基线证据；最新 C10 首字/首音均为空，不能证明播放中物理打断。真人设备验收仍未完成。

## 18. 当前冻结前清单

算法候选的实现和固定虚构案例验证已达到可交接状态，但仍有三项不能省略：

1. 负责人对最新访谈追问、等待、Memory、故事和画像做人工质量评审；当前报告仍是 `REVIEW_PENDING`。
2. 需要完成真实成年人设备体验，重点是麦克风 ASR、说话较慢时的智能打断、首音等待、播放中取消和听感；这不是本轮 HTTP 固定文本复验覆盖的内容。
3. 按负责人后续要求，将本轮源码、测试、脱敏记录和交接说明直接更新到 Gitee；沿用现有分支并正常合并，不再生成 ZIP。核对文件清单和远端提交后才能称为交付完成。正式 `CanonicalMemory`、产品鉴权和持久化仍属于全栈接入边界。
