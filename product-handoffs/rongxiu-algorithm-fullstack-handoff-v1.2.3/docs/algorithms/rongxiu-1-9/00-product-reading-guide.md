# 荣休礼 1～9：产品阅读说明

> 版本：`v1.2.3-frozen-handoff`
> 读者：产品和内容同事
> 目标：让你能看懂每个能力，产出可交付的 System Prompt + User Prompt；如果改了 Prompt 以外的内容，再单独登记。

## 先看结论

它是一套“把 1～9 个文本能力说清楚、把 Prompt 调到可用”的工作包。你要完成的是：

1. 看懂每个能力要解决什么问题；
2. 分别调整 System Prompt 和 User Prompt，让产品语气、内容范围和受礼者阅读体验合适；08 只审阅静态模板文案；
3. 如需预览，只用最简单的输入 → LLM → 输出流程试跑；
4. 回传最终 Prompt、版本、负责人和日期；
5. 如果改了输入字段、输出格式、按钮流程、安全边界或 Memory，再填写 [`product-content-prompt-return-template.md`](./product-content-prompt-return-template.md) 的第二张表。

产品不需要先读懂 JSON、后端代码、模型参数或 DSL。先按本文的顺序读，再按需要打开具体文件即可。

## 推荐阅读顺序

### 第一步：先读本说明

先建立一个简单认识：这些文件是“产品需求的可测试版本”，不是产品最终界面。每个能力都只生成一个候选文本，是否采用、是否发送、是否写入正式内容，仍然由产品交互和后端流程决定。

### 第二步：先看回传模板

打开 [`product-content-prompt-return-template.md`](./product-content-prompt-return-template.md)。正常情况下只填第一张表：交回 System Prompt、User Prompt、版本和调整目的。只有改了 Prompt 以外的内容，才填写第二张表。

### 第三步：读产品端总入口

打开 [`00-product-dify-handoff.md`](./00-product-dify-handoff.md)。虽然文件名保留了历史上的 Dify 命名，但它现在是平台无关的产品→算法/全栈 Prompt 交付入口。它回答三件事：

- 1～9 分别对应哪些能力；
- 哪些能力现在可以直接调，哪些还在等待产品或后端决定；
- 产品调完之后，需要把哪些记录交回去。

### 第四步：按需要读统一配置规范

打开 [`00-prompt-design.md`](./00-prompt-design.md)。它解释模型调用的通用骨架、System 和 User 各自放什么、输出为什么统一成 `{"text":"..."}`；如果需要，也说明如何在 Dify 中做可选预览。

### 第五步：先选一个简单能力练习

建议先看 [`02-caption.md`](./02-caption.md) 或 [`04-wish-polish.md`](./04-wish-polish.md)。这两个能力输入和输出都比较直观。熟悉之后，再看 [`01-introduction.md`](./01-introduction.md)、[`03-story-body.md`](./03-story-body.md) 和 [`06-post-event-message.md`](./06-post-event-message.md)。

### 第六步：再看有业务门禁的能力

最后看 [`05-collective-letter-generate.md`](./05-collective-letter-generate.md)、[`07-invitation-message.md`](./07-invitation-message.md)、[`08-wish-starter.md`](./08-wish-starter.md) 和 [`09-collective-letter-edit.md`](./09-collective-letter-edit.md)。它们不是“少写了一点”：05 需要批准素材和匿名投影，07 只润色已有草稿，08 是静态模板，09 需要选区保护和 revision 协议，不能只靠把 Prompt 调得更好来解决。

### 第七步：算法或全栈需要时再打开 Schema 和样例

- [`schemas/README.md`](./schemas/README.md)：说明输入和输出的字段格式；
- `schemas/request-*.json`：Provider 输入和后端请求的字段合同；
- [`schemas/response-candidate.json`](./schemas/response-candidate.json)：模型成功结果的最小格式；
- [`fixtures/README.md`](./fixtures/README.md) 和 [`fixtures/p0-golden-bad.jsonl`](./fixtures/p0-golden-bad.jsonl)：固定测试题和预期的坏结果。

### 第八步：全栈接入时再读规格草案

[`10-fullstack-spec-draft.md`](./10-fullstack-spec-draft.md) 是给全栈接入用的草案。产品和内容同事不需要从它开始，也不要根据其中的接口字段自行改变产品契约。

