---
description: "Delo 的远程访问登录，供 admission seam 的维护者使用：在 home 受保护记录之上的所有者认领与设备列表、C4、C5 与 C14 所描述的 authenticator 提供方，以及在 Delo 所发布 web 组合上证明 C4 监听器与分发规则的拒绝测试套件。"
---

# @delo/home-auth

[English](README.md) | 中文

## 摘要

本包承载 [约定 C4](../../docs/contracts/c04-admission.zh.md#authenticator) 的 authenticator 提供方 `@delo/home-auth`，同时包含 [约定 C5](../../docs/contracts/c05-device-approval.zh.md) 的所有者认领与设备批准、[约定 C14](../../docs/contracts/c14-oidc-passkeys.zh.md) 的身份因子，以及 C4 的服务端远程访问会话。前半部分是所有者认领与设备列表：`~/.delo/secrets/home-auth/` 下的记录、应答这些记录的路由，以及结束设备在线会话的移除。后半部分是 C4 的准入拒绝测试套件，用于证明准入 seam 的上游一半：上游的 connection 声明 `Authenticator` Service Definition，并通过 `ctx.connection.openReachListener` 打开远程访问监听器；web 服务器在任何路由、upgrade 或回退之前，运行每个远程访问监听器的分发器。约定的标识符、代码与限制来自 [`@delo/contract-admission`](../contract-admission/README.zh.md)。

## 目录

- [所有者认领与设备列表](#the-owner-claim-and-device-list)
- [准入拒绝测试套件](#the-admission-denial-suite)
- [给提供方的说明](#notes-for-the-provider)
- [测试](#tests)

<a id="the-owner-claim-and-device-list"></a>
## 所有者认领与设备列表

`src/home-auth.ts` 是 `~/.delo/secrets/home-auth/` 之上的协调者，`src/service.ts` 把它作为 `homeAuth` 服务挂载，并在 `ctx.effect()` 内把 `POST /auth/owner/claim`、`GET /auth/devices` 与 `POST /auth/devices/remove` 注册到 web 服务器。下面每条规则都由 `tests/` 下的一个 spec 固定：

- **所有者验证码**（`owner-code.json`）。128 位随机数写成 26 个 base32 字符，只打印一次，并且只以 SHA-256 摘要保存。验证码只能使用一次，并在打印后 10 分钟过期；错误的验证码会保留原有的验证码，新的验证码则取代它。
- **认领**（`owner.json`、`devices.json`）。只接受回环访问，且即使没有任何分发器标记请求，`Host` 指向远程访问地址也会被拒绝。一个 home 只有一个所有者：持有效新验证码的第二个认领者会以 `ALREADY_OWNED` 被拒绝，第一个所有者保有自己的 home；同时发起的两个认领会串行执行，因此恰好一个赢得所有者席位。验证码在写入任何记录之前就被消耗，因此认领过 home 的验证码不会再认领第二个 home。
- **设备列表**。所有者与每一台受信任设备，不含密钥材料。未认领的 home 会以 `NO_OWNER` 拒绝列表与移除，而不是像拥有空设备列表那样应答。
- **会话**（`sessions.json`）。令牌只下发一次，并以作为记录键的 SHA-256 摘要保存，因此复制该文件无法让任何人登录。
- **移除**。删除设备记录、使其令牌的每个在线会话失效，并通过 `ctx.connection.closeReachConnections({ deviceId })` 关闭这些会话准入的远程访问连接，全部在返回之前完成；没有记录的设备同样会结束其会话。
- **记录**。每个文件都经 [约定 C1](../../docs/contracts/c01-home-layout.zh.md) 的受保护文件检查读取，因此其他用户可以读取的文件，或不是本包 JSON 的文件，会以 `STORE_INVALID` 拒绝，而不是被当作空内容读取并让一次认领覆盖它。

<a id="the-admission-denial-suite"></a>
## 准入拒绝测试套件

`tests/denial/admission/` 在测试进程中启动 Delo CLI profile 的 web 组合：上游的 web 模板（Delo 的 profile 在其上扩展）以操作系统分配的端口运行 web 服务器。Delo 自身的 bundle 层被排除在外，因为其 host 部分不注册任何 web 路由。随后，该套件加载一个替身提供方 `StandInHomeAuth`，它准入一个会话 cookie，并把回环监听器委托给 Connection 的内置准入；另有一个社区插件 fixture（测试前置数据），带有一条精确路由、一条前缀路由与一条 upgrade 路由。它打开全部三个远程访问监听器：`reach-tailscale-private` 与 `reach-tailscale-funnel` 位于 `127.0.0.1` 的端口上，`reach-self-hosted-relay` 则在本地 TCP 服务器交给它的字节流上运行，证书来自替身堆栈的测试 authority。

各测试的名称取自 C4 的拒绝表：

| 测试 | 证明什么 |
| --- | --- |
| `every route and upgrade answers 401 before sign-in on each reach listener` | 启动后的 web 组合注册的每条精确路由、前缀路由、upgrade 路由以及回退，以及 fixture 插件的每条路由，在每个远程访问监听器上登录前都应答 401，且没有任何 fixture handler 运行；携带会话时，同一 fixture 路由与 upgrade 则会运行。 |
| `a plugin route is pre-login only when the profile lists it` | 提供方作为登录前请求应答的 fixture 路由，在监听器策略列出它之前会被拒绝，在列表被移除后会再次被拒绝。 |
| `a pre-login request never reaches the fallback or another route` | 一条位于允许列表中、却没有注册路由的路径会被拒绝，而不是由回退应答。 |
| `a cookie minted with upstream's secret is refused on a reach listener` | 上游以其密钥为远程访问监听器自身的 authority 签发、且在回环监听器上可以准入的 `dsh-auth-*` cookie，在远程访问监听器上会以 `UPSTREAM_COOKIE_REFUSED` 被拒绝，即使同时带有会话 cookie 也是如此。 |
| `launch tokens and /connect are refused on a reach listener` | 在 `token` 查询参数中携带的进程启动令牌，以及对 `/connect` 的请求，都会被拒绝，且不设置任何 cookie。 |
| `a loopback Host is refused on a reach listener` | `Host` 中的 `localhost`、`127.0.0.1` 与 `[::1]` 会被以 `HOST_MISMATCH` 拒绝，对请求与 upgrade 同样如此。 |
| `each listener refuses a Host its rule does not allow` | 每个远程访问监听器都拒绝其他监听器的地址以及外部名称；中继监听器拒绝与其名称不符的 SNI，返回 `SNI_MISMATCH`；回环监听器以上游的 403 拒绝外部 `Host`。 |
| `an upgrade with a foreign or absent Origin is refused` | 发往 `/api/remote.mux`、不带 `Origin`、带有其他 origin 或带有 `null` 的 upgrade 会被以 `ORIGIN_MISMATCH` 拒绝；监听器自身的 origin 则能到达 upgrade handler。 |
| `removes Tailscale identity headers before admission` | 提供方在任何远程访问监听器上、无论是请求还是 upgrade，都看不到 `Tailscale-*` 头，且 Gateway 的 WebSocket 仍接受该 upgrade。 |
| `no reach listener runs without home-auth` | 移除提供方会关闭每个远程访问监听器及其打开的连接；没有提供方时不会打开任何远程访问监听器，回环监听器则如上游一般准入；替换为一个不服务任何远程访问监听器的提供方后，也不会打开任何远程访问监听器。 |

一项类型级检查保证 C4 的 `Admission` 与 `ListenerPolicy` 类型可以赋值给上游 seam 的对应类型；一个 spec 保证分发器的拒绝状态与 C4 的状态相等。

<a id="notes-for-the-provider"></a>
## 给提供方的说明

- **登录前资产路由。** 处理 `GET /auth/assets/<asset>` 的 handler 会把该段与一张固定的已构建资产名表进行匹配。它从不先解码该段再把它拼接到目录路径上，因为解码后的 `..` 或分隔符会使路径离开资产目录。
- **认领的到达。** 认领路由在读取请求体之前就判断请求从何处到达，其拒绝语句会点名回环监听器与 SSH 端口转发；远程访问监听器在任何路由被查询之前，通过 `reachClaimRefusal()` 应答同样的拒绝。
- **撤销。** 移除设备或结束会话时，会在返回之前调用 `ctx.connection.closeReachConnections({ deviceId })` 或 `({ sessionId })`，使不携带 Peer 的流与已升级的 socket（例如 `/plugins/events` 与插件 upgrade 路由）随会话一同结束；对设备的 Peer 执行 dispose（资源释放），会结束替它发言的流。
- **回环凭据。** 每次回环签发都以 `authenticator/minted` 到达，提供方在写出设置该凭据的响应之前记录它。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-auth` 运行该套件。它通过上游包的已发布入口导入这些包，因此需要当前的 `pnpm run build:artifacts` 产物；构建过期时，Delo 的检查运行器会启动该构建。
