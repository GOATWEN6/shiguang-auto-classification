# 1～9 能力包变更记录

## v1.2.3-frozen-handoff — 2026-10-16

- 冻结 R1～R4：05 使用匿名作者、逐素材标记和独立叙述归属；四个 `style` 使用小写枚举；07 的礼前共创、分享与准入边界确定；08 固定为 6 条静态起笔、每批 3 条，无模型路由。
- 冻结 09 的原字符串 Unicode code point 左闭右开坐标、非选区逐字保护、revision/hash、采用/撤销新 revision 和来源许可撤回规则。
- 将业务请求信封与模型最小投影分开；05 送模型前移除 `sourceRef`，真实账号、审批记录和来源映射只留后端。
- 将 R5 留存期限登记为实施基线；第三方删除、备份和离线撤回能力继续作为 `AI-D04` 上线前技术验收项。
- Dify 继续作为可选 Prompt 调试工具；08 不创建 App/Workflow，生产接入可使用 Spring AI、模型网关、自建服务或其他 Provider。
- 统一业务长度由后端按 NFC/code point/忽略换行口径校验，新增 `INPUT_TOO_LONG`；补齐 `NO_APPROVED_MATERIALS`、`NOT_APPLICABLE`、`INVALID_SELECTION`、`PERMISSION_REVOKED` 等稳定错误语义。
- 成功响应 Schema 只接受八条已冻结模型路由；fixtures 增加 `model/backend/static` 分层，避免把静态模板、分享准入、revision 或撤回测试误送模型平台。
- 为每条模型路由冻结唯一 `promptVersion`；历史审阅与问卷文档明确标记为已被 v1.2.3 取代。

## v1.2.2-product-decisions-received — 2026-10-14

- 回写产品对 Q1～Q10 的决策：1、2、3、4、5、6、9 使用 AI 候选；7 仅润色已有草稿；8 改为静态起笔模板，不配置模型路由。
- 将总信风格改为可选四风格并默认自然口述，增加匿名来源/叙述归属投影约束，明确待审稿不得进入总信。
- 明确总信固定标题、默认无小标题、主题重排但不编造时间/因果，集体署名和最终确认由业务层管理。
- 明确总信局部编辑只允许当前有效统筹选区操作，保护非选区、署名、来源、争议提示和 AI 标识；新 revision 使旧确认失效并支持撤销。
- 将留存期限、第三方删除和离线撤回标为 AI-D04 待冻结建议，不写成生产承诺。

## v1.2.1-platform-neutral-handoff — 2026-10-14

- 将核心交付从 Dify 配置改为平台无关的算法规格与全栈接入契约。
- 明确 Provider 可以是 Spring AI、模型网关、自建服务或 Dify；Dify 仅作为可选 Prompt 调试工具。
- 更新能力矩阵、Prompt 规范、Schema、fixtures、产品阅读说明、全栈验收边界和交接包，去除 Dify 作为生产实现前置条件的表述。
- 保留 `dify/` 目录作为可选调试和平台映射资料，不作为产品/算法/全栈的核心交付格式。

## v1.2.0-content-review — 2026-10-14

- 审阅产品内容负责人回传的 1～9 Prompt 包：保留其 System/User Prompt、事实边界、候选输出和注入隔离规则。
- 统一总信字段为 `materials`、`letterText`、`instruction`、`approvedFacts`、`inputHash`，旧字段只作迁移记录。
- 增加 Dify Workflow 技术配置、模型参数起点、Structured Output 和 03/05/09 的长文本/差异校验门禁。
- 明确 07/08 先以固定模板或原型验证，09 未完成后端保护范围与 revision 校验前不能标记为生产可用。

## v0.3.0 — 2026-10-13

- 将产品/内容交付边界收敛为“只回传最终 System Prompt + User Prompt”；Dify Workflow、模型参数、Schema、DSL、Provider、候选闭环和发布验收统一归算法/全栈负责。
- 新增 `fullstack-acceptance-boundary.md`，用 `PROMPT_RECEIVED`、`CONTRACT_FROZEN`、`PROVIDER_INTEGRATED`、`CANDIDATE_LOOP_VERIFIED`、`PRODUCT_ACCEPTED`、`RELEASE_READY` 区分接手输入、技术接入和产品可用。
- 更新产品阅读说明、Prompt 回传模板和全栈规格，明确产品不需要搭复杂 Workflow；Dify 只可作为 `Start/User Input → LLM → Output` 预览台。
- 重新生成 `rongxiu-dify-product-handoff-v0.3.0` 自包含文件夹和压缩包；目标 Dify workspace、密钥、发布状态和真实用户验收仍不包含在包内。

## v0.2.0 — 2026-10-12

- 将 1～9 的单段 Prompt 重写为 System Prompt、User Prompt、模型参数、Structured Output、后端元数据和验收断言六层交付包。
- 明确 Dify 使用 Workflow + Start/User Input + LLM + Output；一次性文本能力关闭 Chatflow Memory、Knowledge 和工具调用。
- 为人物介绍、照片描述、故事正文、祝福、总信、礼后问候、邀请寄语、起笔和局部编辑补齐事实边界、注入隔离、硬字数和候选确认规则。
- 增加统一 Prompt 设计与 Dify 配置规范，记录官方文档依据和 Unicode 字符计数口径。
- 增加面向产品的阅读说明；将 Dify manifest 的本机绝对路径改为可随交付包携带的相对引用。
- 明确产品/内容本次只回传 System Prompt、User Prompt 和必要的非 Prompt 改动表；完整 Workflow、Schema、模型参数和 DSL 由算法/全栈接手。

## v0.1.1 — 2026-10-12

- 增加产品端 Dify 调试入口，统一 1～9 Prompt、Schema、回归和回传要求。
- 增加全栈接入规格草案，标明可以提前开发和必须等待冻结的部分。
- 增加合成 Golden/Bad fixture，覆盖 1、2、3、4、5、6、9 的首批边界。

## v0.1.0 — 2026-10-12

- 建立图片 1～9 的能力矩阵。
- 提供首版 Capability Card 和 Prompt baseline。
- 明确 `COLLECTIVE_LETTER`、`INVITATION_MESSAGE`、`WISH starter` 和局部编辑的协议缺口。
- 明确所有模型结果均为 candidate，不能绕过后端确认和撤销。
- 待产品在 Dify Workflow 调整后，补充 `promptVersion`、App/Workflow 标识和测试记录。
