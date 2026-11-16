---
description: "@delorun/reach 包，供远程访问维护者阅读：约定 C7 的远程访问服务及其提供方注册表，它为 C4 远程访问监听器持有的固定监听端口，以及把该端口连接到 tailscale serve、移除不属于自己的 serve 规则、拒绝 Funnel 并声明 tailnet 成员身份因子的 Tailscale 私有提供方。"
---

# @delorun/reach

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包是[约定 C7](../../docs/contracts/c07-reach-providers.zh.md) 的 Service Definition 和首个 Service Provider。`reach` 服务为每个远程访问方式持有一个提供方，并启动配置行已开启的每个选项：它请 `@delorun/home-auth` 以提供方声明的身份因子为该选项的远程访问监听器提供服务，在 `127.0.0.1` 上绑定该选项的固定监听端口，通过上游的 `ctx.connection.openReachListener` 在操作系统分配的端口上打开监听器，把固定端口的流量中继到它，并启动提供方。`reach-tailscale-private` 提供方声明 `tailnet-membership`（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#tailnet-membership)），并把 `tailscale serve` 配置到固定端口。该服务挂载在 C16 开关 `reach`（`Config.enabled`）之后，`@delorun/bundle-local` 的行 `delorun-reach` 会开启此开关；每个选项都保持关闭，直到本人运行 `delorun reach on tailscale`，或在安装设置的完整模式中回答「是」。

## 目录

