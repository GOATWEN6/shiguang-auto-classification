# SGX 执行记录：恢复临时公网入口并澄清新增测试（2026-10-19）

> 状态：`device_workspace_verified / local_services_supervised / quick_tunnel_available / named_tunnel_input_pending / candidate_pre_human`
> 当前主线：持久化真人体验资料并把临时公网入口升级为固定域名。
> 上一份执行记录：[10 月 18 日执行记录](./2026-10-18-execution-log.md)
> 产品事实源：[银发 AI 相框 PRD](../../银发AI相框-PRD:MVP.md)

## 1. 当前目标

恢复带密码保护的临时公网算法工作台，使负责人能继续体验真实 ASR、文本模型、TTS、Interview、Memory 和故事画像链路；同时明确本轮新增测试的范围，避免把自动化回归、真实模型定向复验和真人设备体验混为一谈。

## 2. 为什么现在做

10 月 18 日的 Cloudflare Quick Tunnel 临时域名已无法解析。检查证明本机 3100 算法服务和 3200 密码网关仍在运行，失效的是无稳定性保证的临时域名，不是算法服务故障。负责人同时询问新增了哪些测试，因此本日只恢复入口并整理既有新增证据，没有扩大付费测试规模。

## 3. 当日执行总表

| 状态 | 工作 | 做了什么 | 为什么 | 证据 |
|---|---|---|---|---|
| `done` | 本机服务检查 | 3100 `/health` 返回 200；3200 未认证访问返回 401 | 确认算法与密码网关仍可用 | 本日只读连通性检查 |
| `done` | 临时公网入口恢复 | 停止失效隧道，创建新的 Cloudflare Quick Tunnel | 旧 Quick Tunnel 域名已被回收 | 新入口见本文第 4 节 |
| `done` | 公网边界验证 | 未认证工作台 401；认证工作台 200；非白名单 `/voice-assistant` 404；公网 `/version` 为 v24.4 | 证明密码保护和开放范围未被绕过 | `pre-human-2026-10-18-candidate-v24.4-identity-interrupt-profile` |
| `done` | 临时密码调整 | 按负责人要求启用六位密码兼容模式；默认 12 位限制保持不变；公网复验为未认证 401、认证 200 | 降低团队临时内测输入负担，同时不改变正式默认规则 | `scripts/public-test-gateway.mjs` |
| `done` | 测试证据核对 | 核对身份问答、画像来源和真实豆包 6 轮定向脚本 | 回答“增加了什么测试”并保留证据分层 | `harness/live-baseline/v0.1/` 与对应 `.local-runs` |

## 4. 当前公网入口

- 地址：`https://holdem-wife-scroll-citizenship.trycloudflare.com/algorithm-lab`
- 用户名：`sgx-team`
- 密码未写入文档或日志，已重新复制到负责人本机剪贴板。
- 该地址依赖本机 3100、3200 和本次 Cloudflare 隧道进程；电脑休眠、网络变化或进程结束后会失效。它用于临时内部体验，不是持久云部署。

## 5. 新增测试及证据边界

### 自动化回归

- `algorithm-composition.test.mts` 新增身份语义测试：区分“我是谁”“你是谁”“我问你我是谁，不是你是谁”；限制“小叙”只在首轮或直接询问助手身份时自我介绍；模型违反时触发输出门禁。
- 同一文件新增纯画像请求测试：复用已治理的 Memory，只调度 `PROFILE`，不把“生成画像”这条 UI 指令当成新 Memory。
- `g4-derived-artifact-runtime.test.mts` 新增画像来源测试：有直接依据的 `relationship` 可进入社会关系画像，单次 `life_event` 不能被推成稳定性格或爱好。
- 上述两个聚焦测试集分别为 37/37 和 33/33 通过；这证明代码回归，不等于真人体验通过。

### 真实模型定向复验

- 新增固定虚构案例脚本 `live-canary/run-http-identity-profile-v24-4.mjs`，使用真实豆包链路执行 6 轮：首轮问候、普通重阳节叙述、“我是谁”、“你是谁”、越剧偏好形成 Memory、纯画像生成。
- 结果为 6/6 完成、TTS 6/6 成功、自动检查无失败；正式 `CanonicalMemory` 写入仍为 0。
- 原始证据：`harness/live-baseline/v0.1/.local-runs/http-identity-profile-v24-4-2026-10-18T15-24-02.558Z-7ae0ef4c/summary.json`。
- 状态仍是 `TARGETED_CHECKS_PASS_OWNER_REVIEW_PENDING`，因为模型回复质量和真人操作体验仍需负责人判断。

