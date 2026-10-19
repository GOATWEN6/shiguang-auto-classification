# SGX 稳定内测入口：Cloudflare Named Tunnel

## 1. 这个方案解决什么

当前 Quick Tunnel 的随机 `trycloudflare.com` 地址会随进程退出或临时域名回收而失效。Named Tunnel 将一个固定域名绑定到固定 Tunnel UUID；`cloudflared` 重启后仍使用同一地址，适合团队反复打开内测工作台。

它提高的是**入口固定性和进程恢复能力**，不保证模型回复速度，也不会把本机变成全天在线服务器：

- 本机休眠、关机、断网，或者 3100、3200 服务停止时，固定网址仍会存在，但访问不到工作台；
- 需要全天在线时，应把算法服务、认证网关和 Named Tunnel 一起迁移到受控云主机，或使用真正全天运行的机器；
- 当前方案继续使用现有 Basic Auth 网关。团队人数扩大后，建议另行评估 Cloudflare Access 的个人身份、撤权和审计能力。

## 2. 固定的安全链路

```text
团队浏览器
  → Cloudflare 固定域名与 Named Tunnel
  → http://127.0.0.1:3200（现有 Basic Auth 白名单网关）
  → http://127.0.0.1:3100（算法服务，仅本机）
```

Tunnel 配置只能把流量送到 `127.0.0.1:3200`。不得把 `3100`、`0.0.0.0`、整个本机或未受保护的管理接口直接发布到公网。实际可访问的页面和 API 仍由 `scripts/public-test-gateway.mjs` 的白名单决定；Tunnel 不扩大这份白名单。

本目录只存不含凭据的模板。真实 Tunnel UUID、Cloudflare 登录证书、Tunnel JSON、固定域名和 Basic Auth 密码只保存在部署机器或密钥系统中，不提交 Git。

## 3. 一次性创建固定入口

### 3.1 前置条件

1. 已有一个由 Cloudflare 管理 DNS 的域名；
2. 部署机器已经安装 `cloudflared`；
3. `127.0.0.1:3100` 的算法服务和 `127.0.0.1:3200` 的认证网关能够分别启动；
4. 操作者拥有对应 Cloudflare Zone 的授权。

本仓库不自动安装软件、不登录账号，也不替操作者创建 DNS 或 Tunnel。

### 3.2 登录一次并创建 Named Tunnel

以下命令由有权限的操作者在部署机器执行：

```bash
cloudflared tunnel login
cloudflared tunnel create <TUNNEL_NAME>
cloudflared tunnel list
```

第一次命令会在浏览器完成 Cloudflare 登录，并在本机 Cloudflare 配置目录生成账号证书；第二次会生成固定 Tunnel UUID 和独立的 Tunnel JSON 凭据。不要把这些文件复制进仓库。

### 3.3 生成本机配置

把 [`config.yml.example`](./config.yml.example) 复制到 Cloudflare 默认配置目录：

```bash
mkdir -p "$HOME/.cloudflared"
cp deploy/cloudflare/config.yml.example "$HOME/.cloudflared/config.yml"
chmod 600 "$HOME/.cloudflared/config.yml"
```

只在本机副本中替换：

- `<TUNNEL_UUID>`：`cloudflared tunnel create` 输出的 UUID；
- `<LOCAL_ACCOUNT>`：部署机器的本地账号目录名；
- `<PUBLIC_TEST_HOSTNAME>`：准备使用的固定子域名，例如内部测试专用子域名；这里不要填写到仓库模板。

配置的最后一条 `http_status:404` 是拒绝未匹配入口的兜底规则，必须保留。

### 3.4 绑定固定域名并验证配置

```bash
cloudflared tunnel route dns <TUNNEL_UUID_OR_NAME> <PUBLIC_TEST_HOSTNAME>
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress validate
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" ingress rule "https://<PUBLIC_TEST_HOSTNAME>/algorithm-lab"
```

`ingress rule` 应命中 `http://127.0.0.1:3200`，不能命中 3100。先在本机检查认证网关：

```bash
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:3200/algorithm-lab
```

未携带 Basic Auth 时预期为 `401`。这表示认证门正常工作，不表示工作台故障。

### 3.5 前台试运行

```bash
cloudflared tunnel --config "$HOME/.cloudflared/config.yml" run <TUNNEL_UUID_OR_NAME>
```

用固定 HTTPS 地址做三项检查：

1. 未登录访问工作台返回 `401`；
2. 使用测试账号登录后 `/algorithm-lab` 返回 `200`；
3. 未在网关白名单中的页面继续返回 `404`。

不要为了验证 Tunnel 调用付费模型；入口检查只需要 HTTP 状态和版本信息。

## 4. macOS 服务化与恢复

前台试运行通过后，按照 Cloudflare 官方 macOS 指南安装为当前用户 LaunchAgent：

```bash
cloudflared service install
```

LaunchAgent 在该用户登录后启动，读取 `$HOME/.cloudflared/config.yml`。如必须在机器开机、尚未登录时运行，官方也支持系统级 LaunchDaemon，但它读取 `/etc/cloudflared`，需要运维人员迁移配置与凭据并审查文件权限后再执行：

```bash
sudo cloudflared service install
```

不要同时安装用户级和系统级的重复实例。Named Tunnel 服务正常并不代表 3100 算法服务和 3200 认证网关已经被守护；这两个进程也必须由各自的受控服务管理器恢复，否则固定域名仍会返回上游不可达。

建议按下面顺序排障：

1. `curl` 检查 3100 健康接口只在本机可达；
2. 未登录请求 3200 工作台确认返回 `401`；
3. `cloudflared tunnel info <TUNNEL_UUID_OR_NAME>` 检查连接；
4. 最后从外部浏览器检查固定域名。

Cloudflare 官方文档给出的系统级 macOS 恢复命令是：

```bash
sudo launchctl stop com.cloudflare.cloudflared
sudo launchctl start com.cloudflare.cloudflared
```

如果使用的是当前用户 LaunchAgent，应通过对应用户会话的 `launchctl` 管理，或注销后重新登录；不要混用系统级标签和用户级实例。恢复后域名不变。

## 5. 回滚

回滚遵循“先停止公网，再保留本机”的顺序：

1. 停止或卸载 `cloudflared` 服务，立即切断 Tunnel 到本机的连接；
2. 在 Cloudflare DNS 中删除该内测子域名的 Tunnel 路由；
3. 确认不再复用后，再删除 Named Tunnel；
4. 删除部署机器上的 Tunnel JSON 和本机 `config.yml` 副本；
5. 3100 和 3200 可继续只在本机运行，回滚不要求删除算法数据。

删除 Tunnel 或 DNS 是外部资源变更，执行前应核对名称和 UUID。若只是短时维护，停止服务即可，无需删除 Tunnel；恢复时固定域名仍可继续使用。

## 6. 开源来源与许可证

- Cloudflare 官方创建指南：[Create a locally-managed tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/)
- Cloudflare 官方配置指南：[Configuration file](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/configuration-file/)
- Cloudflare 官方 macOS 服务指南：[Run as a service on macOS](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/as-a-service/macos/)
- 上游项目：[cloudflare/cloudflared](https://github.com/cloudflare/cloudflared)
- 上游许可证：[Apache-2.0](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)

本仓库没有复制 `cloudflared` 源码，只提供 SGX 的配置模板和操作说明；Tunnel 客户端本身继续遵循上游 Apache-2.0 许可证，Cloudflare 托管服务仍受其服务条款约束。
