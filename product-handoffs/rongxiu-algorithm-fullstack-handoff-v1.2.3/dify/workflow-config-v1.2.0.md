# 荣休礼 1～9：Dify 可选调试配置 v1.2.3

> 文件名保留 `workflow-config-v1.2.0.md`，用于兼容既有引用。本文只说明如何把平台无关 Prompt 映射到 Dify；接口、权限和数据生命周期以算法规格与业务后端为准。

## 统一调试画布

模型能力使用 Workflow，最小画布为：

```text
Start / User Input
  → 可选输入校验
  → LLM（System Prompt + User Prompt）
  → Structured Output：{"text":"..."}
  → 可选输出校验
  → Output
```

统一配置：

- Memory、Knowledge、Vision 和外部工具默认关闭；`CAPTION` 首期只接收文字。
- LLM Structured Output 为 object，`additionalProperties=false`，必填非空字符串 `text`。
- Dify 输出只是模型候选。服务端再包装 `status`、`purpose`、`mode`、`candidates`、`promptVersion`、`modelVersion` 和 `traceId`。
- 不把真实账号、手机号、`sourceRef`、审批信息、`inputHash`、revision 或 API Key 放进 Start 变量或 Prompt。
- 模型或 Prompt 版本变化后，重新执行对应 fixture；不能沿用旧通过记录。

## 模型参数起点

| 编号 | purpose / mode | temperature | max output tokens | 业务输出上限 | Dify 路由 |
|---:|---|---:|---:|---:|---|
| 1 | `INTRODUCTION/polish` | 0.20 | 512 | 300 code points | 可选 |
| 2 | `CAPTION/polish` | 0.15 | 256 | 100 code points | 可选 |
| 3 | `STORY/body` | 0.20 | 1024 起步 | 20000 code points 安全上限 | 可选；长文实测 |
| 4 | `WISH/polish` | 0.20 | 256 | 150 code points | 可选 |
| 5 | `COLLECTIVE_LETTER/generate` | 0.25 | 1536 起步 | 3000 code points 交接默认 | 可选；先过素材门禁 |
| 6 | `POST_EVENT_MESSAGE/polish` | 0.20 | 256 | 120 code points | 可选 |
| 7 | `INVITATION_MESSAGE/polish` | 0.30 | 256 | 120 code points | 可选；仅已有草稿 |
| 8 | `WISH/starter` | 不适用 | 不适用 | 静态模板原文 | **无 App、无模型路由** |
| 9 | `COLLECTIVE_LETTER/edit` | 0.20 | 1536 起步 | 3000 code points 交接默认 | 可选；先过选区门禁 |

`top_p` 起点为 `1.0`。frequency/presence penalty 仅在目标模型明确支持时配置。03、05、09 超出模型预算时返回稳定错误或转异步；禁止静默截断。

长度校验按各能力规格执行。业务文案长度使用 NFC 后 Unicode code point，标点和空格计入、换行不计；09 的选区坐标与逐字比较使用原字符串的 Unicode code point，不能先 NFC、trim 或改换行。

## Start 变量映射

| 编号 | 模型可见变量 | 后端保留字段 |
|---:|---|---|
| 1 | `biography` | requestId、版本与候选状态 |
| 2 | `caption` | 图片、文件名、EXIF、版本与候选状态 |
| 3 | `title?`、`body` | `inputRevision`、requestId、候选状态 |
| 4 | `wish` | requestId、候选状态 |
| 5 | `recipientLabel`、归一后的 `style`、匿名 `materials` | `inputHash`、`sourceRef`、账号映射、审批与权限元数据 |
| 6 | `message` | requestId、候选状态 |
| 7 | `mode=polish`、`recipientTitle`、`draftMessage`、裁剪后的 `facts` | 模板字段、分享/发送状态、revision、候选状态 |
| 8 | 无 | 本地静态模板版本与批次 |
| 9 | `letterText`、`instruction`、`selection`、`protectedRanges`、匿名 `approvedFacts` | `letterRevision`、`inputHash`、真实 `sourceRef`、审批与权限元数据 |

表中的“后端保留字段”属于业务请求信封，不能因为调试方便而拼进 User Prompt。Dify 变量映射也不能反向改变 JSON Schema。

## 05 总信首次生成

后端接收完整素材对象，用 `sourceRef` 复核用途、批准状态、revision 与权限。通过后，移除 `sourceRef`，仅把以下 JSON 序列化对象送入模型：

