---
description: "约定 C4：上游连接中的准入 seam、回环与远程访问监听器及其协议与 Host 规则、在任何路由或升级之前于分发器中进行的身份验证、登录前允许列表、服务器端会话及其有效期与轮换，以及远程访问监听器的响应头、内容安全策略与 Trusted Types。"
---

# 约定 C4：准入与监听器

[English](c04-admission.md) | 中文

<a id="summary"></a>
## 摘要

准入针对抵达 home 的 Host 的每个 HTTP 请求与每个升级请求，决定它能否继续，以及它代表哪个 Peer。上游的连接把每个通过身份验证的浏览器作为同一个共享的所有者 Peer 准入，并让每个路由自行进行身份验证。Delo 为上游的连接增加一个 Authenticator Service Definition、一种用于远程访问（reach）的第二类监听器，以及在远程访问监听器的分发器中、先于任何路由、升级或回退处理器进行的身份验证。本页定义 Authenticator、各监听器及其声明的协议（scheme）与 `Host` 规则、分发顺序、登录前允许列表、会话存储及其 cookie、有效期与轮换，以及远程访问监听器的响应头。类型包 [`@delo/contract-admission`](../../packages/contract-admission/README.zh.md) 承载这些标识符、代码与限值。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [约定](#contract)
  - [Authenticator](#authenticator)
  - [监听器](#listeners)
  - [分发顺序](#dispatch-order)
  - [登录前允许列表](#pre-login-allowlist)
  - [会话](#sessions)
  - [轮换与撤销](#rotation-and-revocation)
  - [响应头](#response-headers)
  - [Trusted Types](#trusted-types)
  - [拒绝](#refusals)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="authenticator"></a>
### Authenticator

准入 seam 有三种角色。Service Definition 是 Cordis 服务 `authenticator`，即上游的 `@deepseek-ai/dsh-client-connection` 声明的抽象类 `Authenticator`。其 Service Providers 是上游的默认提供方，它原样重现上游基于启动令牌与 `dsh-auth-*` cookie 的准入；以及 Delo 的 `@delo/home-auth`，它在 Delo 的 profile 中替代默认提供方。其消费方是上游的 `HostConnectionService` 与 web 服务器的分发器。

- **`admit(request, listener)`** 为一个监听器上的一个请求返回一个 `Admission`。它是同步的：它只读取提供方的内存状态，从不等待异步操作、从不执行 I/O，也从不调用会执行这些操作的其他服务。上游的 `admit()` 与 `admitConnection()` 在返回之前调用它。
- **`policy(listener)`** 返回一个监听器的 `ListenerPolicy`：其声明的协议、其 `Host` 规则、其登录前允许列表，以及是否接受启动令牌。分发器在监听器启动时读取一次策略，并在提供方宣布变更时再次读取。
- **状态变更**发生在 `admit` 之外。提供方自己的登录前路由以异步方式验证设备签名、通行密钥断言与 OpenID Connect 响应，然后更新 `admit` 读取的内存状态。该状态的持久化遵循[会话](#sessions)一节。

`Admission` 是以下三种结果之一：

| 结果 | 字段 | 含义 |
| --- | --- | --- |
| `admitted` | `peer`、`deviceId`、`sessionId`，可选的 `setCookie` | 请求继续，并代表 `peer`。`setCookie` 携带一个经滚动更新或轮换的 cookie，由分发器加入响应。 |
| `pre-login` | `route` | 请求未经身份验证，且其方法与路径位于该监听器的登录前允许列表中。只有该路由可以响应它。 |
| `refused` | `status`、`code` | 分发器以 `status` 和响应体 `{"error":"<code>"}` 响应，且不分发任何内容。 |

**每台设备一个 Peer。** 提供方通过上游的 `createPeer`，为每台受信任设备（trusted device）在其获准入的每个监听器上各创建一个 Peer。该 Peer 的主体是上游的 `{ kind: 'owner' }`，因为每台受信任设备都代表本人（the person）行事，所以上游的授权保持不变；提供方保存从 Peer id 到设备 id 的映射。当设备被移除、其最后一个会话结束或监听器停止时，该 Peer 会被 dispose（资源释放），dispose 它会结束代表它的每个流。

<a id="listeners"></a>
### 监听器

home 的 Host 运行一个回环监听器；在远程访问开启期间，还为 [C7](c07-reach-providers.zh.md) 的每个生效的远程访问方式各运行一个远程访问监听器。每个监听器都有自己的地址、自己的策略与自己声明的协议。协议是策略的一部分，而不是从套接字推断，因为 `tailscaled` 终止 TLS 并转发明文 HTTP，所以监听器关于 `Secure` cookie 的决定遵循浏览器所见的协议。

| 监听器 id | 绑定到 | 声明的协议 | TLS 终止于 | `Host` 规则 | 登录 |
| --- | --- | --- | --- | --- | --- |
| `loopback` | 上游 web 服务器的地址，在 Delo 的 profile 中为 `127.0.0.1:3080` | `http` | 无 TLS | 上游的防护：回环名称或绑定地址 | 上游的启动令牌与 `/connect` |
| `reach-tailscale-private` | [C7](c07-reach-providers.zh.md#tailscale-serve-target) 的 Tailscale 私有目标：`127.0.0.1` 上的一个 TCP 端口，或 C7 套接字变体的 Unix 套接字 | `https` | `tailscaled` | 等于所配置的 `ts.net` 地址，端口不是 443 时带上端口 | 设备密钥与身份因子（identity factor）之后的[会话](#sessions) |
| `reach-tailscale-funnel` | `127.0.0.1` 上的一个 TCP 端口，与私有目标分开 | `https` | `tailscaled` | 等于所配置的 Funnel 地址，端口不是 443 时带上端口 | 同上 |
| `reach-self-hosted-relay` | 无地址：它只接受 [C6](c06-relay-protocol.zh.md) 的中继客户端在 home 进程（home process）内传给它的流 | `https` | 该监听器，使用 home 自己的证书 | 等于绑定的名称，且等于连接的 SNI | 同上 |

- **不允许覆盖 host。** 没有任何配置字段能设定远程访问监听器的地址。TCP 远程访问监听器绑定 `127.0.0.1`，端口由操作系统分配，远程访问提供方读取绑定后的端口。为远程访问监听器设定 `host` 或 `port` 的 profile 行在加载时失败，并返回 `REACH_LISTENER_HOST_OVERRIDE`。
- **端口复用。** 回环监听器与远程访问监听器从不共用端口或套接字。
- **远程访问监听器依赖 home-auth。** 只有在 `@delo/home-auth` 提供 `authenticator` 期间，远程访问监听器才会启动。当该提供方被移除或替换时，每个远程访问监听器都会在替代者处理任何请求之前关闭其连接并停止，且远程访问不会回退到上游的 cookie。

<a id="dispatch-order"></a>
### 分发顺序

远程访问监听器对每个 HTTP 请求与每个升级请求，按以下顺序应用以下步骤，然后才运行任何路由、升级处理器或回退处理器。

1. **移除请求头。** 监听器移除名称以 `tailscale-` 开头（不区分大小写）的每个请求头，[C7](c07-reach-providers.zh.md#identity-headers) 指定的监听器及条件下除外。
2. **`Host` 规则。** `Host` 不满足监听器规则的请求被拒绝，返回 `421 HOST_MISMATCH`。回环名称或地址（`localhost`、`127.0.0.1`、`[::1]`、任何 `127.0.0.0/8` 地址）从不满足远程访问监听器的规则。
3. **SNI。** 在 `reach-self-hosted-relay` 上，`Host` 与 TLS 连接的 SNI 不同的请求被拒绝，返回 `421 SNI_MISMATCH`。
4. **Origin。** `Origin` 请求头存在且不是该监听器地址的请求，或 `Sec-Fetch-Site` 为 `cross-site` 的请求，被拒绝，返回 `403 ORIGIN_MISMATCH`。没有 `Origin` 请求头的升级请求以同样方式被拒绝。
5. **上游凭据。** 携带 `token` 查询参数的请求被拒绝并返回 `401 LAUNCH_TOKEN_REFUSED`，对 `/connect` 的请求返回 `401 CONNECT_REFUSED`，携带名称以 `dsh-auth-` 开头的 cookie 的请求返回 `401 UPSTREAM_COOKIE_REFUSED`。
6. **准入。** 分发器调用 `admit`。`admitted` 请求继续前往与其匹配的路由、升级处理器或回退处理器。`pre-login` 请求只前往其允许列表中的路由。其他任何请求被拒绝，返回 `401 NOT_SIGNED_IN` 或 `refused` 结果中的代码；被拒绝的升级请求收到状态行，然后套接字被关闭。

回环监听器应用上游的防护，并像上游那样为其路由调用 `admit`；第 1 至 5 步仅适用于远程访问监听器。

<a id="pre-login-allowlist"></a>
### 登录前允许列表

登录之前，远程访问监听器只处理以下精确的方法与路径组合。其他每个路径、每个升级请求以及回退处理器在登录之前都响应 `401`。

| 方法与路径 | 归属方 | 用途 |
| --- | --- | --- |
| `GET /auth/sign-in` | `@delo/home-auth` | 登录页，在 studio 启动之前提供。它只加载下列资源，不加载任何插件代码。 |
| `GET /auth/assets/<asset>` | `@delo/home-auth` | 登录页自身构建出的资源：带内容哈希的 `.js` 与 `.css` 文件。 |
| `POST /auth/device/request` | `@delo/home-auth` | 新设备发出的批准请求（[C5](c05-device-approval.zh.md#approval-request)）。 |
| `GET /auth/device/request/<request id>` | `@delo/home-auth` | 一个批准请求的状态，凭其请求密钥读取。 |
| `POST /auth/device/challenge` | `@delo/home-auth` | 一个新的设备密钥质询（[C5](c05-device-approval.zh.md#sign-in)）。 |
| `POST /auth/session` | `@delo/home-auth` | 根据设备密钥签名创建与轮换会话；创建时还需要身份因子证明。 |
| `POST /auth/passkey/options` | `@delo/home-auth` | 该监听器地址的 WebAuthn 选项（[C14](c14-oidc-passkeys.zh.md#passkeys)）。 |
| `GET /auth/oidc/start` | `@delo/home-auth` | OpenID Connect 登录的开始（[C14](c14-oidc-passkeys.zh.md#authorization-flow)）。 |
| `GET /auth/oidc/callback` | `@delo/home-auth` | 该登录的重定向 URI。 |
| `POST /auth/recovery` | `@delo/home-auth` | 使用恢复套件（recovery kit），见 [C5](c05-device-approval.zh.md#recovery-kit)。 |
| `POST /auth/owner/claim` | `@delo/home-auth` | 在每个远程访问监听器上响应 `403 OWNER_CLAIM_LOOPBACK_ONLY`，且不读取请求体；[C5](c05-device-approval.zh.md#owner-claim) 允许在 Tailscale 私有目标上认领的情况除外。 |

只有当 profile 的 `home-auth` 配置在 `preLoginRoutes` 中列出某个插件路由的精确方法与路径时，该路由才会加入远程访问监听器的登录前允许列表。插件自己的声明不增加任何内容。登录之后，向上游 web 服务器注册的每个路由都在远程访问监听器上提供服务。

<a id="sessions"></a>
### 会话

**远程访问会话**位于服务器端。

- **令牌。** 会话令牌是来自操作系统加密随机源的 32 字节，以不带填充的 base64url 编码（43 个字符）。
- **Cookie。** `__Host-delo-session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<seconds to the absolute expiry>`，不带 `Domain` 属性。每个 studio 地址是独立的 origin，因此一个地址的会话 cookie 从不发送到另一个地址。
- **存储。** 提供方在内存中把每个会话保存为一条以其令牌的 SHA-256 哈希为键的记录：设备 id、监听器、studio 地址、创建时使用的身份因子、创建时间、最近使用时间、最近滚动更新时间与绝对到期时间。没有任何记录保存令牌。存储在变更后 5 秒内以及 home 进程停止时持久化到 `~/.delo/secrets/home-auth/sessions.json`（[C1](c01-home-layout.zh.md#secrets)）。撤销在引起它的响应返回之前持久化。
- **创建。** `POST /auth/session` 只根据以下两项创建会话：已为该监听器地址批准的受信任设备给出的新鲜设备密钥签名，以及针对该地址的身份因子证明（[C5](c05-device-approval.zh.md#sign-in)、[C14](c14-oidc-passkeys.zh.md)）。
- **注册会话。** 在没有已注册身份因子的地址上，同样的签名在没有证明时创建一个注册会话：一个绝对限值为 10 分钟的远程访问会话，只准入 [C14](c14-oidc-passkeys.zh.md#enrolment) 的注册路由，在其他地方被拒绝并返回 `401 NOT_SIGNED_IN`。

**回环会话**保留上游的凭据：启动令牌交换、`/connect`，以及用上游 `.credentials.yaml` 中的浏览器会话密钥签名的无状态 HMAC cookie `dsh-auth-<hash>`。`@delo/home-auth` 在签发每个回环凭据时记录它，以凭据值的 SHA-256 哈希为键；对于验证通过但没有记录的回环凭据，它予以拒绝并返回 `401 SESSION_EXPIRED`。Delo 的 profile 把上游的 `cookieMaxAgeDays` 设为 30。

| 监听器 | 空闲限值 | 绝对限值 | 滚动更新 |
| --- | --- | --- | --- |
| `loopback` | 自最近使用起 7 天 | 自签发起 30 天 | 无：回环凭据在到期或轮换之前保持其值不变。 |
| 每个远程访问监听器 | 自最近使用起 12 小时 | 自创建起 14 天 | 使用期间每 24 小时，下一个获准入的请求会在 `setCookie` 中收到新令牌。旧令牌对已在传输中的请求保持有效 30 秒，然后其记录被删除。 |

超过空闲限值或绝对限值的会话被拒绝并返回 `401 SESSION_EXPIRED`，其记录被删除。滚动更新从不延长绝对限值。

<a id="rotation-and-revocation"></a>
### 轮换与撤销

以下事件会轮换 home 在每个监听器上的每个会话：

- 设备批准（device approval）；
- 设备移除；
- 登录因子变更：注册、替换或移除通行密钥，更换 OpenID Connect 提供方或客户端，以及恢复套件还原完成；
- 远程访问提供方变更：开启或关闭某种远程访问方式，或添加、移除、更改 studio 地址。

被轮换的远程访问会话的下一个请求被拒绝，返回 `401 ROTATION_REQUIRED`。随后 studio 签署一个新的设备密钥质询，并携带旧令牌调用 `POST /auth/session`；该调用返回一个绝对到期时间相同的新令牌，并删除旧记录；不会再次要求身份因子。被轮换的回环凭据的下一个请求会收到一个新签发、绝对到期时间相同的凭据，旧记录被删除。

撤销会立即结束会话。移除设备会在移除操作返回之前删除其会话与记录，并 dispose 其 Peer。`delorun devices reset`（[C5](c05-device-approval.zh.md#reset)）删除每条会话记录，并替换上游 `.credentials.yaml` 中的浏览器会话密钥，因此在此之前签发的每个回环 cookie 都无法通过验证。

<a id="response-headers"></a>
### 响应头

远程访问监听器的每个响应都携带以下响应头。回环监听器保留上游的响应头。

| 响应头 | 值 |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<nonce>'; style-src-elem 'self' 'nonce-<nonce>'; style-src-attr 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; require-trusted-types-for 'script'; trusted-types default delo-plugin-loader` |
| `Strict-Transport-Security` | `max-age=31536000` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | 每个 `/auth/` 与 `/api` 响应上为 `no-store` |

`<nonce>` 是来自加密随机源的 16 字节，以 base64url 编码，每个首页与登录页响应都重新生成。上游的首页渲染器把它作为其渲染的每个内联 `<script>` 与 `<style>` 元素的 `nonce` 属性加入。

**远程图片。** 在远程访问监听器上，studio 把 chat 内容中来源既不同源、也不是 `data:` URL 的图片或媒体元素渲染为占位符，占位符写明来源的主机名。占位符从不请求该来源；若有任何代码发出该请求，内容安全策略（Content Security Policy）会拒绝它。

<a id="trusted-types"></a>
### Trusted Types

远程访问监听器通过上述 `require-trusted-types-for 'script'` 指令强制执行 Trusted Types，并使用两个策略。

- **`default`。** 其 `createHTML` 把输入交给 studio 的 HTML 清理器处理，清理器移除 `<script>` 元素、事件处理器属性、`javascript:` URL 与 `<iframe srcdoc>`，然后返回结果，因此赋值 `innerHTML` 的上游组件与社区客户端插件仍可正常工作。其 `createScriptURL` 只在 URL 同源、路径以 `/plugins/` 开头，且去掉查询部分后的路径是客户端模块注册表当前启动 manifest（元数据清单）中列出的 bundle 时，才返回该 URL；否则返回 `null`，赋值失败。其 `createScript` 始终返回 `null`。
- **`delo-plugin-loader`。** 上游的客户端模块加载器通过这个具名策略赋值 `script.src`，该策略应用与默认策略的 `createScriptURL` 相同的 URL 规则。

<a id="refusals"></a>
### 拒绝

| 代码 | 状态 | 触发条件 |
| --- | --- | --- |
| `HOST_MISMATCH` | 421 | `Host` 不满足监听器的规则。 |
| `SNI_MISMATCH` | 421 | 在 `reach-self-hosted-relay` 上，`Host` 与 SNI 不同。 |
| `ORIGIN_MISMATCH` | 403 | 外部 `Origin`、`Sec-Fetch-Site: cross-site`，或没有 `Origin` 的升级请求。 |
| `LAUNCH_TOKEN_REFUSED` | 401 | 远程访问监听器上的 `token` 查询参数。 |
| `CONNECT_REFUSED` | 401 | 远程访问监听器上的 `/connect`。 |
| `UPSTREAM_COOKIE_REFUSED` | 401 | 远程访问监听器上的 `dsh-auth-*` cookie。 |
| `NOT_SIGNED_IN` | 401 | 没有获准入的会话，也没有允许列表中的路由。 |
| `SESSION_EXPIRED` | 401 | 超过空闲限值或绝对限值，或回环凭据没有记录。 |
| `ROTATION_REQUIRED` | 401 | 被轮换的远程访问会话的下一个请求。 |
| `OWNER_CLAIM_LOOPBACK_ONLY` | 403 | 在不允许认领的远程访问监听器上的 `POST /auth/owner/claim`。 |
| `REACH_LISTENER_HOST_OVERRIDE` | 加载失败 | profile 行设定了远程访问监听器的 `host` 或 `port`。 |

<a id="consumers"></a>
## 消费方

- 上游的 `packages/client/connection`：`Authenticator` Service Definition、其默认提供方，以及按监听器进行的 `admit` 调用。
- 上游的 `packages/host/webserver`：远程访问监听器、分发顺序、响应头，以及内联元素上的 nonce。
- 上游的 `packages/client/modules/src/client/system.ts` 与赋值 `innerHTML` 的上游组件：Trusted Types 策略。
- `delo/packages/home-auth/`：Delo 的提供方、会话存储、登录前路由与轮换。
- `delo/packages/reach/`：远程访问监听器的目标，以及中继客户端向 `reach-self-hosted-relay` 的移交。
- `delo/packages/contract-admission/`：监听器 id、拒绝代码、cookie 名称与各项限值。
- [C10](c10-host-qualified-keys.zh.md)：它留在其清单之外的 cookie 名称。[C15](c15-verification-checks.zh.md)：`reach-binding` 检查读取监听器表。

<a id="compatibility"></a>
## 兼容性

Authenticator 的默认提供方保持上游的准入不变，因此没有 `@delo/home-auth` 的 profile 会像 stock DSH 一样准入请求。远程访问在对等组合（[C16](c16-parity-composition.zh.md)）中处于关闭状态，因此那里不运行任何远程访问监听器。准入不增加任何模型可见的输入，也不增加任何会话事件。

cookie 名称 `__Host-delo-session`、监听器 id、拒绝代码以及会话存储的格式（版本 1）是固定的。更改有效期、响应头的值或登录前允许列表，属于对本约定的变更。更新的会话存储格式是一个带新版本的新文件；读取到未知版本存储的提供方以没有远程访问会话的状态启动，并保留该文件。

<a id="security"></a>
## 安全

要求：

- 远程访问监听器只绑定 `127.0.0.1` 或 Unix 套接字，或者完全不绑定地址，且任何配置都不能覆盖它。
- 远程访问监听器在其分发器中、先于任何路由、升级或回退处理器进行身份验证。登录之前它只处理登录前允许列表，且插件路由只有在 profile 列出它时才会加入该允许列表。
- 远程访问监听器拒绝启动令牌、`/connect`、上游的 `dsh-auth-*` cookie 与回环 `Host` 值。
- 在每个监听器上，监听器规则不允许的 `Host` 都会被拒绝；在中继监听器上，`Host` 还须等于 SNI。
- 远程访问会话以哈希形式保存在服务器端，可被撤销，使用带有与声明协议相符的 `Secure` 属性的 `__Host-` cookie。
- 会话遵循上述有效期，并在上述事件发生时轮换；被移除设备的会话在移除操作返回之前结束。
- `delorun devices reset` 替换回环浏览器会话密钥，因此在此之前签发的回环 cookie 停止生效。
- 远程访问监听器的内容安全策略把 `connect-src`、`img-src` 与 `media-src` 限制为 `'self'`，图片与媒体另允许 `data:`；chat 中渲染的远程图片是占位符，从不被获取。
- Trusted Types 以上述两个策略强制执行。
- 移除或替换 `@delo/home-auth` 会停止每个远程访问监听器，且远程访问从不回退到上游的 cookie。
- `admit` 基于内存状态同步执行；需要 I/O 才能作出决定的提供方，在其状态加载完成之前一律拒绝。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `every route and upgrade answers 401 before sign-in on each reach listener` | 在每个远程访问监听器上，向 web 服务器注册的每个精确路由、前缀路由、升级路由与回退处理器，以及一个 fixture（测试前置数据）插件的路由与升级，都响应 401，且其处理器不运行。 |
| `a plugin route is pre-login only when the profile lists it` | 一个声明自身为登录前路由的 fixture 插件路由，在 profile 的 `preLoginRoutes` 列出它之前，于登录前响应 401。 |
| `a cookie minted with upstream's secret is refused on a reach listener` | 针对同一 authority 的有效 `dsh-auth-*` cookie 被拒绝，返回 `UPSTREAM_COOKIE_REFUSED`。 |
| `launch tokens and /connect are refused on a reach listener` | `token` 查询中的进程启动令牌与对 `/connect` 的请求各自被拒绝，且不设置任何 cookie。 |
| `a loopback Host is refused on a reach listener` | `Host` 中的 `localhost`、`127.0.0.1` 与 `[::1]` 被拒绝，返回 `HOST_MISMATCH`。 |
| `each listener refuses a Host its rule does not allow` | 在每个监听器上，不是其绑定名称或地址的 `Host` 被拒绝；在中继监听器上，与 SNI 不同的 `Host` 被拒绝。 |
| `an upgrade with a foreign or absent Origin is refused` | 在远程访问监听器上，带有其他 origin 或没有 `Origin` 的、到 `/api` 的 WebSocket 升级请求被拒绝。 |
| `no reach listener runs without home-auth` | 移除 `@delo/home-auth` 或由另一个提供方替换它后，没有任何远程访问监听器接受连接，且已打开的远程访问连接关闭。 |
| `a reach listener refuses a host override` | 为远程访问监听器设定 `host` 的 profile 在加载时失败，返回 `REACH_LISTENER_HOST_OVERRIDE`。 |
| `the session store holds no token` | 创建会话后，`sessions.json` 不含其中任何令牌，且作为记录键植入的令牌不会获准入。 |
| `idle and absolute limits refuse a session` | 12 小时未使用的远程访问会话、已创建 14 天的远程访问会话、7 天未使用的回环凭据以及已签发 30 天的回环凭据，各自被拒绝，返回 `SESSION_EXPIRED`。 |
| `a rolled token stops after its grace` | 滚动更新后，旧令牌在 30 秒内仍获准入，此后被拒绝。 |
| `a removed device's sessions end before the removal returns` | 移除操作返回后，该设备的下一个请求被拒绝，且其已打开的流已经结束。 |
| `a rotation needs a fresh device-key proof` | 设备批准后，旧的远程访问会话被拒绝并返回 `ROTATION_REQUIRED`，直到新的设备密钥签名将其轮换；重放的签名不能将其轮换。 |
| `a loopback cookie minted before devices reset is refused after it` | 在 `delorun devices reset` 之前获准入的回环 cookie，在其之后被拒绝。 |
| `a script URL outside the allowlist does not load` | `src` 为不在启动 manifest 中的同源路径、或为其他 origin 的 script 元素，被该策略拒绝，且从不被请求。 |
| `a community plugin's HTML loses its scripts` | 一个赋值含 `<script>` 与 `onerror` 属性的 HTML 的 fixture 客户端插件，渲染出 HTML 的其余部分，且两者都不保留。 |
| `a remote image in chat is never requested` | 一个录制的 fixture chat，其消息含有带远程 URL 的 Markdown 图片；它在远程访问监听器上渲染为占位符，且网络防护没有记录到对该远程主机的任何请求。 |

<a id="decided-values"></a>
## 决定的取值

- 回环会话：空闲 7 天，绝对 30 天。
- 远程访问会话：空闲 12 小时，绝对 14 天，使用期间每 24 小时滚动更新一次，旧令牌有 30 秒宽限期。
- 轮换触发条件：设备批准或移除、登录因子变更，以及远程访问提供方变更。
- 会话令牌与会话存储：每个令牌 32 个随机字节，记录以 SHA-256 为键，在 5 秒内持久化，且在撤销返回之前持久化。
- 内容安全策略 nonce：每个页面响应 16 个随机字节。
- Delo 的 profile 中回环监听器的地址：`127.0.0.1:3080`。
