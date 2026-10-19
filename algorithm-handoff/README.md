# SGX 访谈与 Memory 算法交接快照

本目录是给全栈工程师的**脱敏源码、接口合同和验证证据**。当前候选 build 为 `pre-human-2026-10-19-candidate-v24.5-device-persistence`，状态保持 `candidate/pre-human`。更新直接通过 Git 提交和默认分支合并完成，不生成新的 ZIP。

先阅读：

1. [候选源码启动说明](sgx-source/README.md)
2. [HTTP 合同](docs/2026-10-15-algorithm-fullstack-handoff-v0.2/http-contract-v0.2.md)
3. [设备持久化验证报告](docs/2026-10-15-algorithm-fullstack-handoff-v0.2/docs/reviews/2026-10-19-device-workspace-persistence-validation.md)
4. [稳定公网与设备工作区方案](docs/2026-10-15-algorithm-fullstack-handoff-v0.2/docs/execution/2026-10-19-stable-public-and-device-workspace-plan.md)

## 本次更新

- 补齐设备级测试工作区：刷新、进程重启后恢复原话、回复、评审、受治理 Memory、故事和画像。
- 新增 workspace bootstrap/current/export/delete 接口，并对公网会话、ASR、turn、view、interrupt、end 校验设备归属。
- Evidence、受治理 Memory 和故事/画像可以跨算法服务重启恢复；正在执行的模型任务不续跑。
- 增加当前设备导出、40 天到期、撤回删除传播、CAS 并发保护和设备级费用隔离。
- 增加 Next.js standalone、macOS LaunchAgent 和 Cloudflare Named Tunnel 的无凭据部署模板。
- 保留模块化语音链：独立 ASR → 文本模型 → 独立 TTS；未启用端到端实时语音模型。

## 可复用模块

- `sgx-source/src/app/api/algorithm/v0.1/`：HTTP API 和工作区边界。
- `sgx-source/src/lib/algorithm-service/`：组合、模型 Provider、ASR/TTS、费用、持久化。
- `sgx-source/src/lib/interview-policy/`：访谈状态、模式切换和行为约束。
- `sgx-source/src/lib/memory-runtime/`：候选抽取、来源、确认、撤回、删除和检索。
- `sgx-source/src/lib/derived-artifact-runtime/`：故事与画像草稿。
- `sgx-source/src/lib/turn-orchestrator/`、`response-runtime/`：单轮编排和输出。
- `sgx-source/deploy/`：本机内测部署与公网入口模板。
- `sgx-source/harness/`：离线、持久化、HTTP 和部署验证。

## Memory 边界

当前内部测试 SQLite 是 `TestWorkspaceStore`，用于保存内测证据和受治理 Memory 快照。它不是正式产品权威库。

```text
deviceWorkspaceDurable=true
governedMemoryDurable=true
canonicalWriteCapability=false
```

正式 `CanonicalMemory` 的数据库、账号与家庭权限、跨设备绑定、事务、备份、撤回删除和审计由产品后端接入。算法可以生成有来源的候选和派生草稿，但不能越权直写生产权威记忆。

## 当前证据和限制

- 仓库交付副本聚焦测试 113/113、TypeScript、standalone 构建通过；覆盖设备工作区、Evidence、Memory/画像跨进程恢复、费用隔离、HTTP 边界和本机服务配置。
- 固定虚构资料的真实豆包跨重启 Memory 检索已成功；累计保守预留为 429.44/800 元，`actualCostCny=null/PENDING`，不能当作供应商真实账单。
- Quick Tunnel 只用于临时内测；固定公网地址需要 Cloudflare 托管域名和 Named Tunnel 登录授权。
- 真人设备、手机、物理播放中打断、生产认证、正式 CanonicalMemory 和正式发布仍未完成。

源码完整性见 `source-manifest.json`。本仓库不包含 `.env.local`、API Key、Cloudflare Token、原始音频、`.local-runs`、设备数据库或真人资料。
