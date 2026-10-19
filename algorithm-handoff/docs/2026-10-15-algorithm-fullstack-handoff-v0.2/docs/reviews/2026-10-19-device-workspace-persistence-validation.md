# SGX 设备测试工作区持久化与公网入口验证报告（2026-10-19）

> 结论：设备工作区、算法 Memory 快照、故事/画像、反馈与隔离导出已经完成本机实现，并通过刷新、进程重启和一次真实豆包跨重启检索。当前随机 `trycloudflare.com` 入口可访问，但固定公网域名仍需 Cloudflare Named Tunnel 的域名和一次登录授权。
> 版本：`pre-human-2026-10-19-candidate-v24.5-device-persistence`
> 边界：内部真人体验候选；正式 `CanonicalMemory` 写入继续关闭。

## 1. 用户可见结果

1. 每个浏览器设备首次进入工作台时，由服务端建立独立测试工作区。
2. 刷新页面后恢复本设备的原话、回复、轮次、点赞/点踩、团队评审、Memory、故事和画像。
3. 算法服务重启后，保留已经完成的 Evidence、受治理 Memory 和派生产物；正在进行的 ASR、LLM、TTS 不恢复执行。
4. 工作区导出只包含当前设备的资料、算法版本、预算摘要和该设备会话的成本明细。
5. 原始音频、ASR partial、Base64 音频、Cookie、设备明文凭证、API Key、服务器路径和全局成本账本不进入工作区快照或导出。
6. 删除测试工作区时，原始 Evidence 立即停止使用，依赖的 Memory 和故事/画像通过同一撤回链路变成无正文 tombstone；正式家庭 Memory 不在本接口范围内。

## 2. 为什么不用 IP 作为 Memory 身份

家庭、社区和办公室可能有多人共用一个公网 IP；同一设备也会在 Wi-Fi、流量和 VPN 之间切换。按 IP 恢复会造成两类严重错误：把甲的资料展示给乙，或换网络后找不到自己的资料。

当前身份链路为：

```text
Basic Auth 公网门禁
  → 服务端随机设备凭证（HttpOnly / SameSite=Strict Cookie）
  → 数据库只保存 SHA-256
  → 稳定 actorId / subjectId / familySpaceId
  → 会话、Memory、故事画像、反馈和成本
```

IP 只用于脱敏成本统计和诊断，不参与资料授权、合并或找回。

## 3. 存储结构与边界

```text
SQLite TestWorkspaceStore
├─ 设备工作区：UI资料、revision/CAS、40天到期
├─ 会话归属：阻止其他设备访问 session/view/turn/ASR/interrupt/end
└─ 算法状态快照
   ├─ Final Evidence（保留原到期时间）
   ├─ Reference Store / governed Memory
   └─ Story/Profile 派生产物
```

- SQLite 使用 WAL、事务、`busy_timeout`、`secure_delete` 和文件权限 `0600`。
- 双标签页使用 revision/CAS；发生 `409` 时前端先读取当前版本、合并评审资料，再重试，不能静默覆盖。
- 同一设备的旧算法 session 在进程重启后失效，但页面历史保留；下一句话自动建立新 session，并沿用同一受控主体检索 Memory。
- `storage.durable=true` 只表示内部测试 SQLite backing 已接通；`canonicalWriteCapability=false` 始终保持。

## 4. 验证证据

### 4.1 自动化门禁

| 检查 | 结果 | 覆盖内容 |
|---|---:|---|
| `test-workspace-store.test.mts` | 10/10 | 重启恢复、同 IP 双设备隔离、伪造 token、CAS、导出、删除、40 天到期、算法快照损坏拒绝 |
| `workspace-api.test.mts` | 2/2 | Cookie、稳定 authority、session owner、成本隔离、删除传播、导出 |
| `algorithm-lab-workspace-ui.test.mts` | 4/4 | 页面恢复、自动保存、冲突合并、导出前保存、旧 session 轮换 |
| `evidence-store-persistence.test.mts` | 5/5 | Evidence 重启、期限不延长、撤回不可复活、ASR partial 不落盘 |
| `algorithm-composition-persistence.test.mts` | 3/3 | Memory/画像跨进程恢复、权限隔离、工作区删除后不可恢复 |
| `algorithm-composition.test.mts` | 37/37 | 访谈、Memory、身份、控制动作和派生产物回归 |
| `cost-ledger.test.mts` | 3/3 | 设备成本只含绑定会话 |
| `cloudflare-deployment-config.test.mts` | 3/3 | 只代理 3200、404 兜底、无凭据模板 |
| `macos-service-config.test.mts` | 2/2 | standalone 运行副本、回环监听、无凭据 LaunchAgent 配置 |
| TypeScript | 通过 | `tsc --noEmit --incremental false` |
| Next standalone 生产构建 | 通过 | `next build` exit 0；算法工作台与全部 v0.1 workspace 路由生成成功 |

