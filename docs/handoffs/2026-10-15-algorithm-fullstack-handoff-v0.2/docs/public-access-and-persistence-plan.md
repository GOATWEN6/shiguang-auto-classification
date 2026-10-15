# SGX 算法工作台：持久运行与在线访问方案（候选阶段）

## 结论

当前可以启动 `REAL_INTERNAL` 本机候选服务，也可以通过临时认证隧道给团队做短期内测；当前不能把本机 3100 直接宣称为持久在线产品服务。`CanonicalMemory` 仍是算法侧候选端口，正式持久化由全栈后端完成。

## 当前可用链路

```text
内部评审浏览器
  → 临时 HTTPS 隧道（可选）
  → Basic Auth 网关（127.0.0.1:3200）
  → 算法候选服务（127.0.0.1:3100）
  → 豆包 ASR/TTS/文本模型（服务端凭据）
```

3100 的接口仍有 loopback 检查；网关负责把已认证请求转回本机。健康检查 JSON 只给机器和运维使用，团队体验应打开 `/algorithm-lab`。

## 为什么不能把当前方式叫“永久运行”

- Quick Tunnel 的域名和隧道进程绑定，进程停止后链接立即失效；
- Next 进程中的 session、ASR 流、响应缓存、主体绑定和 Reference Store 会随重启丢失；
- `storage=process_memory_fictional_only`、`durable=false`、`canonicalWriteCapability=false` 仍是当前健康状态；
- 当前网关缺少请求体/速率/并发/超时限制，也不代理 WebSocket Upgrade；
- 旧文档中的临时 URL 不能当作当前在线地址，必须每次以实际隧道输出为准。

## 三种部署层级

| 层级 | 用途 | 当前是否可用 | 需要补什么 |
|---|---|---|---|
| 本机候选服务 | 算法工程师和负责人验证真实模型 | 可以 | 进程守护、端口监听权限 |
| 临时内测 URL | 产品/内容/全栈短期体验 | 可准备 | 临时密码、网关、Quick Tunnel；链接不持久 |
| 固定 staging/生产 | 全栈真实接入和持续使用 | 尚不可用 | 云主机、域名/TLS、认证、限流、持久数据库、CanonicalMemory Adapter、监控回滚 |

## 固定 staging 的最小安全要求

1. 使用 `npm run build` + `npm run start`，不使用 `next dev`；
2. 使用 `launchd/systemd/容器编排` 托管进程；
3. 反向代理只暴露工作台和明确的 v0.1 API，拒绝任意路径；
4. Provider key 留在服务端 secret storage；
5. 业务后端负责登录、家庭空间、角色、用途和授权版本；
6. 限制单 IP、单账户、单会话的请求体、并发、重试和每日预算；
7. 将成本账本和诊断写入受控存储，不记录明文 IP、API key 或完整敏感内容；
8. 为版本、迁移、删除、撤回和 provider 失败准备回滚与降级；
9. `CanonicalMemory` 使用事务数据库、版本链、撤回/删除 tombstone、outbox 删除任务和审计记录；
10. 在真实老人数据前，完成内部成年人和康养专家的受监督体验。

## 与全栈的边界

算法侧交付：接口合同、Fake、真实 provider Adapter、策略/Memory 候选、来源和权限字段、错误码、测试脚本、健康/版本信息和成本语义。

全栈交付：产品认证、家庭与角色权限、业务数据库、`CanonicalMemory` durable Adapter、对象存储、删除 worker、部署、TLS、监控、限流和发布回滚。

算法服务不得拿数据库句柄，也不得让 LLM 或浏览器直接写 `CanonicalMemory`。

## 验收顺序

```text
候选接口包 → 全栈 Fake 联调 → internal staging
→ 负责人真实模型体验 → 修复/定向复验
→ CanonicalMemory durable Adapter 与权限联调
→ 固定 staging 公网地址 → 正式发布评审
```

当前只能把第一、第二阶段标为可执行；第三阶段需要负责人确认 GitHub 目标和公网部署范围，第四阶段需要真实体验反馈，最后阶段还需要全栈后端持久化实现。

