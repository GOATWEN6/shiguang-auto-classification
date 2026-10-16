# 荣休礼 1～9 算法规格与全栈交接包 v1.2.3

这是一份可直接交给产品、算法和全栈工程师的自包含交接包。它把已经确认的 Q1～Q10 与 R1～R5 转成平台无关的 Prompt、Schema、静态模板、权限规则、候选闭环、测试样例和验收门禁。

Dify 只作为可选 Prompt 调试工具。全栈可以选择 Spring AI、模型网关、自建服务或 Dify Provider；选择哪一种都不能改变本包的字段语义、权限检查、candidate 规则和撤回逻辑。

## 先读这些文件

1. [`FULLSTACK_HANDOFF-v1.2.0.md`](docs/algorithms/rongxiu-1-9/FULLSTACK_HANDOFF-v1.2.0.md)：全栈主入口。文件名为兼容旧引用保留，正文合同是 v1.2.3。
2. [`11-frozen-decisions-implementation.md`](docs/algorithms/rongxiu-1-9/11-frozen-decisions-implementation.md)：R1～R5 的最终字段、交互、留存和撤回规则。
3. [`capability-matrix.md`](docs/algorithms/rongxiu-1-9/capability-matrix.md)：1～9 路由、输入输出、状态和错误语义。
4. [`10-fullstack-spec-draft.md`](docs/algorithms/rongxiu-1-9/10-fullstack-spec-draft.md)：服务端 Provider、候选闭环和各能力实现要求。
5. [`schemas/README.md`](docs/algorithms/rongxiu-1-9/schemas/README.md)：请求/响应 Schema；[`fixtures/README.md`](docs/algorithms/rongxiu-1-9/fixtures/README.md)：27 条合成回归样例。
6. [`fullstack-acceptance-boundary.md`](docs/algorithms/rongxiu-1-9/fullstack-acceptance-boundary.md)：从收到 Prompt 到可发布的证据门禁。
7. [`dify/README.md`](dify/README.md)：只有选择 Dify 调试或作为 Provider 时再读。

## 1～9 的实现结论

| 编号 | 实现方式 | 当前合同 |
|---:|---|---|
| 1 | AI candidate | 整理已有人物介绍，不补造经历 |
| 2 | AI candidate | 只处理文字或确认后的转写；图像分类、照片成故事另行实现 |
| 3 | AI candidate | 整理已有故事正文，保留 revision 和事实边界 |
| 4 | AI candidate | 只润色用户已有祝福 |
| 5 | AI candidate | 只使用作者确认且有效统筹逐条批准的素材；匿名投影和四种 `style` 已冻结 |
| 6 | AI candidate | 只润色已有礼后问候草稿 |
| 7 | 固定模板 + 可选 AI 润色 | 礼前邀请亲友共创；只有已有寄语草稿才调用模型 |
| 8 | 静态本地模板 | 6 条起笔、每批 3 条；无 Prompt、Provider、Dify App 或 Workflow |
| 9 | AI candidate + 后端强校验 | 有效统筹选区编辑；非选区逐字保护，采用和撤销都生成新 revision |

所有 AI 输出只创建 candidate。确认前不能覆盖正式内容、自动发送或写入长期 Memory。08 的静态模板也只填入可编辑草稿，不自动提交。

## 全栈实施顺序

1. 按 `purpose + mode` 建立服务端路由，前端不接触 Provider URL 或 Key。
2. 使用 `schemas/` 校验业务请求；完成权限、审批、用途、revision/hash 检查后，再生成模型最小投影。
3. 配置每项能力的 System/User Prompt 和参数。08 直接读取版本化静态模板，不建立模型路由。
4. 严格解析模型的 `{"text":"..."}`，校验长度、禁止字段和事实边界，只保存为 candidate。
5. 实现确认、拒绝、重新生成、采用、撤销和冲突处理；05/09 记录所有实际入模素材依赖。
6. 用 `fixtures/p0-golden-bad.jsonl` 覆盖正常、空值、注入、匿名来源、风格切换、分享准入、静态模板、选区保护和来源撤回。
7. 在目标 Provider 与目标客户端补齐运行证据，按验收状态逐级推进。

## 关键数据边界

- 05/09 的业务素材含 `sourceRef`，用于后端权限、审批和原素材映射；送模型前必须移除。
- `sourceType` 是素材类型；`narrativeAttribution` 是叙述归属，二者不能合并。每条素材都有独立 `materialLabel`。
- 09 的坐标基于原始字符串 Unicode code point，使用左闭右开区间；校验前不能 NFC、trim 或修改换行。
- 自动跨项目 Memory 和长期画像关闭。本项目历史只有在用户显式选择且权限仍有效时才可复用。
- 待审素材不能送入总信；分享链接不授予管理权，分享点击不等于送达。

## AI-D04 上线限制

产品建议的留存基线已经写入规格：未采用候选 7 天、临时转写音频失败恢复最长 24 小时、用户原件普通删除恢复期 30 天、审计元数据 180 天。它们仍需全栈核对真实存储实现。

第三方删除、备份清理、离线设备重连先处理撤回、离线许可有效期和真实清理时限必须通过 `AI-D04` 目标环境验收。在这项门禁通过前，不能把建议期限写成已实现的生产或隐私承诺。

## 包内没有什么

- 没有生产 API Key、Token、私钥、真实账号或真实投稿素材。
- 没有可直接上传的 Dify DSL，也没有已创建/发布 App 的声明。
- 没有 Provider 接入、目标环境运行或真实用户验收结果。
- 没有老人 App 的访谈／Memory 业务；两者只可在算法底层复用通用组件。

文件清单见 [`PACKAGE-MANIFEST.md`](PACKAGE-MANIFEST.md)，本轮检查记录见 [`VALIDATION.md`](VALIDATION.md)。