### 4.2 零模型调用重启验收

流程为“建立设备工作区 → 保存虚构 UI 资料 → 停止 3100 → 重新启动同一生产构建 → 用原设备 Cookie 恢复 → 导出 → 删除测试记录”。结果：

```json
{"restoredAfterRestart":true,"exportAfterRestart":true,"cleanup":true}
```

### 4.3 真实豆包跨重启 Memory 验收

固定虚构输入：

> 我叫林国强，今年七十二岁，平时喜欢听越剧。

第一进程成功生成并显示两条受治理 Memory，其中偏好为“林国强平时喜欢听越剧”。停止并重新启动算法服务后：

- 页面恢复原话、AI 回复和 Memory；
- 旧 session 被识别为失效，历史没有丢失；
- 下一句话自动建立新 session；
- 输入“你还记得我平时喜欢听什么吗？”；
- 新进程真实回复：“您平时喜欢听越剧呀。您今天想选哪段越剧来听呀？”

这证明当前实现不只是恢复浏览器文字，而是新算法 session 实际检索了重启前的 Memory。两轮合计使累计保守预留从 `427.88` 增至 `429.44` 元；`actualCostCny` 仍为 `null / PENDING`，不是供应商真实账单。

### 4.4 公网边界验收

当前 Quick Tunnel 复验：

- 未认证访问：HTTP `401`；
- 使用内测账号密码：HTTP `200`；
- 页面包含新版 `SGX 真人测试工作台`，首个 Next.js 静态脚本返回 `200`；
- 公网请求必须先 bootstrap，之后的会话、成本和导出按设备隔离。

### 4.5 本机服务自动恢复验收

- production standalone 运行副本部署在 `~/Library/Application Support/SGX/releases/`，`current` 只指向当前候选 release；
- 测试 SQLite、费用账本和受治理 Memory 放在 release 之外的私有 data 目录，更新代码不会覆盖资料；
- provider 配置放在权限 `0600` 的 `~/.config/sgx/provider.env`，不写入 release、plist 或 Git；
- 3100 算法服务和 3200 密码网关已经安装为当前用户的 LaunchAgent；
- 强制重启两个 LaunchAgent 后，PID 均更新，`runs=2`、端口恢复监听、`/health` 重新返回 `ready / REAL_INTERNAL`；
- 同一次 Quick Tunnel 在上游网关重启后恢复：未认证 `401`、认证 `200`；本次检查没有调用模型。

## 5. 尚未完成的固定公网入口

当前 Quick Tunnel 地址仍是随机临时地址，不能被描述为固定或长期稳定。项目已提供 Named Tunnel 配置、检查和回滚说明：

- [稳定入口说明](../../deploy/cloudflare/README.md)
- [无凭据配置模板](../../deploy/cloudflare/config.yml.example)

完成固定入口还需要负责人提供一个已经接入 Cloudflare DNS 的测试子域名，并在本机浏览器完成一次 `cloudflared tunnel login`。固定域名解决地址变化和 Tunnel 自动重连；本机休眠、关机或断网仍会中断。若要求 24 小时在线，应将同一构建、网关和数据库迁到受控云主机。

## 6. 当前限制

- Node 22 内置 `node:sqlite` 在运行时仍显示 ExperimentalWarning；本轮类型、构建、重启和数据完整性测试均通过，但它目前只定位为单机内测存储。
- 尚未设计清除浏览器 Cookie 后的跨设备找回；不能用 IP 自动合并。正式产品应交给家庭账号绑定和后端权限系统。
- 正式 `CanonicalMemory` 的数据库、家庭角色权限、跨设备同步和生产备份仍由全栈后端负责，本次没有把测试 SQLite 冒充为生产权威记忆。
