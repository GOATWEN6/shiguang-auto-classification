# 1～9 回归样例

`p0-golden-bad.jsonl` 是给产品可选预览 Prompt、给算法端做离线回归、给全栈联调接口时共用的最小样例集。内容全部为合成材料，不包含真实老人、家庭或投稿人的个人信息。

每行一个 JSON 对象：

- `kind=golden`：应能生成可编辑候选，重点检查事实边界、长度和语气。
- `kind=bad`：应拒绝、降级或保持不确定表达，不能“为了有结果而编造”。
- `assertions`：验收断言；产品调 Prompt 后必须逐条复测，不能只看“读起来顺不顺”。
- `expectedStatus`：用于验证稳定错误或业务门禁，例如 `EMPTY_INPUT`、`REVISION_CONFLICT`、`INVALID_SELECTION`、`PROTECTED_CONTENT_CHANGED`。出现这类状态时不得为了返回文案而绕过门禁。
- `testLayer`：`model` 表示经后端最小投影后可用于 Prompt/模型回归；`backend` 表示权限、revision、候选采用、分享或撤回等服务端门禁；`static` 表示 08 本地模板函数。三层必须分别运行，不能把整份 JSONL 直接送进 Dify 或其他模型平台。
- `expectedOutput`：用于 08 的确定性静态结果；08 没有 Dify App、Prompt、模型参数或 Provider 调用。
- `row=0`：跨能力的数据生命周期用例，验证来源撤回、依赖失效和离线重连顺序，不代表新增第 0 个产品功能。

05、07、08、09 的样例已经按 `v1.2.3` 冻结决策更新：05 使用 `style` 和匿名素材投影，07 是礼前邀请亲友共创且只润色已有草稿，08 是两批静态起笔，09 使用 selection、protectedRanges、revision/hash 和数组形式 approvedFacts。fixture 中的 `inputHash`、revision、sourceRef 属业务后端测试数据，不应出现在模型 Prompt。

算法/全栈联调时记录：`fixtureId`、`testLayer`、Provider/应用标识、`promptVersion`、模型配置摘要、实际输出、断言结果和失败原因。产品/内容不需要填写这些技术字段。完整输出中不得记录 API Key、原始敏感材料或可识别家庭信息。
