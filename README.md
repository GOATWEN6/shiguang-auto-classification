# 拾光叙算法交付仓库

本仓库同时承载多个相互独立的算法交付分支。请先按项目选择分支，不要把荣休礼、访谈／Memory 和自动分类的接口或业务状态混用。本次只新增荣休礼分支，不修改其他分支；其他分支是否已同步到某个远端，以该远端实际分支列表为准。

| 分支 | 项目范围 | 主要入口 | 状态说明 |
|---|---|---|---|
| `main` | 拾光自动分类基础入口 | 根目录 README | 仓库基础分支 |
| `codex/sgx-algorithm-candidate-2026-10-15` | 自动分类候选交付 | 分支根 README、`FULLSTACK_INTEGRATION_GUIDE.md` | internal release candidate，按分支内 README 与证据判断 |
| `codex/interview-memory-fullstack-handoff-2026-10-14` | 访谈与 Memory 全栈交接 | `docs/handoffs/2026-10-14-algorithm-fullstack-handoff-v0.1/README.md` | 独立交接分支，与荣休礼业务分离 |
| `codex/rongxiu-algorithm-handoff-v1.2.3` | 荣休礼 1～9 平台无关算法规格与全栈交接 | [`product-handoffs/rongxiu-algorithm-fullstack-handoff-v1.2.3/README.md`](product-handoffs/rongxiu-algorithm-fullstack-handoff-v1.2.3/README.md) | 本分支；Dify 仅为可选调试工具 |

## 本分支交付范围

本分支只提供荣休礼 1～9 的业务决策、Prompt、请求/响应 Schema、fixture、全栈接入与验收边界，以及可选 Dify 映射。它不包含老人 App 的访谈／Memory 流程，也不把 Dify Workflow 当作生产实现前提。

交接时直接使用仓库目录：

- 可阅读目录：[`product-handoffs/rongxiu-algorithm-fullstack-handoff-v1.2.3/`](product-handoffs/rongxiu-algorithm-fullstack-handoff-v1.2.3/)
- 本版不生成或提交 ZIP；Gitee 分支中的目录内容就是交付物。

生产接入仍需全栈在目标环境完成 Provider、权限、候选确认／撤销、revision/hash、删除与离线撤回验收。包内的 `AI-D04` 标记项不能仅凭文档视为已实现。
