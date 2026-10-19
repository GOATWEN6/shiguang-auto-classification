# SGX 稳定公网入口与设备测试工作区方案（2026-10-19）

> 状态：`IMPLEMENTED_AND_VERIFIED / NAMED_TUNNEL_EXTERNAL_INPUT_PENDING`
> 范围：内部真人体验工作台；不等于正式家庭账号系统或正式 `CanonicalMemory`。
> 上游：[10 月 19 日执行记录](./2026-10-19-execution-log.md) · [银发 AI 相框 PRD](../../银发AI相框-PRD:MVP.md)

## 1. 本轮要解决的问题

1. 当前 `trycloudflare.com` Quick Tunnel 地址会失效或变化，团队无法持续使用同一个入口。
2. 当前会话、Memory、画像、故事、点赞和评审主要在进程或浏览器内存中，刷新、重启或换临时域名后可能丢失。
3. 当前导出由浏览器现场拼装，并包含全局成本表；多测试者后可能把别人的脱敏成本标识带入导出包。

## 2. 已冻结的设计原则

### 2.1 设备身份不用 IP

IP 只用于脱敏成本统计和安全诊断，不用于资料归属、恢复或授权。家庭、社区和公司网络会多人共用一个公网 IP；手机切换 Wi-Fi、流量或 VPN 后 IP 又会变化。以 IP 作为 Memory 身份会串档或丢档。

内部测试改用服务端签发的高熵设备工作区凭证：

```text
共享 Basic Auth 外层门禁
  → 服务端签发随机设备凭证（HttpOnly Cookie）
  → testerWorkspaceId
  → 稳定 subjectId / familySpaceId
  → 会话、原话、Memory、画像、故事、反馈
```

数据库只保存设备凭证哈希，不保存明文凭证。知道共享 Basic Auth 密码不等于能查看另一个设备工作区。跨设备恢复未来使用显式恢复码或正式家庭绑定，绝不按 IP 自动合并。

### 2.2 测试持久化不冒充正式 CanonicalMemory

本轮建立 `TestWorkspaceRepository`，用于内部测试资料跨刷新和跨服务重启恢复。正式 `CanonicalMemory` 仍由业务后端掌握授权、事务、家庭权限、版本、撤回与删除；算法不能直接获得生产数据库权限。

工作台必须同时显示：

- 测试资料是否已经持久保存；
- 正式 `CanonicalMemory` 写入能力是否关闭。

### 2.3 原始材料与长期结构化 Memory 分层

- 原始音频、转写、模型输出和诊断材料继续遵守 40 天到期。
- 低风险、通过规则的结构化测试 Memory 可以在测试工作区内跨会话复用，但保留来源、版本、确认状态、权限和撤回信息。
- 敏感 Memory 不能因“持久化”而自动升级为已确认长期权威记忆。
- 撤回后立即停止普通检索、故事、画像和导出；删除后只保留无正文审计记录。

## 3. 数据与接口

### 3.1 单机内部测试存储

当前单机阶段使用 Node 22 自带 SQLite，开启 WAL、事务、幂等和 revision/CAS，不新增生产依赖。开发态数据库位于 `.local-runs`；后台生产运行副本将同一目录映射到 `~/Library/Application Support/SGX/data/http-current`，权限仅当前用户可读写，不进入 Git，更新 release 时不会覆盖。

首版保存：

- 工作区和设备凭证哈希；
- 稳定的测试 `actorId / subjectId / familySpaceId`；
- 会话归属和已完成轮次；
- 有效 Evidence、Memory 候选/状态/版本；
- 故事、画像、最终成文；
- 点赞、点踩和团队评审；
- 算法版本、时间和当前工作区的费用摘要。

不保存或不导出：API Key、Basic Auth、设备明文凭证、明文 IP、服务器绝对路径、ASR partial。原始音频默认不进入导出。

### 3.2 工作区接口

```text
POST   /api/algorithm/v0.1/workspaces/bootstrap
GET    /api/algorithm/v0.1/workspaces/current
PUT    /api/algorithm/v0.1/workspaces/current
GET    /api/algorithm/v0.1/workspaces/current/export
DELETE /api/algorithm/v0.1/workspaces/current
```

所有公网 session、view、turn、stream、ASR、interrupt 和 end 请求都校验工作区与会话归属。直接本机的固定自动化脚本保持兼容，但不能通过公网网关绕过工作区校验。

### 3.3 恢复语义

- 刷新页面：恢复同一工作区的消息、Memory、画像、故事和反馈，若旧算法 session 仍有效则继续使用。
- 服务重启：恢复已完成内容和 Memory；正在运行的 ASR、模型生成、TTS 标为中断，不恢复执行；同一主体建立新 session。
- 清除 Cookie：不能根据 IP 自动找回；需要恢复码或正式家庭绑定。
- 两个标签页并发写入：使用 revision/CAS；冲突返回 `409`，不能静默覆盖。

## 4. 稳定公网入口

当前推荐：

```text
固定域名
  → Cloudflare Access（团队邮箱或一次性验证码）
  → Cloudflare Named Tunnel（自动重连）
  → 127.0.0.1:3200 认证网关
  → 127.0.0.1:3100 算法服务
```

Named Tunnel 解决固定地址和隧道自动恢复，但本机休眠、断网或关机时仍不可访问。若要求全天在线，再将相同服务和持久数据库迁到独立云主机。

稳定入口启用前只缺一个外部条件：负责人提供一个已经接入 Cloudflare DNS 的域名，并在浏览器完成一次 Cloudflare Tunnel 登录授权。项目内配置不得保存 Cloudflare Token。

本机可恢复部分已经完成：算法服务和密码网关使用 standalone release 与 macOS LaunchAgent，异常退出或重新登录后自动拉起；强制重启复验已通过。它提高本机进程稳定性，但电脑休眠、关机、断网以及 Quick Tunnel 随机地址仍属于公网可用性限制。

## 5. 验收门禁

1. 同一浏览器刷新后恢复自己的完整资料。
2. Next 服务重启后，同一设备的新 session 能看到并调用重启前的有效 Memory。
3. 同一 IP 的两个设备工作区互不可见；同一设备换 IP 后仍能恢复。
4. 篡改设备凭证或访问别人的 session 返回 `401/403`。
5. 工作区 A 的 API 与导出不出现工作区 B 的任何内容或成本标识。
6. 导出 JSON 可解析，包含 manifest、版本、哈希和当前工作区资料，不包含凭据、明文 IP、服务器路径和默认音频。
7. 撤回、删除、40 天到期和备份恢复均不能复活已失效内容。
8. Fake 模式先通过重启、隔离、并发和导出测试；最后只做一次真实模型“形成 Memory → 重启 → 新轮实际调用”定向验证。

## 6. 开源与官方依据

| 项目/文档 | License/性质 | 使用范围 | 边界 |
|---|---|---|---|
| [cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 | Named Tunnel、TLS、自动重连 | 只负责传输，不接触模型密钥和业务权限 |
| [Cloudflare Quick Tunnel](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) | 官方文档 | 证明当前随机域名只适合临时演示 | 不作为稳定入口 |
| [Cloudflare macOS service](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/) | 官方文档 | 登录/开机后自动运行 | 本机离线时仍不可用 |
| [SQLite](https://www.sqlite.org/copyright.html) | Public Domain | 单机内部测试的事务持久化 | 不直接下发浏览器，不冒充生产数据库 |
| [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting) | 官方文档 | production build 与反向代理部署依据 | 不把 API Key 暴露浏览器 |
