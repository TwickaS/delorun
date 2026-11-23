---
description: "契约 C6 的自托管中继：配置与启动拒绝、隧道令牌、握手与关闭码、帧限额与流量控制、443 端口上的 SNI 路由、它所断言的对端事实、容器镜像、C20 的 relay 日志，以及证明每一项拒绝的规格。"
---

# 自托管中继

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 概述

本应用是[契约 C6](../../docs/contracts/c06-relay-protocol.zh.md) 的中继数据面：一个 Node 服务，在 TCP 443 端口接受浏览器连接与各 home 的出站 WebSocket 隧道，然后把每个浏览器连接的加密字节交给注册了该名称的 home。
本人（the person）在自己的服务器与域名上运行它。
`delorun/packages/reach/` 是同一契约中 home 的一侧，`@delorun/contract-relay-protocol` 承载帧类型、代码与限额。

数据面本身不持有套接字：`src/relay.ts` 持有状态与每一项拒绝，`src/node/server.ts` 是读取 ClientHello、为隧道主机终止 TLS 并升级隧道的传输层。
因此规格可以用内存连接驱动整个数据面，另有一条规格通过回环上的真实监听器驱动它。

## 中继能看到与不能看到什么

- **它只读取每个浏览器连接的 SNI 名称。** `src/client-hello.ts` 中的 ClientHello 读取器把第一个 TLS 记录解析到 `server_name` 扩展为止；此后的每个字节都是它搬运的 `DATA` 载荷。
- **它只为自己的隧道主机终止 TLS。** `tunnelCertFile` 与 `tunnelKeyFile` 指定一张证书；某个已绑定名称的握手在 home 上结束，而该名称密钥只有 home 持有。
- **它不持有 studio 的任何密钥。** 配置中每个已绑定名称只放一个 home 公钥，以及中继自己的一把令牌密钥。
- **它断言浏览器的对端地址，而 home 无法校验。** `OPEN` 帧的 `clientAddress` 与 `clientPort` 是中继套接字观测到的值，在数据面中以 `verified: false` 标记（[`peer.ts`](src/peer.ts)）；C6 称其为断言，帧中没有任何字段声称相反。
- **它无法跨 home 路由。** 一个浏览器连接只到达绑定名称等于 ClientHello SNI 的那一条隧道，home 发来的帧只在它自己的流表中解析。
- **home 离开后它无法继续。** 隧道关闭时，它拥有的每个浏览器连接在同一轮内结束，该名称接受下一次握手。
- **它无法读取它拒绝承载的流。** 未绑定的名称、没有 SNI 的 hello、超过 16,384 字节的 hello，以及没有活动隧道的名称，都在不作响应的情况下关闭。

## 配置

容器读取 `/etc/delorun-relay/relay.yaml`，或 `DELORUN_RELAY_CONFIG` 指定的文件。

| 字段 | 值 |
| --- | --- |
| `tunnelHost` | 中继自己的名称。它只为该名称终止 TLS。 |
| `tunnelCertFile`、`tunnelKeyFile` | `tunnelHost` 的 PEM 证书链与私钥。 |
| `bindings` | `{ name, homePublicKey }` 条目：一个 studio 名称与绑定到它的 32 字节原始 Ed25519 home 公钥。 |
| `bindings[].rebindStatement` | 可选。该声明必须指明它自己的绑定，以及该绑定的 `homePublicKey`。 |
| `bindings[].forceRebind` | 可选，只能为 `true`。与 `rebindStatement` 同时出现时被拒绝。 |
| `stateDir` | 令牌密钥所在目录。默认 `/var/lib/delorun-relay`。 |

出现下列情形时中继拒绝启动：一个名称出现在两个绑定中、一把 home 密钥绑定到两个名称、`tunnelHost` 是已绑定名称、某个名称或隧道主机不是 DNS 主机名，以及重新绑定声明没有描述它自己的绑定。
`CONFIG_INVALID` 指明字段；`CONFIG_UNREADABLE` 指明文件。