- [远程访问服务](#the-reach-service)
- [Tailscale 私有提供方](#the-tailscale-private-provider)
- [固定监听端口](#the-fixed-listener-port)
- [尚未构建的内容](#what-is-not-built)
- [测试](#tests)

<a id="the-reach-service"></a>

## 远程访问服务

`GET /delorun/reach/status` 在回环监听器上向 studio 和已准入的远程访问会话应答 `{ "available": true, "options": [...] }`：包含每个选项的 id、状态、地址，以及在被阻塞或失败时的错误码和说明（`REACH_STATUS_PATH`、`ReachSummary`）。没有该服务的 profile 应答 404。studio 的「设备」部分及其引导会读取它。

`src/service.ts` 在 `ctx.effect()` 内注册 Tailscale 私有提供方，并读取 `tailscalePrivate` 行：`enabled`（默认 `false`）、`address`（本机的 `https://<machine>.<tailnet>.ts.net` 地址）、`servePort`（默认 443）、`listenerPort`（`127.0.0.1` 上的固定端口，在 `delorun reach on tailscale` 选定之前默认为 `0`）、`serveCheckIntervalMs`（默认 60000，至少 1000）和 `elevationMinutes`（默认 15，取值 1 到 60），后者会作为监听器上已批准设备的提权时长传给 `homeAuth.serve`。已开启但地址不是 `https` `ts.net` 地址的行，加载时以 `TAILSCALE_ADDRESS_MISMATCH` 失败；没有监听端口的行以 `PORT_CONFLICT` 失败；`elevationMinutes` 超出范围的行以 `ELEVATION_MINUTES_INVALID` 失败。启动一个选项会使其进入 `starting`，然后进入 `ready`；固定端口无法绑定或检查失败时进入带 C7 错误码的 `blocked`；其他任何错误则进入 `failed`。`blocked` 或 `failed` 的选项会先停止其提供方，所以 home 运行期间 serve 规则不会比它指向的端口存活更久，然后关闭其监听器并停止对其提供服务；停止失败的信息会追加到该状态的说明中。选项处于 ready 状态时，一个不阻止进程退出的定时器每隔 `serveCheckIntervalMs` 运行一次提供方的 `check`，一次一个：回答 unknown 会使选项变为 `degraded`，直到后续某次回答 `ok`；阻塞性回答则像启动失败一样停止它。释放插件时依次停止提供方、关闭监听器并停止对其提供服务，并记录失败的停止。每次变化都会发出 `reach/state`。

<a id="the-tailscale-private-provider"></a>

## Tailscale 私有提供方

`src/provider.ts` 和 `src/tailscale.ts` 通过注入的运行器运行每一条 `tailscale` 命令。运行器用参数列表启动二进制文件，从不经过 shell，也没有任何内容通过 `sudo` 运行。

| 检查 | 命令 | 拒绝 |
| --- | --- | --- |
| 已安装 | `tailscale version` | `TAILSCALE_NOT_INSTALLED` |
| 正在运行且已登录 | `tailscale status --json`，`BackendState` 为 `Running` | `TAILSCALE_NOT_LOGGED_IN` |
| HTTPS 证书已开启 | `CertDomains` 列出本机 | `TAILSCALE_HTTPS_DISABLED` |
| 配置的地址属于本机 | `Self.DNSName` | `TAILSCALE_ADDRESS_MISMATCH` |
| 该地址的 Funnel 已关闭 | `tailscale serve status --json`，`AllowFunnel["<name>:<servePort>"]` | `TAILSCALE_FUNNEL_ON`，并给出 `tailscale funnel --https=<servePort> off` |
| 没有其他规则占用 serve 端口 | `tailscale serve status --json`，然后 `tailscale serve --https=<servePort> off`（对应类型用 `--http`、`--tcp`），再次读取状态 | 移除失败或该端口仍被占用时为 `TAILSCALE_SERVE_CONFLICT` |
| 本人的账户可以配置 serve | `tailscale serve --bg --https=<servePort> http://127.0.0.1:<listenerPort>` | `TAILSCALE_SERVE_NOT_PERMITTED`，并给出本人需运行的那一条命令：`sudo tailscale set --operator=$USER` |

`readServeRules` 把 `tailscale serve status --json` 当作 Tailscale 的 `ipn.ServeConfig` 的 JSON 来读取（tailscale/tailscale 的 `ipn/serve.go`；`cmd/tailscale/cli/serve_legacy.go` 负责序列化）：按端口键入的 `TCP`（含 `HTTPS`、`HTTP` 或 `TCPForward`），按 `<name>:<port>` 键入的 `Web`（其 `Handlers` 按挂载点），按 `<name>:<port>` 键入的 `AllowFunnel`，以及 `Foreground` 下每个前台会话的相同字段。本 home 自己的规则是后台配置中 serve 端口上的 HTTPS，仅有一个挂载点 `/`，代理到 `http://127.0.0.1:<listenerPort>`。端口未被占用时，`stop` 和 `removeServe` 不运行任何命令，否则运行其 `off` 命令，并再次读取状态以确认端口空闲。`check` 重新读取状态以检查 Funnel，读取失败时回答 `unknown`。在 C7 的回退方案下，serve 目标上的每个请求的来源都是 `127.0.0.1`，由监听器的 `Host` 规则拒绝 `tailscaled` 透传过来的外来 `Host`。

<a id="the-fixed-listener-port"></a>

## 固定监听端口

`src/front.ts` 独占绑定 `127.0.0.1:<listenerPort>`，并在服务指明远程访问监听器的分配端口后，把每个连接中继到该端口；更早到达的连接会被关闭。端口被其他程序占用时以 `PORT_CONFLICT` 失败，服务随后移除 serve 端口上的任何规则，因为它会转发到那个程序。`chooseListenerPort` 从 C7 的范围 20000 到 32767 中随机挑选一个空闲端口，`delorun reach on tailscale` 和安装设置会把它一次性记录到 profile 的行中。

<a id="what-is-not-built"></a>

## 尚未构建的内容

Funnel 和自托管中继提供方。尚无真实的 tailnet 或手机运行过本包：规格用 `tests/fake-tailscale.ts` 伪造 `tailscale`，它以上述 JSON 形式保存 serve 配置。未经停止就退出的 home 进程，会把它的规则留在 `tailscaled` 中，直到下次启动或 `delorun reach on|off` 将其移除（[C7](../../docs/contracts/c07-reach-providers.zh.md#what-this-does-not-prove)）。

<a id="tests"></a>

## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/reach` 运行这些规格。端到端规格会启动组合好的 studio，所以它与 CLI 放在一起，位于 `delorun/apps/cli/tests/denial/reach/end-to-end.spec.ts`：它在测试进程中以加载了 `@delorun/home-auth` 和本包、并伪造 `tailscale` 的方式启动 Delorun 的 Web 组合，并像手机那样通过回环驱动固定监听端口：窗口之外被拒绝的请求，在回环上打开的窗口，登录页面模块计算出的匹配码，本地批准，创建 `tailnet-membership` 会话的签名，对 home 所在电脑自身的每个操作的拒绝（包括通过状态路由或插件管理更改远程访问），以及结束会话的移除。它需要最新的 `build:artifacts`。
