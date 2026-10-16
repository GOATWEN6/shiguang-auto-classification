# 测试、重试、版本与回滚说明

## 1. 模式区分

| 模式 | 用途 | 是否产生真实模型调用 |
|---|---|---:|
| `LOCAL_FAKE` | 全栈接页面、错误处理、状态机和幂等 | 否 |
| `REAL_INTERNAL` | 负责人和算法团队做受控真实模型体验 | 是，受预算账本控制 |
| `candidate/pre-human` | 当前交接状态 | 可以运行，但不能当正式生产版本 |

真实服务通过环境变量选择模式；不要把 `.env.local` 或任何 provider 凭据复制给全栈。浏览器只调用算法后端，不能拿到 ASR、TTS 或文本模型密钥。

## 2. 每次运行的最短检查顺序

```bash
curl -sS http://127.0.0.1:3100/api/algorithm/v0.1/health
curl -sS http://127.0.0.1:3100/api/algorithm/v0.1/version
```

确认 `status=ready`、`apiVersion`、`buildId` 和 `interviewPolicyVersion` 后，再创建会话。健康接口只做机器检查，产品体验从算法工作台进入。

## 3. 重试规则

- 网络超时或 `retryable=true`：保留原 `idempotencyKey` 进行一次恢复查询；只有确认服务没有接受请求时才生成新键。
- `idempotency_conflict`：不能盲目重试，先检查请求体是否被改过。
- `session_not_found` 或会话已结束：创建新会话，不能复用旧句柄。
- `turn_in_progress`：等待当前轮结束，或先对当前 target 发打断。
- `stale_interrupt_target`：刷新页面上的 target，不要重复打断旧目标。
- ASR 失败：保留已经显示的文字或错误状态，允许用户改用文字输入；不要静默伪造转写。
- 付费 Shadow 或真实模型重试：先查看预算账本和运行目录，不能为了“挑最好结果”重复整批。

## 4. 发布前验收

候选版本要记录：源代码提交或工作区快照、`buildId`、HTTP 合同版本、InterviewPolicy 版本、关键文件 SHA-256、测试命令和失败项。至少完成：

1. Fake 模式的创建、文字、语音、TTS、打断、查看、结束；
2. 24 轮语义 Shadow 的离线回放；
3. 10 个打断场景的离线或模拟验证；
4. 负责人真实模型 smoke cases；
5. `npx tsc --noEmit --incremental false`、聚焦自动化测试和 `git diff --check`。

## 5. 回滚

回滚按“停止新请求—等待或取消旧请求—切回上一 build—重放固定案例”执行：

1. 停止把新请求路由到候选 build，不删除运行记录；
2. 对正在播放或生成的轮次发送 `interrupt`，等待流关闭；
3. 切回上一个已记录的 `buildId` 和合同版本；
4. 重放 24 个固定访谈轮次和 10 个打断用例；
5. 比较回复、Memory 候选、故事/画像和错误状态，确认旧版本恢复；
6. 将回滚原因和影响写入执行日志。

本候选包不允许通过回滚绕过权限、来源、敏感性或撤回检查。`CanonicalMemory` 正式持久化仍由后端权限与持久化门禁控制，当前候选运行的 `canonicalWriteCapability=false`。
