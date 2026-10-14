# SGX 算法 HTTP 合同 v0.1

## 1. 基础约定

- 基础路径：`/api/algorithm/v0.1`
- 内容类型：请求使用 `application/json`；实时结果使用 `application/x-ndjson`
- 每次写操作都必须带唯一 `idempotencyKey`。
- 服务端返回 `requestId`，全栈应把它写入自己的请求日志，便于定位问题。
- 句柄、证据 ID、轮次 ID 和代际 ID 都由服务端生成，客户端只透传。
- 当前内部测试接口只允许 loopback 或受控 SSH 隧道访问；生产接入时由全栈后端负责认证和家庭权限。

## 2. 健康和版本

### `GET /health`

健康接口不调用模型，适合启动检查和监控。

```json
{
  "schemaVersion": "algorithm-health-v0.1",
  "status": "ready",
  "mode": "REAL_INTERNAL",
  "paidExecutionEnabled": true,
  "networkCalls": 0,
  "costCny": null,
  "components": {
    "sessionRegistry": "ready",
    "leaseTree": "ready",
    "evidenceStore": "ready",
    "policy": "ready",
    "responseTts": "ready",
    "asyncJobs": "ready"
  }
}
```

`status=not_ready` 时不要向老人展示“算法失败”，应提示稍后再试，并停止新的付费调用。

### `GET /version`

```json
{
  "schemaVersion": "algorithm-version-v0.1",
  "apiVersion": "v0.1",
  "serviceVersion": "g5-real-internal-v0.18",
  "contractVersion": "algorithm-http-v0.1",
  "buildId": "pre-human-YYYY-MM-DD-build",
  "manifestSha256": "<sha256>",
  "fixtureSha256": "<sha256>",
  "interviewPolicyVersion": "interview-policy-v0.3.3",
  "rollbackCompatibility": "cancel_or_drain_then_replay_24_turns_10_interrupts",
  "paidExecutionEnabled": true
}
```

不要在前端展示 `manifestSha256` 以外的 provider 密钥、URL、原始资源 ID 或环境变量。

## 3. 创建会话

### `POST /sessions`

请求：

```json
{
  "schemaVersion": "algorithm-session-create-v0.1",
  "idempotencyKey": "client-session-001",
  "requestedMode": "DAILY_CHAT"
}
```

`requestedMode` 可选：`DAILY_CHAT`、`FORMAL_INTERVIEW`。正式访谈也可以由产品按钮通过下一轮的 `uiEvent` 进入。

内部工作台可能返回 `subjectBinding`，它只用于虚构测试主体绑定，生产接口不能让客户端自行提交或修改家庭主体。

成功响应：

```json
{
  "requestId": "req-001",
  "schemaVersion": "orchestrated-session-v0.1",
  "replayed": false,
  "opaqueSessionHandle": "session_<opaque>",
  "sessionEpoch": "epoch:<server-generated>",
  "mode": "DAILY_CHAT"
}
```

## 4. 一轮文字或语音输入

### `POST /sessions/{opaqueSessionHandle}/stream`

这是产品主入口，返回 NDJSON。客户端应持续读取事件，不能只等待最后一个 JSON。

#### 文字输入

```json
{
  "schemaVersion": "algorithm-stream-turn-v0.2",
  "idempotencyKey": "turn-001",
  "source": "TYPED_TEXT",
  "text": "我以前在纺织厂工作过。"
}
```

#### 进入正式访谈

```json
{
  "schemaVersion": "algorithm-stream-turn-v0.2",
  "idempotencyKey": "turn-002",
  "source": "TYPED_TEXT",
  "text": "我愿意聊往事，先从工作经历开始。",
  "uiEvent": {
    "type": "MEMORY_TOPIC_CLICK",
    "ref": "ui-event-002"
  }
}
```

#### 一次性 PCM16 语音

