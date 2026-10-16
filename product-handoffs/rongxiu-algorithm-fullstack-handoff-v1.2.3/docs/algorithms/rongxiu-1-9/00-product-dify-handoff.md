# 荣休礼 1～9：产品→算法/全栈 Prompt 交付说明

> 交付版本：`v1.2.3-frozen-handoff`
> 文件名保留历史上的 `dify` 命名；本文不绑定任何模型平台。
>
> 目标：产品在不改变算法契约和安全边界的前提下，调整模型能力的 Prompt，并把最终 Prompt 对和版本记录交回算法端冻结；08 只维护静态模板。Dify 只是可选调试工具。

产品第一次阅读请先看 [`00-product-reading-guide.md`](./00-product-reading-guide.md)。这份说明用非技术语言解释阅读顺序、Prompt 分层和每个字段的作用；本文件负责给出具体的交付映射和回传格式。

本次产品/内容交付只需要回传模型能力最终的 System Prompt 和 User Prompt；08 回传静态模板版本和文案。若修改了输入字段、输出格式、按钮流程、确认规则、隐私范围或 Memory，请填写 [`product-content-prompt-return-template.md`](./product-content-prompt-return-template.md) 的第二张表；Provider、模型参数、Schema、部署方式和后端验收记录由算法/全栈负责。

全栈的完成标准和“Prompt 回传后还差什么”见 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md)。收到 Prompt 只能说明技术侧拿到了接入输入，不能直接说明 Provider 已接入或产品已经可用。

## 产品现在拿到的内容

| 编号 | 能力 | Prompt package | 请求 Schema | 当前交付状态 |
|---:|---|---|---|---|
| 1 | 人物介绍整理 | [`01-introduction.md`](./01-introduction.md) | [`request-introduction.json`](./schemas/request-introduction.json) | 可直接调试 |
| 2 | 照片描述整理 | [`02-caption.md`](./02-caption.md) | [`request-caption.json`](./schemas/request-caption.json) | 可接入；首版只处理文字描述 |
| 3 | 故事正文整理 | [`03-story-body.md`](./03-story-body.md) | [`request-story-body.json`](./schemas/request-story-body.json) | 可直接调试 |
| 4 | 祝福润色 | [`04-wish-polish.md`](./04-wish-polish.md) | [`request-wish-polish.json`](./schemas/request-wish-polish.json) | 可直接调试 |
| 5 | 总信首次生成 | [`05-collective-letter-generate.md`](./05-collective-letter-generate.md) | [`request-collective-letter-generate.json`](./schemas/request-collective-letter-generate.json) | 契约已冻结；只接受作者确认且统筹逐条批准的素材 |
| 6 | 礼后问候整理 | [`06-post-event-message.md`](./06-post-event-message.md) | [`request-post-event-message.json`](./schemas/request-post-event-message.json) | 可直接调试 |
| 7 | 邀请寄语 | [`07-invitation-message.md`](./07-invitation-message.md) | [`request-invitation-message.json`](./schemas/request-invitation-message.json) | 固定邀请模板先行；`polish` 只处理已有草稿；分享和准入边界已冻结 |
| 8 | 祝福空输入起笔 | [`08-wish-starter.md`](./08-wish-starter.md) | [`request-wish-starter.json`](./schemas/request-wish-starter.json) | 6 条静态模板；无 Prompt、模型参数、Provider 或 App 路由 |
| 9 | 总信局部编辑 | [`09-collective-letter-edit.md`](./09-collective-letter-edit.md) | [`request-collective-letter-edit.json`](./schemas/request-collective-letter-edit.json) | 选区、保护范围、revision/hash、撤销和依赖规则已冻结 |

所有模型能力共用成功响应 [`response-candidate.json`](./schemas/response-candidate.json)；08 返回静态模板列表，不使用该模型响应。回归样例见 [`fixtures/p0-golden-bad.jsonl`](./fixtures/p0-golden-bad.jsonl)，分层规范见 [`00-prompt-design.md`](./00-prompt-design.md)。1、2、3、4、6 沿用 `v1.2.0-content-review` Prompt 基线；05、07、08、09 的业务和技术契约按 `v1.2.3` 冻结。每条模型路由的完整、唯一 `promptVersion` 以 [`10-fullstack-spec-draft.md`](./10-fullstack-spec-draft.md) 路由表为准，08 只记录 `templateVersion=v1.2.3`。

R1～R5 的最终实施规则、四种风格示例、权限、删除与撤回边界见 [`11-frozen-decisions-implementation.md`](./11-frozen-decisions-implementation.md)。其中 AI-D04 的第三方删除、备份和离线撤回能力仍须上线前技术验收。

## 算法/全栈实现方式（平台无关）

