# 荣休礼 Dify 可选调试说明

版本：`v1.2.3`
定位：Prompt 预览和模型 Provider 映射参考，不是核心交付格式，也不是生产实现前置条件。

平台无关的算法规格与全栈合同以 [`FULLSTACK_HANDOFF-v1.2.0.md`](../docs/algorithms/rongxiu-1-9/FULLSTACK_HANDOFF-v1.2.0.md) 为入口。产品/内容同事只需维护模型能力的 System Prompt、User Prompt 和内容版本；08 维护静态模板版本和文案。Dify App、模型、密钥、超时、重试、权限与候选闭环由算法/全栈负责。

本目录没有可直接导入的 Dify DSL。`app-manifest.json` 是平台映射清单，不能上传为 DSL，也不代表对应 App 已经创建、发布或验收。

## 什么时候使用

团队选择 Dify 预览 Prompt 时，每条模型能力可以建立最小 Workflow：

```text
Start / User Input → LLM → Output
```

需要调试输入门禁时，可以在 LLM 前后增加 IF/ELSE 或 Code。跨请求 Memory、Knowledge、Vision 和外部工具默认关闭；`CAPTION` 首期只接收已确认的文字描述。

Dify 只返回候选文本。权限检查、已批准素材筛选、版本冲突、候选采用、撤销、用途撤回、留存和删除均由业务后端处理。

## 1～9 映射

| 编号 | purpose / mode | Dify 映射 | 说明 |
|---:|---|---|---|
| 1 | `INTRODUCTION/polish` | 可选 Workflow | 润色已有介绍 |
| 2 | `CAPTION/polish` | 可选 Workflow | 只处理文字或确认转写 |
| 3 | `STORY/body` | 可选 Workflow | 整理已有故事正文 |
| 4 | `WISH/polish` | 可选 Workflow | 润色已有个人祝福 |
| 5 | `COLLECTIVE_LETTER/generate` | 可选 Workflow | 后端先验证并投影逐条批准的素材 |
| 6 | `POST_EVENT_MESSAGE/polish` | 可选 Workflow | 润色已有礼后问候草稿 |
| 7 | `INVITATION_MESSAGE/polish` | 可选 Workflow | 固定邀请模板之后，只有已有寄语草稿才调用 |
| 8 | `WISH/starter` | **无 App、无模型路由** | 本地静态起笔，每批 3 条，支持换一批 |
| 9 | `COLLECTIVE_LETTER/edit` | 可选 Workflow | 后端校验选区、保护区、revision 和逐字差异 |

具体映射见 [`app-manifest.json`](./app-manifest.json)，参数与变量投影见 [`workflow-config-v1.2.0.md`](./workflow-config-v1.2.0.md)。清单中的 `referenceName` 只用于团队命名，不是已创建 App 的证明。

## 业务请求与模型输入

业务 API Schema 是后端合同；Dify Start 变量只承载模型需要的最小投影。两者不能直接等同。

- `inputHash`、`letterRevision`、真实 `sourceRef`、账号映射、审批与权限元数据只留后端，不进入模型 Prompt。
- 05/09 的每条素材投影为 `sourceType`、`authorLabel`、`materialLabel`、`narrativeAttribution` 和 `text`。
- `sourceType` 表示素材类型；`narrativeAttribution` 表示谁经历、依据是亲历还是转述，两者不可合并。
- `style` 使用 `natural_oral`、`soft_literary`、`calm_dignified`、`formal_sincere`；缺省值由后端补成 `natural_oral`。
- 08 的请求由本地函数处理，不能为了统一画布而送入 Dify。

## 快速建立与迁移

已有同版本 Dify DSL 时，可以通过 Studio 的“导入 DSL”建立草稿；导入后逐项重选目标工作区的模型和插件，再运行 fixtures 并发布。密钥、令牌和数据库凭据在目标环境重新配置，不写入 DSL 或仓库。

只有 Prompt 和规格时，按以下顺序建立：

1. 在目标工作区手工创建一个最小 Workflow，并从该工作区导出 DSL，确认当前 Dify 版本和节点格式。
2. 按 `app-manifest.json` 配置 Start 变量、System/User Prompt、模型参数和 `{\"text\":\"...\"}` Structured Output。
3. 从 [`p0-golden-bad.jsonl`](../docs/algorithms/rongxiu-1-9/fixtures/p0-golden-bad.jsonl) 中只选 `testLayer=model` 的样例，经后端最小投影后做 Studio Test Run；`testLayer=backend` 和 `testLayer=static` 分别在服务端 harness 与本地静态函数中验证。
4. 导出已验证的 DSL，记录模型、Prompt 版本和测试证据，再由全栈接入服务端。

不要把整份 JSONL 直接当作 Dify 输入，因为它还包含 revision、`sourceRef`、分享准入、静态模板和撤回等非模型测试。不要根据文档手写猜测版本的 YAML，也不要把 App 页面能运行视为业务接口已经可用。

## 服务端接入边界

前端不保存 Dify URL 或 API Key。服务端负责固定路由、超时、重试、取消、幂等、错误映射、输出校验和审计摘要，并且只把成功结果保存为待确认 candidate。

至少覆盖以下失败：空输入、超长输入、类型错误、Prompt Injection、敏感字段、超时、限流、鉴权失败、Provider 5xx、非法 JSON、空文本和超长输出。长文超过模型预算时返回稳定错误或转异步，不能静默截断后标记成功。

生产发布还需证明：

- 05 只使用用途仍有效、且有效统筹逐条批准的素材；待审稿不入模；
- 07 空草稿不调用 Provider，分享点击不记为“已送达”，转发入口不授予管理权；
- 09 选区与原文一致，非选区及保护内容逐字不变，采用与撤销都会产生新 revision；
- 来源撤回后，依赖该素材且失去用途许可的候选或成品停止采用、展示和分享；
- 第三方删除、备份删除、离线撤回和真实留存期限通过 AI-D04 上线验收。
