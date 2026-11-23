---
description: "约定 C6：自托管中继的协议：其配置与名称绑定、短时有效的隧道令牌、每条隧道上的 home 密钥质询、流的分帧与流量控制、加密浏览器连接的 SNI 路由、每个名称一条活动隧道、带 60 秒延迟的重新绑定、限额、证书监控，以及作为后续功能的 Delorun 中继。"
---

# 约定 C6：中继协议

[English](c06-relay-protocol.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

中继让浏览器能够访问一个不接受任何入站连接的 home。home 向中继打开一个出站 WebSocket，并证明其 home 密钥；中继只读取 443 端口上每个浏览器连接的 SNI，并把该连接的加密字节经 WebSocket 传给 home，TLS 在 home 上以 home 自己的证书终止。中继不持有 studio 的任何密钥，也无法读取其流量。在 Delorun 1.0 中，中继即自托管中继，由本人（the person）使用 `delorun/apps/relay/` 中的镜像，在自己的服务器与域名上运行。本页定义其配置、隧道（tunnel）令牌、握手、帧、SNI 路由、限额、重新绑定、通告与证书监控，并说明哪些规则约束 Delorun 中继（Delorun relay），它是一个后续功能（fast-follow）项。类型包 [`@delorun/contract-relay-protocol`](../../packages/contract-relay-protocol/README.zh.md) 承载帧类型、代码与限额。

<a id="status"></a>
## 状态

中继的服务器端已构建并已搁置；没有任何 home 能使用它。

- **已构建，但无人使用：** `delorun/apps/relay`，标记为已搁置，带有其配置检查、一次性 60 秒的隧道令牌、home 密钥质询、每个名称一条活动隧道及对第二条的拒绝、分帧、流量控制与限额、SNI 路由，以及其容器镜像。不存在 home 端的中继客户端，因此没有任何 home 打开隧道。
- **在中继中不成立：** 重新绑定。中继只检查重新绑定声明写明了该绑定的名称与新密钥；它不验证旧密钥的签名，不应用 60 秒延迟，也不发出任何通告，并且它的配置只在启动时读取一次，因此编辑文件并重启的运营者可以悄悄地重新绑定一个名称。安全一节所说的模糊测试语料库并不存在。
- **尚未构建：** home 端的中继客户端、通告引发的告警、证书监控以及在证书无法解释时拒绝打开隧道，以及 `delorun reach rebind-statement`。

下文中，本列表称为尚未构建或无人使用的要求与拒绝测试，在某次改动构建并接入它们之前，不保护任何人。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [参与方](#parties)
  - [中继配置](#relay-configuration)
  - [隧道令牌](#tunnel-token)
  - [握手](#handshake)
  - [帧](#frames)
  - [流量控制](#flow-control)
  - [SNI 路由](#sni-routing)
  - [每个名称一条活动隧道](#one-live-tunnel-per-name)
  - [重新绑定](#rebinding)
  - [通告](#announcements)
  - [证书监控](#certificate-monitoring)
  - [限额](#limits)
  - [错误](#errors)
  - [Delorun 中继](#delorun-relay)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
  - [本约定不能证明的内容](#what-this-does-not-prove)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="parties"></a>
### 参与方

- **中继。** `delorun/apps/relay/` 中的中继数据面：一个 Node 服务，在 TCP 443 端口上接受浏览器连接与来自各 home 的隧道。它不存储任何流量，不持有任何 studio 密钥，只为自己的隧道主机终止 TLS。
- **令牌签发方。** 签发隧道令牌的一方。对于自托管中继，它是中继进程本身，使用中继首次启动时生成的令牌密钥。对于 Delorun 中继，它是[托管服务](../reference/glossary.zh.md#hosted-service)中的中继控制面。
- **中继客户端。** home 一侧的部分，位于 `delorun/packages/reach/`。它获取令牌、打开隧道、回答质询，并把每个流交给 [C4](c04-admission.zh.md#listeners) 的 `reach-self-hosted-relay` 监听器，TLS 在该监听器处终止。

每个字节串都是不带填充的 base64url，每个签名对象都对其去掉 `signature` 字段后的 RFC 8785 序列化进行签名。home 密钥与 home 密钥 id 即 [C5](c05-device-approval.zh.md#keys-and-storage) 中定义的密钥与密钥 id。

<a id="relay-configuration"></a>
### 中继配置

自托管中继读取一个 YAML 文件，即其容器内的 `/etc/delorun-relay/relay.yaml`。其运营者是运行它的人，中继的配置是其绑定的权威来源。

| 字段 | 取值 |
| --- | --- |
| `tunnelHost` | 中继自己的名称，例如 `relay.example.com`。中继只为该名称终止 TLS，所用证书与密钥为 `tunnelCertFile` 与 `tunnelKeyFile`。 |
| `tunnelCertFile`、`tunnelKeyFile` | `tunnelHost` 的 PEM 证书链与密钥。 |
| `bindings` | 由 `{ name, homePublicKey }` 组成的列表：一个 studio 名称（例如 `studio.example.com`），以及该名称所属 home 的 32 字节原始 Ed25519 公钥。 |
| `bindings[].rebindStatement` | 可选：由先前绑定的密钥签名的[重新绑定声明](#rebinding)。 |
| `bindings[].forceRebind` | 可选，只能为 `true`：运营者在没有先前密钥签名的情况下替换一个绑定。 |
| `stateDir` | 存放令牌密钥与绑定历史的目录，默认为 `/var/lib/delorun-relay`。 |

当一个名称出现在两个绑定中、一个 home 公钥出现在两个绑定中、`tunnelHost` 等于某个已绑定的名称，或某个名称不是有效的 DNS 主机名时，中继拒绝启动。令牌密钥为 `<stateDir>/token-key.pem`，是一个模式为 0600 的 Ed25519 密钥。中继通过 [C20](c20-operational-logs.zh.md) 的 `relay` surface 记录日志。

<a id="tunnel-token"></a>
### 隧道令牌

一个隧道令牌授权针对一个名称与 home 密钥的一次隧道尝试。

- **请求。** 中继客户端发送 `POST https://<tunnelHost>/v1/tunnel-token`，请求体为 `{ "v": 1, "name", "homePublicKey", "timestamp", "signature" }`，由 home 密钥签名。若请求的 `timestamp` 与签发方时钟相差超过 60 秒、其签名无法验证，或其名称未绑定到该密钥，签发方拒绝该请求。
- **令牌。** 应答为 `{ "token" }`，其中令牌依次由其声明的 base64url RFC 8785 序列化、一个点，以及签发方令牌密钥所作 Ed25519 签名的 base64url 组成。声明为 `{ "v": 1, "iss" (the relay id: the SHA-256 hash of the token public key), "name", "homeKeyId", "jti" (16 random bytes), "iat", "exp" }`，`exp` 为 `iat` 加 60 秒。
- **一次性使用。** 中继记录它接受的每个 `jti`，直到该令牌的 `exp` 过去为止，并拒绝 `jti` 已出现过的令牌。它还拒绝 `iat` 早于其自身启动时间的令牌，因此重启后的中继不会接受重启前签发的令牌。

<a id="handshake"></a>
### 握手

1. **升级。** 中继客户端以 WebSocket 子协议 `delorun-relay.v1` 和请求头 `Authorization: Delorun-Tunnel <token>` 请求 `GET wss://<tunnelHost>/v1/tunnel`。中继在升级之前验证令牌的签名、有效期、`jti` 未被使用以及绑定，否则以[错误](#errors)中的代码回答 `401`。
2. **质询。** 中继发送文本消息 `{ "type": "challenge", "relayId", "nonce" }`，`nonce` 中为 32 个随机字节。
3. **证明。** 中继客户端回答 `{ "type": "proof", "signature" }`：home 密钥对 `"delorun-relay-tunnel-v1" ‖ 0x00 ‖ relayId ‖ name ‖ jti ‖ nonce` 所作的 Ed25519 签名。中继用绑定到该令牌名称的密钥验证它。
4. **活动检查。** 若该名称已有活动隧道，中继发送 `{ "type": "refused", "code": "TUNNEL_ALREADY_LIVE" }`，以代码 4409 关闭，并把这次尝试[通告](#announcements)给活动隧道。
5. **就绪。** 否则中继发送 `{ "type": "ready", "tunnelId", "limits" }`，其中 `limits` 重复中继所施加的[限额](#limits)，隧道随即处于活动状态。

第 2 至 5 步在升级后 10 秒内完成，否则中继以 4408 关闭。每条隧道（包括重连）都用一个新令牌重复完整的握手。

<a id="frames"></a>
### 帧

`ready` 之后，每条消息都是二进制 WebSocket 消息：一个字节的帧类型、一个 4 字节无符号大端序流 id，然后是负载。流 id 0 属于隧道；1 及以上的流是浏览器连接，由中继编号，在一条隧道内不复用。

| 类型 | 名称 | 方向 | 负载 |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | 中继到 home | JSON `{ "sni", "clientAddress", "clientPort" }`，至多 1,024 字节。`clientAddress` 是中继的断言，未经验证。 |
| `0x02` | `DATA` | 双向 | 该连接的 1 至 65,536 字节加密字节。中继在一个流上发送的第一个 `DATA` 是浏览器的 ClientHello。 |
| `0x03` | `CREDIT` | 双向 | 一个 4 字节无符号大端序数，表示发送方可增加的字节数（[流量控制](#flow-control)）。 |
| `0x04` | `CLOSE` | 双向 | 一个字节：`0` 正常，`1` 被拒绝，`2` 限额，`3` 协议错误，`4` 超时。 |
| `0x10` | `CONTROL` | 双向，流 0 | 至多 16,384 字节的 JSON：来自中继的 `announce`，以及来自 home 的 `pong` 与 `rebind-pending` 确认。 |

未知类型、短于 5 字节的帧、未打开的流 id、在流 0 以外的流上的 `CONTROL` 帧，或超出其限额的负载，都是协议错误：接收方以 4400 关闭隧道，负载过大时以 4413 关闭。中继每 15 秒发送一次 WebSocket ping，任一方在 45 秒内未从某条隧道收到任何内容时关闭该隧道。

<a id="flow-control"></a>
### 流量控制

每个流的每个方向都以 1 MiB 的额度（credit）开始。发送方只在剩余额度内发送 `DATA`，接收方在转发或消耗字节时返回 `CREDIT`。中继在每个流的每个方向上至多缓冲 1 MiB，并在浏览器连接或隧道慢于其对端时暂不发放额度。超出剩余额度的 `DATA` 以原因 `3` 关闭该流。

<a id="sni-routing"></a>
### SNI 路由

中继在 443 端口上接受 TCP 连接，并在不解密任何内容的情况下读取 TLS ClientHello，至多 16,384 字节，限时 10 秒。

- **隧道主机。** 当 SNI 等于 `tunnelHost` 时，中继终止 TLS，并且只提供 `/v1/tunnel-token` 与 `/v1/tunnel`。
- **已绑定的名称。** 当 SNI 是一个已绑定的名称、其隧道处于活动状态，且该 home 打开的流少于 64 个时，中继发送 `OPEN`，然后以 `DATA` 发送 ClientHello 及之后的每个字节，并在该流关闭时关闭浏览器连接。
- **其他任何情况。** 没有 SNI 的 ClientHello、没有绑定或没有活动隧道的名称、第 65 个并发流、超过 16,384 字节的 ClientHello，或未在 10 秒内完成的 ClientHello，都会使 TCP 连接在不作任何响应的情况下被关闭。

中继像转发其他 ClientHello 一样转发 ALPN 为 `acme-tls/1` 的 ClientHello，因此 home 只通过其经密钥证明的隧道回答 TLS-ALPN-01 质询。中继在 80 端口上不为已绑定的名称提供任何内容，因此无法通过中继回答针对该名称的任何 HTTP-01 质询。

<a id="one-live-tunnel-per-name"></a>
### 每个名称一条活动隧道

一个名称至多有一条活动隧道。针对活动名称的第二次握手即使令牌与证明都有效，也会在活动检查时被拒绝，且该拒绝会被通告。隧道在关闭时，或在中继 45 秒内未在其上收到任何内容时，不再处于活动状态；中继客户端以退避方式重连，从 1 秒开始，每次加倍，至多 60 秒。

<a id="rebinding"></a>
### 重新绑定

重新绑定会替换绑定到某个名称的 home 密钥，例如在 home 迁移到新计算机时。

- **重新绑定声明。** 旧 home 通过 `delorun reach rebind-statement <new home public key>` 打印声明 `{ "v": 1, "name", "previousHomeKeyId", "newHomePublicKey", "issuedAt", "signature" }`，该声明由旧 home 密钥签名。运营者把它与新密钥一起放入该绑定的 `rebindStatement`。
- **强制重新绑定。** 没有旧密钥时，运营者设置 `forceRebind: true`。中继在相同的延迟下应用它，并在其运行日志中将其记录为强制重新绑定。
- **延迟与通知。** 中继读到一个已变更的绑定时，立即向该名称的活动隧道通告 `tunnel-rebound`，保留旧绑定 60 秒，然后以 4410 关闭旧隧道，并且只接受新密钥。若声明的签名无法用先前绑定的密钥验证，且未设置 `forceRebind`，该声明被拒绝，旧绑定保持不变。

<a id="announcements"></a>
### 通告

中继在该名称活动隧道的流 0 上发送 `{ "type": "announce", "kind", "at", "clientAddress", "jti" }`。`kind` 为 `second-tunnel-refused` 或 `tunnel-rebound`；`clientAddress` 是中继未经验证的断言；`jti` 指明被拒绝的令牌。home 会发起同一种类的 [C5 告警](c05-device-approval.zh.md#alerts)，但 `jti` 属于 home 自身在过去 60 秒内的某次尝试的 `second-tunnel-refused` 除外。

<a id="certificate-monitoring"></a>
### 证书监控

一个正在运行、使用自有域名远程访问（reach）的 home，会监视公开的证书透明度（Certificate Transparency）日志，查找覆盖其名称的证书。

- **来源。** home 每 30 分钟查询一次 `https://api.certspotter.com/v1/issuances?domain=<registrable domain>&include_subdomains=true&expand=dns_names`。来源为配置行 `certificates.ctSource`，其默认值即该 URL。一次查询会向来源透露 home 的 IP 地址与所查询的域名。
- **覆盖。** 当证书的某个 DNS 名称等于该名称，或为 `*.<parent>`（其中 `<parent>` 是去掉第一个标签后的该名称）时，该证书覆盖该名称。多名称证书的每个名称都会被检查。
- **已申请的证书。** home 记录其自身 ACME 账户获得的每张证书与预证书的 SHA-256 哈希。哈希未被记录的覆盖证书即为未申请证书，直到本人从回环监听器或用 `delorun certificates explain <SHA-256>` 将其标记为已说明，或直到其过期。
- **拒绝。** 只要存在未说明的未申请证书，home 就会发起 `unrequested-certificate`，其中继客户端关闭隧道，且不打开任何隧道。
- **延迟。** 检测需要等待某个日志收录该证书，并等待下一次查询，该延迟受各日志的收录策略限定；在此延迟期间，上述拒绝无法生效。

`ts.net` 名称不受监控：其证书由 Tailscale 获取（[C7](c07-reach-providers.zh.md#visibility-notes)）。

<a id="limits"></a>
### 限额

| 限额 | 取值 |
| --- | --- |
| 每个名称与每个 home 的活动隧道 | 1 |
| 每个 home 的并发流 | 64 |
| 每个流每个方向的缓冲区 | 1 MiB |
| `DATA` 负载 | 65,536 字节 |
| `OPEN` 负载 | 1,024 字节 |
| `CONTROL` 负载 | 16,384 字节 |
| ClientHello | 16,384 字节，在 10 秒内读取 |
| 握手 | 自升级起 10 秒 |
| 隧道令牌 | 60 秒，一次性使用 |
| 令牌请求时钟偏差 | 60 秒 |
| 重新绑定延迟 | 60 秒 |
| ping 间隔与静默上限 | 15 秒与 45 秒 |
| 重连退避 | 1 秒，加倍至 60 秒 |
| 证书查询间隔 | 30 分钟 |

<a id="errors"></a>
### 错误

| 代码 | 位置 | 触发条件 |
| --- | --- | --- |
| `TOKEN_REQUEST_INVALID` | `/v1/tunnel-token` 上的 `400` | 格式错误的请求，或无法验证的签名。 |
| `TOKEN_REQUEST_STALE` | `/v1/tunnel-token` 上的 `401` | `timestamp` 与签发方时钟相差超过 60 秒。 |
| `NAME_NOT_BOUND` | `/v1/tunnel-token` 上的 `403` | 该名称未绑定到所出示的密钥。 |
| `TUNNEL_TOKEN_INVALID` | `/v1/tunnel` 上的 `401` | 签名错误、有效期已过或绑定已变更的令牌。 |
| `TUNNEL_TOKEN_REPLAYED` | `/v1/tunnel` 上的 `401` | `jti` 已被中继接受过的令牌。 |
| `PROOF_INVALID` | 关闭 4401 | 无法用绑定的密钥验证的证明。 |
| `TUNNEL_ALREADY_LIVE` | 关闭 4409 | 针对活动名称的第二条隧道。 |
| `HANDSHAKE_TIMEOUT` | 关闭 4408 | 握手未在 10 秒内完成。 |
| `PROTOCOL_ERROR` | 关闭 4400 | 格式错误或意外的帧。 |
| `FRAME_TOO_LARGE` | 关闭 4413 | 超出其限额的负载。 |
| `REBOUND` | 关闭 4410 | 该名称已被重新绑定到另一个密钥。 |

<a id="delorun-relay"></a>
### Delorun 中继

Delorun 中继位于 `delo.run` 名称下，其中继控制面位于托管服务中；它不属于 Delorun，Delorun 不包含 Delorun 中继客户端，也不包含中继控制面（[路线图](../guide/roadmap.zh.md)）。上述中继数据面、帧、SNI 路由、握手与限额原样适用于它，由中继控制面担任令牌签发方。以下规则也约束它：

- 名称永不重新分配给另一个账户，随机名称永不复用。
- 重新绑定需要绑定密钥的签名；不存在强制重新绑定。
- 适用每账户限额与按名称的停用开关。
- `delo.run` 名称的 DNS-01 质询通过 CNAME 委派给一个限定范围的质询区域，中继控制面只在 home 密钥证明之后写入该区域。
- 只有当 Chromium、Firefox 与 Safari 的当前发布版本都已包含 `delo.run` 的 Public Suffix List（公共后缀列表）条目时，该条目才算已就位。

自托管中继的运营者即其所有者，因此 Delorun 中继的每账户限额与停用开关不适用于它。

<a id="consumers"></a>
## 消费方

- `delorun/apps/relay/`：中继数据面、令牌签发方、配置加载与自托管镜像。
- `delorun/apps/relay/tests/fuzz/`：帧解析器、ClientHello 读取器与控制消息的模糊测试语料库。
- `delorun/packages/reach/`：中继客户端、令牌请求、握手，以及把流交给 `reach-self-hosted-relay`。
- `delorun/packages/certificates/`：证书监控，以及证书未说明期间的拒绝。
- `delorun/packages/contract-relay-protocol/`：帧类型、关闭代码、错误代码与限额。
- [C5](c05-device-approval.zh.md#alerts)：通告所发起的告警；[C7](c07-reach-providers.zh.md)：自托管中继提供方及其自有域名规则。

<a id="compatibility"></a>
## 兼容性

协议版本即子协议 `delorun-relay.v1` 与每个签名对象的 `v` 字段。中继拒绝不带该子协议的升级，home 拒绝 `limits` 超出本页限额的 `ready`。对帧、签名对象或限额的变更即为新的子协议版本；在各 home 于两个版本之间迁移期间，中继可以同时提供两个版本。新的帧类型即为新版本，因为未知类型是协议错误。

<a id="security"></a>
## 安全

要求：

- 每条隧道都针对一个新鲜的中继 nonce 证明其持有绑定的 home 密钥，并携带一个 60 秒后过期的一次性隧道令牌。
- 一个名称至多有一条活动隧道；第二条隧道即使持有有效密钥，也会被拒绝并通告给活动隧道，home 会向其受信任设备（trusted device）发出告警。
- 重新绑定需要先前绑定密钥的签名或运营者明确的强制重新绑定，等待 60 秒，并会被通告。
- 中继只读取 SNI，并传递它无法读取的加密字节；它不持有任何已绑定名称的 TLS 密钥，其自身的 TLS 密钥只服务于 `tunnelHost`。
- 每个流的缓冲区在每个方向上以 1 MiB 为上限，一个 home 至多有 64 个并发流。
- 中继所断言的客户端地址，在 home 使用它们的每一处都未经验证。
- home 只通过其经密钥证明的隧道回答 TLS-ALPN-01，中继不为已绑定的名称回答任何 HTTP-01 质询。
- 证书监控匹配精确、通配符与多名称证书，且在存在未说明的未申请证书期间，home 不打开任何隧道。
- 中继输入的每个解析器都具有上述限额与一个模糊测试语料库。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `a second valid-key tunnel is refused and announced` | 在某名称已有活动隧道时，携带有效令牌与证明的第二次握手以 4409 关闭，活动隧道收到种类为 `second-tunnel-refused` 的 `announce`，该通告发起 C5 告警。 |
| `a replayed tunnel token is refused` | 已打开过隧道的令牌在过期前再次出示时，以 `TUNNEL_TOKEN_REPLAYED` 被拒绝；中继重启前签发的令牌在重启后被拒绝。 |
| `an expired tunnel token is refused` | 在 `iat` 之后 61 秒出示的令牌以 `TUNNEL_TOKEN_INVALID` 被拒绝。 |
| `a proof by another key is refused` | 证明由绑定密钥以外的密钥签名的握手以 4401 关闭。 |
| `a token for one name cannot open another` | 为一个名称签发、并附带该名称密钥所作证明的令牌，不会为第二个已绑定的名称打开任何隧道。 |
| `the relay holds no key for a bound name` | 浏览器只能以 home 的证书完成已绑定名称的 TLS 握手，且中继的文件中除令牌密钥与隧道主机的密钥外不含任何私钥。 |
| `a rebind without the previous key's signature is refused` | 一个 `rebindStatement` 无法验证、且未设置 `forceRebind` 的已变更绑定，会使旧绑定继续生效。 |
| `a rebind waits 60 seconds and is announced` | 有效的重新绑定会立即通告 `tunnel-rebound`，并且只在 60 秒后才接受新密钥。 |
| `per-stream buffers and the stream limit hold` | 超出剩余额度的 `DATA` 会关闭该流，中继为一个流所设的缓冲区从不超过 1 MiB，第 65 个并发浏览器连接会被关闭。 |
| `oversized and malformed frames close the tunnel` | 超过 65,536 字节的 `DATA` 负载以 4413 关闭，未知帧类型以 4400 关闭。 |
| `a wildcard certificate for the home's domain raises the alert` | 一张夹具 `*.example.com` 证书，以及一张列出 home 名称的多名称证书，在 home 的 ACME 账户未记录它们时，各自都会发起 `unrequested-certificate` 并关闭中继隧道。 |
| `an unexplained certificate keeps the tunnel closed` | 在告警未说明期间，中继客户端不打开任何隧道；从回环监听器对其作出说明后，隧道打开。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **证书日志时间窗。** 监控只有在某个日志收录证书且下一次查询运行之后才能看到该证书，这一延迟由每个日志的收录策略界定。在这段延迟内隧道保持打开，持有该证书的截获方不会被检测到。
- **被截获路径上的告警页面。** 提供自己页面的截获方会在该路径上丢弃 home 的告警页面；home 检测到该证书时会关闭隧道，告警则通过 [C5](c05-device-approval.zh.md#alerts) 中不经过中继的渠道送达本人。
- **中继运营者。** 中继能看到每个连接的名称、客户端地址、时间与流量大小，可以拒绝或丢弃任何连接，并且在自托管中继上可以用 `forceRebind` 重新绑定名称。其运营者就是本人，因此本约定保护的是 studio 内容不被中继读取，而不是中继的服务。
- **地址。** 中继的 `clientAddress` 是它自己的声称，home 上没有任何东西能核对它。

<a id="decided-values"></a>
## 决定的取值

- 重新绑定延迟：60 秒。
- 每个 home：一条活动隧道与 64 个并发流。
- 每个流的缓冲区：每个方向 1 MiB。
- 隧道令牌：60 秒，一次性使用。
- 帧限额：`DATA` 65,536 字节，`OPEN` 1,024 字节，`CONTROL` 与 ClientHello 各 16,384 字节。
- 证书监控：Cert Spotter 的签发搜索，每 30 分钟一次，可配置。