### 浏览器体验检查

- 空闲点击“停下”不再产生虚假的中断提示。
- 输入“我平时喜欢听越剧”后点击“生成画像”，界面能显示 `preferences.music=听越剧`、来源数量和状态。
- 当前没有新增一轮覆盖所有场景的 24 轮测试，也没有声称慢速老人真实语音、物理播放中打断或老人样本已经通过。

## 6. 预算与持久化边界

- 恢复公网入口和本日连通性检查没有调用模型，不产生新的模型调用预留。
- 当前账本累计预留 `427.04/800` 元，剩余 `372.96` 元；`actualCostCny=null / PENDING`，该数字是调用前保守预留，不是供应商真实账单。
- 当前链路仍是独立 ASR、豆包文本模型和独立 TTS，没有启用端到端实时语音模型。
- `canonicalWriteCount=0`；当前真人工作台展示的是候选/进程内 Memory 与派生产物，正式权威记忆持久化仍未开启。

## 7. 下一步

1. 按[稳定公网入口与设备测试工作区方案](./2026-10-19-stable-public-and-device-workspace-plan.md)实现设备隔离、SQLite 持久化、恢复和单工作区导出。
2. 完成 Fake 重启、同 IP 双设备隔离、越权、并发和导出门禁，再做一次真实模型跨重启 Memory 定向验证。
3. 配置固定域名的 Named Tunnel；负责人只需提供已接入 Cloudflare DNS 的域名并完成一次登录授权。
4. 稳定入口和持久化门禁通过后，再继续真人体验，重点判断“小叙”身份、追问节奏、慢速停顿、中断提示和画像可用性。

## 8. 设备工作区持久化继续执行结果

本日后续已完成并验证：

- 服务端随机设备凭证、HttpOnly Cookie、SQLite WAL/CAS 与 40 天到期；
- 公网 session、view、turn、stream、ASR、interrupt、end 的设备归属校验；
- Evidence、governed Memory、Story/Profile 的跨进程恢复；
- 页面消息、轮次、点赞/点踩、团队评审、当前 Memory/故事/画像的自动保存与恢复；
- 本设备隔离导出和本设备成本过滤；
- 删除工作区时把 Evidence、Memory 和派生产物一起送入撤回/删除链路；
- TypeScript、聚焦自动化和 Next 生产构建通过；
- 虚构案例完成一次真实豆包“形成 Memory → 重启服务 → 新 session 检索 Memory”复验。

真实复验后累计保守预留为 `429.44/800` 元，`actualCostCny=null / PENDING`。详细证据见[设备测试工作区持久化与公网入口验证报告](../reviews/2026-10-19-device-workspace-persistence-validation.md)。

当前随机 Quick Tunnel 已复验为未认证 `401`、认证 `200`，但它仍不是固定稳定域名。固定入口的剩余外部条件只有：Cloudflare DNS 域名和一次浏览器登录授权。

## 9. 本机后台守护与独立数据目录

为避免 macOS LaunchAgent 无法直接读取 `Documents`，本日继续完成了以下部署收尾：

- `next.config.js` 启用 standalone production 构建；
- 当前候选发布到 `~/Library/Application Support/SGX/releases/pre-human-2026-10-19-candidate-v24.5-device-persistence`；
- `current` 符号链接指向当前 release，后续更新可保留旧 release 回滚；
- 测试 SQLite、费用账本、Evidence、Memory、故事画像保存在 release 外的私有 data 目录；
- provider 配置复制到权限 `0600` 的私有配置文件，plist、源码和日志不保存凭据；
- 3100 算法服务与 3200 密码网关安装为当前用户 LaunchAgent。

强制重启复验中，两个进程 PID 均变化并自动恢复，3100 `/health` 返回 `ready / REAL_INTERNAL`，持久化状态为 `deviceWorkspaceDurable=true`、`governedMemoryDurable=true`、`canonicalWriteCapability=false`；公网入口再次复验为未认证 `401`、认证 `200`，页面标识和 Next.js 静态脚本也正常返回。该复验没有调用付费模型，累计保守预留仍为 `429.44/800` 元。

固定且更稳定的公网 URL 仍需 Cloudflare 托管子域名与一次登录授权；本机守护已经完成，不再依赖手工保持 3100/3200 终端窗口。
