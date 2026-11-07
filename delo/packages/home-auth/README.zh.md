---
description: "Delo 的远程访问登录，供 admission seam 的维护者使用：C4、C5 与 C14 所描述的 authenticator 提供方，以及在 Delo 所发布 web 组合上证明 C4 监听器与分发规则的拒绝测试套件。"
---

# @delo/home-auth

[English](README.md) | 中文

## 摘要

本包承载 [约定 C4](../../docs/contracts/c04-admission.zh.md#authenticator) 的 authenticator 提供方 `@delo/home-auth`，同时包含 [约定 C5](../../docs/contracts/c05-device-approval.zh.md) 的所有者认领与设备批准、[约定 C14](../../docs/contracts/c14-oidc-passkeys.zh.md) 的身份因子，以及 C4 的服务端远程访问会话。它目前不含提供方代码。它包含 C4 的准入拒绝测试套件，用于证明准入 seam 的上游一半：上游的 connection 声明 `Authenticator` Service Definition，并通过 `ctx.connection.openReachListener` 打开远程访问监听器；web 服务器在任何路由、upgrade 或回退之前，运行每个远程访问监听器的分发器。约定的标识符、代码与限制来自 [`@delo/contract-admission`](../contract-admission/README.zh.md)。

## 目录

- [准入拒绝测试套件](#the-admission-denial-suite)
- [测试](#tests)

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
| `a loopback Host is refused on a reach listener` | `Host` 中的 `localhost`、`127.0.0.1` 与 `[::1]` 会被以 `HOST_MISMATCH` 拒绝。 |
| `each listener refuses a Host its rule does not allow` | 每个远程访问监听器都拒绝其他监听器的地址以及外部名称；中继监听器拒绝与其名称不符的 SNI，返回 `SNI_MISMATCH`；回环监听器以上游的 403 拒绝外部 `Host`。 |
| `an upgrade with a foreign or absent Origin is refused` | 发往 `/api/remote.mux`、不带 `Origin`、带有其他 origin 或带有 `null` 的 upgrade 会被以 `ORIGIN_MISMATCH` 拒绝；监听器自身的 origin 则能到达 upgrade handler。 |
| `removes Tailscale identity headers before admission` | 提供方在任何远程访问监听器上都看不到 `Tailscale-*` 头。 |
| `no reach listener runs without home-auth` | 移除提供方会关闭每个远程访问监听器及其打开的连接；没有提供方时不会打开任何远程访问监听器，回环监听器则如上游一般准入；替换为一个不服务任何远程访问监听器的提供方后，也不会打开任何远程访问监听器。 |

一项类型级检查保证 C4 的 `Admission` 与 `ListenerPolicy` 类型可以赋值给上游 seam 的对应类型；一个 spec 保证分发器的拒绝状态与 C4 的状态相等。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/home-auth` 运行该套件。它通过上游包的已发布入口导入这些包，因此需要当前的 `pnpm run build:artifacts` 产物；构建过期时，Delo 的检查运行器会启动该构建。
