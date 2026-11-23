---
description: "约定 C5：home 密钥、绑定到其源的设备密钥与绑定到其依赖方 ID 的通行密钥、所有者验证码与所有者认领、批准请求与批准及其匹配码、签名、过期与速率限制、登录、撤销、设备重置、带 72 小时取消延迟的恢复套件、桌面应用的 TLS 固定，以及无屏幕 home 上的告警投递。"
---

# 约定 C5：设备批准

[English](c05-device-approval.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

home 只把浏览器或桌面应用作为受信任设备（trusted device）接纳：即 home 已为某一个 studio 地址批准其密钥的设备。第一台设备在 home 所在的计算机上用所有者验证码（owner code）认领该 home。之后的每台设备都由一台受信任设备在实时会话中批准，方法是输入新设备显示的代码。本页定义各密钥及其存储位置、设备密钥与其源（origin）的绑定以及通行密钥与其依赖方 ID（relying-party ID）的绑定、所有者认领与重置、批准请求与批准及其匹配码、签名、过期与速率限制、登录、撤销、恢复套件（recovery kit）、桌面应用在另一个 home 上的 TLS 固定，以及告警如何送达 home 没有屏幕的本人（the person）。类型包 [`@delorun/contract-device-approval`](../../packages/contract-device-approval/README.zh.md) 承载消息类型、错误码与限制。

<a id="status"></a>
## 状态

设备批准只为 Tailscale 私有路线构建，并在本人开启远程访问期间使用。

- **已构建并已使用：** `@delorun/home-auth`（每个 CLI profile 都加载它）持有一次性所有者验证码、只在回环监听器上响应的所有者认领、批准窗口、待处理请求、匹配码、本地批准（回环 studio 的表单与 `delorun devices approve`）、Tailscale 私有监听器上用设备密钥登录、设备列表与设备移除（`delorun devices list | approve | remove | code`）。`delorun export` 在 `secrets/home-auth/home-key.pem` 创建的 home 密钥只为归档签名（[C8](c08-archive-and-trash.zh.md)）。
- **尚未构建：** 在有效会话中从受信任设备批准及其批准提示、不持有通行密钥的设备从另一台设备移除、`delorun devices reset`、恢复套件、通行密钥与 OpenID Connect 登录、桌面应用连接到另一个 home 及其 TLS 固定，以及告警。私有 tailnet 路线的规则见[远程访问设计](../design/reach.zh.md)。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [密钥与存储](#keys-and-storage)
  - [绑定到地址](#binding-to-an-address)
  - [所有者认领](#owner-claim)
  - [批准请求](#approval-request)
  - [批准窗口](#approval-window)
  - [匹配码](#match-code)
  - [批准](#approval)
  - [批准提示](#approval-prompt)
  - [本地批准](#local-approval)
  - [登录](#sign-in)
  - [移除](#removal)
  - [重置](#reset)
  - [恢复套件](#recovery-kit)
  - [另一个 home 上的桌面应用](#desktop-app-on-another-home)
  - [告警](#alerts)
  - [限制](#limits)
  - [错误](#errors)
  - [Delorun 信箱](#delorun-mailbox)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
  - [本约定不能证明的内容](#what-this-does-not-prove)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="keys-and-storage"></a>
### 密钥与存储

传输中的每个字节串都是不带填充的 base64url。每个签名对象在签名或验证之前，都去掉其 `signature` 字段，并以 JSON 规范化方案（JSON Canonicalization Scheme，RFC 8785）序列化。

| 密钥或机密 | 类型 | 持有方 | 存储 |
| --- | --- | --- | --- |
| home 密钥 | Ed25519 | home | `~/.delorun/secrets/home-auth/home-key.pem`，PKCS #8，模式 0600（[C1](c01-home-layout.zh.md#secrets)）。在 home 首次启动时生成，重置后仍保留。 |
| home 密钥 id | 32 字节原始 home 公钥的 SHA-256 | 所有人 | 不保密。它在批准、告警以及 [C6](c06-relay-protocol.zh.md) 的中继绑定中标识该 home。 |
| 浏览器设备密钥 | ECDSA P-256 配合 SHA-256，由 WebCrypto 以 `extractable: false` 生成 | 一个浏览器源 | 该源的 IndexedDB，数据库 `delorun-device`，对象存储 `keys`。私钥从不离开浏览器。 |
| 桌面设备密钥 | ECDSA P-256 配合 SHA-256 | 桌面应用 | 桌面应用 profile 目录中每个 home 一个文件 `delorun/device-keys/<home key id>.bin`，以 Electron 的 `safeStorage` 加密。 |
| 设备 id | 设备公钥的 RFC 7638 SHA-256 指纹 | 所有人 | 不保密。 |
| 通行密钥 | 一个 WebAuthn 凭据，算法为 ES256、EdDSA 或 RS256，带用户验证 | 认证器 | 认证器；home 在 `~/.delorun/secrets/home-auth/passkeys.json` 中保存凭据 id、公钥与地址（[C14](c14-oidc-passkeys.zh.md#passkeys)）。 |
| 所有者验证码 | 16 个随机字节 | home 与本人 | 在终端中显示一次；home 只在 `~/.delorun/secrets/home-auth/owner-code.json` 中保存其 SHA-256 哈希与过期时间。 |
| 恢复套件 | 32 个随机字节，写作 `DELORUN-RK1-` 后接 52 个 base32 字符 | 本人 | 在 studio 中显示一次；home 只在 `~/.delorun/secrets/home-auth/recovery.json` 中保存其 SHA-256 哈希。 |

设备记录位于 `~/.delorun/secrets/home-auth/devices.json`：每台设备的 id、公钥、studio 地址、标签、平台、批准时间、批准它的设备与最近一次登录时间。所有者记录位于 `~/.delorun/secrets/home-auth/owner.json`：认领时间、第一台设备，以及 [C14](c14-oidc-passkeys.zh.md#owner-subject) 的已固定身份。每个文件的模式为 0600，并带有值为 `1` 的 `v` 字段。

<a id="binding-to-an-address"></a>
### 绑定到地址

设备密钥绑定到生成它的源，通行密钥绑定到其依赖方 ID（[C14](c14-oidc-passkeys.zh.md#relying-party-ids)）。为某一个 studio 地址批准的设备在另一个地址上不受信任，home 在那里以 `DEVICE_NOT_TRUSTED` 拒绝其密钥。

- **添加地址。** 每台要使用新地址的设备都在该源上生成密钥，并像新设备一样为该地址获得批准。身份因子（identity factor）先为新地址完成注册，home 才在该地址上接受注册会话以外的会话（[C14](c14-oidc-passkeys.zh.md#enrolment)）。
- **更改地址。** 更改地址会移除旧地址及其设备记录、通行密钥与会话，并添加新地址。
- **回环。** 在回环源上，持有回环会话（[C4](c04-admission.zh.md#sessions)）的浏览器无需批准即可登记其设备密钥，因为回环凭据已经证明了本地访问。回环设备可以为每个地址批准设备。

<a id="owner-claim"></a>
### 所有者认领

在有设备认领之前，home 没有所有者；在有所有者之前，远程访问（reach）保持关闭。只有回环监听器接受所有者认领，可在 home 所在的计算机上或通过 SSH 端口转发访问该监听器。

- **所有者验证码。** home 没有所有者时，`delorun setup` 与 `delorun start` 会向其终端打印所有者验证码，`delorun devices code` 会打印一个新的验证码。验证码为 RFC 4648 base32 字母表（`A`–`Z`、`2`–`7`）中的 26 个字符，连续打印为一串。每个命令只在其标准输出是终端时才打印验证码；否则它打印一条说明，要求在终端中运行 `delorun devices code`。新验证码取代之前的验证码。验证码只能使用一次，并在打印后 10 分钟过期。输入大小写均可接受，空格与连字符会被忽略。任何服务都不记录验证码，C20 的脱敏器把每个已登记的验证码视为机密（[C20](c20-operational-logs.zh.md#redaction)）。
- **用验证码认领。** 回环监听器上的 `POST /auth/owner/claim` 携带 `{ "v": 1, "ownerCode", "devicePublicKey", "label" }`。home 以恒定时间比较验证码的哈希，消耗该验证码，创建所有者记录，并把该设备记录为第一台受信任设备。错误、已使用或已过期的验证码得到 `403 OWNER_CODE_INVALID`。不设锁定：验证码具有 128 位熵，且认领尝试限制为每个来源每分钟 10 次。
- **从回环会话认领。** 回环监听器上带有上游启动令牌凭据的请求，可以不用验证码认领 home，作为开启远程访问的第一步。
- **本地认领。** 在 home 所在的计算机上打开第一个[批准窗口](#approval-window)，无论是通过回环 studio，还是通过 home 套接字（[C19](c19-home-process.zh.md#requests-and-responses)）运行本人自己的 `delorun devices approve`，都会为本地的本人认领一个没有所有者的 home：所有者记录把 `local` 记为其第一台设备，且不写入设备记录。
- **远程访问监听器。** 每个远程访问监听器对 `POST /auth/owner/claim` 都以 `403 OWNER_CLAIM_LOOPBACK_ONLY` 和一条写明回环监听器与 SSH 端口转发的消息作答，且不读取请求体（[C4](c04-admission.zh.md#pre-login-allowlist)）。这是当前约定，因为 C7 的[回退方案](c07-reach-providers.zh.md#tailscale-serve-target)正在生效：远程访问开启之前不存在身份因子，且任何监听器都不信任身份标头。
- **Tailscale 套接字变体上的认领。** 若 C7 采用其套接字变体，`reach-tailscale-private` 也接受携带所有者验证码、且其 Tailscale 身份标头受 C7 信任的请求所发起的认领。发起认领的 tailnet 登录名成为 tailnet 登录名允许列表的第一项（[C7](c07-reach-providers.zh.md#identity-headers)）。

<a id="approval-request"></a>
### 批准请求

远程访问地址上的新设备发送 `POST /auth/device/request`：

| 字段 | 取值 |
| --- | --- |
| `v` | `1` |
| `devicePublicKey` | 以 JWK 表示的设备公钥（`kty` `EC`，`crv` `P-256`）。 |
| `deviceNonce` | 16 个随机字节。 |
| `label` | 本人为设备取的名称，1 到 64 个字符。 |
| `platform` | 页面读取到的浏览器与操作系统，最多 64 个字符。 |

home 把请求绑定到该监听器的 studio 地址，并以 `201` 作答，返回 `requestId`（16 个随机字节）、`requestSecret`（16 个随机字节）、`homePublicKey`（32 字节原始 home 公钥）、`homeNonce`（16 个随机字节）与 `expiresAt`。请求在创建 5 分钟后过期。一个 home 最多持有 5 个待处理请求；第六个以 `429 APPROVAL_PENDING_LIMIT` 被拒绝，且不取代其中任何一个。待处理请求只在被批准、过期、因 3 次错误验证码而被取消，或被本人在 home 所在的计算机上取消（[本地批准](#local-approval)）时离开，离开即腾出其位置。一个来源每分钟最多发出 10 个请求；第十一个以 `429 APPROVAL_RATE_LIMITED` 被拒绝。来源即[批准提示](#approval-prompt)所显示的地址。带有 C0 或 C1 控制字符、DEL、U+2028 或 U+2029，或双向控制字符（U+061C、U+200E、U+200F、U+202A 至 U+202E、U+2066 至 U+2069）的 `label` 或 `platform` 以 `400 BAD_REQUEST` 被拒绝，认领中这样的 `label` 同样如此。设备记录按写入时的原样读取，`delorun` 把标签、平台或 id 中的每个这类字符打印为 `\uXXXX` 转义。

新设备使用 `GET /auth/device/request/<request id>` 与标头 `Authorization: Delorun-Request <request secret>` 读取其请求的状态，每 2 秒最多一次。状态为 `pending`、`approved`、`cancelled`、`recovery-pending` 与 `expired`。未知的请求和错误的密钥都以 `410 APPROVAL_EXPIRED` 作答，请求在过期后仍可读取 5 分钟。

<a id="approval-window"></a>
### 批准窗口

在身份因子为 `tailnet-membership` 的监听器上（[C14](c14-oidc-passkeys.zh.md#tailnet-membership)），home 只在批准窗口打开期间接受批准请求，窗口取代那里的常驻队列：该路线上的每个请求的来源都是 `127.0.0.1`，否则 tailnet 上的任何设备都可以一直占满 5 个待处理位置。本人只能在 home 所在的计算机上打开窗口，方式是回环 studio 的「Add a device」（回环监听器上来自 studio 自身 origin 的 `POST /auth/devices/window`）或 `delorun devices approve`。窗口持续 5 分钟，并在第一次批准时关闭。窗口之外，`POST /auth/device/request` 在不读取请求体的情况下回答 `403 APPROVALS_CLOSED`。在窗口中接受的请求保持自己的 5 分钟过期时间。窗口打开期间，写明某个 Tailscale 登录名的请求按登录名计数：它每分钟最多发出 10 个请求，其请求最多有 `pairing.pendingPerIdentity` 个在等待，所有登录名合计每分钟最多发出 50 个请求；没有写明登录名的请求共用其来源的额度。home 无法验证请求来自何处：窗口打开期间，tailnet 上的任何设备都可以发起请求，匹配码才是把批准绑定到本人所读屏幕所在设备的依据。

<a id="pop-up-pairing"></a>
### 弹出配对

设备可以在没有批准窗口的情况下请求配对，home 所在计算机上的 studio 随后显示该请求。`@delorun/home-auth` 的 `pairing` 配置决定谁可以请求；每个字段在加载时验证，超出范围时会写明其范围。

| 字段 | 取值 | Delorun 默认值 |
| --- | --- | --- |
| `pairing.mayAskWithoutWindow` | `own-user`：以这台计算机所登录的 Tailscale 用户登录的设备。`tailnet`：tailnet 上的任何设备。`window-only`：无人（需要窗口）。 | `own-user` |
| `pairing.showRequest` | `dialog`: the pop-up below opens at once. `notice`: a notice with **Enter code** and **Decline**, and **Enter code** opens the pop-up. `none`: only Settings → Devices and `delorun devices approve` list it. | `dialog` |
| `pairing.windowMinutes` | 1 至 15 | 5 |
| `pairing.requestExpiryMinutes` | 1 至 10 | 5 |
| `pairing.pendingPerIdentity` | 来自同一 Tailscale 用户的、处于等待状态的请求为 1 至 5 个 | 1 |

固定、无字段可设的内容：只在 home 所在的计算机上批准，且从不通过远程访问会话批准，危险模式下也是如此；8 位匹配码，没有一键批准；3 次错误验证码后取消；等待中请求的全局上限为 5 个，其中没有窗口的请求最多占 4 个，因此通过批准窗口发起的请求总有位置；以及批准时轮换每个会话。远程访问会话既不能列出也不能回应请求，也从不收到通知的数据，只有回环路由回答这些数据。远程访问设备不能写入 `pairing` 一节：home 把它注册为仅限计算机的设置。计算机上的 studio 从 Settings → Devices 写入它，home 立即应用变更，无需重启；`delorun setup reach` 则从命令行写入。

**The pop-up.** Titled "A device wants to pair", it shows from the top the request's device name and platform, its Tailscale user, the address it asked through, when it asked and a countdown to its expiry; then the field for the 8 digits, which takes a pasted code with spaces or hyphens and refuses a paste that does not hold exactly 8 digits; then **Not you making this request?**, which declines the request, **Don't show this pop-up again**, which on close sets `pairing.showRequest` to `notice`, and **Submit**, which stays disabled until all 8 digits are in. Several waiting requests show one at a time, oldest first, with "1 of 2". Close, Escape and the dimmed page leave every waiting request in Settings → Devices. After **Not you making this request?** or Close, a later request from the same Tailscale user and address shows only as the notice for the rest of the studio session, so asking again cannot bring the pop-up back. While a field is being typed in, the pop-up does not open and the notice shows instead; the pop-up opens once the person chooses **Enter code** or leaves the field.

**身份。** `tailscale serve` 在转发用户设备的每个请求时设置 `Tailscale-User-Login` 与 `Tailscale-User-Name`，并替换客户端发送的任何副本（2026-11-13 对照 Tailscale 1.104 检查，并通过 serve 端口发送了伪造副本）。带标签的设备没有用户，因此不发送它们。计算机自己的用户是 `tailscale status --json` 中 `Self.UserID` 所指的 `User` 条目，在监听器启动时读取；无法读取时，`own-user` 不接受任何人。没有窗口的请求只有在写明模式所允许的身份时才被接受，否则在不读取其请求体的情况下回答 `APPROVALS_CLOSED`。

**身份标头只是配额和显示的提示，绝不是授权。** 任何本地进程都可以访问 `tailscale serve` 之后的回环监听器，并自行发送这些标头。这只让它得到一个等待中的请求，该请求仍需要在计算机上输入来自其自身屏幕的 8 位验证码，3 次错误验证码就会取消它。

<a id="match-code"></a>
### 匹配码

匹配码为 8 位十进制数字，由两个公钥、两个 nonce 与地址派生：

`SHA-256("delorun-match-v1" ‖ 0x00 ‖ home public key ‖ device id ‖ homeNonce ‖ deviceNonce ‖ address)`，取其前 8 个字节，按无符号大端整数读取后对 10⁸ 取模，补足前导零后写作 `1234 5678`。home 公钥是它的 32 个原始字节；设备 id 和两个 nonce 是其 base64url 文本解码得到的字节；地址是其 UTF-8 文本。输入的验证码在去除空格和连字符之后比较。

新设备根据它收到的 home 公钥计算该码并显示。受信任设备根据它获批准时所用的 home 公钥以及它从 home 读取的请求计算该码。因此，在新设备与 home 之间被替换的 home 密钥所产生的码，不是受信任设备计算出的码。

<a id="approval"></a>
### 批准

受信任设备只能通过 `POST /auth/device/approve` 批准请求，这是其自身实时会话中的一个已认证请求；它不是登录前路由。批准包含：

| 字段 | 取值 |
| --- | --- |
| `v` | `1` |
| `requestId`、`homeNonce` | 与请求中相同。 |
| `homeKeyId` | 批准方设备持有的 home 密钥 id。 |
| `deviceId`、`address` | 新设备的 id，以及其请求所绑定的地址。 |
| `typedCode` | 本人从新设备屏幕上输入的 8 位数字。 |
| `issuedAt`、`expiresAt` | 以毫秒计的时间；`expiresAt` 不晚于请求的过期时间。 |
| `approverDeviceId` | 批准方设备的 id。 |
| `signature` | 由批准方设备密钥生成的 ECDSA P-256 签名。 |
| `webauthn` | 在其地址具有通行密钥的远程访问监听器上（[C14](c14-oidc-passkeys.zh.md#relying-party-ids)）：一个带用户验证的 WebAuthn 断言，其质询为批准哈希，即去掉 `signature`、`webauthn` 与 `oidcReauth` 后的批准的 SHA-256 哈希。 |
| `oidcReauth` | 在其地址没有通行密钥的远程访问监听器上：一次以 `prompt=login` 与 `max_age=0` 进行的 OpenID Connect 登录所得的 ID 令牌，其 `nonce` 为批准哈希（[C14](c14-oidc-passkeys.zh.md#re-authentication)）。 |

只有以下各项全部成立时，home 才接受该批准：该请求在一个设备为 `approverDeviceId` 的实时会话上被接纳；签名可用该设备的密钥验证；在远程访问监听器上，要么断言可针对为批准方地址注册的通行密钥验证且设置了用户已验证标志，要么重新认证令牌可针对所有者的已固定身份验证且 `auth_time` 在 120 秒以内；远程访问监听器上两者都没有的批准会被拒绝，此类地址上的设备从回环监听器批准；请求处于待处理状态且未过期，且 `homeNonce`、`homeKeyId`、`deviceId` 与 `address` 与请求中的相同；`typedCode` 等于匹配码；且 `issuedAt` 与 home 时钟相差不超过 60 秒。同一请求出现 3 次错误代码后，home 取消该请求。接受之后，home 记录该设备，每个会话都轮换（[C4](c04-admission.zh.md#rotation-and-revocation)），且 home 发出 `device-approved` 告警。

<a id="approval-prompt"></a>
### 批准提示

受信任设备的提示显示新设备的标签与平台、请求时间、其来源地址，以及本人必须填写的匹配码字段。来源地址要么是直接连接的套接字对端地址，显示为已验证；要么是由中继、`tailscaled` 或转发标头声明的地址，显示时带有标签「未验证」（unverified），或被省略。由中继声明的地址从不作为单纯的事实显示。提示不从地址推导任何地名。

<a id="local-approval"></a>
### 本地批准

在 home 所在的计算机上，请求无需会话或设备签名即可批准：本人在场代替了这两者。两种形式是回环 studio 的批准表单（回环监听器上来自 studio 自身 origin 的 `GET /auth/devices/pending`、`POST /auth/devices/approve` 与 `POST /auth/devices/cancel`）和 `delorun devices approve`，即 home 套接字的 `devices.approve` 操作，C19 只在带有本人自己的令牌时接受它。两者都显示每个待处理请求的标签、平台和时间，本人选择要批准的请求，并输入该设备上显示的 8 位匹配码；两种形式都允许本人取消所选请求（表单的 `POST /auth/devices/cancel`，或带 `cancelRequestId` 的 `devices.approve`，`delorun devices approve` 为此显示每个请求 id 的前 8 个字符），新设备随后将其读作 `cancelled`。home 检查请求处于待处理状态且未过期，并检查所输入的验证码等于匹配码；3 次错误验证码后它取消该请求，其他请求仍保持待处理。接受时，它以批准者 `local` 记录该设备，轮换每个会话（[C4](c04-admission.zh.md#rotation-and-revocation)）并关闭窗口。接受还会签发一个绑定到该设备、其监听器及其会话的一次性注册票据，随后该设备提示设置 Face ID：该票据让 `POST /auth/passkey/register/options` 与 `/register` 为该设备创建一次通行密钥（[C14](c14-oidc-passkeys.zh.md#face-id-unlock)）。较早配对的设备无需票据即可添加通行密钥：它在 `POST /auth/passkey/add/request` 请求一个验证码，并让本人在电脑上输入它。远程访问监听器准入的请求，在这些路由上都回答 `403 LOOPBACK_REQUIRED`（[C14](c14-oidc-passkeys.zh.md#tailnet-membership)）。在场由 studio 自己的凭据表明，而不是回环地址：每个回环设备路由（窗口、待处理、批准、取消、列表、移除）都要求上游的 `connection.requestRejection` 所接受的内容，即浏览器已签名的启动 cookie 或有效的 API 凭据，没有它则以 `401 NOT_SIGNED_IN` 拒绝；每次状态变更还要求 `Origin` 等于 studio 自身的回环 origin（`403 ORIGIN_MISMATCH`）。没有任何回环路由返回匹配码或其派生来源的值。匹配码证明被批准的请求来自本人所读屏幕所在的设备；它不证明谁持有该设备。

<a id="sign-in"></a>
### 登录

受信任设备使用新的质询在远程访问监听器上登录。

1. 携带 `{ "deviceId" }` 的 `POST /auth/device/challenge` 返回一个 32 字节的 `challenge`，它在 60 秒后过期。一台设备最多持有 5 个未使用的质询。
2. `POST /auth/session` 携带 `deviceId`、`challenge`、对 `"delorun-signin-v1" ‖ 0x00 ‖ address ‖ challenge` 的 `signature`，以及该地址的身份因子证明（通行密钥断言或 OpenID Connect 登录凭证，[C14](c14-oidc-passkeys.zh.md)）与正在轮换的会话令牌二者之一。在没有已注册身份因子的地址上，两者都不带的请求会创建一个注册会话（[C14](c14-oidc-passkeys.zh.md#enrolment)）。

质询只能使用一次。在该监听器地址上没有记录的设备 id 得到 `401 DEVICE_NOT_TRUSTED`，重复使用、已过期或外来的质询，或无法通过验证的签名，得到 `401 CHALLENGE_INVALID`；失败的尝试会用掉它的质询。没有已批准设备密钥的有效身份因子证明不会创建会话。在因子为 `tailnet-membership` 的监听器上，仅凭签名就创建带有该因子的完整会话，且那里不存在注册会话，因为该地址上没有注册任何因子。登录请求携带的会话 cookie，在该会话是此设备在该监听器上的会话时，指明被轮换的会话；任何其他 cookie 都不予理会，签名会创建一个新会话。

<a id="removal"></a>
### 移除

实时会话中的受信任设备，或本人在 home 运行时通过 `delorun devices remove <device id>`，可以移除设备。移除会删除该设备的记录、从它注册的通行密钥以及其会话，释放其 Peer，轮换其他每个会话，并发出 `device-removed` 告警，所有这些都在移除返回之前完成。持有通行密钥的受信任设备在 `POST /auth/devices/remove` 移除另一台设备，需要针对恰为该请求的 Face ID 授权凭证（grant）（[C14](c14-oidc-passkeys.zh.md#face-id-unlock)）；PIN 从不能确认它。[PIN 模式](c14-oidc-passkeys.zh.md#pin-mode)开启期间，输错五次 PIN 的设备会被 home 以同样方式移除。

<a id="reset"></a>
### 重置

`delorun devices reset` 从 home 的终端恢复批准权限。当 home 进程（home process）持有其锁时，它以 `HOME_RUNNING` 拒绝执行（[C19](c19-home-process.zh.md)）。否则，它在 profile 中关闭远程访问，删除所有者记录以及每条设备记录、会话、待处理请求、通行密钥记录与已固定身份，使恢复套件失效，替换回环浏览器会话机密（[C4](c04-admission.zh.md#rotation-and-revocation)），并写入 `reset` 告警。它保留 home 密钥以及重置告警中的前任设备 id 列表，因此之后连接的前任设备会看到该 home 已被重置。下一次认领遵循[所有者认领](#owner-claim)。

<a id="recovery-kit"></a>
### 恢复套件

所有受信任设备都丢失时，恢复套件用于恢复批准权限。它只存在于已注册通行密钥或 OpenID Connect 身份因子的 home 上。

| 配置 | 恢复途径 | setup 与设备屏幕的说明 |
| --- | --- | --- |
| 没有远程访问，或有远程访问但没有已注册的通行密钥或 OpenID Connect 登录 | home 的终端（`delorun devices reset`） | 只能从终端恢复。 |
| 已为某个远程访问地址注册通行密钥或 OpenID Connect 登录 | 恢复套件与 home 的终端 | 套件与终端。 |

- **签发。** home 在注册第一个通行密钥或 OpenID Connect 登录时签发一个套件，并显示一次。
- **使用。** 有待处理批准请求的新设备发送 `POST /auth/recovery`，携带其 `requestId`、`requestSecret`、套件，以及该监听器地址的身份因子证明，该证明必须属于所有者的已固定身份。没有这种因子的 home 以 `403 RECOVERY_NEEDS_FACTOR` 拒绝，并附上一条说明只能从终端恢复的消息。不匹配的套件得到 `403 RECOVERY_KIT_INVALID`。
- **单次使用。** 匹配的套件在出示时即被消耗，无论之后发生什么；之后的每次使用都会失败。
- **取消延迟。** 请求进入 `recovery-pending` 状态 72 小时，home 向每台受信任设备发出 `recovery-started` 告警。任何受信任设备都可以从实时会话中取消，终端中的 `delorun devices recovery-cancel` 也可以。取消会发出 `recovery-cancelled`，并向执行取消的设备提供一个新套件。
- **完成。** 72 小时内没有取消，则该设备获得批准，每个会话都轮换，home 发出 `recovery-completed`，恢复的设备收到一个新套件，显示一次。

<a id="desktop-app-on-another-home"></a>
### 另一个 home 上的桌面应用

在同一台计算机上运行该 home 的桌面应用，是该 home 的回环设备。连接到另一个 home 的桌面应用像任何设备一样获得批准：它发送批准请求，显示根据它观察到的 home 公钥计算的匹配码，并由一台受信任设备批准。

- **TLS 固定。** 在证书续期之间保持同一 TLS 密钥的 home，会在批准之后发送一份由 home 密钥签名的 TLS 密钥声明 `{ "v": 1, "address", "spkiSha256", "issuedAt" }`。应用使用其匹配码所承诺的 home 密钥验证该声明，并固定 `spkiSha256`，即叶证书 SubjectPublicKeyInfo 的 SHA-256 哈希。叶密钥不同的连接会以 `TLS_PIN_MISMATCH` 被拒绝。
- **重新固定。** 应用只凭一份由其固定时所用 home 密钥签名、并经由通过了旧固定的连接收到的新声明来替换固定。没有这样的声明时，应用须重新获得批准。
- **不固定。** 在由 Tailscale 持有 TLS 密钥的 `ts.net` 地址上，以及在不保持其 TLS 密钥的 home 上，应用不固定任何内容，显示不适用固定，且不声称经由中继具有端到端保护。
- **被替换的 home 密钥。** 若批准响应中的 home 公钥与同一地址之前某次批准的密钥不同，应用以 `HOME_KEY_MISMATCH` 拒绝。

<a id="alerts"></a>
### 告警

告警记录本人必须看到的事件。其种类为 `unrequested-certificate`、`second-tunnel-refused` 与 `tunnel-rebound`（[C6](c06-relay-protocol.zh.md)），以及 `device-approved`、`device-removed`、`recovery-started`、`recovery-cancelled`、`recovery-completed` 与 `reset`。`unrequested-certificate`、`second-tunnel-refused` 与 `recovery-started` 是阻断性告警；其余为通知。

每个 home 都通过以下所有渠道投递每条告警；屏幕无人查看的 home 依靠后三个渠道。

1. **home 自己的屏幕。** 回环监听器上的 studio 以及运行该 home 的桌面应用，会在每个屏幕之上显示阻断性告警，直到在那里确认为止。
2. **告警文件。** home 以模式 0600 写入 `~/.delorun/alerts/<alert id>.json`（[C1](c01-home-layout.zh.md)）。该文件保存 `{ "v": 1, "id", "kind", "severity", "raisedAt", "homeKeyId", "subject", "signature" }`，其中 `id` 为 16 个随机字节，写作 32 个小写十六进制数字，`subject` 保存该种类的详细信息，`signature` 为由 home 密钥生成的 Ed25519 签名。该文件不含机密。Delorun 从不删除告警文件，`delorun verify` 会报告未确认的告警（[C15](c15-verification-checks.zh.md)）。
3. **告警页面。** 在每台受信任设备下一次经认证的连接上（任何监听器均可），home 以告警页面响应 studio 的首页请求，该页面列出自该设备上次连接以来发出的每条告警，直到该设备确认为止。在一台设备上确认，不等于在另一台设备上确认。
4. **命令或 webhook。** 本人可以配置其中之一或两者；两者默认都关闭。
   - **命令。** `alerts.command` 是一个参数列表，其第一个元素是绝对路径。home 不经 shell、以本人的身份运行它，标准输入为告警文件的 JSON，环境中只有 `PATH`、`HOME`、`DELORUN_ALERT_ID` 与 `DELORUN_ALERT_KIND`，并在 30 秒后停止它。
   - **Webhook。** webhook URL 是保存在 `~/.delorun/secrets/alerts/webhook-url` 中的机密，且必须使用 `https`。home 发送携带告警 JSON 与标头 `Delorun-Alert-Signature: ed25519=<signature>` 的 `POST`，最多等待 10 秒，并在 1、5 与 15 分钟后对失败的投递重试 3 次。每次尝试的结果（不含 URL）写入运行日志。

<a id="limits"></a>
### 限制

| 限制 | 取值 |
| --- | --- |
| 所有者验证码 | 128 位，26 个 base32 字符，单次使用，10 分钟过期，不锁定 |
| 所有者认领尝试 | 每个来源每分钟 10 次 |
| 批准请求过期 | 5 分钟 |
| 每个 home 的待处理批准请求 | 5 |
| 每个来源的批准请求 | 每分钟 10 个 |
| 批准窗口 | 5 分钟，在第一次批准时关闭 |
| 请求状态读取 | 每个请求每 2 秒 1 次 |
| 每个请求的错误输入代码 | 3 次，之后请求被取消 |
| 批准时钟偏差 | 60 秒 |
| 重新认证时效 | 120 秒 |
| 登录质询 | 32 字节，60 秒过期，每台设备 5 个未使用 |
| 恢复套件 | 256 位，单次使用，72 小时取消延迟 |
| 设备标签与平台 | 各 64 个字符 |
| 告警命令运行时间 | 30 秒 |
| Webhook 投递 | 10 秒超时，在 1、5 与 15 分钟后重试 3 次 |

<a id="errors"></a>
### 错误

| 错误码 | 状态 | 触发条件 |
| --- | --- | --- |
| `NO_OWNER` | 403 | 批准请求到达没有所有者的 home。 |
| `ALREADY_OWNED` | 409 | 认领到达已有所有者的 home。 |
| `OWNER_CODE_INVALID` | 403 | 错误、已使用或已过期的所有者验证码。 |
| `OWNER_CLAIM_RATE_LIMITED` | 429 | 一个来源每分钟超过 10 次认领尝试。 |
| `APPROVAL_PENDING_LIMIT` | 429 | 第六个待处理请求。 |
| `APPROVAL_RATE_LIMITED` | 429 | 一个来源一分钟内的第十一个请求，或快于每 2 秒一次的状态读取。 |
| `APPROVAL_EXPIRED` | 410 | 针对已过期或已取消请求的批准。 |
| `APPROVAL_NOT_IN_SESSION` | 401 | 在 `approverDeviceId` 已接纳的实时会话之外的批准。 |
| `APPROVAL_SIGNATURE_INVALID` | 403 | 无法通过验证的设备签名或 WebAuthn 断言，或与请求中不同的字段。 |
| `APPROVAL_USER_VERIFICATION_REQUIRED` | 403 | 远程访问监听器上既没有用户已验证断言、也没有有效重新认证令牌的批准。 |
| `APPROVAL_CODE_MISMATCH` | 403 | 与匹配码不同的输入代码。 |
| `DEVICE_NOT_TRUSTED` | 401 | 在该监听器地址上没有记录的设备密钥。 |
| `CHALLENGE_INVALID` | 401 | 重复使用、已过期或外来的质询。 |
| `RECOVERY_NEEDS_FACTOR` | 403 | 在没有已注册通行密钥或 OpenID Connect 登录的 home 上使用的套件。 |
| `RECOVERY_KIT_INVALID` | 403 | 不匹配或已使用的套件。 |
| `HOME_RUNNING` | CLI 退出码 1 | 在 home 运行时执行 `delorun devices reset`。 |
| `TLS_PIN_MISMATCH` | 桌面端拒绝 | 不同于已固定叶密钥的叶密钥。 |
| `HOME_KEY_MISMATCH` | 桌面端拒绝 | 不同于之前某次批准所承诺的 home 密钥的 home 密钥。 |
| `APPROVALS_CLOSED` | 403 | 在没有批准窗口打开期间，`tailnet-membership` 监听器上收到的批准请求。 |

<a id="delorun-mailbox"></a>
### Delorun 信箱

Delorun 信箱经由[托管服务](../reference/glossary.zh.md#hosted-service)在设备之间传递由设备签名的批准，它不属于 Delorun（[路线图](../guide/roadmap.zh.md)）。每个批准都作为批准方设备实时会话中一个已接纳的请求，直接到达 home。信箱只会传递它无法伪造的消息，并会拒绝只经由它、在实时会话之外到达的批准。

<a id="consumers"></a>
## 消费方

- `delorun/packages/home-auth/`：所有者认领、批准请求与批准、登录、移除、重置与设备存储。
- `delorun/packages/home-auth/src/recovery/`：恢复套件与 `delorun devices reset`。
- `delorun/packages/certificates/`：`unrequested-certificate` 告警及其投递渠道。
- `delorun/packages/plugin-reach-ui/`：批准提示、设备屏幕、告警页面与恢复屏幕。
- 桌面应用与另一个 home 的连接：其设备密钥、批准与 TLS 固定。
- `delorun/packages/contract-device-approval/`：消息类型、告警种类、错误码与限制。
- [C4](c04-admission.zh.md)（路由与轮换）、[C14](c14-oidc-passkeys.zh.md)（身份因子证明）、[C15](c15-verification-checks.zh.md)（`owner-and-devices` 与 `certificates` 检查）。

<a id="compatibility"></a>
## 兼容性

消息版本为 `1`，每个存储的文件都带有 `v: 1`。home 以 `400` 拒绝其他版本的消息。对匹配码派生方式、签名对象或限制的更改，属于对本约定的更改，并需要新的消息版本。新的告警种类属于新增；读取方把未知种类显示为阻断性告警，并附上其原始 subject。

`ts.net` 依赖方 ID 的 spike 结果决定通行密钥是否作为 `ts.net` 地址上的身份因子（[C14](c14-oidc-passkeys.zh.md#compatibility)），Tailscale serve 目标的 spike 结果决定 `reach-tailscale-private` 是否接受所有者认领（[C7](c07-reach-providers.zh.md#compatibility)）。在这些页面记录 spike 结果之前，本页的当前约定有效：所有者认领只限回环，且 `ts.net` 地址上的批准携带 OpenID Connect 重新认证，因为 C14 的当前约定在那里不提供通行密钥。

<a id="security"></a>
## 安全

要求：

- 设备密钥不可导出并绑定到其源，通行密钥绑定到其依赖方 ID；在一个地址上获批准的设备在另一个地址上会被拒绝，添加或更改地址时，须为该地址重新批准设备并重新注册身份因子。
- 匹配码承诺两个公钥与两个 nonce，并在两台设备上都显示；批准携带本人输入的代码。
- 批准只在实时会话内有效，携带批准方设备的签名，在远程访问监听器上携带经用户验证的 WebAuthn 断言（或者，在没有通行密钥的地址上，携带绑定到该批准的 OpenID Connect 重新认证），并绑定到请求的 nonce、过期时间、home 密钥与地址。
- 批准提示显示设备、时间与来源地址，由中继或转发标头声明的地址会被标为未验证或被省略。
- 所有者认领，无论是首次还是重置后，都只在回环监听器上接受，包括经由 SSH 端口转发的访问；在 C7 的回退方案下，Tailscale 私有目标上的认领会被拒绝，并附上一条引导本人使用回环的消息。
- 所有者验证码具有 128 位熵，只能使用一次，10 分钟后过期，只打印到终端，且从不写入日志。
- `delorun devices reset` 在 home 运行时拒绝执行，并且会关闭远程访问、通知前任设备。
- 在 `tailnet-membership` 监听器上，批准请求只在 home 所在计算机上打开的窗口内接受，设备也只在那里通过本地批准获得批准。
- 恢复套件只能使用一次，需要已注册的通行密钥或 OpenID Connect 登录，在完成时被替换，并等待 72 小时，期间任何受信任设备都可以取消它；没有这种因子时它会被拒绝，setup 与设备屏幕会说明只能从终端恢复。
- 另一个 home 上的桌面应用像任何设备一样获得批准，其匹配码承诺它观察到的 home 密钥，它只在保持 TLS 叶密钥的 home 上固定该密钥，只凭 home 密钥的签名重新固定，并在 `ts.net` 上说明不适用固定。
- 告警写入已签名的文件，并显示在 home 的屏幕上以及每台受信任设备的下一次连接中，从不只经由 Delorun 基础设施传递。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `an approval outside a live session is refused` | 在批准方设备没有已接纳会话时发送的、签名正确的批准，会以 `APPROVAL_NOT_IN_SESSION` 被拒绝，且该设备不会被记录。 |
| `the reach listener has no claim route` | 向每个远程访问监听器上的 `/auth/owner/claim` 提交有效的所有者验证码，不会认领任何内容，且响应为 `OWNER_CLAIM_LOOPBACK_ONLY`。 |
| `owner claim on the serve target is refused under the fallback` | 在 C7 的回退方案生效时，`reach-tailscale-private` 上携带伪造 Tailscale 身份标头的认领会被拒绝，并附上一条写明回环与 SSH 端口转发的消息。 |
| `a device key approved on loopback is refused on a reach address` | 具有回环记录的设备密钥在远程访问监听器上为质询签名时，得到 `DEVICE_NOT_TRUSTED`。 |
| `a device approved on one reach address is refused on another` | 为一个地址批准的设备密钥，在同一 home 的第二个地址上会被拒绝，直到它在该地址获得批准。 |
| `a valid identity without a device key creates no session` | 设备 id 未知的有效通行密钥断言或 OpenID Connect 凭证不会创建会话。 |
| `an approval with a wrong typed code is refused and the third cancels` | 错误的代码以 `APPROVAL_CODE_MISMATCH` 被拒绝，第三次之后请求被取消。 |
| `an approval on a reach listener without user verification is refused` | 断言缺少用户已验证标志、没有断言，或所携带重新认证令牌的 `nonce` 不是批准哈希或其 `auth_time` 距今超过 120 秒的批准，会被拒绝。 |
| `a request outside a window is refused unread` | 在 Tailscale 私有监听器上，没有打开窗口时的 `POST /auth/device/request`，在其声明的请求体仍未发送时就回答 `APPROVALS_CLOSED`。 |
| `an unapproved device on the tailnet route gets no session` | 没有记录的密钥，无论是否带有伪造的 `Tailscale-*` 标头，都得到 `DEVICE_NOT_TRUSTED`，且没有 cookie。 |
| `a tailnet-route session cannot approve a device` | `tailnet-membership` 会话的窗口、批准和移除请求回答 `LOOPBACK_REQUIRED`，且不打开任何窗口。 |
| `approval limits hold` | 第六个待处理请求，以及同一来源一分钟内的第十一个请求，都会被拒绝，第六个请求不取代任何等待中的请求；本人在 home 所在的计算机上取消其中一个之后，第六个被接受，被取消的请求读作 `cancelled`。带有控制字符或双向格式字符的标签或平台以 `BAD_REQUEST` 被拒绝。 |
| `a used owner code fails a second time` | 已认领过 home 的所有者验证码，或已超过 10 分钟的验证码，得到 `OWNER_CODE_INVALID`。 |
| `owner codes never reach a log` | 使用预置验证码的认领，不会让该验证码出现在任何运行日志中。 |
| `devices reset refuses while the home runs` | 锁被持有时，`delorun devices reset` 以 `HOME_RUNNING` 退出，且不改变任何内容。 |
| `a used recovery kit fails a second time` | 已出示过一次的套件，无论恢复已完成还是已取消，再次出示时都得到 `RECOVERY_KIT_INVALID`。 |
| `a recovery kit without an enrolled factor is refused while reset works` | 在没有注册通行密钥或 OpenID Connect 的 home 上，套件以 `RECOVERY_NEEDS_FACTOR` 被拒绝，而 `delorun devices reset` 可以恢复认领。 |
| `a cancelled recovery approves nothing` | 在 72 小时内从受信任设备取消的恢复，在延迟结束后，发起请求的设备仍不受信任。 |
| `a desktop shown a substituted home key refuses the connection` | 批准响应携带的 home 密钥与其之前批准不同的桌面应用，以 `HOME_KEY_MISMATCH` 拒绝，且其匹配码与受信任设备的不同。 |
| `a desktop refuses a substituted certificate and an unsigned re-pin` | 已固定的应用拒绝不同于已固定叶密钥的叶密钥，并拒绝未由 home 密钥签名的新固定。 |
| `a relay-asserted address is marked unverified` | 经由中继到达、且中继声明了预置客户端地址的批准请求，会以未验证标签显示该地址，或将其省略。 |
| `a headless alert reaches its channels` | 在没有屏幕的夹具 home 上发出的告警，会产生签名可用 home 密钥验证的告警文件、受信任设备下一次连接时的告警页面，以及在已配置时的一次命令运行与一次 webhook 投递。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **转发路径上的按来源限额。** 在中继、Funnel 与 Tailscale 路径上，请求的来源地址由中继、`tailscaled` 或转发请求头声称，而在回退方案下，本地进程可以伪造它。因此按来源的限额在这些路径上只是建议性的；在这些路径上成立的限额是每个 home 最多 5 个待处理请求。
- **`attestation: "none"` 下的用户验证。** home 读取认证器设置的用户已验证标志，但不验证由哪个认证器作出断言，因此该标志的可信程度只取决于该认证器。
- **被截获的中继路径上的告警页面。** 截获中继路径的一方可以提供自己的页面并丢弃告警页面；告警文件、home 自己的屏幕以及已配置的命令或 webhook 不依赖该路径。证书检测还要等到某个日志收录该证书之后（[C6](c06-relay-protocol.zh.md#certificate-monitoring)），在此之前不会发出告警。
- **本人自己的进程。** 本人用户在沙箱之外的进程可以读取 home 密钥与设备记录，并可以批准设备；这些规则防范的是其他方，而不是这类进程（[C1](c01-home-layout.zh.md#security)）。

<a id="decided-values"></a>
## 决定的取值

- 所有者验证码：128 位，26 个 base32 字符，单次使用，10 分钟过期，不锁定。
- 批准请求：5 分钟过期，每个 home 最多 5 个待处理，每个来源每分钟 10 个请求。
- 恢复套件的取消延迟：72 小时，可从任何受信任设备取消。
- 无屏幕 home 上的告警：`~/.delorun/alerts/` 下已签名的告警文件、在每台受信任设备下一次连接时向其显示的经认证告警页面，以及本人配置的可选命令或 webhook。
- 密钥类型：home 密钥为 Ed25519，设备密钥为 ECDSA P-256，通行密钥为 ES256、EdDSA 或 RS256。
- 匹配码：8 位十进制数字，每个请求允许 3 次错误尝试。
