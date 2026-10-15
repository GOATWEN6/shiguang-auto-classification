# SGX Live Baseline v0.1

本目录保存真实模型调用前的冻结 manifest 和固定场景，不保存密钥、原始音频、转写、完整 Prompt、provider 输出或真实运行产物。

当前状态为 `G4_local_gate_closed / independently_reviewed / G5_design_gate_ready / real_wire_pending / paid_calls_disabled`。运行：

```bash
node harness/live-baseline/v0.1/validate-manifest.mjs
npm run test:algorithm-runtime
npm run check:g2
npm run check:g3
npm run check:g4
```

`test:algorithm-runtime` 当前使用 Node.js 22 的 TypeScript type-stripping 执行聚焦测试；生产构建仍由 Next.js/TypeScript 处理。

阶段报告：

- [G1 共用运行合同](./G1_REPORT.md)
- [G2 访谈与 Life Memory 纯算法运行库](./G2_REPORT.md)
- [G3 Fake Provider 与独立流式 ASR](./G3_REPORT.md)
- [G4 LLM/TTS/访谈表达/故事与画像](./G4_REPORT.md)

只有当无费用 G0–G5 完成、provider 数据条款和价格重新核验、输出目录与删除任务就绪、manifest 版本更新并通过复核后，才允许另行启用真实调用 runner。

真实运行产物必须写入相邻的 `.local-runs/`，该目录被 Git 忽略，并受 40 天到期与撤回后 24 小时删除规则控制。
