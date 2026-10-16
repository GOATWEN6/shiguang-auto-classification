# 荣休礼 1～9：全栈交接包 v1.2.3

状态：`READY_FOR_FULLSTACK_IMPLEMENTATION_WITH_AI_D04_ACCEPTANCE_GATE`
文件名保留 v1.2.0 以兼容已有引用；正文和交付合同以 v1.2.3 为准。

这不是“九个模型应用已上线”的声明，而是内容负责人回传包审阅后的平台无关技术交接入口。原始 ZIP 只作为内容审阅记录保存；全栈实现以本目录的算法规格为准。Dify 目录仅提供可选调试参考，不是实现前置条件。

## 交接结论

- 1、2、4、6：可以按当前 Prompt、Schema 和调用骨架开始接 Provider，并进入目标模型回归。
- 3：可以接入，但必须按长文本预算处理；超出 Provider 可用预算时失败或转异步，不得静默截断。
- 5：业务批准、匿名模型输入投影和小写 `style` 枚举均已冻结。待审稿不得进入总信；生成前和采用时都要复核权限、revision、用途和 inputHash。
- 7：主分支为礼前邀请亲友共创投稿；AI 只润色已有草稿，结构化字段由模板管理，入口、分享渠道、转发和准入规则已冻结。
- 8：本期只用 6 条通用静态起笔，两批轮换，不接模型 Provider，也不建立 Dify App/Workflow。
- 9：有效统筹按 Unicode code point 选段编辑，逐字保护非选区及保护字段；采用和撤销均生成新 revision，旧确认失效。
- AI-D04：留存期限采用产品建议基线；第三方/备份删除、离线撤回和离线许可有效期仍需目标环境技术冻结和上线验收。

## 唯一入口与文件

当前实施事实源是 [全栈接入规格](./10-fullstack-spec-draft.md) 与 [冻结决策实施规格](./11-frozen-decisions-implementation.md)。若历史审阅或问卷中的旧状态与当前规格冲突，以这两份文档及其引用的当前 Schema 为准；历史材料只用于追溯决策过程。

1. [能力矩阵](./capability-matrix.md)：`purpose + mode`、输入/输出和统一错误语义。
2. [各能力规格入口](./01-introduction.md)：01～07、09 包含 Prompt、模型参数起点、Structured Output 和后端门禁；08 是静态模板规格。
3. [请求/响应 Schema](./schemas/README.md)：全栈接口校验和 Provider 输入/输出映射。
4. [可选平台映射](../../../dify/app-manifest.json)：如果选择 Dify，可用它记录应用名称、字段和能力状态。
5. [可选 Dify 调试配置](../../../dify/workflow-config-v1.2.0.md)：仅供 Dify 预览，不是全栈实现合同。
6. [全栈接入规格](./10-fullstack-spec-draft.md)：调用链、错误映射、日志和验收条件。
7. [验收状态边界](./fullstack-acceptance-boundary.md)：`PROMPT_RECEIVED` 到 `RELEASE_READY` 的状态定义。
8. [历史审阅快照](./2026-10-14-content-review-v1.2.0.md)：仅用于追溯 v1.2.0 原始回传包当时的问题与处理过程；其中旧“待冻结”“原型”和未决状态不得作为当前实现依据。
9. [产品决策回传记录](./product-decision-record-v0.2.0.md)：Q1～Q10 的产品答复、影响和最小技术冻结项。
10. [冻结决策实施规格](./11-frozen-decisions-implementation.md)：R1～R5 已确认的字段、交互、留存和撤回实现口径，与全栈接入规格共同构成当前实施事实源。

## 平台无关实现要求

每个一次性文本能力使用以下调用骨架；具体由全栈选择 Spring AI、模型网关、自建服务或 Dify：

```text
后端输入校验
  → Prompt 组装（System + User）
  → 模型 Provider
  → 输出解析（仅 text）
  → 后端校验与 candidate 响应
```

跨请求记忆、知识库检索和不必要的工具调用默认关闭；`CAPTION` 首版只处理文字 caption。模型 Provider 只生成 candidate，不负责授权、数据库写入、长期 Memory、确认、撤销或正式版本。

