# 1～9 Schema

这些 JSON 文件是算法端给全栈的 v1.2.3 请求契约。后端必须在调用任意模型 Provider 前完成字段裁剪、敏感信息过滤、权限复核和 revision/hash 校验；生产实现变更字段时须升级契约版本并重跑 fixtures。

- 模型能力的成功响应统一使用 [`response-candidate.json`](./response-candidate.json)；08 是静态本地函数，按能力文档返回模板列表。
- `text` 是最小必需消费字段。
- 模型调用层只返回最小对象 `{"text":"..."}`；`status`、`purpose`、`mode`、`promptVersion`、trace 和 candidate 状态由后端包装并校验。统一成功响应只接受 01～07、09 已冻结的八组模型 `purpose + mode`，明确排除 08 的 `WISH/starter` 与其他虚构路由。
- 普通 JSON Schema 的字符串 `maxLength` 与本项目 NFC/code-point/忽略换行的业务计数口径不同。Schema 负责结构与原始传输安全上限；后端须在调用 Provider 前用统一业务计数器执行各能力长度门禁，超限返回 `INPUT_TOO_LONG`。
- `materials[]` 只接受作者已确认用途且已经由有效统筹逐条批准纳入总信的素材；待审稿不能进入生成请求。
- 总信素材结构见 [`approved-material.json`](./approved-material.json)：素材类型 `sourceType` 与叙述归属 `narrativeAttribution` 分开，`authorLabel` 标记匿名作者，`materialLabel` 唯一定位每条素材。
- `sourceRef` 只用于后端映射、审计和有权限的原素材查看；送模型前必须移除。真实账号、手机号、审批人和权限信息始终只留后端。
- `letterRevision`、`inputHash`、`sourceRef` 和 requestId 是后端元数据，不由模型生成或裁决。09 的坐标按原字符串 Unicode code point、左闭右开解释，校验前不得归一化或 trim。
- 这些 Schema 不授权任何模型 Provider 访问数据库、OSS 或长期 Memory。
