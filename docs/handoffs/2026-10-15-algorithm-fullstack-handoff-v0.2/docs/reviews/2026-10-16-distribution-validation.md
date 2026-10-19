# Gitee 候选源码交付验证（2026-10-16）

## 目标和变更

负责人要求从 GitHub 更新目标切换至 Gitee，直接维护源码和文档，沿用分支并正常合并，不再生成 ZIP。交付仍为 `candidate/pre-human`。

本轮在 `algorithm-handoff/sgx-source/` 补齐共用运行库、输入规整、模型运行库、Next 入口和构建配置；新增空凭据模板、VAD 静态资源准备脚本、启动说明及仓库内运行指纹。启动不再依赖开发机未打包的付费 runner。原分类代码保留。

分发 build：`pre-human-2026-10-15-candidate-v23-gitee.1`。算法核心沿用 v23，真实模型历史结果绑定 v23；不能把这次分发验证写成新一轮付费 baseline。

## 实际验证

| 检查 | 结果 | 范围 |
|---|---|---|
| `npm run test:handoff` | 74/74，通过 | 组合、provider 回归和故事画像运行库 |
| `npm run typecheck` | 通过 | 分发源码 TypeScript |
| `npm run prepare:vad` | 4 个资源准备成功 | 仅从已安装的锁定依赖复制 |
| `npm run build` | 退出码 0 | 编译、类型检查、页面生成和构建追踪 |
| 构建后 health/version 处理器 | 均返回 HTTP 200 | `LOCAL_FAKE`，build 为 gitee.1，网络调用数 0 |
| 新增付费模型调用 | 0 | 本轮复用历史真实证据 |
| 提交范围与凭据 | 通过 | 117 个源码文件，排除运行数据；凭据模板为空 |
| 文档与文件清单 | 通过 | 修复失效相对链接；三份源码清单逐项 SHA-256 一致 |

验证时依赖解析复用了 SGX 开发机已有 `node_modules`。尚未执行干净环境的独立 `npm ci`；health/version 为构建产物的处理器调用，不是监听 3100 或浏览器 E2E 验收。

构建警告保留：ONNX 的动态 require、Browserslist 数据过旧、工作台 React ref cleanup。此次迁移未扩大为依赖升级任务。

VAD 资源均忽略提交。准备时的 SHA-256：

| 文件 | SHA-256 |
|---|---|
| `vad.worklet.bundle.min.js` | `8a48fdc7429948a2fde3d29a84bb1a64c1f67b4ba578ccaa7548b7f989f06a74` |
| `silero_vad_v5.onnx` | `2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f` |
| `ort-wasm-simd-threaded.mjs` | `2de262ca1fe2d6e0ef9236bf77632fa01de232ce7b6a33071c37637ee53f4669` |
| `ort-wasm-simd-threaded.wasm` | `040d52ce5066707a10d45cb9500c35e70a9c2fb33c4fb63428da9ae45b956b97` |

## 真实证据与未完成事项

- 2026-10-15 完整 C1～C12 为 12 场景、13 子项执行，保留 Memory/画像污染等负面结果。
- 随后 6 轮控制/Memory 定向复验完成，TTS 6/6 成功，正式 CanonicalMemory 写入 0；质量待负责人评审。
- 最新完整批次 C10 在首字/首音前取消，只证明生成前取消；真人麦克风、实际扬声器播放中打断、听感仍未通过。
- 正式持久化、产品认证、权限、部署和回滚未由当前算法测试服务完成。
- Shadow 历史付费 24 轮与修复后 24/24 离线归一化分开记录。

详细逐轮输入、回复、等待和派生结果见 [真实评审记录](../owner-c1-c12-real-smoke-report.md)。

## 交付状态

本地源码已提交为 `5adcbaf`，沿用 `codex/sgx-algorithm-candidate-2026-10-15`。本地验证完成不等于 Gitee 已更新。远端默认分支查询因沙箱 DNS 限制及两次自动执行审批超时未完成，浏览器读取随后遇到审批服务 503；本地提交后当前终端的一次只读查询申请也超时，均未实际执行。未取得 Gitee refs，不猜默认分支、不强推。

恢复联网执行后：读取默认分支和已有候选分支 → fetch → 比较双方历史 → 在既有分支正常合并并验证差异 → 推送并核对远端提交。具体提交和远端结果维护在 [当日记录](../execution-log-2026-10-16.md)。
