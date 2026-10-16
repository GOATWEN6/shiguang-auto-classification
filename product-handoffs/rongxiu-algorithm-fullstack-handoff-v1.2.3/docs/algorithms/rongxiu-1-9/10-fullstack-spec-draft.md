# 荣休礼 1～9：全栈接入规格 v1.2.3

> 状态：`READY_FOR_FULLSTACK_IMPLEMENTATION_WITH_AI_D04_ACCEPTANCE_GATE`
>
> 本文是算法/全栈技术文档。产品和内容同事只需要回传最终 System Prompt + User Prompt；模型 Provider、模型参数、Schema、部署方式和发布验收由算法/全栈完成。Dify 仅是可选调试工具。产品回传 Prompt 后，按 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md) 推进状态，不得把“收到 Prompt”当作“产品已可用”。

R1～R5 的产品口径已冻结，可按本文和各能力规格实现。AI-D04 的期限、第三方/备份删除能力、离线撤回和离线许可有效期仍须在目标环境完成技术冻结和上线验收。

平台无关的调用骨架、模型参数起点和 05/09 门禁见 [`00-prompt-design.md`](./00-prompt-design.md)；如选择 Dify 调试，再参考 [`dify/workflow-config-v1.2.0.md`](../../../dify/workflow-config-v1.2.0.md)。

## 1. 接入结论

调用链固定为：

```text
小程序/相框
  → Spring assistant-jobs / AssistantProvider
  → 受控模型 Provider（Spring AI、模型网关、自建服务或可选 Dify）
  → Spring 校验并保存 candidate
  → 用户确认
  → 应用到业务数据
```

- 浏览器、小程序和相框端不直接持有 Provider URL、App Key 或模型密钥。
- 模型 Provider 只生成 candidate，不负责权限、数据库写入、长期 Memory、确认、撤销和正式版本。
- 全栈按 `purpose + mode` 路由，不能只按自然语言场景名猜测调用目标。
- 产品/内容只提供 Prompt 对和版本记录；技术侧负责把 Prompt 映射到可审查的 Provider 配置。

## 2. 可以提前开发的冻结部分

以下部分不依赖产品最终措辞，可以立即实现：

1. 统一请求信封与各能力输入校验：见 [`capability-matrix.md`](./capability-matrix.md) 和 [`schemas/`](./schemas/README.md)。
2. 统一候选响应：见 [`response-candidate.json`](./schemas/response-candidate.json)。
3. `purpose + mode → provider configuration` 路由接口；资源 ID 和 Key 先用环境配置占位。
4. 超时、限流、Provider 失败、非法输出和 revision conflict 的稳定错误映射。
5. candidate 的确认、应用和撤销闭环；生成结果不得直接覆盖原文。
6. traceId、promptVersion、modelVersion、耗时和结果状态日志；日志不得保存密钥和未脱敏原文。

产品调 Prompt 只会替换 Prompt 版本配置，不应要求全栈重写请求/响应协议；如果 Prompt 变更了输入或输出合同，必须走第二张回传表和契约变更评审。

## 3. 路由表

| 能力 | purpose | mode | Prompt package | Provider 接入 | 接入状态 |
|---|---|---|---|---|---|
| 人物介绍整理 | `INTRODUCTION` | `polish` | `introduction-v1.2.0-content-review` | 待算法/全栈配置 | 可提前接 Provider stub |
| 照片描述整理 | `CAPTION` | `polish` | `caption-v1.2.0-content-review` | 待算法/全栈配置 | 可提前接 Provider stub；首版无图片理解 |
| 故事正文整理 | `STORY` | `body` | `story-body-v1.2.0-content-review` | 待算法/全栈配置 | 可提前接 Provider stub；必须带 revision |
| 祝福润色 | `WISH` | `polish` | `wish-polish-v1.2.0-content-review` | 待算法/全栈配置 | 可提前接 Provider stub |
| 总信首次生成 | `COLLECTIVE_LETTER` | `generate` | `collective-letter-generate-v1.2.3` | 待算法/全栈配置 | 可实现；匿名投影、style 默认值、审批复核、依赖记录和 inputHash 均为强制门禁 |
| 礼后问候整理 | `POST_EVENT_MESSAGE` | `polish` | `post-event-message-v1.2.0-content-review` | 待算法/全栈配置 | 可提前接 Provider stub |
| 邀请寄语 | `INVITATION_MESSAGE` | `polish` | `invitation-message-polish-v1.2.3` | 待算法/全栈配置 | 只润色已有草稿；固定模板、入口、分享与准入规则已冻结 |
| 祝福空输入起笔 | `WISH` | `starter`（静态本地函数） | —（`templateVersion=v1.2.3`） | 不接 Provider | 6 条通用起笔、两批轮换；点击填入草稿，不自动提交 |
| 总信局部编辑 | `COLLECTIVE_LETTER` | `edit` | `collective-letter-edit-v1.2.3` | 待算法/全栈配置 | 有效统筹选区；code point 索引、保护区逐字比较、revision/hash、采用和撤销均须落地 |

