# 当前候选版本补充说明（更新于 2026-10-16）

这份补充说明覆盖旧交接包中可能过期的版本和预算文字。以本文件、`handoff-manifest.json` 以及服务实际 `/health`、`/version` 返回为准。

## 当前版本

- 状态：`candidate/pre-human`
- API 合同：`algorithm-http-v0.1`
- 服务：`g5-real-internal-v0.18`
- InterviewPolicy：`interview-policy-v0.3.4`
- 历史真实模型 Build：`pre-human-2026-10-15-candidate-v23`
- 仓库分发 Build：`pre-human-2026-10-15-candidate-v23-gitee.1`；补齐启动依赖和运行指纹，未重跑付费 baseline。
- `canonicalWriteCapability=false`
- `storage=process_memory_fictional_only`
- 活动助手名称：`小叙`
- 浏览器兼容 ASR：普通句子静默缓冲 1.8 秒；疑似未完句最多 2.6 秒
- 语音输入选择：实时模式可切换“语音发原音频 / 语音转文字”；兼容模式明确只支持转写文字
- 语音发送模式：默认自动发送转写文字，也可切换为先看文字再发送；实时 PCM 模式仍发送原始音频
- 文字输入框：桌面/手机按回车发送，`Shift+Enter` 保留换行

## 预算历史快照（2026-10-15）

- 程序硬上限：400 元
- 当前批次上限：364.48 元
- 累计预留：335.24 元
- 当前可继续预留：64.76 元
- 账单：`PENDING`
- 120 元汇报点：已触发

以上预留不等于实际费用，本轮迁移新增付费调用 0 次。下一次调用前读取实际累计账本，不把该快照或示例配置当作可重新消费的额度。该目录不包含任何密钥、`.env.local`、原始音频或付费运行目录。

## 新增接口和展示

- `GET /api/algorithm/v0.1/costs`：只读成本表；按脱敏 IP、会话、轮次和模块展示预留上限。
- 工作台“成本统计”页：可查看轮次明细、IP 汇总和无法反向归属的历史总账。
- 反馈包字段 `costTable` 和 `budgetSnapshot`：用于复盘，不包含明文 IP。

## 真实证据边界

- 历史 62/62：组合、访谈离线验收和 G5 编排聚焦测试。
- 历史 160/160：本地实时语音契约、慢语速缓冲、发送模式和回车发送检查，不等于真人语音验收。
- 历史 v20 的 5/5：暂停、换题、暂停态等待和明确继续的定向真实复验。
- SemanticTurnProposal：历史付费 24 轮主链完成；修复后仅做保留输出的 24/24 离线归一化，不能称为修复后的第二次付费通过。
- 本包不打开正式 `CanonicalMemory` 写入。
- 最新控制/Memory 定向真实复验：6/6 主流程完成、TTS 6/6 成功，`TARGETED_CHECKS_PASS_REVIEW_PENDING`；详见 [定向报告](./reviews/2026-10-15-control-memory-targeted-revalidation.md)。
- 完整 C1～C12 为 12 场景、13 子项执行；C10 在首字/首音前取消，不能称为播放中物理打断已通过。逐轮原话及负面结果见 [评审记录](./owner-c1-c12-real-smoke-report.md)。
- 本轮仓库分发：74/74 聚焦测试、TypeScript、构建及 4 项 VAD 资源准备通过。health/version 是构建后处理器检查，未执行独立 `npm ci` 或浏览器 E2E，详见 [分发验证](./reviews/2026-10-16-distribution-validation.md)。

## 访谈体验和主题

- 追问深度达到自然停顿点时，使用“您还愿意继续讲吗，还是今天先到这里”等直接表达，不使用“把经历收住”等容易产生歧义的措辞。
- 图片标题写“八个主题”但当前可辨认七行；本包新增第八个候选“人生转折与告别”，状态为 `PROPOSED`，未接成强制流程。
- 具体主题目标、首问、子线索、Memory 维度和敏感边界见 `interview-theme-outline-v0.1.md`。

## 全栈接入顺序

1. Fake 联调页面和错误状态；
2. `REAL_INTERNAL` internal staging；
3. 负责人真实模型和设备体验；
4. 反馈修复、定向复验和版本冻结；
5. 后端实现 durable `CanonicalMemory`、家庭权限、撤回/删除和部署。

当前语音选择是模块化链路：独立 ASR → 文本模型 → 模块化 TTS；不使用端到端实时语音模型。源码快照只把 `src/lib/voice/tts/` 作为当前接入路径，旧 `src/lib/voice/realtime/` 保留在 SGX 源仓库中作历史兼容参考，不得在本轮接入中启用。

## 公网和持久化

现有临时 Basic Auth 网关和 Quick Tunnel 只适合短期内测。它们没有持久进程、数据库、完整限流和 WebSocket 代理能力，不能代表生产公网服务。固定 staging 需要全栈提供主机、域名、TLS、认证、限流、监控和持久化存储。