令牌密钥是 `<stateDir>/token-key.pem`，一把 Ed25519 PKCS #8 密钥，在首次启动时以 0600 模式创建。
已存在的密钥若其他用户可读、是符号链接或不是 Ed25519，则以 `TOKEN_KEY_UNPROTECTED` 拒绝，而不会被替换。
中继 id 是令牌公钥 32 个原始字节的 SHA-256 哈希，以 base64url 表示。

## 隧道令牌

`POST /v1/tunnel-token` 接受 `{ v, name, homePublicKey, timestamp, signature }`，其中签名是 home 密钥对该对象（去掉 `signature` 字段）的 RFC 8785 序列化所做的 Ed25519 签名。
它返回 `{ token }`，或下列拒绝之一：

| 状态 | 代码 | 何时 |
| --- | --- | --- |
| 400 | `TOKEN_REQUEST_INVALID` | 请求体不符合 schema、密钥不是 32 字节，或签名无法校验。 |
| 401 | `TOKEN_REQUEST_STALE` | `timestamp` 与中继时钟相差超过 60 秒。 |
| 403 | `NAME_NOT_BOUND` | 该名称未绑定到所提交的密钥。 |

令牌是 base64url 的 RFC 8785 声明、一个点，以及 base64url 的令牌密钥 Ed25519 签名。
其声明为 `{ v, iss, name, homeKeyId, jti, iat, exp }`：`iss` 是中继 id，`jti` 是 16 个随机字节，`exp` 是 `iat` 加 60 秒，所有时刻都是自纪元起的毫秒数。
中继拒绝签名无法校验、`iss` 指向其他中继、绑定已变更、`exp` 已过、`iat` 早于中继启动，以及 `jti` 已被它接受的令牌。

## 握手

`GET wss://<tunnelHost>/v1/tunnel` 需要子协议 `delorun-relay.v1` 与 `Authorization: Delorun-Tunnel <token>`，中继在升级请求之前检查两者：未带该子协议的升级返回 400 `SUBPROTOCOL_MISSING`，缺失、伪造、过期或重放的令牌返回 401 与 C6 的代码。

升级之后中继发送 `{"type":"challenge","relayId","nonce"}`，home 回答 `{"type":"proof","signature"}`：绑定 home 密钥对 `delorun-relay-tunnel-v1`、一个零字节，随后 `relayId`、`name`、`jti` 与 `nonce` 的 UTF-8 字节所做的 Ed25519 签名。
无法校验的证明以 4401 关闭。
当该名称已有活动隧道时，中继返回 `{"type":"refused","code":"TUNNEL_ALREADY_LIVE"}`，以 4409 关闭，并向活动隧道发送一条 `second-tunnel-refused` 种类的 `announce`，携带被拒令牌的 `jti`。
否则它返回 `{"type":"ready","tunnelId","limits"}`，该名称即为活动。
握手须在 10 秒内完成，否则中继以 4408 关闭。

| 关闭码 | 代码 | 何时 |
| --- | --- | --- |
| 4400 | `PROTOCOL_ERROR` | 畸形或意外的帧或消息、为隧道从未打开的流发来的帧，或 45 秒内未收到任何内容（包括 WebSocket pong）。 |
| 4401 | `PROOF_INVALID` | 证明无法用绑定密钥校验。 |
| 4408 | `HANDSHAKE_TIMEOUT` | 握手未在 10 秒内完成。 |
| 4409 | `TUNNEL_ALREADY_LIVE` | 针对活动名称的第二次握手。 |
| 4413 | `FRAME_TOO_LARGE` | 载荷超过其限额。 |

## 帧与流量控制

`ready` 之后每条消息都是二进制：一个类型字节、一个 4 字节大端流 id，随后是载荷。
流 0 属于隧道；流 1 及以上是浏览器连接，由中继按隧道编号且不重复使用。