Provider 的实际名称、资源 ID、模型版本和发布状态不在产品回传表中填写，接入后由算法/全栈记录在受控技术配置中。

## 4. 请求与响应

统一请求信封、成功响应和错误语义以 [`capability-matrix.md`](./capability-matrix.md) 为准。各 `input` 的 JSON Schema 位于 [`schemas/`](./schemas/README.md)。

Provider 返回成功前至少校验：

- HTTP/Provider 调用成功；
- Provider 输出可解析；
- `text` 为非空字符串；
- 长度满足对应能力约束；
- `purpose`、`mode`、`promptVersion` 与本次请求一致；
- job 未取消，相关原文 revision/inputHash 仍有效。

任一条件不满足都不能保存为成功 candidate，更不能应用到正式内容。

### 4.1 05：匿名素材投影、审批与风格

后端业务请求中的每条素材采用 [`approved-material.json`](./schemas/approved-material.json)，严格区分素材类型和叙述归属：

```json
{
  "sourceType": "STORY",
  "sourceRef": "backend-only-reference",
  "authorLabel": "投稿者A",
  "materialLabel": "素材A-01",
  "narrativeAttribution": {
    "experienceSubject": "AUTHOR",
    "basis": "FIRSTHAND"
  },
  "text": "已获准素材"
}
```

- 模型调用前必须移除 `sourceRef`；真实账号、手机号、审批记录、权限信息和匿名映射只留后端。
- 同一作者的 `authorLabel` 在项目内稳定，每条素材的 `materialLabel` 唯一。审核页显示匿名标签；有权限的统筹经后端映射查看原素材，正文不输出内部标签。
- 后端在生成前和应用候选时复核作者用途确认、有效统筹逐条批准、素材 revision 和当前权限；待审稿不得进入模型。
- `style` 仅允许 `natural_oral | soft_literary | calm_dignified | formal_sincere`。前端名称依次为“自然口述、文辞柔美、沉静大气、郑重真诚”。
- 风格控件默认可见并预选 `natural_oral`；后端负责补缺省值。旧 `tone` 只由兼容层按核实后的历史值映射。
- 换风格生成时保留人工修改稿，新结果先预览，采用后重新确认。
- 所有实际送入模型的素材都建立依赖记录，即使成品没有直接引用对应文字。

### 4.2 07：模板、AI 润色与分享

- 入口固定为统筹项目主页“邀请亲友共创”，项目发起完成后仍可进入；项目名称、截止日期等复用已有资料。
- 系统先拼装固定邀请模板。只有统筹提供非空白寄语草稿时，才可调用 `INVITATION_MESSAGE/polish`；空白草稿返回 `EMPTY_INPUT`，不配置 `starter` 模型路由。
- 统筹预览后主动分享；支持微信好友/群分享、二维码海报，复制链接按实际渠道能力开放。可面向多人，但不读取通讯录、不自动群发。
- 普通共创入口允许转发。进入者仍须登录、确认身份关系并经过投稿审核；转发不授予管理权，也不开放他人私密投稿。
- 分享动作只记录为分享事件，不能写成“已送达”；可分别统计有效进入、参与和投稿。
- “邀请荣休者查看/接收礼物”以后作为独立业务分支，不复用本路由。

### 4.3 08：纯静态起笔

08 是本地确定性函数，没有 System Prompt、User Prompt、模型参数、Provider、Dify App 或 Workflow。首期使用 6 条通用起笔，每批 3 条：

```text
想借这个机会，对您说……
送上这份祝福，愿您……
关于接下来的生活，我想祝您……
此刻最想送给您的一句话是……
有一份心意，想这样告诉您……
写下这段话，我想表达的是……
```