```json
{
  "schemaVersion": "algorithm-stream-turn-v0.2",
  "idempotencyKey": "turn-audio-001",
  "source": "PCM16",
  "base64Audio": "<base64-pcm16-mono-16khz>"
}
```

音频要求：PCM16、单声道、16 kHz；不要把 provider 的 API key 放到浏览器请求。

#### NDJSON 事件示例

```text
{"type":"phase","phase":"MODEL_PENDING","targetHandle":"target_<opaque>","generationId":3}
{"type":"text","text":"您以前在纺织厂工作，想必有不少难忘经历。","policyEngine":"InterviewPolicyV0.2","action":"FOLLOW_UP"}
{"type":"audio","base64Audio":"<base64-audio-chunk>","mimeType":"audio/mpeg","sequence":0}
{"type":"result","result":{"schemaVersion":"orchestrated-turn-result-v0.1","status":"completed"}}
```

事件中的 `text` 和 `audio` 是可播放/可显示内容；最终 `result` 是本轮机器状态和异步任务索引。

## 5. 最终轮次结果

```json
{
  "schemaVersion": "orchestrated-turn-result-v0.1",
  "status": "completed",
  "phase": "COMPLETED",
  "opaqueSessionHandle": "session_<opaque>",
  "targetHandle": "target_<opaque>",
  "sessionEpoch": "epoch:<server-generated>",
  "turnId": "turn:<server-generated>",
  "generationId": 3,
  "evidenceId": "evidence:<server-generated>",
  "mode": "FORMAL_INTERVIEW",
  "response": {
    "status": "success",
    "text": "您以前在纺织厂工作，想必有不少难忘经历。",
    "policyEngine": "InterviewPolicyV0.2",
    "action": "FOLLOW_UP",
    "questionCount": 1,
    "evidenceRefs": ["evidence:<server-generated>"],
    "retentionIntent": "DEFAULT",
    "retentionScope": "NONE",
    "sessionControl": "CONTINUE"
  },
  "tts": {
    "status": "success",
    "audioChunkCount": 6
  },
  "asyncJobs": [
    {
      "jobId": "MEMORY:turn:<id>",
      "kind": "MEMORY",
      "status": "success",
      "errorCode": null
    },
    {
      "jobId": "STORY:turn:<id>",
      "kind": "STORY",
      "status": "success",
      "errorCode": null
    },
    {
      "jobId": "PROFILE:turn:<id>",
      "kind": "PROFILE",
      "status": "success",
      "errorCode": null
    }
  ],
  "errorCode": null,
  "retentionEffect": null,
  "canonicalWriteCount": 0
}
```

`response.action` 是当前策略已经执行的动作，常见值为 `RESPOND`、`FOLLOW_UP`、`CLARIFY`、`WAIT`、`SWITCH_TOPIC`、`PAUSE`、`END`。`semanticTurnShadow` 中的候选动作不等于这个字段。

## 6. ASR 流

### `POST /sessions/{handle}/asr`

```json
{
  "schemaVersion": "algorithm-asr-open-v0.1",
  "idempotencyKey": "asr-001"
}
```

成功响应：

```json
{
  "asrStreamId": "asr_stream_<opaque>",
  "targetHandle": "asr_target_<opaque>",
  "sampleRate": 16000,
  "chunkDurationMs": {"minimum": 100, "maximum": 200},
  "expiresInMs": 75000
}
```

ASR 流的音频 chunk 发送和结束方式由全栈适配当前后端实现；最终通过 `/stream` 的 `source=ASR_STREAM` 提交。

### `POST /sessions/{handle}/asr/{asrStreamId}`

每个 chunk 必须按顺序发送。单个 chunk 为 100～200 ms 的 PCM16；最后一个 chunk 将 `endOfStream` 设为 `true`。

```json
{
  "schemaVersion": "algorithm-asr-chunk-v0.1",
  "sequence": 0,
  "endOfStream": false,
  "base64Audio": "<base64-pcm16-100-to-200ms>"
}
```