| 类型 | 名称 | 载荷 | 限额 |
| --- | --- | --- | --- |
| `0x01` | `OPEN` | JSON `{ sni, clientAddress, clientPort }`，中继到 home | 1,024 字节 |
| `0x02` | `DATA` | 连接的加密字节，1 到 65,536 字节 | 65,536 字节 |
| `0x03` | `CREDIT` | 一个 4 字节大端数，表示发送方可追加的字节数 | 4 字节 |
| `0x04` | `CLOSE` | 一个原因字节：0 正常、1 拒绝、2 限额、3 协议错误、4 超时 | 1 字节 |
| `0x10` | `CONTROL` | 流 0 上的 JSON：中继的 `announce`，home 的 `pong` 与 `rebind-pending` | 16,384 字节 |

每条流的每个方向初始都有 1 MiB 信用额度。
中继只在 home 授予的信用额度内发送 `DATA` 帧，在等待额度期间最多持有浏览器 1 MiB 的字节，并在达到该上限时暂停浏览器连接。
它只在浏览器的传输层取走字节后才把额度授予 home，因此它自己为 home 载荷保留的缓冲区同样不超过 1 MiB。
超出自己额度发送的一方会被以原因 3 关闭该流。
一个 home 最多有 64 条并发流；第 65 个浏览器连接在不发送 `OPEN` 帧的情况下关闭。

## SNI 路由

每个 TCP 连接的第一个 ClientHello 被读取到 `server_name`，最多 16,384 字节、在 10 秒内，且不解密任何内容。
当名称是 `tunnelHost` 时，中继终止 TLS 并在那里只提供 `/v1/tunnel-token` 与 `/v1/tunnel`。
当名称是带有活动隧道的已绑定名称时，中继发送 `OPEN`，随后把 ClientHello 及之后每个字节作为 `DATA` 发送。
没有 SNI 的 hello、没有绑定或没有活动隧道的名称、第 65 条流，以及超过限额的 hello，都在不作响应的情况下关闭。
ALPN 为 `acme-tls/1` 的 hello 与任何其他 hello 一样被转发，因此 TLS-ALPN-01 挑战只能通过已证明密钥的隧道被应答；中继在 80 端口不提供任何内容。

## 镜像

数据面从本仓库导入 C6 的契约包与 C20 的日志包，因此镜像从仓库根目录、从干净的检出构建：

```sh
git archive HEAD | docker build -f delorun/apps/relay/Dockerfile -t delorun-relay -
docker run --rm \
  -p 443:443 \
  -v /etc/delorun-relay:/etc/delorun-relay:ro \
  -v delorun-relay-state:/var/lib/delorun-relay \
  -v delorun-relay-logs:/var/log/delorun-relay \
  delorun-relay
```

镜像通过本仓库的 tsx 启动器运行入口，即 `node --import tsx/esm delorun/apps/relay/src/node/main.ts`，因为 Node 24 无法去除中继所导入的每个工作区包中的类型。
`DELORUN_RELAY_CONFIG` 指定另一份配置文件，`DELORUN_RELAY_PORT` 指定另一个端口；C6 固定为 443。
进程在 `SIGTERM` 与 `SIGINT` 时停止，并把启动失败报告为其代码与详情。
镜像以其 `node` 用户运行，该用户必须能读取配置及其证书文件，并能写入状态与日志卷；因此以 0600 模式挂载的配置需要一个该用户所属的组。
命名卷继承镜像中 0700 模式的状态与日志目录；绑定挂载的目录必须以 0700 模式准备并归容器用户所有，因为 C20 会拒绝其他用户可访问的日志目录。

## 日志

中继通过 `@delorun/logs` 写入 C20 的 `relay` 表面，位置为 `/var/log/delorun-relay/relay.log`：监听端口、每次被接受或拒绝的尝试、每条活动与关闭的隧道、每个被路由或丢弃的浏览器连接。
中继处理的每个令牌都以 `relay-key` 注册到脱敏器，因此即使消息中带有令牌，它也无法进入文件。
已接受 id 的 `jti` 只留在内存中，绝不写入日志。
本应用还为 C20 的跨表面拒绝测试套件（`delorun/packages/logs/tests/denial/`）注册了一个驱动，因此该套件的机密、轮转、模式与清除测试也会在这个表面上运行。