- `batchIndex=0|1`，缺省为 0；“换一批”只切换展示，不改已写草稿。
- 仅正文为空或只有称呼时展示。用户点击模板时再次检查当前正文，避免覆盖并发输入；点击只填入可编辑草稿，不自动提交。
- 用户补充实质表达后才可进入 04 润色；纯模板或仅修改标点不算实质内容。
- 首期不按关系维护多套模板，不记录个人长期浏览历史，也不新增 HTTP 模型接口。

### 4.4 09：局部编辑、保护区和 revision

- 请求必填 `letterText`、`instruction`、`letterRevision`、`inputHash`、`selection`、`protectedRanges`、`approvedFacts`。
- `approvedFacts` 使用已批准素材数组，可为空；调用模型前同样移除每项 `sourceRef`，审批、用途和真实来源映射只留后端。
- `selection={start,end,selectedText}`；保护区项为 `{start,end,kind}`，其中 `kind` 仅允许 `SIGNATURE | SOURCE | DISPUTE_NOTICE | AI_LABEL`。
- 所有坐标基于原字符串 Unicode code point，采用左闭右开区间；校验前不得 NFC、trim 或变更换行。公共业务长度校验可以 NFC 后按 code point 计算、标点和空格计入、换行不计，但不能把该规则用于 09 索引。
- 后端校验选区非空、边界有效、`selectedText` 与原文一致，保护区合法且彼此不重叠，选区不与保护区相交。
- 模型只返回完整 `{"text":"..."}`。后端以原始坐标取得原前缀/后缀，再与候选逐字比较；候选长度变化时不能使用旧坐标截取候选后缀。非选区空格或换行变化也返回 `PROTECTED_CONTENT_CHANGED`。
- 生成只创建 candidate；采用和撤销均生成新 revision，旧确认失效。撤销不能恢复已经撤回的素材许可。
- 生成前和采用时重复检查有效统筹权限、letterRevision、inputHash、素材用途及依赖状态。

### 4.5 AI-D04：留存、删除与撤回门禁

产品建议基线为：未采用候选最后活动后 7 天清理；临时转写音频确认后尽快删除、失败恢复最长 24 小时；用户原件按有效用途保存、普通删除提供 30 天恢复期；审计元数据保留 180 天且默认不含正文、音频或私信全文；已采用成品随有效业务用途保存。

普通删除恢复期内，内容必须退出展示、生成和分享范围。来源撤回后，应立即停用失去对应许可的依赖候选和成品，并清理相关索引；无关内容不整体失效。第三方删除失败时仅保存必要的删除任务标识和状态，不能无限保留本地正文，也不能在完成前显示“已全部删除”。离线设备重连后先处理撤回，再恢复内容访问。

上述期限属于建议基线。第三方/备份删除能力、离线撤回、离线许可有效期和真实清理时限必须由 AI-D04 在目标环境完成技术冻结与上线验收。

## 5. 错误映射

| 外部/内部场景 | 业务错误 | 是否可重试 | 是否保留原文 |
|---|---|---:|---:|
| Provider、Key、模型未配置 | `ALGORITHM_UNAVAILABLE` | 否 | 是 |
| 05 没有用途有效且已逐条批准的素材 | `NO_APPROVED_MATERIALS` | 素材批准后重试 | 是 |
| 必填草稿为空或只有空白字符 | `EMPTY_INPUT` | 补充草稿后重试 | 是 |
| 输入或候选超过业务长度上限 | `INPUT_TOO_LONG` | 缩短内容或转长文流程 | 是 |
| 08 已有实质正文，静态起笔不适用 | `NOT_APPLICABLE` | 内容清空后重新判断 | 是 |
| 09 选区、selectedText 或保护区不合法 | `INVALID_SELECTION` | 重新选择后重试 | 是 |
| 网络或 Provider 超时 | `PROVIDER_TIMEOUT` | 是 | 是 |
| Provider 限流 | `PROVIDER_RATE_LIMITED` | 是 | 是 |
| 401/403/404/5xx、非法 JSON、空或超长 text | `PROVIDER_FAILED` | 视原因 | 是 |
| 原文 revision/inputHash 已改变 | `REVISION_CONFLICT` | 重新生成 | 是 |
| 09 非选区或保护内容发生变化 | `PROTECTED_CONTENT_CHANGED` | 修改选区后重新生成 | 是 |
| 素材用途许可已撤回 | `PERMISSION_REVOKED` | 获得新的有效许可后重新生成 | 是 |
| 用户取消或 job 被取代 | `CANCELLED` | 否 | 是 |

