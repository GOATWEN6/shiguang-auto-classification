# 当前候选版本补充说明（更新于 2026-10-19）

本文件覆盖交接目录中较早版本、预算和持久化描述。运行时仍以实际 `/health` 与 `/version` 返回为准。

## 当前版本

- 状态：`candidate/pre-human`
- Build：`pre-human-2026-10-19-candidate-v24.5-device-persistence`
- API：`algorithm-http-v0.1`
- 服务：`g5-real-internal-v0.18`
- InterviewPolicy：`interview-policy-v0.3.5`
- 助手默认名称：`小叙`
- 语音链路：独立流式 ASR → 文本模型 → 模块化 TTS
- `deviceWorkspaceDurable=true`
- `governedMemoryDurable=true`
- `canonicalWriteCapability=false`

## 本轮新增能力

1. 浏览器首次进入后建立独立设备测试工作区；刷新后恢复原话、回复、反馈、Memory、故事和画像。
2. SQLite 保存完成 Evidence、受治理 Memory 和派生草稿；算法服务重启后，新 session 可以检索重启前的有效 Memory。
3. 公网 session、turn、ASR、view、interrupt、end 都校验工作区与会话归属，防止同一 IP 的不同设备串档。
4. 当前设备支持 JSON 导出；原始音频、ASR partial、Cookie、凭据、服务器路径和全局成本账本不进入导出。
5. 新增 standalone 构建、macOS LaunchAgent 和 Cloudflare Named Tunnel 无凭据模板。

## 预算快照（2026-10-19）

- 累计测试上限：800 元
- 当前批次上限：764.48 元
- 批次已预留：393.92 元
- 历史前置预留：35.52 元
- 累计保守预留：429.44 元
- 剩余可预留：370.56 元
- 实际账单：`null / PENDING`

“预留”是防止超预算的保守上界，不是供应商已出账金额。同步代码和文档没有新增付费调用。

## 证据边界

- 设备工作区 10/10、Evidence 5/5、组合持久化 3/3、工作台恢复 4/4、费用隔离 3/3、Cloudflare 3/3、macOS 2/2 通过。
- 组合层回归 37/37，TypeScript 和 standalone 构建通过。
- 固定虚构资料的真实豆包跨重启 Memory 检索成功；这不是老人真人效果验证。
- Quick Tunnel 已证明临时可访问，但地址会变化；固定域名仍需 Cloudflare Named Tunnel 与受控域名。
- 正式家庭认证、跨设备账号绑定、生产数据库、备份和正式 CanonicalMemory Adapter 尚未完成。

详细证据见 [设备持久化验证](./reviews/2026-10-19-device-workspace-persistence-validation.md)。

## 全栈接入重点

1. 先接 `/health`、`/version` 和 workspace bootstrap。
2. 公网请求必须携带服务端签发的 HttpOnly 工作区 Cookie。
3. 前端区分测试持久化资料、受治理 Memory 与正式 CanonicalMemory。
4. 产品后端接管家庭账号、角色权限、生产事务库、跨设备恢复和备份。
5. 不把模型候选、测试 SQLite 或 IP 当成产品权威身份与长期记忆。