## 规格

`delorun/apps/relay/tests` 为每一项拒绝提供证明；指明某项检查的规格在该检查被移除时会失败，因为它必须拒绝的尝试与一次成功的尝试成对出现。

| 规格 | 证明 |
| --- | --- |
| `config.spec.ts` | 绑定与 id、C6 的每一项启动拒绝、重新绑定声明的自洽性、令牌密钥的模式、身份与拒绝。 |
| `token.spec.ts` | 请求签名、时钟偏移、绑定、过期、重启规则、一次性使用，以及令牌所签名的规范化声明。 |
| `frames.spec.ts` | 每种往返、每项载荷限额、流与头部规则，以及只给出拒绝的确定性畸形消息语料。 |
| `client-hello.spec.ts` | 单个分片与多个分片中的 SNI、没有 SNI 的 hello、记录与大小限额、跨记录的 hello、不是主机名的名称。 |
| `handshake.spec.ts` | `ready`、升级前的拒绝（包括签名伪造或由其他令牌密钥签名的令牌）、其他密钥的证明、10 秒限额、第二条有效密钥隧道被拒绝并通告、一个名称的令牌无法为另一个名称开路、`ready` 之前的帧。 |
| `routing.spec.ts` | 一个名称一个 home、不做前缀匹配、在其自己 home 的流表中解析帧、home 不得发送的 `OPEN`、对端事实、64 条流的限额。 |
| `stream.spec.ts` | 双向的不透明字节、DATA 限额、双向的信用额度规则、1 MiB 持有字节上限、浏览器的背压。 |
| `teardown.spec.ts` | home 断开会立即结束它拥有的每个浏览器连接、该名称接受下一次握手、另一个名称不受影响、停滞限额（home 的 WebSocket pong 会重置它）、中继自身的关闭。 |
| `logging.spec.ts` | C20 的字段、以机密注册的令牌、记录代码但不记录令牌的拒绝。 |
| `node/end-to-end.spec.ts` | 在回环上：浏览器握手只与 home 的证书完成、字节往返、home 收到浏览器套接字自己的地址与端口、日志不含明文、令牌端点返回 C6 的状态码。 |

## 文件

- `src/config.ts`：配置、绑定、令牌密钥与中继 id。
- `src/token.ts`：令牌请求、令牌及其检查。
- `src/tunnel.ts`：握手、活动检查、通告与帧循环。
- `src/stream.ts`：一条流的流量控制、缓冲区与关闭。
- `src/relay.ts`：数据面的状态，以及传输层所需的每一项拒绝。
- `src/frames.ts`、`src/client-hello.ts`、`src/peer.ts`、`src/keys.ts`、`src/errors.ts`：编解码、SNI 读取器、对端断言、密钥原语与类型化拒绝。
- `src/log.ts`：C20 的 `relay` 表面。
- `src/node/server.ts`、`src/node/main.ts`：TCP 监听器、隧道主机的 TLS、HTTP 端点与入口。

## 本应用尚未包含

- **重新绑定的签名检查、60 秒延迟与通告。** 配置会检查重新绑定声明指名了其绑定的名称和新密钥，但不验证旧密钥的签名。已变更的绑定在中继以编辑后的配置重启时生效，没有延迟，也没有 `tunnel-rebound` 通告；这些等待 `stateDir` 中的绑定历史。
- **证书监控。** C6 把它交给 home，而 home 一侧的证书监控尚未构建。
- **Delorun 中继。** 中继控制与 `delo.run` 名称不属于 Delorun（[路线图](../../docs/guide/roadmap.zh.md)），数据面只服务自托管中继。