全栈按 `purpose + mode` 路由到一个受控模型 Provider。Provider 可以是 Spring AI、模型网关、自建服务或 Dify；平台选择不改变本目录中的输入、输出和安全合同。

```text
后端请求校验
  → 按 purpose + mode 选择 Prompt
  → 组装 System Prompt + User Prompt
  → 调用模型 Provider
  → 解析并校验 text
  → 返回 candidate 响应
```

后端负责输入裁剪、敏感信息过滤、超时/重试/取消、输出校验、候选确认和撤销。模型 Provider 不负责权限、正式数据写入或长期 Memory。

如需要，产品或算法可以在 Dify Studio、本地脚本或其他调试环境中预览 Prompt；“能跑通”不等于“已具备生产接入条件”。其中 5、7、8、9 必须保留上表里的产品/后端门禁。产品/内容只需要把最终 Prompt 对和版本记录回传。

算法/全栈接手后，每个模型调用按对应能力文档分别配置：

1. **System Prompt**：固定任务、事实边界、注入隔离和输出合同；不随用户素材变化。
2. **User Prompt**：插入本次请求的最小输入；实现时使用安全的变量绑定或 JSON 序列化，不拼接未经转义的原文。
3. **Model Parameters**：记录 provider、model、temperature、top_p、max tokens 和发布日期。默认 `top_p=1.0`，先只调 temperature。
4. **Structured Output**：如 Provider 支持 JSON Schema，最小形状为 `{"text":"string"}`；不支持时由后端严格解析和校验。

1～9 的具体 System/User/参数模板见 [`00-prompt-design.md`](./00-prompt-design.md) 以及各能力文件。产品可以修改语气、示例和 Prompt 表达方式；模型参数由算法/全栈配置，不能删除事实保护、候选确认和后端门禁。

### 可选：用 Dify 做 Prompt 预览

产品不需要创建生产 App、配置复杂 Workflow、导出 DSL 或接入后端 Tool。若要预览，只需使用最小的 `输入 → LLM → 输出` 流程；Dify 变量映射只服务于调试，不改变本目录中的接口契约。

## 产品可以改什么

- 可以调整：措辞、语气、长度提示、段落风格和示例；模型参数由算法/全栈接手。
- 不可以自行改变：输入字段名和含义、事实不得补造、候选必须确认后应用、敏感信息边界、输出 JSON 结构、revision/hash 校验职责。
- 如果确实需要改变契约，先记录成“契约变更提案”，由算法、产品、全栈共同冻结新版本，不能直接在 Dify 里暗改。

## 算法/全栈接手时需要的记录（产品/内容不必填写）

产品和内容同事只需要使用 [`product-content-prompt-return-template.md`](./product-content-prompt-return-template.md)。下面的 YAML 是算法/全栈完成 Provider 接入后补充的技术记录，不是产品/内容的必交项。

```yaml
capability: CAPTION
mode: polish
providerType: "待算法/全栈填写，例如 spring-ai、model-gateway、dify"
providerName: "待算法/全栈填写"
providerResourceId: "待算法/全栈填写；不是 API Key"
promptVersion: caption-v1.2.0-content-review
modelProvider: "待算法/全栈填写"
modelName: "待算法/全栈填写"
modelParameters: "temperature 等非密钥配置摘要"
fixtureResults:
  - fixtureId: r2-caption-golden-001
    passed: true
    output: "脱敏后的实际候选"
  - fixtureId: r2-caption-bad-001
    passed: false
    failureReason: "模型补出了具体年份"
knownLimitations: []
deploymentConfigPath: "待算法/全栈填写；不得包含密钥"
reviewer: "待填写"
reviewedAt: "待填写"
```

产品不得在文档、配置、截图或聊天中粘贴任何 Provider 的 API Key。模型、插件、部署状态和调用结果都要在目标环境重新验证。

## 调试完成的判定

一个能力只有同时满足下列条件，才从“产品 Prompt 调整中”进入“算法冻结候选”：

1. 基线的正常与 bad case 均已运行，并保存断言结果；
2. 输出能稳定解析为 `{"text":"..."}`，没有空文本或额外解释；
3. 没有新增输入外事实，没有执行素材中的 Prompt Injection；
4. 产品/内容提交最终 Prompt 和准确的 `promptVersion`；算法/全栈补齐模型配置摘要和不含密钥的部署配置；
5. 算法端复核后，更新能力卡与全栈规格草案中的版本占位符。

## 交给全栈的不是一段 Prompt

产品回传 Prompt 后，算法端会把以下内容合成一个冻结包：Prompt 版本、`purpose + mode` 路由、请求/响应 Schema、错误语义、fixture 结果、安全边界和未完成门禁。全栈按 [`10-fullstack-spec-draft.md`](./10-fullstack-spec-draft.md) 及 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md) 开发，不需要根据自然语言 Prompt 猜接口。
