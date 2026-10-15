# 当前候选版本补充说明（2026-10-15）

这份补充说明覆盖旧交接包中可能过期的版本和预算文字。以本文件、`handoff-manifest.json` 以及服务实际 `/health`、`/version` 返回为准。

## 当前版本

- 状态：`candidate/pre-human`
- API 合同：`algorithm-http-v0.1`
- 服务：`g5-real-internal-v0.18`
- InterviewPolicy：`interview-policy-v0.3.4`
- Build：`pre-human-2026-10-15-candidate-v23`
- `canonicalWriteCapability=false`
- `storage=process_memory_fictional_only`
- 活动助手名称：`小叙`
- 浏览器兼容 ASR：普通句子静默缓冲 1.8 秒；疑似未完句最多 2.6 秒
- 语音输入选择：实时模式可切换“语音发原音频 / 语音转文字”；兼容模式明确只支持转写文字
- 语音发送模式：默认自动发送转写文字，也可切换为先看文字再发送；实时 PCM 模式仍发送原始音频
- 文字输入框：桌面/手机按回车发送，`Shift+Enter` 保留换行

## 当前预算

- 程序硬上限：400 元
- 当前批次上限：364.48 元
- 累计预留：295.76 元
- 当前可继续预留：104.24 元
- 账单：`PENDING`
- 120 元汇报点：已触发

每次新模型调用仍必须遵守当前账本和停止规则。该包不包含任何密钥、`.env.local`、原始音频或付费运行目录。

## 新增接口和展示

- `GET /api/algorithm/v0.1/costs`：只读成本表；按脱敏 IP、会话、轮次和模块展示预留上限。
- 工作台“成本统计”页：可查看轮次明细、IP 汇总和无法反向归属的历史总账。
- 反馈包字段 `costTable` 和 `budgetSnapshot`：用于复盘，不包含明文 IP。

## 真实证据边界

- 62/62：组合、访谈离线验收和 G5 编排聚焦测试。
- 159/159：本地实时语音契约、慢语速缓冲、发送模式和回车发送检查。
- 5/5：暂停、换题、暂停态等待和明确继续的定向真实复验。
- SemanticTurnProposal：历史付费 24 轮主链完成；修复后仅做保留输出的 24/24 离线归一化，不能称为修复后的第二次付费通过。
- 本包不打开正式 `CanonicalMemory` 写入。

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

## 公网和持久化

现有临时 Basic Auth 网关和 Quick Tunnel 只适合短期内测。它们没有持久进程、数据库、完整限流和 WebSocket 代理能力，不能代表生产公网服务。固定 staging 需要全栈提供主机、域名、TLS、认证、限流、监控和持久化存储。
