# SGX 访谈与 Memory 算法交接快照

本目录是给全栈工程师的**脱敏源码和接口文档**。算法真实调用证据对应 `pre-human-2026-10-15-candidate-v23`、`interview-policy-v0.3.4`；仓库启动适配版本为 `pre-human-2026-10-15-candidate-v23-gitee.1`。最新定向真实复验为 6/6 主流程完成，质量仍处于 `REVIEW_PENDING`。目录与原分类代码分开维护。

更新直接通过 Git 提交和合并完成，不再生成 ZIP。首先阅读 [源码启动说明](sgx-source/README.md) 和 [本次验证记录](docs/reviews/2026-10-16-distribution-validation.md)；本地准备完成不等于远端已推送，实际同步状态见 [当日执行记录](docs/execution/2026-10-16-execution-log.md)。

## 可以接入的内容

- `sgx-source/src/app/api/algorithm/v0.1/`：版本化 HTTP 接口；
- `sgx-source/src/lib/algorithm-service/`：组合、ASR、TTS、成本和 Shadow 适配；
- `sgx-source/src/lib/interview-policy/`：访谈状态和行为边界；
- `sgx-source/src/lib/memory-runtime/`：候选抽取、来源、确认、撤回、删除和检索规则；
- `sgx-source/src/lib/derived-artifact-runtime/`：故事草稿和画像草稿；
- `sgx-source/src/lib/turn-orchestrator/`、`response-runtime/`：一轮对话的编排和输出；
- `sgx-source/src/lib/asr-runtime/`、`voice/tts/`：独立 ASR 和模块化 TTS；
- 离线测试契约和示例。

## 当前语音边界

本版本采用：**独立 ASR → 文本模型 → 模块化 TTS**。不使用端到端实时语音模型，也没有把 provider 密钥放到浏览器。`voice/realtime/header-websocket.ts` 仅为可选的旧 MiniMax TTS 传输依赖保留；旧的端到端 `voice/realtime` 会话不在本快照中，不能启用。

## Memory 边界

算法侧只能提交有来源的候选、返回可展示的派生草稿和执行受控检索；`canonicalWriteCapability=false`。正式 `CanonicalMemory` 的数据库、事务、家庭/社区权限、版本、撤回、删除、备份和持久化由全栈/后端实现，算法没有数据库直连。

## 使用方式

1. 先读 `docs/2026-10-15-algorithm-fullstack-handoff-v0.2/README.md` 和 `http-contract-v0.2.md`；
2. 按源码启动说明用 Fake 接通文字和状态；真实 ASR、TTS 及流式音频在配置后接内部 `REAL_INTERNAL`；
3. 先做 `/health`、`/version`、幂等、错误恢复和 `view` 展示；
4. 不把 `candidate/pre-human` 标记为生产版本，生产前仍需完成真人反馈、持久化 `CanonicalMemory`、认证、部署、回滚和安全评审。

关键架构依据还放在 `docs/architecture/`：访谈 Baseline 1.0 差异与集成、Memory/CanonicalMemory 架构、访谈与 Memory 操作规格、整体算法系统总览；`docs/execution/` 保存本轮执行记录。

文件完整性见 `source-manifest.json`。快照不包含 `.env.local`、API key、原始音频、付费运行目录或生产数据。