```json
{
  "recipientLabel": "李老师",
  "style": "natural_oral",
  "materials": [
    {
      "sourceType": "STORY",
      "authorLabel": "投稿者A",
      "materialLabel": "素材A-01",
      "narrativeAttribution": {
        "experienceSubject": "AUTHOR",
        "basis": "FIRSTHAND"
      },
      "text": "有一次我没理解题目，您换了一个例子讲给我听。"
    },
    {
      "sourceType": "STORY",
      "authorLabel": "投稿者A",
      "materialLabel": "素材A-02",
      "narrativeAttribution": {
        "experienceSubject": "THIRD_PARTY",
        "basis": "REPORTED"
      },
      "text": "我听同事提起，您曾耐心帮助一位新老师。"
    }
  ]
}
```

`sourceType` 是素材类型，`narrativeAttribution` 是叙述归属，不能合并成一个枚举。同一作者的多条素材使用不同 `materialLabel`。最终正文不显示这些内部标签，也不得把转述改写成作者亲历。

`style` 只接受：

| 值 | 前端名称 |
|---|---|
| `natural_oral` | 自然口述 |
| `soft_literary` | 文辞柔美 |
| `calm_dignified` | 沉静大气 |
| `formal_sincere` | 郑重真诚 |

后端在字段缺失时补 `natural_oral`。旧 `tone` 只由兼容层按已核实映射转换，Dify 不接受或猜测旧值。换风格后新结果先预览；已有人工修改稿保持原样，采用新候选后重新确认。

`materials` 为空、含待审素材或权限已失效时不调用 Dify。所有实际入模素材都记录为候选依赖，即使最终文本没有直接引用。

## 07 礼前共创邀请

业务层先拼装固定邀请模板。只有发起人填写了非空寄语草稿并主动选择 AI 润色时，才运行 `INVITATION_MESSAGE/polish`；空白草稿返回 `EMPTY_INPUT`，不配置 starter 路由。

Workflow 只润色寄语字段，不生成二维码、链接、截止日期、主办方、署名或发送动作。普通共创入口可以被转发，但新进入者仍需登录、确认身份关系并经过投稿审核；链接不授予管理权。分享点击不能记录为“已送达”。这些准入与统计规则都在后端实现，不由 Dify 判断。

## 08 静态祝福起笔

08 使用本地确定性配置，不创建 Dify App，也不复用 04 的模型：

```json
{
  "mode": "static",
  "templateVersion": "v1.2.3",
  "batchIndex": 0,
  "items": [
    {"templateId": "wish-01", "text": "想借这个机会，对您说……"},
    {"templateId": "wish-02", "text": "送上这份祝福，愿您……"},
    {"templateId": "wish-03", "text": "关于接下来的生活，我想祝您……"}
  ]
}
```

只在正文为空或只有称呼时展示。用户点击后填入可编辑草稿；换一批不改已有内容。用户补充实际表达后，才允许进入 04 润色。纯模板或只改标点不视为已有实质草稿。

## 09 总信局部编辑

业务请求必须包含 `letterText`、`instruction`、`letterRevision`、`inputHash`、`selection`、`protectedRanges` 和数组类型的 `approvedFacts`。调用 Dify 前，后端需要：

1. 按原字符串 Unicode code point 校验 `selection.start/end/selectedText`，坐标左闭右开；
2. 校验保护区合法、互不重叠，且选区不与保护区交叉；
3. 复核当前统筹权限、用途、revision 和 hash；
4. 对 `approvedFacts` 执行与 05 相同的匿名投影，移除 `sourceRef`。

Dify 仅看到完整原文、编辑指令、选区和匿名事实，并返回完整 `{\"text\":\"...\"}` candidate。返回后，后端逐字比较原前缀和原后缀；候选长度变化时不能用旧绝对坐标截取后缀。非选区空格或换行变化也返回 `PROTECTED_CONTENT_CHANGED`。

候选采用或撤销都会产生新 revision，旧确认失效；撤销不能恢复已撤回的素材许可。生成前和采用时都重新检查权限、revision、hash 与用途。

## 回归与发布记录

Studio Test Run 只使用 [`p0-golden-bad.jsonl`](../docs/algorithms/rongxiu-1-9/fixtures/p0-golden-bad.jsonl) 中 `testLayer=model` 的样例，并先按本文件的 Start 变量表投影为最小模型输入。`testLayer=backend` 的权限、revision、分享、撤回和保护比较用服务端 harness 验证；`testLayer=static` 的 08 用本地函数测试。不得把整份 JSONL 或含 `sourceRef`/revision 的业务请求直接送进 Dify。

至少记录 fixtureId、Prompt 版本、模型及版本、参数、脱敏输入 hash、实际输出、断言、错误码和耗时；不记录 API Key 或真实敏感正文。

Dify 调试通过只证明所选模型能执行 Prompt。全栈发布还需要通过 Schema、后端门禁、候选确认、revision 冲突、用途撤回和错误恢复测试。第三方删除、备份删除、离线重连先处理撤回、离线许可有效期及实际留存期限仍由 AI-D04 上线验收，不能由 Workflow 配置替代。