08 是例外：它是本地静态函数，不进入上述模型调用链。01～07、09 才配置模型路由，其中 07 仅开放 `polish`。

模型只返回：

```json
{"text":"候选正文"}
```

Spring 服务端再补齐 `status`、`purpose`、`mode`、`promptVersion`、`traceId` 和 candidate 状态。任何 Provider 的 Key、模型密钥和 URL 都不得进入前端或文档。

05 新接口的风格枚举固定为：

| `style` | 前端名称 |
|---|---|
| `natural_oral` | 自然口述 |
| `soft_literary` | 文辞柔美 |
| `calm_dignified` | 沉静大气 |
| `formal_sincere` | 郑重真诚 |

缺省值由后端补为 `natural_oral`；旧 `tone` 只在兼容层按已核实的历史值映射。模型可见素材包含 `sourceType`、`authorLabel`、`materialLabel`、`narrativeAttribution` 和 `text`，不得包含 `sourceRef`、真实账号或审批元数据。

07 从统筹项目主页“邀请亲友共创”进入，先生成固定模板，有寄语草稿才可选 AI 润色。统筹预览后主动分享；普通共创入口允许转发，但登录、身份关系确认和投稿审核仍然生效。分享点击不能记为送达。

08 固定使用 6 条通用起笔，每批 3 条，仅在正文为空或只有称呼时展示。点击只填入草稿；换一批不改草稿；用户补充实质表达后才进入 04。

09 的请求必须包含 `letterRevision`、`inputHash`、`selection`、`protectedRanges` 和 `approvedFacts`。`approvedFacts` 可为空，送模型前移除 `sourceRef`。选区按原字符串 Unicode code point 左闭右开计算，不做 NFC/trim/换行转换；非选区任何字符变化均拒绝。采用和撤销都生成新 revision，撤销不能恢复已经撤回的素材许可。

## 交接验收

全栈完成每项能力后，至少留下以下证据：

- Provider 类型、资源标识、模型版本和不含密钥的部署配置路径；如果选择 Dify，再附 App/Workflow 名称和不含密钥的 DSL 路径；
- 正常、空输入、超长输入、嵌入指令、敏感字段、非法 JSON、超时/限流的结果和稳定错误码；
- 输出可解析为 `{"text":"..."}`，无额外解释、空文本或静默截断；
- 成功只产生 candidate，用户确认前不写正式数据；
- `promptVersion`、`modelVersion`、输入 hash、耗时和 traceId 可定位，日志不含密钥和未脱敏原文；05/09 可追踪实际模型输入素材依赖；
- 状态从 `PROMPT_RECEIVED` 逐级推进，不能用“调试平台能运行”替代 `PROVIDER_INTEGRATED`、`CANDIDATE_LOOP_VERIFIED` 或 `RELEASE_READY`。

## 已冻结实现口径与上线限制

R1～R4 已转成字段和流程合同，全栈无需再等待产品回答：

- 05 使用 `sourceType + authorLabel + materialLabel + narrativeAttribution + text` 的模型投影，`sourceRef` 只留后端；审核页可按权限回看原素材；
- 07 使用已冻结入口、模板优先、草稿可选润色、主动分享、允许普通入口转发以及登录/身份/审核准入；
- 08 使用 6 条中性模板、两批轮换、点击填草稿和并发防覆盖；首期不做关系模板和长期浏览记忆；
- 09 使用原字符串 code point 坐标、左闭右开选区、保护区逐字校验、新 revision 和用途撤回门禁。

R5 的留存时间是产品建议基线：未采用候选 7 天、临时转写音频最长恢复 24 小时、用户原件普通删除恢复期 30 天、审计元数据 180 天。普通删除恢复期内禁止展示、生成和分享；来源用途撤回后立即停止相应依赖候选/成品继续使用并清理索引。

AI-D04 仍须验证目标第三方和备份的删除能力、离线撤回顺序、离线许可有效期及真实清理时限。未通过该门禁前，不能把建议期限写成已实现的生产或隐私承诺。
