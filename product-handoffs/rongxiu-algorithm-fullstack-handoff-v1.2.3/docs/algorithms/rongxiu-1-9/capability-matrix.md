# 荣休礼能力 1～9 能力矩阵

> 版本：`v1.2.3-frozen-handoff`
>
> 说明：本矩阵是算法端交给产品和全栈的边界。产品/内容只回传 Prompt 对；可以用任意模型平台做可选预览，但不能改变输入字段语义、事实边界、输出结构和确认规则。

| 编号 | 能力 | purpose / mode | 输入核心字段 | 输出核心字段 | 约束 | 状态 |
|---:|---|---|---|---|---|---|
| 1 | 人物介绍整理 | `INTRODUCTION` | `biography` | `text` | ≤300 字；只整理，不补事实 | P0 可调 Prompt |
| 2 | 照片描述整理 | `CAPTION` | `caption` | `text` | ≤100 字；不根据图片/文件名猜测 | P0 文本优先 |
| 3 | 故事正文整理 | `STORY` + `mode=body` | `title?`, `body`, `inputRevision` | `text` | 不增加人物、时间、对话、结局 | P0 可调 Prompt |
| 4 | 祝福润色 | `WISH` + `mode=polish` | `wish` | `text` | 轻量润色；不冒充组织/自动发送 | P0 可调 Prompt |
| 5 | 总信首次生成 | `COLLECTIVE_LETTER` + `mode=generate` | `recipientLabel`, `style?`, `materials[]`, `inputHash` | `text` | 只能使用作者已确认且统筹逐条批准的素材；`style` 缺省为 `natural_oral` | P0 契约已冻结，待全栈实现与验证 |
| 6 | 礼后问候整理 | `POST_EVENT_MESSAGE` | `message` | `text` | ≤120 字；不得补造近况 | P0 可调 Prompt |
| 7 | 邀请寄语 | `INVITATION_MESSAGE` + `mode=polish` | `recipientTitle`, `draftMessage`, `facts` | `text` | ≤120 字；只润色已有草稿；结构化邀请由模板管理 | P0 流程已冻结，待全栈实现与验证 |
| 8 | 祝福空输入起笔 | `WISH` + `mode=starter`（静态本地函数） | `recipientTitle?`, `wish`, `batchIndex?` | `mode`, `templateVersion`, `batchIndex`, `items[]` | 6 条静态模板，每批 3 条；点击才填入草稿；不调用模型 | P0 规格已冻结，无 Provider/App 路由 |
| 9 | 总信局部编辑 | `COLLECTIVE_LETTER` + `mode=edit` | `letterText`, `instruction`, `letterRevision`, `inputHash`, `selection`, `protectedRanges`, `approvedFacts` | `text` | 有效统筹选区编辑；保护非选区及保护范围；采用/撤销均生成新 revision | P0 契约已冻结，待全栈实现与验证 |

## 统一请求信封

业务 API 可使用统一请求信封，但传给模型 Provider 的内容必须是经过权限复核和裁剪后的最小投影：

```json
{
  "requestId": "job-123",
  "purpose": "CAPTION",
  "mode": "polish",
  "projectRef": "opaque-project-ref",
  "locale": "zh-CN",
  "promptVersion": "caption-v1.2.0-content-review",
  "input": {},
  "constraints": {},
  "privacy": {
    "allowedScope": "current_gift",
    "allowLongTermMemory": false
  }
}
```

禁止发送：手机号、地址、设备令牌、微信凭证、完整用户 ID、OSS 私密路径、项目全量数据库记录和未授权原文。

05 的业务 `materials[]` 含后端 `sourceRef` 时，送模型前必须移除；09 的 revision/hash/保护区用于后端并发与完整性校验，不由模型裁决。08 不使用本信封，也不返回模型 candidate。

## 统一成功响应

```json
{
  "status": "SUCCESS",
  "purpose": "CAPTION",
  "mode": "polish",
  "candidates": [
    {
      "text": "候选正文",
      "warnings": [],
      "violations": []
    }
  ],
  "promptVersion": "caption-v1.2.0-content-review",
  "modelVersion": "provider-model-version",
  "traceId": "trace-123"
}
```

`candidates[0].text` 是唯一的最小消费字段。没有非空 `text` 时不能标记成功。

## 统一失败语义

| 场景 | 后端错误语义 | 前端行为 |
|---|---|---|
| App/Key/模型未配置 | `ALGORITHM_UNAVAILABLE` | 保留手写入口，不显示假候选 |
| 05 没有任何用途有效且已逐条批准的素材 | `NO_APPROVED_MATERIALS` | 返回素材审核页，不调用 Provider |
| 必填草稿为空或只有空白字符 | `EMPTY_INPUT` | 保留编辑页，补充内容后再试 |
| 输入或候选超过该能力的业务长度上限 | `INPUT_TOO_LONG` | 保留原文；缩短内容或按长文流程处理 |
| 08 当前正文已有实质内容，不应展示静态起笔 | `NOT_APPLICABLE` | 隐藏起笔，不覆盖现有草稿 |
| 09 选区、selectedText 或保护区不合法 | `INVALID_SELECTION` | 保留正文并要求重新选择，不调用 Provider |
| Provider 超时 | `PROVIDER_TIMEOUT` | 可重试，不覆盖原文 |
| Provider 限流 | `PROVIDER_RATE_LIMITED` | 提示稍后重试 |
| 非法 JSON/空 text/超长 | `PROVIDER_FAILED` | 不应用候选 |
| 原文 revision 已变化 | `REVISION_CONFLICT` | 重新生成 |
| 09 非选区或保护区被改变 | `PROTECTED_CONTENT_CHANGED` | 拒绝候选，保留当前正文 |
| 素材用途许可已撤回 | `PERMISSION_REVOKED` | 停止生成、采用、展示或分享依赖内容 |
| 用户取消 | `CANCELLED` | 保留当前编辑内容 |

以上错误码由后端门禁或 Provider 适配层返回。`ALGORITHM_UNAVAILABLE` 只表示模型能力未配置或不可用，不能用于表达“业务素材为空”；08 的 `NOT_APPLICABLE` 是静态函数结果，不属于模型失败。

## 共同验收样例

每个能力至少覆盖：正常最小输入、空输入、超长输入、不确定事实、Prompt Injection、手机号/地址敏感字段、原文无需修改。所有通过结果仍然是 candidate，必须经过用户确认才能应用。
