# SGX 本机测试服务守护（macOS LaunchAgent）

这组模板把独立的 production standalone 运行副本放到 `~/Library/Application Support/SGX`，让 3100 算法服务和 3200 认证网关在当前用户登录后自动启动、异常退出后自动恢复。运行副本避开 macOS 对 LaunchAgent 直接读取 `Documents` 的隐私限制。它不负责创建公网域名；公网固定入口仍由 Cloudflare Named Tunnel 提供。

## 文件与边界

- `install-local-runtime.sh`：把已经完成的 standalone 构建、静态资源和必要指纹文件复制到版本化 release；把测试数据库放在独立 data 目录，更新代码不会覆盖资料。
- `run-algorithm-service.sh`：只启动已部署的 standalone production 构建，监听 `127.0.0.1:3100`；不会自动构建或调用模型。
- `run-public-gateway.sh`：只启动白名单 Basic Auth 网关，监听 `127.0.0.1:3200`。
- 两份 plist 是无凭据模板；真实密码、模型密钥和 Cloudflare 凭据不得写入仓库或 plist。
- `.env.local` 会被安装脚本复制为权限 `0600` 的 `~/.config/sgx/provider.env`，release 只保留指向它的符号链接。
- LaunchAgent 在用户退出登录、本机关机、休眠或断网时不可用。全天在线需要云主机。

## 本机私有配置

在 `$HOME/.config/sgx/` 创建权限为 `0600` 的配置：

```text
algorithm-runtime.env
  SGX_ALGORITHM_MODE=real
  SGX_INTERNAL_BATCH_CAP_CNY=<本批额度>
  SGX_INTERNAL_PRIOR_EXPOSURE_CNY=<既有暴露>
  SGX_ALGORITHM_BUILD_ID=<候选版本>

public-gateway.env
  SGX_PUBLIC_UPSTREAM=http://127.0.0.1:3100
  SGX_PUBLIC_GATEWAY_PORT=3200
  SGX_PUBLIC_GATEWAY_USER=<团队账号>
  SGX_PUBLIC_GATEWAY_PASSWORD_FILE=<仓库外0600密码文件>
  SGX_PUBLIC_GATEWAY_ALLOW_SHORT_PASSWORD=true
```

短密码兼容只用于负责人已明确批准的临时内测密码。正式或更大范围访问应改为高强度密码或 Cloudflare Access。

## 安装顺序

1. `next.config.js` 保持 `output: 'standalone'`，运行 `npm run build` 并确认 exit 0。
2. 运行 `SGX_RELEASE_NAME=<版本> deploy/macos/install-local-runtime.sh`；首次部署会把现有测试资料复制到独立 data 目录，后续 release 复用同一目录。
3. 复制 plist 到 `$HOME/Library/LaunchAgents/`，替换 XML 中的 `&lt;LOCAL_ACCOUNT&gt;` 占位符。
4. 创建 `$HOME/Library/Logs/SGX` 并限制私有配置权限。
5. 通过 `launchctl bootstrap gui/$(id -u) <plist>` 加载；不要同时保留手工启动的 3100/3200 进程。
6. 验证 3100 health、3200 未认证 401，再启动 Named Tunnel。

## 回滚

先用 `launchctl bootout gui/$(id -u) <plist>` 停止两个 LaunchAgent。代码回滚只需把 `~/Library/Application Support/SGX/current` 重新指向上一个 release 后重新加载；独立 data 目录不会被 release 替换。如需删除测试资料，应先通过工作区 DELETE 接口执行受控删除。