## 6. 待算法/全栈接入后回填的技术字段

产品/内容不填写本节。算法/全栈完成目标环境接入后，为每个 `purpose + mode` 补齐以下记录；密钥只写 secret storage 配置名，不写明文：

- Provider 类型、资源 ID 和实际名称；
- secret storage 中的 Provider Key 配置名；
- 产品回传的 `promptVersion` 与技术配置的对应关系；
- 部署配置版本和不含密钥的配置路径；如选择 Dify，可额外记录 DSL 路径；
- 模型 Provider、模型名和必要参数；
- 超时、重试、取消和幂等策略；
- fixture 通过记录、目标环境调用记录和已知失败边界；
- 负责人、评审时间、当前验收状态（见 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md)）。

示例记录：

```yaml
capability: CAPTION
mode: polish
providerType: "待算法/全栈填写，例如 spring-ai、model-gateway、dify"
providerName: "待算法/全栈填写"
providerResourceId: "待算法/全栈填写；不是 API Key"
secretConfigName: "待算法/全栈填写；不写明文 Key"
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
acceptanceStatus: PROMPT_RECEIVED
reviewer: "待填写"
reviewedAt: "待填写"
```

## 7. 已冻结实现项与待验收项

R1～R4 已形成可实现规格：05 匿名来源投影和小写风格枚举、07 入口/分享/准入、08 六条静态起笔及轮换、09 选区/保护/revision/撤销均不再作为产品待决策项。全栈应按本文、对应能力文档和 JSON Schema 实现，不再自行猜测字段或交互。

仍须在技术接入后回填或验证：

- 各 Provider 的资源 ID、模型名、参数、Prompt 配置版本、超时/重试和实际 SLA；
- 01～07、09 在目标模型上的 fixture、非法输出、超长、取消、冲突和失败恢复证据；
- 07 在各目标客户端上的微信分享、二维码海报与复制链接能力；
- 08 客户端空白判断、点击防覆盖和进入 04 的实质内容判断；
- 09 Unicode code point 坐标、保护区逐字比较、采用/撤销生成 revision 和用途撤回的自动化测试；
- AI-D04 的真实清理时限、第三方/备份删除、离线撤回和离线许可有效期。

只有 AI-D04 最后一项仍属于技术冻结问题，不能把产品建议期限直接写成已上线的隐私承诺。

## 8. 技术验收与产品可用边界

技术验收至少覆盖：

1. 前端无法读取 Provider Key，所有调用经过 Spring；
2. 01～07、09 能命中唯一的 `purpose + mode` Provider 配置；08 只能命中静态本地函数，不能进入模型路由；不支持的能力返回稳定错误；
3. fixture 的正常、空值、超长、注入、不确定事实和 revision conflict 能被复现；
4. 模型生成成功只产生 candidate；确认前不改正式数据。采用与撤销均生成新 revision，且撤销不恢复已经失效的用途许可；
5. 超时、限流、非法输出和取消不会覆盖用户原文；
6. 日志能按 requestId/traceId/promptVersion 定位问题，但不泄露密钥和敏感原文；
7. 目标 Provider/目标环境重新运行过调用和失败恢复，记录未完成门禁。

技术验收通过后仍需产品验收：入口、候选与原文区分、等待/失败提示、确认/拒绝/撤销路径、长文本阅读体验。只有技术验收和产品验收都通过，才能进入 `PRODUCT_ACCEPTED`；全部发布检查通过后才能进入 `RELEASE_READY`。

下列证据不能替代完整验收：

- 收到 Prompt 不能证明 Provider 已接入；
- 任意调试平台能运行不能证明生产接口、权限和候选闭环已通过；
- 接口返回 200 不能证明事实正确或产品体验可用；
- 本地 fixture 通过不能证明真实家庭数据准确率或生产质量；
- 本地文档/部署配置完整不能证明目标模型 Provider 已接入并具备运行依赖。

完整清单见 [`fullstack-acceptance-boundary.md`](./fullstack-acceptance-boundary.md)。
