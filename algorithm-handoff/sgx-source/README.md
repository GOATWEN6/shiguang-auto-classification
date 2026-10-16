# 访谈与 Memory 候选源码启动说明

状态：`candidate/pre-human`。当前分发 build 为 `pre-human-2026-10-15-candidate-v23-gitee.1`；它补齐仓库运行依赖、启动配置和指纹文件，访谈与 Memory 核心沿用 v23。工程验证不替代真人体验。

## 本地启动

使用 Node.js 22 和 npm，在本目录执行：

```bash
npm ci
npm run prepare:vad
cp .env.example .env.local
npm run dev -- -p 3100
```

浏览器访问 `http://127.0.0.1:3100/algorithm-lab`。机器检查入口是 `/api/algorithm/v0.1/health` 和 `/api/algorithm/v0.1/version`。

默认 `LOCAL_FAKE`，额度为 0，不调用供应商。Fake 可验证文字、状态和接口合同；真实语音识别、声音效果、播放中打断和 Memory/故事质量必须在真实模式及设备上验证，不能用 Fake 结果代替。

可复现的本地检查：

```bash
npm run test:handoff
npm run typecheck
npm run build
npm run start -- -p 3100
```

`dev` 和 `start` 选择其一运行；端口占用时先确认已有进程，避免并行占用同一个端口。本次验证复用开发机已有依赖，尚未在全新机器执行独立 `npm ci`。

## 真实模式配置

只在本机 `.env.local` 或服务端 secret storage 填写模板中的文本模型、独立 ASR、独立 TTS 凭据。算法链路固定为 **ASR → 文本模型 → TTS**，不是端到端实时语音模型。

- 将 `SGX_ALGORITHM_MODE` 改为 `real`、`SGX_ALGORITHM_FAKE_MODE` 改为 `0`。
- 填入 `LLM_API_KEY`、`DOUBAO_ASR_API_KEY`、`DOUBAO_TTS_API_KEY`；模型、资源和音色字段须对应已开通能力。
- 根据累计账本分配 `SGX_INTERNAL_BATCH_CAP_CNY` 和 `SGX_INTERNAL_PRIOR_EXPOSURE_CNY`。默认 prior=400 是防误调用的保守占位，不能作为已花费金额。迁移不能把历史用量清零；2026-10-15 的 335.24 元是历史累计预留，不是供应商实际账单。
- 保持 `SGX_SEMANTIC_TURN_SHADOW=0`，除非明确安排 Shadow 观察批次。
- 重启后核对 `/health`、`/version` 的模式、预算和 build，再调用真实模型。Fake 的配置就绪字段不证明真实供应商凭据有效。

当前默认音色仍为模板中已使用的音色。男孩/小猪佩奇音色等待负责人提供准确 Speaker ID；不要凭名字猜 ID。

## 接口和后端边界

先读 [候选接口说明](../docs/2026-10-15-algorithm-fullstack-handoff-v0.2/README.md) 和 [HTTP 合同](../docs/2026-10-15-algorithm-fullstack-handoff-v0.2/http-contract-v0.2.md)。服务仅监听 loopback，当前身份绑定为内部测试用途，不是产品认证。

算法输出候选和派生草稿，`canonicalWriteCapability=false`，会话存储为进程内测试存储。正式数据库、认证、家庭权限、CanonicalMemory Adapter、撤回删除工作流、部署和回滚由产品后端接入。服务重启不能保证 Memory 留存。

源码中 `voice/realtime/header-websocket.ts` 仅被旧 TTS 适配依赖引用，不代表启用端到端实时语音。

## VAD 资源来源

`prepare:vad` 仅从 lockfile 对应的已安装依赖复制静态文件到 `public/vad/`，不另外下载模型，不调用付费 API。资源和 `node_modules` 不提交到仓库。

| 依赖 | 锁定版本 | 本机 package metadata 的许可 | 用途 |
|---|---|---|---|
| `@ricky0123/vad-web` | 0.0.30 | ISC | 浏览器 VAD worklet 与随包模型 |
| `onnxruntime-web` | 1.26.0 | MIT | 浏览器 ONNX 执行资源 |

以上是包元数据的许可记录；不等于随包 Silero 模型已经独立完成再分发许可审核。正式部署/再分发前由接入方核实模型归属与许可。

## 文件范围与当前证据

当前仓库提供完整性清单 [source-manifest.json](../source-manifest.json)，不含 `.env.local`、原始音频、付费运行目录或真实家庭数据。

74 项聚焦测试、typecheck、build、VAD 资源准备，以及构建后 health/version Route Handler 检查通过。后者直接调用处理器，没有经过浏览器或真实网络监听。构建存在 ONNX 动态依赖、Browserslist 数据陈旧和 React ref 清理警告；未因此扩大依赖升级范围。

真实模型的 C1～C12 和 6 轮定向结果见 [逐轮评审记录](../docs/2026-10-15-algorithm-fullstack-handoff-v0.2/docs/owner-c1-c12-real-smoke-report.md)。仍需负责人判断追问、等待、故事画像，以及真人麦克风和物理打断表现。
