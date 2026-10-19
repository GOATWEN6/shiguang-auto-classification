# SGX 访谈、Memory 与模块化语音候选源码

状态：`candidate/pre-human`
当前 build：`pre-human-2026-10-19-candidate-v24.5-device-persistence`

本目录提供算法工作台、版本化 HTTP 接口、InterviewPolicy、受治理 Memory、故事/画像草稿、独立 ASR、文本模型、独立 TTS、设备测试工作区持久化及本机部署脚本。算法链路固定为：

```text
浏览器采集语音
  → 独立流式 ASR
  → 输入整理与 InterviewPolicy
  → 豆包文本模型
  → Memory 候选/检索与故事画像草稿
  → 独立模块化 TTS
```

不使用端到端实时语音模型。浏览器不持有供应商凭据。

## 本地启动

要求 Node.js 22：设备测试工作区使用 Node 22 内置 `node:sqlite`。

```bash
npm ci
npm run prepare:vad
cp .env.example .env.local
npm run dev -- -p 3100
```

打开 `http://127.0.0.1:3100/algorithm-lab`。机器检查入口：

- `/api/algorithm/v0.1/health`
- `/api/algorithm/v0.1/version`

默认配置为 `LOCAL_FAKE`、额度 0，不调用供应商。真实模式只在服务端 `.env.local` 或 secret storage 配置模型凭据；启动后必须先检查 health/version 的模式、build、预算和 `canonicalWriteCapability`。

## 持久化和 Memory 边界

当前内部测试实现会为每个浏览器设备签发 HttpOnly 工作区 Cookie，并用 SQLite 保存：

- 原话、回复、点赞/点踩和团队评审；
- 完成轮次、受治理 Memory、故事和画像；
- 设备工作区的会话归属及费用摘要。

默认数据库位于运行目录的 `harness/live-baseline/v0.1/.local-runs/http-current/`，不进入 Git。刷新和算法服务重启后可以恢复已完成内容；正在执行的 ASR、LLM 或 TTS 不续跑。

这仍不是正式家庭权威库：`canonicalWriteCapability=false`。正式 `CanonicalMemory` 的产品数据库、家庭权限、跨设备绑定、事务、备份、撤回和删除由全栈后端实现。IP 只用于脱敏费用诊断，不能用作 Memory 身份。

工作区接口：

```text
POST   /api/algorithm/v0.1/workspaces/bootstrap
GET    /api/algorithm/v0.1/workspaces/current
PUT    /api/algorithm/v0.1/workspaces/current
GET    /api/algorithm/v0.1/workspaces/current/export
DELETE /api/algorithm/v0.1/workspaces/current
```

## 验证

```bash
npm run test:handoff
npm run typecheck
npm run build
```

当前 v24.5 已验证设备工作区、Evidence、Memory/画像跨进程恢复、费用隔离、macOS standalone 部署和 Cloudflare 配置。详细证据见：

本仓库交付副本的 `test:handoff` 共 113 项，全部通过；TypeScript 检查和 standalone 构建通过。构建保留 ONNX 动态依赖、Browserslist 数据陈旧和 React Hook 依赖提示，均未造成构建失败。

- `../docs/2026-10-15-algorithm-fullstack-handoff-v0.2/docs/reviews/2026-10-19-device-workspace-persistence-validation.md`
- `../docs/2026-10-15-algorithm-fullstack-handoff-v0.2/docs/execution/2026-10-19-stable-public-and-device-workspace-plan.md`

真实模型验证使用固定虚构资料；真实老人体验、手机设备、物理播放中打断、生产认证和正式 CanonicalMemory 仍需后续门禁。

## 部署入口

- `deploy/macos/`：standalone release、LaunchAgent、私有环境文件和回滚说明。
- `deploy/cloudflare/`：Cloudflare Named Tunnel 的无凭据模板。Quick Tunnel 仅用于临时体验；固定域名需要受控 Cloudflare 域名与一次登录授权。
- `scripts/public-test-gateway.mjs`：Basic Auth 内测网关，只代理本机算法服务。

不得提交 `.env.local`、API Key、原始音频、`.local-runs`、设备数据库、真人资料或 Cloudflare 凭据。

## VAD 资源

`prepare:vad` 只从 lockfile 对应的已安装依赖复制浏览器资源，不下载模型、不调用付费 API。`@ricky0123/vad-web` 的包元数据许可为 ISC，`onnxruntime-web` 为 MIT；正式再分发前仍需接入方独立确认随包 Silero 模型的归属和许可。
