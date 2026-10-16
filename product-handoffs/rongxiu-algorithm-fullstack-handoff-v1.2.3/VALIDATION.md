# v1.2.3 交付检查记录

检查日期：2026-10-16

本轮完成的是交付物结构与合同一致性检查；Provider、Dify Cloud、目标客户端和真实用户验证不属于本轮结果。

## 本地检查

- [x] JSON 与 JSONL 可解析，fixture ID 唯一
- [x] 05/09 的批准素材字段、匿名投影和后端字段边界一致
- [x] 08 无 App、无 Provider、无模型路由
- [x] 09 选区示例按原字符串 Unicode code point 正确定位
- [x] fixtures 明确分为 `model`、`backend`、`static`，模型样例均命中唯一模型路由
- [x] 统一成功响应只接受 8 条已冻结模型路由，排除 `WISH/starter`
- [x] fixture 使用的稳定错误码在能力矩阵和全栈错误表中都有定义
- [x] Markdown 相对链接在自包含目录内可解析
- [x] 旧大写风格、旧匿名字段和已失效“待冻结”表述无当前态残留
- [x] 未发现常见 API Key、云访问 Key 或私钥格式
- [x] GitHub 待提交目录与本地交付目录逐文件一致

## 检查结果

| 检查项 | 结果 |
|---|---|
| 包内普通文件 | 43 个 |
| Markdown | 29 个，相对链接目标均存在 |
| JSON Schema/配置 | 11 个 Schema 加 1 个 Dify manifest，均可解析 |
| P0 fixture | 27 条，`fixtureId` 唯一 |
| 09 fixture 坐标 | 所有 `selection` 均能按原字符串 code point 精确还原 `selectedText` |
| fixture 分层 | 每条均有 `testLayer`；模型、后端、静态函数分别执行，禁止整包直接送模型 |
| 路由与响应合同 | 8 条 `modelRoutes`、8 个唯一 `promptVersion` 与成功响应 Schema 的合法组合一致；08 不在模型路由 |
| Dify 投影 | 09 模型投影包含 `protectedRanges`，revision/hash/sourceRef 留后端 |
| 稳定错误 | fixtures 的 `NO_APPROVED_MATERIALS`、`EMPTY_INPUT`、`NOT_APPLICABLE`、`REVISION_CONFLICT`、`INVALID_SELECTION`、`PROTECTED_CONTENT_CHANGED` 均有统一定义 |
| 当前态残留扫描 | 未发现旧大写风格、`sourceLabel`、`narrativeRole`、`BLOCKED_ON_CONTRACT`、旧登录或 SSH 状态 |
| 路径与隐私 | 无开发机绝对路径；未发现常见明文凭据格式；仅含合成素材 |
| 仓库交付 | 不生成 ZIP；以 GitHub 独立分支中的自包含目录为准 |

## 未执行

- 目标模型或 Provider 调用
- Dify App 创建、导入、发布或 DSL 验证
- 前端、小程序、Spring 服务端或数据库集成测试
- 第三方删除、备份清理和离线撤回的 AI-D04 验收
- 真实用户素材或真实用户效果测试
