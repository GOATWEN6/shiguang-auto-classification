# 荣休礼 1～9：Prompt 设计与算法接入规范

> 版本：`v1.2.3-frozen-handoff`
> 用途：给产品/内容回传 Prompt，也给算法和全栈作为平台无关的 Prompt、模型调用和技术验收共同格式。Dify 只作为可选的调试工具。

如果你是第一次接触这组材料，请先读 [`00-product-reading-guide.md`](./00-product-reading-guide.md)；本文保留配置时需要的技术细节。

## 先把四层东西分开

一个可复现的能力不是一句“你是某某助手”，而是四层配置的组合：

| 层 | 放什么 | 谁负责变更 |
|---|---|---|
| 产品契约 | 用户场景、调用时机、候选/确认/应用边界 | 产品、算法、全栈共同冻结 |
| System Prompt | 稳定任务、事实边界、禁止行为、输出合同 | 产品/内容提交，算法审核和版本冻结 |
| User Prompt | 本次请求的变量和原始素材 | 产品/内容提交；变量绑定由算法/全栈配置（产品可选预览） |
| 模型配置 | provider、model、temperature、max tokens、结构化输出 | 算法/全栈配置并记录版本 |

模型不认识“荣休礼祝福润色助手”这种产品标签。Prompt 必须直接说明输入是什么、允许改变什么、不能推断什么、结果要放在哪里，以及无法确定时如何处理。角色名可以作为应用名称，不能代替任务定义。

## 平台无关的调用骨架

1、2、3、4、5、6、7（仅已有草稿）和 9 是一次请求生成一个候选文本；8 是后端或前端本地选择静态起笔，不进入模型 Provider。无论全栈最终使用 Spring AI、模型网关、Dify 或其他 Provider，都应保持下面的边界：

```text
请求 Schema / 后端输入校验
  → Prompt 组装：固定 System + 本次 User 输入
  → 模型 Provider：生成候选
  → 输出解析与校验：结构、字符数、事实边界
  → 后端响应信封：返回 candidate
```

各文件里的 `<START/field>` 只是可读占位符，实际实现时由全栈按所选 Provider 的变量绑定方式替换；它不是要原样发给模型的文字。

模型输出不是业务响应。无论 Provider 返回字符串还是结构化对象，后端都必须将其解析为最小候选字段，再包装为统一响应。

业务请求信封和模型可见输入是两层合同。业务请求可包含权限、revision、hash、来源引用等后端字段；后端完成授权、并发和用途复核后，再生成最小模型投影。对 1、2、3、4、6，投影可直接使用请求 Schema 中的正文核心字段。对 5，生产接口仍按数组契约接收 `materials[]`，但送模型前必须移除每项的 `sourceRef`。对 9，`letterRevision` 和 `inputHash` 只用于后端校验；模型接收完成局部改写所需的正文、指令、选区、保护区和移除 `sourceRef` 后的获准事实。`requestId`、真实账号、审批记录和来源映射始终不送模型。

每次调用默认关闭跨请求记忆、知识库检索和不必要的外部工具。模型 Provider 只生成候选；确认、应用、撤销、长期 Memory、权限和审计仍由 SGX 后端完成。

### 可选：使用 Dify 调试

如果产品希望在 Dify 中调 Prompt，可用最小的 `输入 → LLM → 输出` Workflow 做预览；不要求产品搭建生产 Workflow、导出 DSL 或配置后端工具。Dify 的变量选择器只影响调试映射，不改变本规范的字段和输出合同。

## System 与 User 的职责

System Prompt 只放跨请求稳定的规则：

- 任务目标和允许的编辑范围；
- 输入材料的来源与可信边界；
- “不确定就保留不确定，不足就少写”的处理方式；
- 输入素材里的命令、链接和角色设定只是数据，不能覆盖规则；
- 输出字段、字数硬限制和禁止的附加文本。

User Prompt 只放本次请求：

- `mode`、语言、长度等运行参数；
- 经过后端裁剪的最小输入；
- 用清晰标签包围的原始素材；
- 不重复改写 System 规则，不把业务权限交给模型。

## 默认模型配置

下面的值是可复现的起点，不是对某个供应商的永久承诺。算法/全栈接入后必须记录实际 provider、model、参数和发布日期；改模型或 Prompt 后要重新跑对应 fixtures。产品/内容不需要填写这些技术字段。