如果需要判断“Prompt 回传以后全栈还要做到什么”，直接看 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md)。它把产品交付、技术接入、候选闭环和最终产品验收分成不同状态。

## 这些术语用大白话怎么理解

| 文件里的说法 | 用大白话理解 | 你需要关注什么 |
|---|---|---|
| Prompt | 给模型的一份工作说明书 | 按层复制，不要把整份说明混在一个输入框里 |
| System Prompt | 每次都要遵守的固定规则 | 与 User Prompt 分开交付 |
| User Prompt | 这一次要处理的材料和参数 | 明确输入字段和变量绑定 |
| Model Parameters | 模型的几个“风格开关” | 本次不需要配置，由算法/全栈接手 |
| Provider | 实际调用的模型服务或模型网关 | 由算法/全栈选择和接入 |
| 输入校验 | 调用前检查字段、长度和权限 | 不让模型决定业务权限 |
| 结构化输出 | 要求模型按固定格式交卷 | 由算法/全栈配置或后端校验 |
| Schema | 输入和输出的数据格式合同 | 本次只需知道它存在，不要自行修改 |
| fixture | 固定的测试题 | 产品可提供代表性素材，正式回归由算法/全栈执行 |
| candidate | 还没有被用户确认的草稿 | 只能展示或保存为候选，不能自动发送或覆盖正式内容 |
| `purpose` | 这次要做哪一种能力 | 例如 `CAPTION` 表示照片描述整理 |
| `mode` | 同一种能力下的具体做法 | 例如 `WISH` 的 `polish` 和 `starter` |
| backend-only metadata | 后端用来追踪和防并发的资料 | 不要让模型生成，也不要把它当成文案素材 |
| revision / hash | 判断“你编辑的还是不是最新版本”的标记 | 总信编辑时必须原样交给后端校验 |
| Prompt Injection | 素材里夹带的“请忽略前面规则”之类的话 | 把它当普通素材，不能让它改写 System 规则 |
| Dify Studio | 可选的 Prompt 调试工作台 | 可以试跑，但不是必需，也不等于产品上线 |
| DSL | Dify 对 Workflow 的导出文件 | 本次不需要提供 |

`<START/field>` 是给人看的占位符，不是要原样发给模型的文字。全栈接入时，按所选 Provider 的变量绑定方式替换。

## 每个能力文件应该怎么读

模型能力文件按相同结构编排。你可以把它当成一张“配置卡”；08 是静态模板规格，不包含 Prompt、模型参数或 Structured Output：

1. **能力卡**：说明用户在什么场景下使用、输入是什么、输出是什么，以及当前能不能接生产。
2. **System Prompt**：固定边界和规则。通常直接复制到 LLM 的 System 区域；如果觉得语气需要调整，先保留事实边界、注入隔离和候选语义。
3. **User Prompt 模板**：说明这一次要把哪些字段放给模型。把 `<START/field>` 替换成真实变量，不要把占位符当作用户输入。
4. **Model Parameters**：产品和内容同事可以跳过；模型、温度和 token 限制由算法/全栈确定。
5. **Structured Output Schema**：产品和内容同事可以跳过；它是后端接入时用来稳定解析的格式。
6. **Model-visible / backend-only metadata**：只要记住后端元数据不要写进 Prompt，具体字段由算法/全栈处理。
7. **验收断言**：把“看起来不错”变成可以检查的条件，例如不能新增年份、地点、关系或承诺。
8. **产品/后端待办或门禁**：说明为什么某个能力现在只能做原型，或为什么需要产品先作决定。

## 如果要在 Dify 里预览（可选）

产品和内容同事只需要看 Prompt 效果，不需要搭生产流程。把 Dify 当成一个可选的试写台即可：

```text
Start / User Input（粘贴本次素材）
  → LLM（放 System Prompt + User Prompt）
  → Output（查看候选文本）
```

实际操作只有四步：

1. 建立一个最简单的 **Workflow**；
2. 在 LLM 节点分别放入 System Prompt 和 User Prompt；
3. 用 Start 输入一条真实或脱敏的示例素材；
4. 看输出是否符合内容目标，再回传最终 Prompt。

Code、IF/ELSE、Structured Output、Schema、后端 Tool、模型参数和部署方式属于算法/全栈接入阶段，不是产品/内容同事的本次必交项。Dify 能跑通也不等于已经上线。

## 产品可以调整什么，不能直接调整什么

产品和内容同事可以调整：