服务端返回：

```json
{
  "accepted": true,
  "sequence": 0,
  "transcript": {"text": "我以前在厂里", "final": false}
}
```

最后一个 chunk 被接受后，用下面的请求把最终转写提交为一轮对话：

```json
{
  "schemaVersion": "algorithm-stream-turn-v0.2",
  "idempotencyKey": "turn-asr-final-001",
  "source": "ASR_STREAM",
  "asrStreamId": "asr_stream_<opaque>"
}
```

常见 ASR 错误是 `asr_sequence_conflict`、`invalid_pcm_chunk`、`asr_stream_expired` 和 `asr_send_failed`。顺序冲突不要重新发送同一序号以外的 chunk；过期时新建 ASR 流。

## 7. 打断

### `POST /sessions/{handle}/interrupts`

```json
{
  "schemaVersion": "algorithm-interrupt-v0.1",
  "idempotencyKey": "interrupt-001",
  "interruptTargetHandle": "target_<opaque>",
  "reason": "user_speech"
}
```

可用原因：`user_speech`、`self_correction`、`explicit_cancel`、`source_correction`、`safety_stop`、`session_end`。

服务端必须取消当前生成和过期 TTS，不能只隐藏前端音频。成功通常返回 `202` 和 `accepted=true`。

## 8. 查看 Memory、故事、画像和 Shadow

### `GET /sessions/{handle}/view`

```json
{
  "schemaVersion": "algorithm-session-view-v0.1",
  "mode": "FORMAL_INTERVIEW",
  "status": "ACTIVE",
  "interviewPolicyVersion": "interview-policy-v0.3.3",
  "memoryOperationGuardVersion": "memory-operation-guard-v0.2",
  "currentTarget": null,
  "memoryExtractions": [],
  "memory": [],
  "artifacts": [],
  "semanticTurnShadow": [],
  "storage": {
    "durable": false,
    "canonicalWriteCapability": false
  }
}
```

展示建议：

- `memoryExtractions`：展示本轮模型提出多少候选、多少有效、多少被拒绝、最终提交是否完整；
- `memory`：展示当前测试服务中的候选/临时记录，并明确“尚未写入正式长期记忆”；
- `artifacts`：展示 `STORY` 故事草稿和 `PROFILE` 基础画像；
- `semanticTurnShadow`：仅供算法/测试人员查看，产品老人端默认不展示；
- `storage.durable=false` 或 `canonicalWriteCapability=false` 时，不显示“已永久保存”。

## 9. 结束会话

### `POST /sessions/{handle}/end`

```json
{
  "schemaVersion": "algorithm-session-end-v0.1",
  "idempotencyKey": "end-001"
}
```

结束后不要复用旧句柄继续发送新轮次；需要新会话时重新创建。

## 10. 错误响应

```json
{
  "requestId": "req-001",
  "code": "service_not_ready",
  "message": "算法服务尚未就绪。",
  "retryable": true
}
```

常见错误：

| 错误码 | 含义 | 客户端动作 |
|---|---|---|
| `service_not_ready` | 服务或额度未准备好 | 延迟重试并提示状态 |
| `invalid_schema` | 请求字段错误 | 修复请求，不重试 |
| `idempotency_conflict` | 同一幂等键对应不同请求 | 生成新键或恢复原请求 |
| `session_not_found` | 句柄失效 | 新建会话 |
| `session_not_active` | 会话已暂停/结束 | 按状态处理 |
| `turn_in_progress` | 上一轮仍在处理 | 等待或先打断 |
| `asr_stream_not_finalizable` | ASR 流还未结束 | 继续发送/结束 ASR |
| `stale_interrupt_target` | 打断目标已过期 | 忽略旧目标，刷新界面 |
| `asr_or_stream_failed` | 语音或流式处理失败 | 保留文字/错误状态，允许重试 |

不要把 provider 原始错误、密钥、模型提示词或内部主体 ID返回给客户端。