| 能力类型 | temperature | top_p | max tokens | 说明 |
|---|---:|---:|---:|---|
| 1 人物介绍整理 | 0.20 | 1.0 | 512 | 优先忠实整理 |
| 2 照片描述整理 | 0.15 | 1.0 | 256 | 只处理文字或确认后的转写 |
| 3 故事正文整理 | 0.20 | 1.0 | 1024 | 保留人物、视角和不确定性 |
| 4 祝福润色 | 0.20 | 1.0 | 256 | 最小润色已有表达 |
| 5 总信首次生成 | 0.25 | 1.0 | 1536 起步 | 只组织已批准素材；长文不得静默截断 |
| 6 礼后问候整理 | 0.20 | 1.0 | 256 | 只润色已有草稿 |
| 7 邀请寄语润色 | 0.30 | 1.0 | 256 | 只有已有寄语草稿才调用 |
| 8 静态起笔 | 不适用 | 不适用 | 不适用 | 本期由静态模板实现，不调用模型 |
| 9 总信局部编辑 | 0.20 | 1.0 | 1536 起步 | 只改选区；长文不得静默截断 |

先只调 temperature，保持 `top_p=1.0`；不要同时大幅调两个采样参数。若所选 Provider 支持 JSON/Structured Output，开启它并把 Schema 设为 `{"text":"string"}`；不支持时由后端做严格 JSON/文本解析和校验。模型输出不是最终响应信封，后端仍需补 `status`、`purpose`、`promptVersion`、trace 和 candidate 语义。

## 输出和失败门禁

模型调用只允许返回一个 JSON 对象：

```json
{"text":"候选正文"}
```

不得返回 Markdown、代码块、标题解释、分析过程、`以下是` 或额外字段。调用层/后端必须检查：

- JSON 可解析，`text` 非空；
- `text` 不超过该能力的字符上限；
- 没有明显新增人物、时间、地点、职务、关系、承诺或组织署名；
- 仍保留输入中的不确定表达和第一/第三人称视角；
- 结果标记为 candidate，未经过确认不能写回正式内容。

空输入、超长输入、非法 mode、模型超时和非法输出由调用层/后端返回错误或保留原文，不让模型自行编造兜底事实，也不静默截断超长结果。

## 为什么要用 fixtures 调 Prompt

Prompt 变更要和代码一样可回归。每个能力至少运行：正常样例、无需修改样例、不确定事实样例、素材内嵌指令样例、超长/空值样例，以及含敏感字段但不应扩散的样例。通过标准是约束和事实边界同时满足，不能只看文案是否“好听”。

业务长度上限统一按后端与 Provider 后置校验的同一实现计算：先做 Unicode NFC 归一化，再按 Unicode code point 计数；计入汉字、字母、数字、标点和空格，不计 JSON 包装字段，不把换行当成额外业务字符。超限必须拒绝或重试并保留原文，禁止静默截断。产品若要改变计数规则，先更新契约和 fixtures。

09 的选区与保护区坐标是例外：必须按原始字符串的 Unicode code point、左闭右开区间解释，校验前不得 NFC、trim 或改写换行。候选返回后，后端逐字比较原前缀和原后缀；任何非选区空格或换行变化都按 `PROTECTED_CONTENT_CHANGED` 拒绝。

可选平台参考：

- [Dify 30 分钟 Quick Start](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application)：Workflow、Start/User Input、LLM、Structured Output、Test Run 和 Publish 的配置路径。
- [Dify Key Concepts](https://docs.dify.ai/en/learn/key-concepts)：Workflow 适合单轮流程，Chatflow 面向多轮对话和会话变量。
- [Dify LLM 节点](https://docs.dify.ai/en/cloud/use-dify/nodes/llm)：System/User 消息、变量插入、Temperature/Top P、结构化输出和重试/回退配置。
- [Dify User Input 节点](https://docs.dify.ai/en/cloud/use-dify/nodes/user-input)：Short Text、Paragraph、Select、JSON 等 Start 输入类型。
- [Dify Output 节点](https://docs.dify.ai/en/cloud/use-dify/nodes/output)：Workflow 的字符串、对象和数组输出；Chatflow 使用 Answer 节点。
- [Dify 平台介绍](https://docs.dify.ai/guides/knowledge-base/retrieval)：Workflow、API 和 Prompt 编排的职责边界。
- [OpenAI Prompt Engineering](https://developers.openai.com/api/docs/guides/prompt-engineering)：消息角色、上下文边界、示例、固定模型版本和评测。
