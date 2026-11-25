---
description: "约定 C4：上游连接中的准入 seam、回环与远程访问监听器及其协议与 Host 规则、在任何路由或升级之前于分发器中进行的身份验证、登录前允许列表、服务器端会话及其有效期与轮换，以及远程访问监听器的响应头、内容安全策略与 Trusted Types。"
---

# 约定 C4：准入与监听器

[English](c04-admission.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

准入针对抵达 home 的 Host 的每个 HTTP 请求与每个升级请求，决定它能否继续，以及它代表哪个 Peer。上游的连接把每个通过身份验证的浏览器作为同一个共享的所有者 Peer 准入，并让每个路由自行进行身份验证。Delorun 为上游的连接增加一个 Authenticator Service Definition、一种用于远程访问（reach）的第二类监听器，以及在远程访问监听器的分发器中、先于任何路由、升级或回退处理器进行的身份验证。本页定义 Authenticator、各监听器及其声明的协议（scheme）与 `Host` 规则、分发顺序、登录前允许列表、会话存储及其 cookie、有效期与轮换，以及远程访问监听器的响应头。类型包 [`@delorun/contract-admission`](../../packages/contract-admission/README.zh.md) 承载这些标识符、代码与限值。

<a id="status"></a>
## 状态

回环监听器使用上游的准入运行。Tailscale 私有远程访问监听器只在本人开启远程访问期间运行，由 `@delorun/home-auth` 准入；不会打开其他远程访问监听器。

- **已构建并已使用：** CLI profile 中位于 `127.0.0.1:3080` 的回环监听器，它准入由 `delorun open` 和启动流程从 home 进程取得的[一次性启动令牌](#launch-tokens)、`/connect` 以及上游的无状态 `dsh-auth-*` cookie（见[会话](#sessions)），并对 `/api` 与 `/connect` 使用上游的 `Host` 与 `Origin` 检查。上游的连接以 `authenticator/minted` 通告每次回环签发，没有任何监听者。
- **远程访问开启时已构建并已使用：** `authenticator` Service Definition，`@delorun/home-auth` 在每个 CLI profile 中提供它，并在回环监听器上保留上游的准入；Tailscale 私有远程访问监听器，及其分发顺序、对上游凭据的拒绝、响应头、Content Security Policy、Trusted Types 头和远程图像占位符；除通行密钥、OpenID Connect 与恢复路由之外的登录前路由；以及远程访问会话的创建、滚动更新、轮换和空闲与绝对限值。
- **已构建，但无人使用：** Funnel 与 relay 远程访问监听器，只有测试会打开它们。
- **尚未构建：** 登录前允许列表中的通行密钥、OpenID Connect 与恢复路由；回环凭据记录、7 天空闲限值和回环凭据的轮换，以及 `delorun devices reset`，它们都在[远程访问设计](../design/reach.zh.md#loopback-credentials)中；以及回环 studio 上的 Content Security Policy。回环凭据是上游的启动 cookie 与 API 凭据，由上游内置的准入准入；不存在逐凭据的记录，因此没有请求因缺少记录而被拒绝。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [Authenticator](#authenticator)
  - [监听器](#listeners)
  - [分发顺序](#dispatch-order)
  - [登录前允许列表](#pre-login-allowlist)
  - [会话](#sessions)
  - [页面解锁](#page-unlock)
  - [启动令牌](#launch-tokens)
  - [轮换与撤销](#rotation-and-revocation)
  - [响应头](#response-headers)
  - [Trusted Types](#trusted-types)
  - [拒绝](#refusals)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
  - [本约定不能证明的内容](#what-this-does-not-prove)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="authenticator"></a>
### Authenticator

准入 seam 有三种角色。Service Definition 是 Cordis 服务 `authenticator`，即上游的 `@deepseek-ai/dsh-client-connection` 声明的抽象类 `Authenticator`。没有任何包提供它：在没有注册提供方期间，上游的连接以其自身基于启动令牌与 `dsh-auth-*` cookie 的准入进行准入，保持不变。Delorun 的提供方在下文中规定，尚未构建；`@delorun/home-auth` 不提供 `authenticator`。其消费方是上游的 `HostConnectionService` 与同一包中远程访问监听器的分发器。

- **`admit(request, listener)`** 为一个监听器上的一个请求返回一个 `Admission`。它是同步的：它只读取提供方的内存状态，从不等待异步操作、从不执行 I/O，也从不调用会执行这些操作的其他服务。上游的 `admit()` 与 `admitConnection()` 在返回之前调用它。
- **`policy(listener)`** 返回一个监听器的 `ListenerPolicy`：其声明的协议、其 `Host` 规则、其登录前允许列表，以及是否接受启动令牌。分发器在监听器启动时读取一次策略，并在提供方宣布变更时再次读取。
- **状态变更**发生在 `admit` 之外。提供方自己的登录前路由以异步方式验证设备签名、通行密钥断言与 OpenID Connect 响应，然后更新 `admit` 读取的内存状态。该状态的持久化遵循[会话](#sessions)一节。

`Admission` 是以下三种结果之一：

| 结果 | 字段 | 含义 |
| --- | --- | --- |
| `admitted` | `peer`、`deviceId`、`sessionId`，可选的 `setCookie` | 请求继续，并代表 `peer`。`setCookie` 携带一个经滚动更新或轮换的 cookie，由分发器加入响应。 |
| `pre-login` | `route` | 请求未经身份验证，且其方法与路径位于该监听器的登录前允许列表中。只有该路由可以响应它。 |
| `refused` | `status`、`code` | 分发器以 `status` 和响应体 `{"error":"<code>"}` 响应，且不分发任何内容。 |

**每台设备一个 Peer。** 提供方通过上游的 `createPeer`，为每台受信任设备（trusted device）在其获准入的每个监听器上各创建一个 Peer。该 Peer 的主体是 `{ kind: 'reach-device', deviceId }`，从不是上游的所有者，因此上游的 Gateway 根据提供方注册的 `reach-device` 远程访问策略，决定该 Peer 的每次调用和每个转发事件，该策略只允许 [C14](c14-oidc-passkeys.zh.md#tailnet-membership) 允许设备做的事；提供方保存从 Peer id 到设备 id 的映射。当设备被移除、其最后一个会话结束或监听器停止时，该 Peer 会被 dispose（资源释放），dispose 它会结束代表它的每个流。

<a id="listeners"></a>
### 监听器

home 的 Host 运行一个回环监听器；在远程访问开启期间，还为 [C7](c07-reach-providers.zh.md) 的每个生效的远程访问方式各运行一个远程访问监听器。每个监听器都有自己的地址、自己的策略与自己声明的协议。协议是策略的一部分，而不是从套接字推断，因为 `tailscaled` 终止 TLS 并转发明文 HTTP，所以监听器关于 `Secure` cookie 的决定遵循浏览器所见的协议。

| 监听器 id | 绑定到 | 声明的协议 | TLS 终止于 | `Host` 规则 | 登录 |
| --- | --- | --- | --- | --- | --- |
| `loopback` | 上游 web 服务器的地址，在 Delorun 的 profile 中为 `127.0.0.1:3080` | `http` | 无 TLS | 上游的防护：回环名称或绑定地址 | 根路径和 `/connect` 上的[一次性启动令牌](#launch-tokens) |
| `reach-tailscale-private` | [C7](c07-reach-providers.zh.md#tailscale-serve-target) 的 Tailscale 私有目标：`127.0.0.1` 上的一个 TCP 端口，或 C7 套接字变体的 Unix 套接字 | `https` | `tailscaled` | 等于所配置的 `ts.net` 地址，端口不是 443 时带上端口 | 设备密钥与身份因子（identity factor）之后的[会话](#sessions) |
| `reach-tailscale-funnel` | `127.0.0.1` 上的一个 TCP 端口，与私有目标分开 | `https` | `tailscaled` | 等于所配置的 Funnel 地址，端口不是 443 时带上端口 | 同上 |
| `reach-self-hosted-relay` | 无地址：它只接受 [C6](c06-relay-protocol.zh.md) 的中继客户端在 home 进程（home process）内传给它的流 | `https` | 该监听器，使用 home 自己的证书 | 等于绑定的名称，且等于连接的 SNI | 同上 |

- **不允许覆盖 host。** 没有任何配置字段能设定远程访问监听器的地址。TCP 远程访问监听器绑定 `127.0.0.1`，端口由操作系统分配，远程访问提供方读取绑定后的端口。为远程访问监听器设定 `host` 或 `port` 的 profile 行在加载时失败，并返回 `REACH_LISTENER_HOST_OVERRIDE`。
- **端口复用。** 回环监听器与远程访问监听器从不共用端口或套接字。
- **远程访问监听器依赖 home-auth。** 只有在 `@delorun/home-auth` 提供 `authenticator` 期间，远程访问监听器才会启动。当该提供方被移除或替换时，每个远程访问监听器都会在替代者处理任何请求之前关闭其连接并停止，且远程访问不会回退到上游的 cookie。

<a id="dispatch-order"></a>
### 分发顺序

远程访问监听器对每个 HTTP 请求与每个升级请求，按以下顺序应用以下步骤，然后才运行任何路由、升级处理器或回退处理器。

1. **移除请求头。** 监听器移除名称以 `tailscale-` 开头（不区分大小写）的每个请求头，[C7](c07-reach-providers.zh.md#identity-headers) 指定的监听器及条件下除外。
2. **`Host` 规则。** `Host` 不满足监听器规则的请求被拒绝，返回 `421 HOST_MISMATCH`。回环名称或地址（`localhost`、`127.0.0.1`、`[::1]`、任何 `127.0.0.0/8` 地址）从不满足远程访问监听器的规则。
3. **SNI。** 在 `reach-self-hosted-relay` 上，`Host` 与 TLS 连接的 SNI 不同的请求被拒绝，返回 `421 SNI_MISMATCH`。
4. **Origin。** `Origin` 请求头存在且不是该监听器地址的请求，或 `Sec-Fetch-Site` 为 `cross-site` 的请求，被拒绝，返回 `403 ORIGIN_MISMATCH`。没有 `Origin` 请求头的升级请求以同样方式被拒绝。
5. **上游凭据。** 携带 `token` 查询参数的请求被拒绝并返回 `401 LAUNCH_TOKEN_REFUSED`，对 `/connect` 的请求返回 `401 CONNECT_REFUSED`，携带名称以 `dsh-auth-` 开头的 cookie 的请求返回 `401 UPSTREAM_COOKIE_REFUSED`。
6. **准入。** 分发器调用 `admit`。`admitted` 请求继续前往与其匹配的路由、升级处理器或回退处理器。`pre-login` 请求只前往其允许列表中的路由。其他任何请求被拒绝，返回 `401 NOT_SIGNED_IN` 或 `refused` 结果中的代码；被拒绝的升级请求收到状态行，然后套接字被关闭。`refused` 结果可以写明 `location`：此时分发器对 `GET` 或 `HEAD` 请求改为以 `303 See Other` 重定向到它，前提是它是监听器自身 origin 上的路径（以一个前导 `/` 开头，其后不是 `/` 或 `\`，且不含 `\`、控制字符或空格）。对于没有有效会话的浏览器导航（`Sec-Fetch-Mode: navigate`，或在没有 fetch 元数据时 `Accept` 写明 `text/html`），Delorun 写明 `/auth/sign-in`，目标为 `/auth` 之外的普通路径时作为 `next`；脚本的请求、状态变更和升级请求保留 JSON 拒绝，回环监听器从不重定向。

回环监听器应用上游的防护，并像上游那样为其路由调用 `admit`；第 1 至 5 步仅适用于远程访问监听器。

**抵达时失败即关闭。** 提供方在任何路由运行之前，为远程访问监听器传给 `admit` 的每个请求打上该监听器的 id 戳记。只在回环监听器上响应的路由，例如 [C5](c05-device-approval.zh.md) 的所有者认领和设备路由，只有在请求不带戳记，且由回环监听器自己的套接字接受时，才把请求视为回环：套接字的本地端口是所配置监听器的绑定端口，其本地地址是回环地址。两者皆不满足的请求绝不是回环，因此转发了不带戳记请求的远程访问监听器一无所获，该路由还要求回环 `Host`。

回环监听器的防护是上游的 `api-request-trust.ts` 加上 Delorun 记录的改动，应用于 `/api` 以及每个调用 `requestRejection` 的路由，例如 studio 的 dist 文件（安装文件除外）：

- **`Host`。** `Host` 必须是回环名称或地址、监听器的绑定地址，或 `trustedHosts` 条目，并写成单独的 authority。上游 web 服务器的每个监听器对带有一行以上 `Host` 的请求或升级请求，在防护或任何路由运行之前就回答 `400`。
- **Origin 记录。** 存在的 `Origin` 必须是监听器自己的 origin，`Sec-Fetch-Site: cross-site` 被拒绝。目标为 `/api` 或其下的状态变更请求（除 `GET`、`HEAD`、`OPTIONS` 之外的任何方法）还必须表明其 origin：`Origin`，或 `Sec-Fetch-Site: same-origin` 或 `none`；`same-site` 和 `cross-origin` 被拒绝。目标按路由器读取的方式（WHATWG URL 解析）读取，因此点段（`/x/../api`）或其百分号编码写法（`/x/%2e%2e/api`）都无法让请求移出该规则。
- **无标记请求。** 既没有 `Origin` 也没有 `Sec-Fetch-Site` 的状态变更 `/api` 请求，只能通往回环 `Host` 或协议为 `https` 的监听器；在后者上，发送 Fetch-Metadata 的浏览器总会附带它，因此缺少标记表明调用方不是浏览器，例如脚本、`curl` 或桌面转发器。在明文 HTTP 上通往任何其他 authority（`trustedHosts` 名称或非回环绑定地址）时，它被拒绝并返回 `403`：浏览器在那里不发送这些标记，no-referrer 的表单提交也不发送 `Origin`，因此该请求与伪造请求无法区分。调用此类监听器的脚本应发送写明该监听器的 `Origin`（[升级指南](../../../docs/upgrade-guide/v0.2.2-rc.1/api-origin-over-plain-http/guide.zh.md)）。

<a id="pre-login-allowlist"></a>
### 登录前允许列表

登录之前，远程访问监听器只处理以下精确的方法与路径组合。其他每个路径、每个升级请求以及回退处理器在登录之前都响应 `401`。

| 方法与路径 | 归属方 | 用途 |
| --- | --- | --- |
| `GET /auth/sign-in` | `@delorun/home-auth` | 登录页，在 studio 启动之前提供。它只加载下列资源，不加载任何插件代码。 |
| `GET /auth/assets/<asset>` | `@delorun/home-auth` | 登录页自身构建出的资源：带内容哈希的 `.js` 与 `.css` 文件。 |
| `POST /auth/device/request` | `@delorun/home-auth` | 新设备发出的批准请求（[C5](c05-device-approval.zh.md#approval-request)）。 |
| `GET /auth/device/request/<request id>` | `@delorun/home-auth` | 一个批准请求的状态，凭其请求密钥读取。 |
| `POST /auth/device/challenge` | `@delorun/home-auth` | 一个新的设备密钥质询（[C5](c05-device-approval.zh.md#sign-in)）。 |
| `POST /auth/session` | `@delorun/home-auth` | 根据设备密钥签名创建与轮换会话；创建时还需要身份因子证明。 |
| `POST /auth/passkey/options` | `@delorun/home-auth` | 该监听器地址的 WebAuthn 选项（[C14](c14-oidc-passkeys.zh.md#passkeys)）。 |
| `GET /auth/oidc/start` | `@delorun/home-auth` | OpenID Connect 登录的开始（[C14](c14-oidc-passkeys.zh.md#authorization-flow)）。 |
| `GET /auth/oidc/callback` | `@delorun/home-auth` | 该登录的重定向 URI。 |
| `POST /auth/recovery` | `@delorun/home-auth` | 使用恢复套件（recovery kit），见 [C5](c05-device-approval.zh.md#recovery-kit)。 |
| `POST /auth/owner/claim` | `@delorun/home-auth` | 在每个远程访问监听器上响应 `403 OWNER_CLAIM_LOOPBACK_ONLY`，且不读取请求体；[C5](c05-device-approval.zh.md#owner-claim) 允许在 Tailscale 私有目标上认领的情况除外。 |

只有当 profile 的 `home-auth` 配置在 `preLoginRoutes` 中列出某个插件路由的精确方法与路径时，该路由才会加入远程访问监听器的登录前允许列表。插件自己的声明不增加任何内容。监听器的策略只列出本表中 home 已构建的路由；在 `0.1.0` 中，除通行密钥、OpenID Connect 与恢复路由之外的每一行都已构建。登录之后，只有当远程访问请求的目标是普通路径（匹配时不含查询），且位于 `@delorun/home-auth` 的 `REACH_DEVICE_PATHS`（studio 页面及其资源、`/api` 及其升级、`/plugins`、`/auth` 和 `/delorun/reach/status`）上时，`admit` 才放行；其他每个路由、升级请求和回退处理器都被拒绝并返回 `403 LOOPBACK_REQUIRED`。

<a id="sessions"></a>
### 会话

**远程访问会话**位于服务器端。

- **令牌。** 会话令牌是来自操作系统加密随机源的 32 字节，以不带填充的 base64url 编码（43 个字符）。
- **Cookie。** `__Host-delorun-session=<token>; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=<seconds to the absolute expiry>`，不带 `Domain` 属性。每个 studio 地址是独立的 origin，因此一个地址的会话 cookie 从不发送到另一个地址。
- **存储。** 提供方在内存中把每个会话保存为一条以其令牌的 SHA-256 哈希为键的记录：设备 id、监听器、studio 地址、创建时使用的身份因子、自签发以来是否触发过轮换条件、创建时间、最近使用时间、最近滚动更新时间与绝对到期时间。没有任何记录保存令牌。未写明监听器、[C14](c14-oidc-passkeys.zh.md) 的身份因子或轮换标记的已存记录会被当作不可读而拒绝，因为 home 在授予保留给其自身计算机的操作时会读取该因子（[C14](c14-oidc-passkeys.zh.md#tailnet-membership)）。存储在变更后 5 秒内以及 home 进程停止时持久化到 `~/.delorun/secrets/home-auth/sessions.json`（[C1](c01-home-layout.zh.md#secrets)）。撤销在引起它的响应返回之前持久化。
- **创建。** `POST /auth/session` 只根据以下两项创建会话：已为该监听器地址批准的受信任设备给出的新鲜设备密钥签名，以及针对该地址的身份因子证明（[C5](c05-device-approval.zh.md#sign-in)、[C14](c14-oidc-passkeys.zh.md)）。
- **注册会话。** 在没有已注册身份因子的地址上，同样的签名在没有证明时创建一个注册会话：一个绝对限值为 10 分钟的远程访问会话，只准入 [C14](c14-oidc-passkeys.zh.md#enrolment) 的注册路由，在其他地方被拒绝并返回 `401 NOT_SIGNED_IN`。提供方声明 `tailnet-membership` 的监听器没有注册会话：已批准设备的签名会创建带有该因子的完整会话，且不会据此注册任何因子。

**回环会话**保留上游的凭据：启动令牌交换、`/connect`，以及用上游 `.credentials.yaml` 中的浏览器会话密钥签名的无状态 HMAC cookie `dsh-auth-<hash>`。在 CLI profile 中，启动令牌是一次性的（[启动令牌](#launch-tokens)）；上游自己的 profile 保留每个 Host 进程生成一次、在该进程整个生命期内都被接受的 32 字节随机启动令牌。cookie 只检查其签名和到期时间：不存在服务器端记录，没有任何东西能撤销它，每个 cookie 都作为同一个所有者 Peer 准入。它在签发 `cookieMaxAgeDays` 之后到期，即上游的默认值 30，Delorun 的 profile 不改变它。浏览器会话密钥从不被替换，因此 cookie 在重启后仍然有效，直到到期。上游的连接以事件 `authenticator/minted` 通告每次签发，该事件同步发出，且早于写出携带该凭据的响应；它携带凭据的种类（启动令牌交换签发的为 `browser`，`/connect` 签发的为 `api`）、凭据值的 SHA-256 哈希（无填充的 base64url）、其受众、签发与过期时间，以及对 `api` 而言其所接纳的 Peer 的 id；该事件从不携带凭据值。该事件没有监听者；记录每个回环凭据并拒绝没有记录的凭据，见[远程访问设计](../design/reach.zh.md#loopback-credentials)。

| 监听器 | 空闲限值 | 绝对限值 | 滚动更新 |
| --- | --- | --- | --- |
| `loopback` | 无 | 自签发起 30 天 | 无：回环凭据在到期之前保持其值不变。 |
| 每个远程访问监听器 | 自最近使用起 12 小时 | 自创建起 14 天 | 使用期间每 24 小时，下一个获准入的请求会在 `setCookie` 中收到新令牌。旧令牌对已在传输中的请求保持有效 30 秒，然后其记录被删除。 |

超过空闲限值或绝对限值的会话被拒绝并返回 `401 SESSION_EXPIRED`，其记录被删除。滚动更新从不延长绝对限值。远程访问会话的使用是携带其令牌且被准入的 HTTP 请求或升级请求；在此前已准入的连接上的流量，包括客户端在已打开的 WebSocket 上发送的帧，不算使用。当远程访问会话超过其空闲或绝对限值，或被滚动更新的令牌的 30 秒宽限期结束时，无论是否有请求到来，提供方都会在那一刻关闭携带过为该令牌所准入请求的每个已打开的远程访问连接。

<a id="page-unlock"></a>
### 页面解锁

没有任何路由签发页面解锁：[PIN 模式](c14-oidc-passkeys.zh.md#pin-mode)对每台设备都拒绝解锁，设备改为用一次一个操作的授权凭证（grant）确认每项操作，持有通行密钥的设备则在 Face ID 通行期（pass）内确认。准入仍会剥离并检查下面的令牌载体，因此页面仍发送的令牌会以 `401 UNLOCK_INVALID` 被拒绝，并且不准入任何东西。下面每一部分都是准入的事实，而不是路由的事实。

- **载体。** 令牌在 `/api` 请求中作为 `Delorun-Unlock` 头传送，在 `/api/remote.mux` 升级请求中作为 WebSocket 子协议 `delorun-unlock.<token>` 传送。查询参数从不被读作令牌。提供该子协议的页面会在它之前再提供一个固定协议，使升级应答写明浏览器接受的协议。
- **剥离。** `admit` 在任何路由、升级处理器或插件看到请求之前，从请求的每个头视图中移除这两种载体。PIN 模式关闭时，令牌被剥离并被忽略。
- **检查。** 会话被准入之后，令牌必须写明一个绑定到该会话的设备、监听器与会话的解锁（最近 30 秒内被滚动更新的会话视为同一会话）。没有令牌的请求照常被准入，归属于该设备的锁定 Peer。未知、已结束、重复或绑定到其他对象的令牌会被拒绝并返回 `401 UNLOCK_INVALID`，绑定到其他设备、监听器或会话的解锁随之结束：移动过的令牌已经泄露。
- **每页一个 Peer。** 设备在每个监听器上持有一个已锁定的 Peer，并为每个运行中的页面解锁持有一个 Peer，其主体携带该解锁的 `unlockId`。Peer 决定它的页面可以做什么；没有任何 Peer 在没有自己的授权凭证时答复保留的提示或执行 `face` 操作，一次解锁也从不准入另一个页面。
- **结束。** 解锁结束时，其 Peer 被 dispose，其会话的远程访问连接被关闭。设备的其他页面以各自的令牌重新连接。
- **缓存。** 远程访问首页以 `Cache-Control: no-store` 应答，因此恢复的页面不会从缓存提供。

**授权凭证（Face ID）。** 已确认的操作不以令牌的形式传送：home 为每个设备、监听器、操作和调用哈希保存一个授权凭证（C14，「Face ID 解锁」）。`face` 类别的插件 Fetch 路由在 `Delorun-Grant` 头中写明它的授权凭证，home 在路由运行之前读取并移除该头，就像对 `Delorun-Unlock` 所做的那样；该头只保存授权凭证 id，home 检查的是它所收到的请求的哈希。Remote 调用和提示答复什么也不携带：策略和答复守卫去查找授权凭证。终端或文件夹选择器的保持窗口（hold）绑定到那个 id 和该连接。

<a id="launch-tokens"></a>
### 启动令牌

启动令牌是浏览器一次出示以取得回环 cookie 的凭据。上游的连接在 Host 的生命期内持有一个随机启动令牌，并接受它任意多次。CLI profile 开启上游的 `oneTimeLaunchTokens`（C16 开关 `one_time_launch_tokens`，在 Delorun 默认组合中开启，在对等组合中关闭），随之：

- **没有可重复使用的令牌。** Host 没有进程级启动令牌。上游的 `authenticatedUrl` 每次调用都为一次打开签发一个令牌：来自加密随机源的 32 字节，以 base64url 编码，绑定到它所加入的 URL 的协议和主机。
- **谁来签发。** `delorun` 用 C19 操作 `studio.open-token` 向 home 进程请求链接，该操作只接受来自令牌文件的启动令牌（[C19](c19-home-process.zh.md#requests-and-responses)）；`delorun open`、`delorun start`、不带参数的 `delorun` 以及设置结束时都这样请求。没有 HTTP 路由签发令牌，携带 Host 自己通道令牌的通道请求在该操作上被拒绝。在 Host 中运行的代码不受限制：Host 插件可以自己调用 `authenticatedUrl`。
- **转发端口。** 链接写明 studio 的回环主机与端口。`delorun open --print --port <n>` 写明同一个回环主机和另一个端口，例如 `ssh -L` 转发的本地端；主机从来只是 studio 的回环地址。
- **生命期。** 令牌在签发 60 秒后过期。同一时刻最多存在 5 个未被使用的令牌；签发第六个会丢弃最旧的一个。
- **仅用一次。** 令牌第一次被出示就被消耗，无论结果如何：在根路径或 `/connect` 上，无论交换成功，还是被 `Host`／`Origin` 屏障、拒绝启动令牌的提供方策略拒绝，或因其方法、站点或第二个 `token` 值被拒绝；在回环监听器的任何其他路径上，例如资源或 `/api`，在路由之前通过 Web 服务器的 `webserver/request` 事件消耗；在远程访问监听器上，同样消耗，并以 `LAUNCH_TOKEN_REFUSED` 拒绝。唯一的例外是带有 4 个以上 `token` 值的请求：它被拒绝，其任何值都不被读取或消耗。
- **交换。** 只有当出示是对根路径或 `/connect` 的 `GET`，恰好带一个未消耗且未过期的 `token` 值，其 `Host` 写明所签发 URL 的主机，其 `Sec-Fetch-Site`（若存在）为 `none` 或 `same-origin`，且其 `Origin`（若存在）是请求自己的 origin 时，才会登录。随后它收到上文所述的回环 cookie，不作改变。
- **比较。** 连接只保存未消耗令牌的 SHA-256 摘要，并以常量时间将出示的值与每个摘要比较。
- **拒绝。** 被拒绝的出示收到上游的 `401` 文本，并附 Delorun 的指示：运行 `delorun open`，或对经转发端口的链接运行 `delorun open --print --port <port>`。在不同于签发时的主机或端口出示的令牌会被拒绝，其文本写明它签发时所对应的地址。
- **不落盘。** 令牌只出现在交给浏览器启动器的链接中，以及 `delorun open --print` 下该命令的输出中。没有任何日志、状态应答、错误消息或打印出的启动行携带它；home 日志对 `token` URL 参数的脱敏（[C20](c20-operational-logs.zh.md)）仍作为第二道防线。

<a id="rotation-and-revocation"></a>
### 轮换与撤销

以下事件会轮换 home 在每个监听器上的每个会话：

- 设备批准（device approval）；
- 设备移除；
- 登录因子变更：注册、替换或移除通行密钥，更换 OpenID Connect 提供方或客户端，以及恢复套件还原完成；
- 远程访问提供方变更：开启或关闭某种远程访问方式，或添加、移除、更改 studio 地址。

轮换会在触发它的操作返回之前，关闭携带过为任一被轮换会话所准入请求的每个已打开的远程访问连接。被轮换的远程访问会话的下一个请求被拒绝，返回 `401 ROTATION_REQUIRED`。随后 studio 签署一个新的设备密钥质询，并携带旧令牌调用 `POST /auth/session`；该调用返回一个绝对到期时间相同的新令牌，并删除旧记录；不会再次要求身份因子。轮换不涉及没有记录的回环凭据。

撤销会立即结束会话。移除设备会在移除操作返回之前删除其会话与记录，并 dispose 其 Peer。`delorun devices reset`（[C5](c05-device-approval.zh.md#reset)）尚未构建，它会删除每条会话记录并替换浏览器会话密钥（[远程访问设计](../design/reach.zh.md#loopback-credentials)）。

<a id="response-headers"></a>
### 响应头

远程访问监听器的每个响应都携带以下响应头。回环监听器保留上游的响应头。

| 响应头 | 值 |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'; script-src 'self' 'nonce-<nonce>'; style-src-elem 'self' 'nonce-<nonce>'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; frame-src 'self' blob:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; require-trusted-types-for 'script'; trusted-types default delorun-plugin-loader delorun-blob-worker` |
| `Strict-Transport-Security` | `max-age=31536000` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `no-referrer` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | 每个 `/auth/` 与 `/api` 响应上为 `no-store` |

`<nonce>` 是来自加密随机源的 16 字节，以 base64url 编码，每个首页与登录页响应都重新生成。上游的首页渲染器把它作为其渲染的每个内联 `<script>` 与 `<style>` 元素的 `nonce` 属性加入。

**不对字符串求值，样式带 nonce。** 该策略从不允许 `'unsafe-eval'`，因此 studio 代码在加载时不对任何字符串求值。Loader 只在某个配置表达式需要时才编译其 `!!js` 求值器，而浏览器端组合不含此类表达式。Web 入口把页面的 nonce 加到通过 `document.createElement` 创建的每个 `<style>` 元素上，使插件与库的样式得以生效，并把 zod 切换到 jitless 模式，使 zod 不探测字符串求值。

**远程图片。** 在远程访问监听器上，studio 把 chat 内容中来源既不同源、也不是 `data:` URL 的图片或媒体元素渲染为占位符，占位符写明来源的主机名。占位符从不请求该来源；若有任何代码发出该请求，内容安全策略（Content Security Policy）会拒绝它。

<a id="trusted-types"></a>
### Trusted Types

远程访问监听器通过上述 `require-trusted-types-for 'script'` 指令强制执行 Trusted Types，并使用三个策略。`trusted-types` 指令逐一列出它们，因为该指令未列出的策略根本无法创建。

- **`default`。** 其 `createHTML` 把输入交给 studio 的 HTML 清理器处理，清理器移除 `<script>` 元素、事件处理器属性、`javascript:` URL 与 `<iframe srcdoc>`，然后返回结果，因此赋值 `innerHTML` 的上游组件与社区客户端插件仍可正常工作。其 `createScriptURL` 只在 URL 同源、路径以 `/plugins/` 开头，且去掉查询部分后的路径是客户端模块注册表当前启动 manifest（元数据清单）中列出的 bundle 时，才返回该 URL；否则返回 `null`，赋值失败。其 `createScript` 始终返回 `null`。
- **`delorun-plugin-loader`。** 上游的客户端模块加载器通过这个具名策略赋值 `script.src`，该策略应用与默认策略的 `createScriptURL` 相同的 URL 规则。
- **`delorun-blob-worker`。** 其 `createScriptURL` 只在 URL 是 `blob:` URL 且其源与页面自身相同时才返回该 URL；否则返回 `null`。blob URL 继承创建它的页面的源，因此该策略允许页面自己构建的 Worker 源码，而拒绝由另一个源构建的源码。源为不透明源（opaque origin）的页面会被拒绝每一个 URL，因为所有不透明源的字符串形式都相同。在由 Blob 构建的 Worker 中运行自身工作的四项功能（文件与图片上传，以及电子表格、PDF 与 Office 预览）都通过该策略生成其 Worker URL。`worker-src` 指令出于同样的原因允许 `blob:`：仅构造函数接受该 URL 还不够，因为如果该指令不允许其来源，Worker 随后就会被拒绝。

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
| `SESSION_EXPIRED` | 401 | 远程访问会话超过空闲限值或绝对限值。 |
| `ROTATION_REQUIRED` | 401 | 被轮换的远程访问会话的下一个请求。 |
| `OWNER_CLAIM_LOOPBACK_ONLY` | 403 | 在不允许认领的远程访问监听器上的 `POST /auth/owner/claim`。 |
| `REACH_LISTENER_HOST_OVERRIDE` | 加载失败 | profile 行设定了远程访问监听器的 `host` 或 `port`。 |

<a id="consumers"></a>
## 消费方

- 上游的 `packages/client/connection`：`Authenticator` Service Definition、其默认提供方、按监听器进行的 `admit` 调用，以及每个远程访问监听器的分发器，它执行分发顺序。
- 上游的 `packages/host/webserver`：远程访问监听器的套接字与字节流、在任何路由、upgrade 处理器或回退之前调用分发器的门控（gate）、响应头，以及内联元素上的 nonce。
- 上游的 `packages/client/modules/src/client/system.ts` 与赋值 `innerHTML` 的上游组件：Trusted Types 策略。
- `delorun/packages/home-auth/`：`authenticator` 提供方，包含登录前路由、会话存储与轮换、仅限回环的所有者认领、设备列表、批准窗口与移除；每个 CLI profile 都加载它。它不记录任何回环凭据。
- [C7](c07-reach-providers.zh.md) 的远程访问提供方：Tailscale 私有提供方已构建，并为该监听器提供目标；Funnel 提供方，以及中继客户端向 `reach-self-hosted-relay` 的移交尚未构建。
- `delorun/packages/plugin-changes/`：Changes 路由（[C21](c21-changes.zh.md#routes-and-the-recovery-screen)）先调用 `admit`，允许远程访问会话读取，并且只对回环 `Host` 下的请求采取行动，该请求须在回环监听器上，且按 `home-auth` 的 authenticator 为远程访问监听器所准入的每个请求设置的监听器戳记判断，其会话 Connection 的 `isReachPeer` 不指向它；前两项由 `@delorun/home` 的到达辅助函数决定。
- `delorun/packages/contract-admission/`：监听器 id、拒绝代码、cookie 名称与各项限值。
- [C10](c10-host-qualified-keys.zh.md)：它留在其清单之外的 cookie 名称。[C15](c15-verification-checks.zh.md)：`reach-binding` 检查读取监听器表。

<a id="compatibility"></a>
## 兼容性

没有 `authenticator` 提供方时，上游的准入保持不变；使用 `@delorun/home-auth`（它在回环监听器上保持上游的准入）时，CLI profile 仍像 stock DSH 一样准入回环请求，区别在于 `@delorun/bundle-local` 在那里开启上游的一次性启动令牌；上游的 profile、桌面应用和对等组合保留可重复使用的启动令牌。远程访问在对等组合（[C16](c16-parity-composition.zh.md)）中处于关闭状态，因此那里不运行任何远程访问监听器。准入不增加任何模型可见的输入，也不增加任何会话事件。

cookie 名称 `__Host-delorun-session`、监听器 id、拒绝代码以及会话存储的格式（版本 1）是固定的。更改有效期、响应头的值或登录前允许列表，属于对本约定的变更。更新的会话存储格式是一个带新版本的新文件；读取到未知版本存储的提供方以没有远程访问会话的状态启动，并保留该文件。

<a id="security"></a>
## 安全

要求：

- 远程访问监听器只绑定 `127.0.0.1` 或 Unix 套接字，或者完全不绑定地址，且任何配置都不能覆盖它。
- 远程访问监听器在其分发器中、先于任何路由、升级或回退处理器进行身份验证。登录之前它只处理登录前允许列表，且插件路由只有在 profile 列出它时才会加入该允许列表。
- 远程访问监听器拒绝启动令牌、`/connect`、上游的 `dsh-auth-*` cookie 与回环 `Host` 值。
- 在每个监听器上，监听器规则不允许的 `Host` 都会被拒绝；在中继监听器上，`Host` 还须等于 SNI。
- 远程访问会话以哈希形式保存在服务器端，可被撤销，使用带有与声明协议相符的 `Secure` 属性的 `__Host-` cookie。
- 会话遵循上述有效期，并在上述事件发生时轮换；被移除设备的会话在移除操作返回之前结束。
- `delorun devices reset` 替换回环浏览器会话密钥，因此在此之前签发的回环 cookie 停止生效。尚未构建（[远程访问设计](../design/reach.zh.md#loopback-credentials)）。
- 远程访问监听器的内容安全策略把 `connect-src`、`img-src` 与 `media-src` 限制为 `'self'`，图片与媒体另允许 `data:`，图片还允许 `blob:`，且从不允许 `'unsafe-eval'`；chat 中渲染的远程图片是占位符，从不被获取。
- Trusted Types 以上述两个策略强制执行。
- 移除或替换 `@delorun/home-auth` 会停止每个远程访问监听器，且远程访问从不回退到上游的 cookie。
- `admit` 基于内存状态同步执行；需要 I/O 才能作出决定的提供方，在其状态加载完成之前一律拒绝。
- 在 CLI profile 中，启动令牌只能使用一次，60 秒后过期，绑定到签发它的主机，来自其他站点时被拒绝，并且被任何出示它的回环或远程访问请求消耗；同时最多等待 5 个，带有 4 个以上 `token` 值的请求不经读取即被拒绝。`delorun` 只通过 `studio.open-token` 并凭本人的启动令牌取得令牌。

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
| `no reach listener runs without home-auth` | 移除 `@delorun/home-auth` 或由另一个提供方替换它后，没有任何远程访问监听器接受连接，且已打开的远程访问连接关闭。 |
| `a reach listener refuses a host override` | 为远程访问监听器设定 `host` 的 profile 在加载时失败，返回 `REACH_LISTENER_HOST_OVERRIDE`。 |
| `a request without a listener stamp is not loopback` | 带有回环 `Host` 却没有戳记、在回环监听器之外的套接字上被接受的认领与设备列表请求被拒绝，且不认领任何内容。 |
| `a forged Tailscale-User-Login changes nothing` | 在 Tailscale 私有监听器上，携带伪造 `Tailscale-*` 头的请求在没有这些头的情况下到达准入，发送它们的未批准设备收到 `DEVICE_NOT_TRUSTED`，且没有会话。 |
| `the session store holds no token` | 创建会话后，`sessions.json` 不含其中任何令牌，且作为记录键植入的令牌不会获准入。 |
| `idle and absolute limits refuse a session` | 12 小时未使用的远程访问会话与已创建 14 天的远程访问会话，各自被拒绝，返回 `SESSION_EXPIRED`。 |
| `a rolled token stops after its grace` | 滚动更新后，旧令牌在 30 秒内仍获准入，此后被拒绝。 |
| `a removed device's sessions end before the removal returns` | 移除操作返回后，该设备的下一个请求被拒绝，且其已打开的流已经结束。 |
| `a rotation needs a fresh device-key proof` | 设备批准后，旧的远程访问会话被拒绝并返回 `ROTATION_REQUIRED`，直到新的设备密钥签名将其轮换；重放的签名不能将其轮换。 |
| `a script URL outside the allowlist does not load` | `src` 为不在启动 manifest 中的同源路径、或为其他 origin 的 script 元素，被该策略拒绝，且从不被请求。 |
| `a community plugin's HTML loses its scripts` | 一个赋值含 `<script>` 与 `onerror` 属性的 HTML 的 fixture 客户端插件，渲染出 HTML 的其余部分，且两者都不保留。 |
| `the studio boots and styles a terminal with no policy violation` | 在远程访问监听器上，studio 启动、连接一个工作区并渲染一个侧边栏终端，其所有 `<style>` 元素都生效，且页面没有报告任何内容安全策略违规，包括字符串求值违规。 |
| `a remote image in chat is never requested` | 一个录制的 fixture chat，其消息含有带远程 URL 的 Markdown 图片；它在远程访问监听器上渲染为占位符，且网络防护没有记录到对该远程主机的任何请求。 |
| `signs in once with each token and refuses its second use with the configured instruction` | 一次性启动令牌只签发一次 cookie；它的第二次出示被拒绝，并附 `delorun open` 的指示。 |
| `refuses a token after 60 seconds` | 签发 60 秒后出示的令牌被拒绝。 |
| `keeps at most five waiting tokens and drops the oldest when a sixth is minted` | 第六次签发之后，第一个令牌被拒绝，其余五个可以登录。 |
| `refuses and consumes a token presented with another Host, from another site, by another method or beside another token` | 每一种这样的出示都被拒绝，且同一令牌在本可登录之处随后也被拒绝。 |
| `consumes a one-time launch token it refuses, so the loopback listener refuses it too` | 在远程访问监听器上出示的令牌在那里被拒绝，并且不再能在回环监听器上登录。 |
| `refuses a token at another loopback port or name, naming the address it was made for` | 以另一个回环端口，或以 `localhost` 代替 `127.0.0.1` 出示的令牌被拒绝并被消耗，拒绝文本写明它所签发的地址；为转发端口签发的令牌可通过该端口登录。 |
| `refuses Origin: null and accepts Sec-Fetch-Site: same-origin` | 不透明 origin 被拒绝并消耗令牌；同源导航可以登录。 |
| `drops expired tokens before it counts the five, and refuses more than four token values unread` | 过期令牌在下一次签发时离开等待集合，五个值（其中含一个有效令牌）既不登录也不消耗该令牌。 |
| `consumes a one-time launch token wherever a loopback request presents it and is refused` | 在信任屏障之后向 `/connect` 出示、在拒绝启动令牌的提供方策略下出示、向首页路由、资源路径、`/api` 或其他路由出示的令牌，都不再能登录。 |
| `refuses a reach request with more than four token values without reading them` | 带五个值的远程访问请求被拒绝，返回 `LAUNCH_TOKEN_REFUSED`。 |
| `keeps the reusable process token when the mode is off` | 开关处于对等值时，进程令牌可重复登录，与上游相同。 |
| `studio-open-token-person-only` | 只有来自令牌文件的启动令牌能取得链接；Host 的通道令牌和没有启动令牌的调用方被拒绝，home 日志不含任何链接。 |
| `setup-ending-signs-in` | 设置结束时从 home 进程打开的链接对真实连接登录一次，第二次使用被拒绝，并附 `delorun open` 的指示。 |
| `reads the target as the router does, so no dot-segment spelling of /api skips the origin rule` | 目标只有在去除点段（明文或百分号编码）之后才到达 `/api` 的状态变更请求，受 origin 规则约束，并以 `same-site` 标记被拒绝。 |
| `lets a caller with no browser markers reach only a destination a browser would have marked` | 没有浏览器标记的状态变更 `/api` 请求可通往回环与 HTTPS，而通往 `trustedHosts` 名称或明文 HTTP 绑定地址时被拒绝。 |
| `are answered 400 on the configured and an additional listener before any gate, route, resource, upgrade or fallback runs` | 带有两行 `Host` 的请求或升级请求在两类监听器上都收到 400，且不运行任何门控、处理器、资源、升级处理器或回退处理器。 |
| `keeps public only the exact dist-root install files, so a look-alike chunk or a nested copy stays fenced` | 与安装文件同名的 dist 文件，或其在子目录中的副本，需要登录；只有固定的根文件和 manifest 列出的根级图标是公开的。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **受信任源上的代码。** 准入决定谁能访问 Host，而不决定已获准入的代码做什么。社区客户端插件，或绕过净化器的脚本，以会话的全部权限在 studio 的源上运行；内容安全策略与 Trusted Types 限制脚本和请求如何进入，而不限制本人安装的代码。
- **每台设备都是所有者。** 每台受信任设备的 Peer 都以上游的 `owner` 主体行事，因此本约定不会让任何设备的权限低于另一台设备。
- **本人自己的进程。** 本人用户在沙箱之外的进程可以读取 home 的机密（包括浏览器会话密钥），可以签发回环凭据并修改会话存储；会话限额防范的是其他方，而不是这类进程（[C1](c01-home-layout.zh.md#security)）。
- **被复制的回环 cookie。** 回环 cookie 自签发起 30 天内有效，在重启后仍有效，且没有可用于撤销它的记录；回环 studio 不发送内容安全策略，因此 studio 创建的 Trusted Types 策略在那里不被强制执行。
- **命令行上的链接。** 浏览器启动器（`xdg-open`、`open`，或 Windows 与 WSL 下的 `cmd.exe`）以参数形式接收链接，因此令牌出现在该进程的命令行上；当启动器启动新的浏览器进程时，还出现在浏览器的命令行上。能读取命令行的另一个进程（Linux 上未设 `hidepid` 时的其他用户的进程，或 Landlock 或 Seatbelt 下的受限命令，它们的方言不隐藏本人的进程）可以在启动到浏览器第一次请求之间，最多在令牌的 60 秒内，抢在浏览器之前取得令牌。该请求之后，令牌就毫无价值。bwrap 给受限命令独立的进程命名空间，因此它看不到 Linux 上的其他进程；在 WSL 下该命名空间不覆盖经互操作到达的 Windows 进程，该情形在验证之前不在覆盖范围内。
- **聊天渲染之外的远程内容。** 占位符规则覆盖 studio 在聊天内容中渲染的图片与媒体；客户端插件发出的其他请求只由内容安全策略拒绝。

<a id="decided-values"></a>
## 决定的取值

- 回环凭据：自签发起绝对 30 天，上游的默认值；7 天空闲限值见[远程访问设计](../design/reach.zh.md#loopback-credentials)，尚未构建。
- 远程访问会话：空闲 12 小时，绝对 14 天，使用期间每 24 小时滚动更新一次，旧令牌有 30 秒宽限期。
- 轮换触发条件：设备批准或移除、登录因子变更，以及远程访问提供方变更。
- 会话令牌与会话存储：每个令牌 32 个随机字节，记录以 SHA-256 为键，在 5 秒内持久化，且在撤销返回之前持久化。
- 内容安全策略 nonce：每个页面响应 16 个随机字节。
- Delorun 的 profile 中回环监听器的地址：`127.0.0.1:3080`。
- CLI profile 中的启动令牌：只能使用一次，60 秒，最多 5 个未消耗，每个 32 个随机字节，每个请求最多读取 4 个 `token` 值。
