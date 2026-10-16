# 荣休礼 v1.2.3 交付包清单

## 包信息

- 包名：`rongxiu-algorithm-fullstack-handoff-v1.2.3`
- 规范版本：`v1.2.3-frozen-handoff`
- 生成日期：2026-10-16
- 核心策略：平台无关；Dify 只作为可选 Prompt 调试或 Provider 映射参考
- 数据：仅合成示例，不包含真实用户素材或凭据

## 目录

| 路径 | 内容 |
|---|---|
| `README.md` | 产品、算法和全栈统一入口 |
| `VALIDATION.md` | 结构、契约、链接、凭据与仓库交付检查结果 |
| `docs/algorithms/rongxiu-1-9/00-*.md` | 产品阅读、Prompt 交付和平台无关设计规范 |
| `docs/algorithms/rongxiu-1-9/01-*.md` ～ `09-*.md` | 1～9 能力规格；08 为静态模板，其他按文档配置模型能力 |
| `docs/algorithms/rongxiu-1-9/10-fullstack-spec-draft.md` | 全栈接入规格 |
| `docs/algorithms/rongxiu-1-9/11-frozen-decisions-implementation.md` | R1～R5 冻结实施规则与 AI-D04 门禁 |
| `docs/algorithms/rongxiu-1-9/FULLSTACK_HANDOFF-v1.2.0.md` | 全栈主入口；历史文件名保留，正文版本为 v1.2.3 |
| `docs/algorithms/rongxiu-1-9/product-decision-record-v0.2.0.md` | Q1～Q10 与 R1～R5 决策记录 |
| `docs/algorithms/rongxiu-1-9/capability-matrix.md` | 路由、字段、错误和状态矩阵 |
| `docs/algorithms/rongxiu-1-9/schemas/` | 业务请求、批准素材和统一 candidate 响应 Schema |
| `docs/algorithms/rongxiu-1-9/fixtures/` | 合成 Golden/Bad、生命周期和静态模板样例 |
| `docs/algorithms/rongxiu-1-9/fullstack-acceptance-boundary.md` | 全栈证据与发布状态门禁 |
| `docs/algorithms/rongxiu-1-9/CHANGELOG.md` | 版本历史 |
| `dify/` | 可选 Dify 映射清单和调试说明，无 DSL |

## 使用约束

- 生产实现以 `docs/algorithms/rongxiu-1-9/` 为事实源；`dify/` 不能反向改变接口合同。
- 01、02、03、04、05、06、07、09 才可能配置模型路由；08 必须保持本地静态实现。
- 产品决策、代码实现和目标环境验证是三个状态；本包冻结前者和技术合同，不声明后两者已经完成。
- Prompt、Schema、静态模板或数据生命周期规则变化时，必须升级版本并重新执行对应 fixtures。
