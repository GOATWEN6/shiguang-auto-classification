# G1 共用运行合同报告

> 日期：2026-10-03
> 状态：`core_contract_implemented / focused_tests_pass / independent_reviewed / durable_adapter_pending / paid_calls_0`

## 已实现

- `src/lib/algorithm-runtime/contracts.ts`：七模块共用 identity、invocation、usage、错误和结果合同；
- `src/lib/algorithm-runtime/cancellation-registry.ts`：按 session 与 channel 管理当前 invocation，签发绑定 canonical identity/signal 的 execution lease；重复启动、supersede、取消、完成、伪造 identity 及 response mismatch 均拒绝迟到输出；重启恢复时默认拒绝旧进程在途结果；
- `src/lib/algorithm-runtime/model-call-ledger.ts`：冻结价格目录、provider/model/计费单位/输入上限绑定、微元精度、20% 费用缓冲、CNY 45 复核、CNY 60 硬上限、复核报告与 manifest 哈希绑定、固定输入重试、四次尝试上限、硬停闩锁和完整 attempt 费用记录；
- `src/lib/algorithm-runtime/data-lifecycle.ts`：40 天到期、来源/派生类型隔离、撤回级联失效、24 小时删除期限、逐存储面删除回执、逾期状态和无内容 tombstone；恢复时重新推导到期与删除期限；
- `src/lib/algorithm-runtime/governance-repository.ts`：规定付费执行必须使用具备原子 compare-and-swap 的 durable repository；内存仓会被门禁拒绝；
- `harness/live-baseline/v0.1/algorithm-runtime.test.mts`：上述规则的聚焦行为测试。

## 已运行证据

```bash
npm run test:algorithm-runtime
npx tsc --noEmit --target es2022 --module esnext --moduleResolution bundler \
  --strict --skipLibCheck --types node --allowImportingTsExtensions \
  src/lib/algorithm-runtime/contracts.ts \
  src/lib/algorithm-runtime/cancellation-registry.ts \
  src/lib/algorithm-runtime/model-call-ledger.ts \
  src/lib/algorithm-runtime/data-lifecycle.ts \
  src/lib/algorithm-runtime/governance-repository.ts \
  src/lib/algorithm-runtime/index.ts \
  harness/live-baseline/v0.1/algorithm-runtime.test.mts
```

当前聚焦测试为 `15/15 PASS`，目标文件严格 TypeScript 检查通过。测试包括：

1. runtime identity 非法值和 key 碰撞边界；
2. 内存 repository 不能启用付费执行；
3. 重复 invocation、supersede、用户取消、完成和 response mismatch 后的旧输出拒绝；
4. execution lease 暴露注册表拥有的 signal，字段相同但非注册表签发的伪造 identity 不能取消或 finalize；
5. 预算暴露按 20% 缓冲计算，并在达到 CNY 45 前阻断；复核授权必须绑定负责人、费用报告、manifest 和批准额度；
6. 晚到账单会回写 attempt；实际费用超过冻结预留会触发 `pricing_catalog_invalid` 并锁停；
7. attempt 在调用前绑定冻结的 provider、model、billing unit、billable units 与 input-limit hash，重启时校验完整价格目录 fingerprint；
8. 亚分级费用累计不丢失，非法结算不破坏原预留；Budget 与 ModelCall 状态恢复时交叉核账；
9. 同一案例最多四次尝试，状态恢复后仍不能产生第五次，非 retryable 错误不重试；
10. 硬性不变量不能计为成功；并发在途结果在硬停后只能记为 `cancelled/non-usable`，丢失 stop latch 的恢复状态会失败关闭；
11. 撤回立即使来源及故事等派生物失效，异常未来时间不能阻塞撤回，重复撤回不能延后删除期限；
12. 删除必须收齐各存储面回执；父来源先删、已失效派生物后删仍可恢复，ACTIVE 派生物不得依赖失效来源；
13. 派生类型不能冒充新来源重置期限，source 到期日必须等于 capture＋40 天，派生物继承最早来源到期日；
14. 第 40 天清理任务即使延迟运行，也按原到期时刻记账并如实标记逾期；撤回删除期限为 `min(撤回＋24h, 原到期日)`；
15. 生命周期 policy、opaque object ID、删除期限和无内容审计在重启恢复时保持一致。

## 证据边界

这些测试证明共用治理规则在内存实现中可复现。它们尚未证明：

- Interview、Memory、ASR、TTS 或 LLM 已接入这些合同；
- 已经存在 durable repository Adapter 或真实删除调度器；当前只完成状态导出/恢复合同和付费前硬门；
- 已经存在把 durable CAS、预算预留、provider dispatch 与 stop/cancel 串成单一原子流程的真实 runner；
- 数据已写入持久数据库，或对象存储、缓存、索引、导出与 provider 删除回执已真实取得；
- provider 会遵守本地 24 小时删除期限；
- 真实模型、真实语音、真人体验或产品集成已经通过。

下一 Gate 是 G2：将 Interview v0.2 与 Memory hybrid/M2 从 harness 提升为可导入运行库，同时保留当前 parity 与 hard-gate 结果。durable repository Adapter 和真实删除执行器在 G5 前必须完成；否则 G6 付费 canary 保持阻塞。