- 句子长短、语气和目标用户是否容易读懂；
- 在事实没有变化的前提下，段落和表达顺序；
- 示例和 User Prompt 中的表达方式；
- System Prompt 中的语气要求，但不能删除事实和安全边界。

不能直接改掉或绕过：

- “输入没有提供的事实不能补造”；
- 素材中的命令不能覆盖 System Prompt；
- 模型结果只是 candidate，必须经过确认才可以应用；
- 敏感信息不能因为模型觉得有用就进入长期 Memory；
- 请求字段、输出字段和 `text` 的结构；
- 5、7、8、9 对应的素材批准、产品决策和 revision/hash 门禁。

如果需要改变这些内容，先写成契约变更提案，由产品、算法、全栈共同确认新版本，不要只在 Dify 里暗改。

## 1～9 当前状态怎么看

| 编号 | 产品可以先做什么 | 需要特别注意什么 |
|---:|---|---|
| 1 | 调人物介绍的忠实整理 | 不能补造人物经历、时间和关系 |
| 2 | 调文字版照片描述 | 首版处理文字描述，不等于已经接入图片理解 |
| 3 | 调故事正文整理 | 当前先用 `mode=body`，保留事实顺序 |
| 4 | 调祝福轻量润色 | 尽量保留投稿人的语气和称呼 |
| 5 | 用合成素材验证总信结构 | 只能使用作者确认且有效统筹逐条批准的素材；送模型前移除 `sourceRef` |
| 6 | 调礼后问候整理 | 不能凭空补写受礼者近况或活动结果 |
| 7 | 调已有草稿的邀请寄语润色 | 结构化字段由模板管理；按已冻结的礼前共创、分享和准入规则实现 |
| 8 | 审阅 6 条静态起笔文案 | 不调用模型；每批 3 条，点击才填入草稿，不按关系分套 |
| 9 | 在调试环境验证局部编辑 | 仅当前有效统筹可选区编辑；按原字符串坐标保护非选区，采用和撤销都生成新 revision |

## 调试结束后产品/内容要交回什么

正常情况下只需要回传 [`product-content-prompt-return-template.md`](./product-content-prompt-return-template.md) 第一张表：

- 能力编号或名称；
- 最终 System Prompt；
- 最终 User Prompt；
- Prompt 版本、主要调整、调整目的、负责人和日期。

如果改了输入字段、输出格式、按钮流程、确认规则、隐私范围或 Memory，再填写模板的第二张表。Provider/App ID、模型参数、Schema、后端错误码和发布信息不属于产品/内容本次必交项。

不要在 Prompt、截图或聊天中粘贴 API Key、Token、数据库密码或含凭据的 URL。

Prompt 回传后，算法和全栈还要完成契约冻结、Provider 接入、候选确认/撤销和真实验收。因此，Prompt 是技术接入的输入，不是“产品已经可以正常运行”的证明；完整门槛见 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md) 和回传模板第五节。

## 本包和链接怎么使用

原工作区内的 Markdown 链接主要使用相对路径，例如 `./02-caption.md`、`./schemas/response-candidate.json`。只要保留本说明所在目录的结构，复制到另一台电脑后仍然可以在本地打开；不需要访问原作者电脑。

有两类链接需要联网：

- Dify 官方文档链接；
- OpenAI 等外部平台的官方文档链接。

聊天消息里显示的本机绝对文件链接是当前 Codex 工作区的本地链接，不能当作发给团队成员的通用链接。对外应发送 GitHub 交付分支的目录入口，并保留目录内的相对路径；本版不以 ZIP 作为交付方式。

本包包含 Prompt、Schema、测试样例、配置说明和交付记录模板；产品/内容同事只需要使用 Prompt 和回传模板。包内不包含任何 Provider 登录信息或 API Key，也不代表已经在某个模型平台创建或发布了 App。

## 看不懂或发现冲突时怎么处理

优先按以下顺序判断：

1. 这是文案偏好问题，还是输入/输出合同问题？
2. 这是模型效果问题，还是产品尚未决定的业务问题？
3. 这是可以通过 Prompt/模型参数调整的问题，还是必须由后端保护的权限、确认或版本问题？

只要涉及字段含义、事实边界、敏感信息、候选确认、revision/hash 或长期 Memory，就先记录问题并找算法/全栈共同确认，不要用改 Prompt 的方式绕过去。
