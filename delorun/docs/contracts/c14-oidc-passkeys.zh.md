---
description: "约定 C14：远程访问地址可使用的身份因子；每个地址的通行密钥依赖方 ID，以及 ts.net 规则的两种情形；本人自己的 OpenID Connect 提供方，包括客户端注册与每个地址的重定向 URI；必需声明；每个 home 的受众；在首次注册时固定的所有者身份；nonce、PKCE、签发方检查与混淆防护；签名密钥 ID 与轮换；以及作为后续功能的 Delorun 签发方。"
---

# 约定 C14：OpenID Connect 与通行密钥

[English](c14-oidc-passkeys.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

远程访问（reach）在设备批准（device approval）之外还要求一个身份因子（identity factor）：通行密钥，或在本人（the person）自己的 OpenID Connect 提供方处登录。home 是两者的依赖方（relying party）。本页定义每个远程访问地址可使用哪些因子、每个地址的通行密钥依赖方 ID、home 如何在本人的提供方处注册为客户端、带有 nonce、PKCE 与签发方（issuer）检查的授权流程、home 要求的声明与受众、它固定的所有者身份、它如何获取并轮换签名密钥，以及约束 Delorun 签发方的规则，该签发方是一项后续功能（fast-follow）。因子从不替代设备批准（[C5](c05-device-approval.zh.md)）。类型包 [`@delorun/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.zh.md) 承载这些规则、声明、代码与上限。

<a id="status"></a>
## 状态

Face ID 解锁（见下文）已构建。本页的通行密钥与 OpenID Connect 登录因子尚未构建：home 没有通行密钥依赖方，也没有 OpenID Connect 客户端。Tailscale 私有路由的 `tailnet-membership` 因子已构建。

- **已构建并已接入：** 设置的答案模式指明 `reach.identityFactor`，并在 `--config` 文档中拒绝 `null` 以外的任何值（[C11](c11-setup-answers.zh.md)）。
- **未构建：** 带用户验证与计数器的通行密钥注册与断言；在本人提供方处的客户端注册；带 `state`、`nonce`、PKCE 与签发方检查的授权流程；ID 令牌检查与签名密钥轮换；固定的所有者主体；重新认证；Delorun 签发方。

下文中被此列表称为未构建或未被任何部分接入的要求与拒绝测试，在某项变更构建并接入它们之前不保护任何人。[远程访问设计](../design/reach.zh.md)规定私有 tailnet 路由仅凭已批准的设备密钥登录，不使用通行密钥或 OpenID Connect；本页为 `tailscale-private` 列出身份因子之处，以该设计为准。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [状态](#status)
- [约定](#contract)
  - [依赖方 ID](#relying-party-ids)
  - [注册](#enrolment)
  - [通行密钥](#passkeys)
  - [客户端注册](#client-registration)
  - [授权流程](#authorization-flow)
  - [ID 令牌检查](#id-token-checks)
  - [所有者主体](#owner-subject)
  - [重新认证](#re-authentication)
  - [签名密钥](#signing-keys)
  - [tailnet 身份](#tailnet-identity)
  - [tailnet 成员身份](#tailnet-membership)
  - [设备可以调用什么](#what-a-device-may-call)
  - [提权](#elevation)
  - [PIN 模式](#pin-mode)
  - [上限](#limits)
  - [错误](#errors)
  - [Delorun 签发方](#delorun-issuer)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
  - [本约定不能证明的内容](#what-this-does-not-prove)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="relying-party-ids"></a>
### 依赖方 ID

每条规则都按 studio 地址生效：一个地址的通行密钥或重定向 URI 永远不会在另一个地址上被接受。

| 地址 | 通行密钥 | 通行密钥依赖方 ID | OpenID Connect 重定向 URI |
| --- | --- | --- | --- |
| 回环 | 不使用：回环监听器不需要身份因子 | — | — |
| Tailscale 私有网络，`https://<machine>.<tailnet>.ts.net[:<port>]` | 当前约定：不可用；该地址以 [tailnet 成员身份](#tailnet-membership)登录 | — | `0.1.0` 中未构建 |
| Tailscale Funnel，`https://<machine>.<tailnet>.ts.net[:<port>]` | 当前约定：不可用 | — | `https://<address>/auth/oidc/callback` |
| 自有域名，`https://<name>` | 可用 | `<name>`，与该地址的主机名完全一致 | `https://<name>/auth/oidc/callback` |

`<address>` 是该地址的主机名，端口不是 443 时附带其端口。在 Tailscale 私有网络地址上，身份因子是 [tailnet 成员身份](#tailnet-membership)，且没有为它构建 OpenID Connect 登录，因为从手机注册会把所有者身份固定在较弱的会话上。在当前约定下的 Funnel 地址上，本人的 OpenID Connect 提供方就是身份因子，setup 与远程访问屏幕会说明该地址上不提供通行密钥。

- **ts.net 规则，当前约定。** `ts.net` 地址上不提供通行密钥。在[兼容性](#compatibility)下记录的 spike 结果表明情况并非如此之前，这一点一直成立。
- **ts.net 规则，由通过的 spike 采纳。** `ts.net` 地址的依赖方 ID 是其主机名 `<machine>.<tailnet>.ts.net`。同一台机器的 Tailscale 私有网络地址与 Funnel 地址共用该主机名，因此共用一个依赖方 ID；所以 home 把每个通行密钥绑定到注册它时所在的地址，并拒绝 `clientDataJSON.origin` 不是该地址的断言。
- **永不使用父域。** 依赖方 ID 永远不是该地址主机名的父域，例如对 `studio.example.com` 使用 `example.com`，或使用 `<tailnet>.ts.net`，因此一个通行密钥只能在一个主机上使用。

<a id="enrolment"></a>
### 注册

地址的身份因子在添加该地址时注册。若某台设备已为一个尚无已注册因子的地址获得批准，它会收到一个注册会话：一个 C4 会话（[C4](c04-admission.zh.md#sessions)），绝对时限为 10 分钟，只准入 `POST /auth/passkey/register/options`、`POST /auth/passkey/register`、带 `purpose=enrol` 的 `GET /auth/oidc/start` 与 `GET /auth/oidc/callback`。完成注册会结束该注册会话，并且属于登录因子变更，它会轮换每个会话。home 在首次注册通行密钥或 OpenID Connect 登录时发放恢复套件（recovery kit）（[C5](c05-device-approval.zh.md#recovery-kit)）。

<a id="passkeys"></a>
### 通行密钥

- **注册选项。** `POST /auth/passkey/register/options` 返回：`rp` `{ id: <relying-party ID>, name: "Delorun" }`；`user` `{ id: <the home's owner handle>, name: "owner", displayName: <device label> }`，其中所有者句柄是每个 home 固定的 32 个随机字节；`pubKeyCredParams` EdDSA（-8）、ES256（-7）与 RS256（-257）；`authenticatorSelection` `{ residentKey: "required", userVerification: "required" }`；`attestation: "none"`；列出本地址凭据的 `excludeCredentials`；一个 32 字节的质询；以及 300,000 毫秒的超时。
- **存储。** `~/.delorun/secrets/home-auth/passkeys.json` 按凭据保存：凭据 id、COSE 公钥与算法、地址、依赖方 ID、签名计数器、传输方式、创建时间以及注册设备的 id。
- **断言选项。** `POST /auth/passkey/options` 返回一个 32 字节的质询、监听器所在地址的依赖方 ID、列出该地址凭据的 `allowCredentials`，以及 `userVerification: "required"`。
- **断言检查。** home 只在以下条件全部满足时接受断言：`clientDataJSON.type` 为 `webauthn.get`；其质询由 home 签发，且未使用、未过期；其来源与监听器的地址完全相等；`rpIdHash` 等于该地址依赖方 ID 的 SHA-256 哈希；用户在场与用户已验证标志均已设置；该凭据已为该地址注册；签名可用存储的密钥验证；已存储的计数器非零时小于所呈现的计数器，随后 home 存储所呈现的计数器。
- **质询。** 通行密钥质询在 5 分钟后过期，且只能使用一次。

<a id="client-registration"></a>
### 客户端注册

在 setup 期间，或在本人开启远程访问时，本人在自己的 OpenID Connect 提供方处将 Delorun 注册为客户端，并输入三个值：签发方 URL、客户端 ID 与客户端密钥。setup 列出需要注册的重定向 URI：为 home 的每个 `ts.net` 地址与自有域名地址各列一个 `https://<address>/auth/oidc/callback`。

- **发现。** home 通过 `https` 读取 `<issuer>/.well-known/openid-configuration`。该文档的 `issuer` 必须与输入的签发方完全相等，`response_types_supported` 必须包含 `code`，`code_challenge_methods_supported` 必须包含 `S256`，`id_token_signing_alg_values_supported` 必须包含 [ID 令牌检查](#id-token-checks)中的一种算法；否则 setup 以相应的代码拒绝。
- **动态注册。** 只有当提供方的元数据含有 `registration_endpoint` 且本人选择使用它时，home 才按 RFC 7591 的描述注册自身：`client_name` 为 `Delorun`，重定向 URI 为上述各项，`grant_types` 为 `["authorization_code"]`，`response_types` 为 `["code"]`，`token_endpoint_auth_method` 为 `client_secret_basic`，`application_type` 为 `web`；当提供方要求初始访问令牌且本人输入了它时，附带该令牌。
- **存储。** `~/.delorun/secrets/home-auth/oidc-client.json` 保存签发方、客户端 ID、客户端密钥、重定向 URI，以及动态注册之后的注册访问令牌。任何配置行都不保存它们。
- **每个 home 一个客户端。** home 的客户端注册归它自己所有：两个 home 永远不共用一个客户端 ID，因此客户端 ID 就是指明该 home 的受众。
- **添加地址。** 添加地址会在提供方处添加其重定向 URI：由本人添加，或由 home 通过其注册访问令牌更新动态注册。

<a id="authorization-flow"></a>
### 授权流程

1. **开始。** 带 `purpose`（`enrol`、`sign-in`、`recovery` 或 `reauth`）与设备 id 的 `GET /auth/oidc/start` 创建一个绑定到监听器地址的流程，包含：一个 32 字节的 `state`、一个 32 字节的 `nonce`、一个 32 字节的 PKCE `code_verifier`、签发方、用途、设备 id 与创建时间。home 在内存中保存该流程，把 cookie `__Host-delorun-oidc` 设为一个 32 字节的随机值（流程记录该值的哈希），并重定向到签发方的 `authorization_endpoint`，附带 `response_type=code`、`client_id`、该地址的 `redirect_uri`、`scope=openid`、`state`、`nonce`、`code_challenge`（verifier 的 SHA-256 哈希）与 `code_challenge_method=S256`。对于 `reauth`，它另外添加 `prompt=login` 与 `max_age=0`，且 `nonce` 为设备发送的批准哈希。
2. **回调。** 只有当 `state` 指向本地址一个待处理且未过期的流程，并且 `__Host-delorun-oidc` cookie 与该流程匹配时，`GET /auth/oidc/callback` 才被接受。当提供方的元数据设置了 `authorization_response_iss_parameter_supported` 时，响应必须携带等于该流程签发方的 `iss`（RFC 9207）；在任何情况下，出现的 `iss` 都必须与之相等。无论结果如何，流程都在回调时被消耗。
3. **令牌请求。** home 使用 `client_secret_basic`，把授权码与 `code_verifier` 发送到该流程签发方的 `token_endpoint`；该端点读取自该签发方的元数据，永远不读取自响应。
4. **结果。** 通过 [ID 令牌检查](#id-token-checks)后，home 签发一张登录票据：32 个随机字节，只能使用一次，有效期 60 秒，绑定到该流程的设备 id、地址与用途；设备将其作为因子证明出示（[C5](c05-device-approval.zh.md#sign-in)）。home 不存储 ID 令牌，也不请求刷新令牌。

<a id="id-token-checks"></a>
### ID 令牌检查

| 检查 | 规则 |
| --- | --- |
| 算法 | `RS256`、`PS256`、`ES256` 或 `EdDSA`。`none` 与所有 `HS*` 算法都被拒绝。 |
| 密钥 | 头部携带 `kid`，它指明该流程签发方密钥集中的一个密钥（[签名密钥](#signing-keys)）；签名可用该密钥验证。 |
| `iss` | 与该流程的签发方完全相等。 |
| `aud` | 包含 home 的客户端 ID。当 `aud` 有多个值时，`azp` 等于该客户端 ID。 |
| `exp` | 晚于 home 的时钟，允许 60 秒偏差。 |
| `iat` | 在 home 时钟之前 10 分钟以内，允许 60 秒偏差。 |
| `nonce` | 等于该流程的 nonce。 |
| `sub` | 必须存在。对于 `sign-in`、`recovery` 与 `reauth`，`iss` 与 `sub` 等于所有者已固定的身份。 |
| `auth_time` | `reauth` 必需，且与 home 的时钟相差不超过 120 秒。 |

因此必需的声明为 `iss`、`sub`、`aud`、`exp`、`iat` 与 `nonce`，对 `reauth` 另加 `auth_time`。未通过某项检查的令牌以该检查的代码被拒绝，且不创建票据。

<a id="owner-subject"></a>
### 所有者主体

所有者在本人提供方处的身份，在所有者认领身份因子时被固定：由所有者的一台设备完成的首次 OpenID Connect 注册（[C5](c05-device-approval.zh.md#owner-claim)）会把签发方与 `sub` 记录到 `~/.delorun/secrets/home-auth/owner.json`。之后的每次登录、恢复与重新认证都必须出示这一对值，为另一个地址进行的 `enrol` 流程也必须如此。更改它属于登录因子变更，只有在新身份上完成 `enrol` 流程之后，从实时会话中的受信任设备（trusted device）发起时才被接受；它会轮换每个会话（[C4](c04-admission.zh.md#rotation-and-revocation)）。`delorun devices reset` 会移除该固定（[C5](c05-device-approval.zh.md#reset)）。

<a id="re-authentication"></a>
### 重新认证

在没有通行密钥的地址上，设备批准携带一次 OpenID Connect 重新认证（[C5](c05-device-approval.zh.md#approval)）：一个 `reauth` 流程，其 `nonce` 为批准哈希，并带有 `prompt=login` 与 `max_age=0`。只有在通过上述检查、`auth_time` 在 120 秒以内且身份为所有者已固定的身份之后，home 才接受其 ID 令牌作为该批准的 `oidcReauth`。

<a id="signing-keys"></a>
### 签名密钥

- **密钥集。** home 通过 `https`，从签发方元数据的 `jwks_uri` 读取签发方的 JSON Web Key Set，大小不超过 65,536 字节，用时不超过 10 秒。没有 `kid` 或 `use` 不是 `sig` 的密钥会被忽略。
- **轮换。** home 每 24 小时刷新一次密钥集；当令牌指明未知的 `kid` 时也会刷新，但最多每 5 分钟一次。刷新后 `kid` 仍未知的令牌以 `OIDC_UNKNOWN_KEY` 被拒绝。签发方从其密钥集中移除的密钥，在下次刷新时停止用于验证令牌。
- **元数据。** home 每 24 小时刷新一次签发方的元数据，采用相同的大小与时间上限，并拒绝 `issuer` 已改变的元数据。

<a id="tailnet-identity"></a>
### tailnet 身份

`tailnet` 身份因子只存在于 C7 的套接字变体下（[C7](c07-reach-providers.zh.md#identity-headers)）：serve 套接字上的一个请求，若其 `Tailscale-User-Login` 位于 tailnet 登录允许列表中，即为 `tailscale-private` 证明了该因子。在当前约定下，它以 `TAILNET_IDENTITY_UNAVAILABLE` 被拒绝。恢复套件永远不接受它（[C5](c05-device-approval.zh.md#recovery-kit)）。

<a id="tailnet-membership"></a>
### tailnet 成员身份

`tailnet-membership` 因子不携带任何证明：它表明一个请求经由声明了该因子的远程访问提供方的 serve 目标到达。只有 `reach-tailscale-private` 提供方可以声明它（[C7](c07-reach-providers.zh.md#provider-service-definition)），对于任何其他监听器以及任何不是 `ts.net` 地址的地址，home 以 `TAILNET_IDENTITY_UNAVAILABLE` 拒绝该声明。在该监听器上，已批准设备的一个新鲜设备密钥签名本身即可创建完整会话（[C5](c05-device-approval.zh.md#sign-in)），会话记录携带该因子（[C4](c04-admission.zh.md#sessions)）。

对于每一项只在 home 自己的电脑上授予的操作，home 以 `403 LOOPBACK_REQUIRED` 拒绝因子为 `tailnet-membership` 的会话：授予完全访问，无论是升级到 `danger-full-access`（包括 `plugin_manager` 的升级）还是某个工作区的完全访问同意；授予标记为 `workspace-management` 的提示（主 chat 的工作区工具及其其他询问，以及指令层写入）；授予标记为 `external-agent` 的提示（启动 Claude Code 或 Codex 之类的外部智能体），以及为某个工作区允许或撤销这类智能体；允许、拒绝或撤销某个 stdio MCP 服务器的启动，设备只能读取等待中服务器的名称以及每个服务器发生了什么变化；打开批准窗口以及批准或移除设备；重置；恢复套件；注册身份因子；以及更改远程访问设置。拒绝发生在授予操作的地方，而不是客户端：授予完全访问的批准提示携带 `grants: "full-access"`，以该因子准入的 Peer 的答复不会被应用，因此该提示保持打开，留给 home 自己电脑上的 studio。远程 studio 会提示在电脑上批准该操作。观看、回复、开始 chat、答复其他所有提示以及停止运行都是允许的，而从手机安装插件需要在电脑上批准的[解锁](#elevation)。同一规则适用于 studio 调用的每个 Remote 方法：设备的 Peer 代表其 `reach-device` 主体，该主体的远程访问策略允许[设备可以调用什么](#what-a-device-may-call)一节列出的方法和转发事件，仅在解锁时准入提权类操作，并以 `remote-access/denied` 和原因 `loopback-required: <action>` 拒绝其他所有方法；该策略及其三张表格位于 [`@delorun/home-auth`](../../packages/home-auth/README.zh.md)。

<a id="what-a-device-may-call"></a>
### 设备可以调用什么

所有者对设备的规则是：已批准的设备就是本人，它本来就可以向智能体发送提示：风险不高于一条提示的每项操作都被允许，而[解锁](#elevation)只覆盖那些少见的操作，即扩大智能体可触及的范围、添加在电脑上运行的代码，或更改 home 的设置。`@delorun/home-auth` 把 Delorun 默认 profile 的每个 Remote 方法和每个转发事件归入四类之一；当某个操作不被任何表格列出、某个表格条目没有对应操作、某个操作被两个表格列出，或某个操作位于[提权](#elevation)表格给其所属族的类别之外时，reach 访问拒绝测试套件失败。

- **允许**：设备做本人在电脑上做的事。各项操作及其原因见 [`reach-access.ts`](../../packages/home-auth/src/reach-access.ts) 中的 `REACH_ALLOWED_ACTIONS`。
- **解锁**：以 `403` 和原因 `elevation-required: <action>` 拒绝，除非该设备持有针对该次调用的[授权凭证（grant）](#face-id-unlock)（来自 Face ID 或其 PIN），或有效的 Face ID 通行期（pass）准入该次调用。各项操作及其让本人能做什么，见同一文件中的 `REACH_ELEVATED_ACTIONS`；只有列在那里的操作才属于提权。位于已知工作区之外文件夹中的 `session/create`，由策略的条件提权，原因为 `CREATE_OUTSIDE_WORKSPACES`。
- **从不**：无论是否解锁，都以 `403 LOOPBACK_REQUIRED` 和原因 `loopback-required: <action>` 拒绝。各项操作及其原因见同一文件中的 `REACH_DENIED_ACTIONS`；没有任何配置能改变该表格。
- **只有电脑能给出的授权**：在授予之处而不是调用之处被拒绝（[tailnet 成员身份](#tailnet-membership)）。

在允许的操作之内，策略的条件对每次调用保持两条规则。工作区文件调用（`workspaceFiles/*`、`officeKit/render`）只有在它指名的每个路径（含字节读取的基准文件）的真实路径都位于该 chat 工作区的真实路径之内、且在 Delorun 主目录之外时才被准入；含 `..` 段或以 `~` 开头的路径，以及不存在的路径，无论是否解锁都会被拒绝。`session/create` 在其指名 Host 所列出的某个 Workspace，或其真实路径是某个已列出 Workspace 的路径的文件夹时被允许，可使用任何预设；指名其他文件夹，或既没有指名 Workspace 也没有指名文件夹（Host 自己的工作目录）的调用需要解锁。选择预设本身不授予任何访问：工作区的完全访问同意仍然是电脑上的答复，每个批准提示也仍然适用。

<a id="elevation"></a>
### 提权

提权（studio 用语中的解锁，“sudo mode”）曾是为一台设备开放几分钟的提权操作，在 home 自己的电脑上批准。home 服务启动后，授权凭证存储就已存在，提权不再准入任何 `face` 操作或提示答复；studio 不为设备提供解锁，只有电脑会列出请求。`@delorun/home-auth` 把它保存在内存中，位于 [`elevation.ts`](../../packages/home-auth/src/elevation.ts)，上限为 `@delorun/contract-oidc-passkeys` 的 `ELEVATION_LIMITS`。

下面三张表是 Remote 方法的 [`AUTH_CLASSES`](#face-id-unlock) 类别：第一张是 `free`，第二张是 `face`（针对该次调用的授权凭证或有效的 Face ID 通行期，但 `alwaysAsk` 行除外，它们始终需要授权凭证；没有通行密钥的设备使用一次一个操作的 PIN 授权凭证，而下面的解锁只覆盖解锁此前覆盖的那些操作），第三张是 `computer`。

**无需解锁即允许**

| 族 | 操作 |
| --- | --- |
| chat，读取与写入 | `session/*` 的读取、在已知工作区内以任何预设进行的 `session/create`、`session/fork`、`session/prompt`、`session/updateQueue`、`session/cancel`、`session/rename`、`fileUploads/upload`、`userQuestions/*`、`subagents/*`、`job/*`、`toolResults/watch`、`sessionReferenceResolver/candidates`、`skills/list`、`commands/list` |
| chat 与工作区的整理 | `workspace/follow`、`workspace/pinSession`、`workspace/unpinSession`、`workspace/archiveSession`、`workspace/unarchiveSession`、`workspace/insertSessionBefore`、`workspace/insertBefore`、`workspace/rename`、`workspace/delete`（移入回收站）、`workspace/initializeDefault` |
| 目标与计划的跟进 | `goals/*`、`schedule/*` |
| 模型与预设 | `session/selectModel`、`session/initializeDefaultModel`、`session/modelCatalog`、`llm/listProviders`、`llm/listConfigurableProviders`、`llm/discoverModels`、`agentPresets/*`、`permissionPresets/catalog` |
| chat 所在工作区的文件 | `workspaceFiles/list`、`read`、`readBytes`、`stat`、`changes`，`officeKit/*`、`fileReferences/list`，遵循工作区文件规则 |
| 设置与插件的读取 | `settings/describe`（密钥已脱敏）、`pluginManager/history`、`inspect`、`listBundles`、`listPlugins`、`listVersionExemptions`、`listVersions`、`readBundleDetail`、`registries`、`waitForInstall`、`pluginInventory/list`、`pluginRegistryProbe/fastest` |
| 反馈 | `sessionFeedback/record`、`messageFeedback/*` |
| 转发事件 | `event:approval/request`（答复守卫仍然拒绝授权）、`event:user-questions/request`、`event:api-session/*`、`event:agent-preset/selected`、`event:commands/change`、`event:goal/activation-changed`、`event:llm/*`、`event:permission-presets/catalog-changed`、`event:plugin-manager/*`、`event:plugin-market/changed`、`event:settings/document-updated`、`event:schedule/changed` |

**解锁**

| 族 | 操作 | 原因 |
| --- | --- | --- |
| 设置写入 | `settings/mutate`、`settings/replace`、`settings/update` | 它们更改 home 的设置。对于可能关闭仅限电脑的开关的写入，条件会拒绝，并给出 `loopback-required: turning <switch> off`，解锁时同样如此：插件在挂载期间用 `HomeAuthService.registerComputerOnlySwitch` 注册这样的开关，`@delorun/plugin-delegation-consent` 注册它的 `enabled` 字段，因此拒绝信息读作 `loopback-required: turning the external-agent consent off`。该字段只能被写成字面量 `true`，`replace` 必须这样写明它，条件无法读取的参数会被拒绝。条件还会拒绝写入权限预设行的 `defaultPreset` 而放宽新 chat 开始时的权限，并给出 `loopback-required: loosening the permission new chats start in`，解锁时同样如此：沙箱模式或批准策略比当前预设更宽松的预设、各行并未持有的预设、删除该字段的写入，或当前预设无法读取时的任何更改；更严格或相同的预设是普通写入。唯一属于设置命名空间的受保护插件行是外部智能体同意的，其开关由条件决定；bash 沙箱的实时字段是执行限制，沙箱模式属于 sandbox-policy 行，它没有这样的字段。 |
| 斜杠命令 | 对 `REACH_DEVICE_COMMANDS` 所列命令（`compact`、`export`、`goal`、`permission` 和 `plan`）的 `commands/execute` | 每个命令只更改或读取它自己的 chat。条件用命令服务自己的解析器解析该行，并以 `loopback-required: commands/execute of a command a device does not run` 拒绝任何其他命令或未指名任何命令的行，解锁时同样如此，因此插件新增的命令在被列出之前会被拒绝。 |
| 插件与 profile 历史 | `pluginManager/installBundle`、`updateBundle`、`removeBundle`、`setBundleEnabled`、`setPluginEnabled`、`setVersionExemption`、`cancelInstall`、`undo`、`restore` | 它们添加或启用在沙箱之外于 Host 中运行的代码。受保护的行，即其模块被 `plugin-manager` 行的 `protectedPlugins` 指名的行（同意与防护行、更新闸门与更新检查、home-auth、reach 和沙箱行），从不通过设备更改：条件对其上的 `setPluginEnabled`，或带有无法读取的参数的调用，以 `loopback-required: changing a protected plugin row` 拒绝，解锁时同样如此，列表无法读取时则拒绝每一行。插件管理器以 `management-required` 拒绝任何其他会停用、移除或重新配置受保护行的更改，或恢复到其中某一行不同的 profile 状态，无论是否解锁。 |
| 终端 | `terminal/*` | 终端是电脑上沙箱之外的 shell。打开终端始终需要针对该次调用的 [Face ID 授权凭证](#face-id-unlock)：没有任何开关、完全访问授权凭证或危险模式能免除它，批准后的宽限期也不是解锁。 |
| 外部工具服务器 | `mcpManager/probe`、`restart`、`watch` | 它们启动并观察 home 为其外部工具服务器配置的命令。 |
| 文件夹 | `directoryPicker/*`、`workspace/create`、位于已知工作区之外文件夹中的 `session/create` | 文件夹决定 chat 的命令可以写入哪里。 |
| 动态插件代码 | `dynamicCordisRunner/*`、`event:cordis/*` | 它在 Host 中运行模型编写的插件代码。 |

**从不**

| 族 | 操作 | 原因 |
| --- | --- | --- |
| 账户 | `account/*`、`event:deepseek-account/*` | 账户登录在 Delorun 中是关闭的，账户更改属于电脑。 |
| 电脑自己的屏幕 | `settings/openSettingsDocument`、`session/openWorkspacePath`、`session/workspacePathApplications` | 它们会在电脑上打开应用，设备用不到。 |
| 授权与设备 | 升级到完全访问、某个工作区的完全访问同意、`workspace-management` 提示、设备批准、不持有通行密钥的设备移除另一台设备，以及启动、批准或延长一次解锁 | 电脑的路由与答复守卫拒绝其中每一项（[tailnet 成员身份](#tailnet-membership)）；它们都不是表格能列出的 Remote 方法。 |

- **路由。** 设备在 `GET /auth/elevation` 读取状态（`none` 与 `pending` 带有 `unlockMinutes`，即其监听器上一次解锁持续的分钟数，使工作室在解锁前就能说明时长），在 `POST /auth/elevation/request` 发起请求，在 `POST /auth/elevation/lock` 锁定，每个路由都要求请求到达的远程访问监听器上的有效会话，`POST` 只接受 studio 自己的源。电脑在 `GET /auth/elevation/pending` 列出，在 `POST /auth/elevation/approve` 批准，在 `POST /auth/elevation/revoke` 撤销；设备访问这些路由会以 `LOOPBACK_REQUIRED` 被拒绝。
- **放宽的设置。** 危险模式成立期间，持有针对该次调用的授权凭证的设备，可以放宽默认预设，并关闭 `DANGEROUS_LIFTABLE_SWITCHES` 所列的开关。策略在调用继续之前，把每次这样的写入连同字段原先的值与该调用设置的值，记录在 `~/.delorun/secrets/home-auth/reach-dangerous-settings.json` 中。当该模式不再成立时（在第一次读到它已结束时，以及启动时），home 通过设置服务写回原先的值，除非该字段已不再保存所记录的设备值，因为本人在电脑上更改过它。写入失败时记录保留，并会重试。
- **终端。** 每个 `terminal/*` 操作都始终需要确认，在每个 Session 和全局资源上都是如此，但 `terminal/environment`、`terminal/shells` 和 `terminal/list` 除外：它们读取终端的大小限制、chat 的工作目录、它可以启动的 shell，以及 chat 的终端（每个终端的 id、标题、shell、起始工作目录、大小、状态、退出码、取代任何启动错误文本的固定一行、谁启动了它、谁持有它的输入，以及它的沙箱模式），不读取输出或输入（针对 `terminal/create`，或针对现有终端的 `terminal/retain` 或 `terminal/attach` 的授权凭证，也会为该终端打开[保持窗口（hold）](#face-id-unlock)，因此重新加载的终端标签页在保持窗口失效后确认一次，在此之前沿用它；手机从不为 `terminal/retain` 本身询问，studio 为每个已保存的标签页发送它，屏幕上的终端通过 `terminal/attach` 询问）：危险模式、工作区的完全访问授权，以及终端将打开的文件夹，都不起决定作用。早期版本在 `~/.delorun/secrets/home-auth/reach-terminal.json` 中保存终端开关；现在没有任何东西读取该文件，仍保留它的 home 继续工作，该文件可以删除。已经打开的终端会一直运行到结束。
- **请求。** 已登录的设备从自己的 studio 发起请求。home 把请求记在该设备、监听器和请求到达的会话名下，设备显示一个 8 位数字代码。请求等待 5 分钟，一个 home 最多保留 5 个，同一设备在同一监听器上的新请求会替换它正在等待的请求。设备持有解锁期间，其状态显示的是解锁而不是代码，因此设备无法延长自己的解锁。
- **批准。** 只有在 home 电脑前的本人能批准，方法是在 `delorun devices elevate` 中输入设备上的代码（它调用 [C19](c19-home-process.zh.md) 的 `devices.elevate`）、在 studio 的 Settings 的 Devices 中输入，或通过电脑路由；第三次输错会取消请求。批准和撤销是 `LOOPBACK_REQUIRED_ACTIONS` 中的 `elevation-approve` 和 `elevation-revoke`，设备会被拒绝。
- **时长。** 解锁持续远程访问行的 `elevationMinutes`，默认 15 分钟，最多 60 分钟；更大的值会在监听器开始服务时被拒绝。没有任何操作能延长解锁：新的批准会替换它。
- **范围。** 解锁绑定到它的设备、监听器和 profile。`reach-device` 主体指明设备及其 Peer 所在的监听器，策略只在该监听器上询问设备的解锁。一个 profile 的 Host 把自己的解锁保存在内存中，从不放在共享的 secrets 目录里，因此另一个 profile 的 Host 看不到任何解锁，重启会结束它们。
- **检查。** 设备绑定的条件在每个提权操作之前读取解锁，调用与事件、快照或列表筛选一视同仁，并且即使计时器尚未触发，也会拒绝已过期的解锁。解锁准入的每次调用都会连同设备、监听器、操作和解锁 id 记入日志。Gateway 只在流打开时作出决定，因此解锁结束时 home 会关闭该设备的远程访问连接，studio 随后不带解锁地重新连接。
- **结束。** 解锁在到期时、本人在电脑上撤销时、设备锁定时、新的批准替换时、发起请求的会话结束时（其期限或轮换；滚动会延续它）、设备被移除时、监听器停止时以及 Host 停止时结束。每次开始和结束都会连同设备、监听器、解锁 id 和原因（`ELEVATION_END_REASONS`）记入日志。

<a id="face-id-unlock"></a>
### Face ID 解锁

已配对的设备可以用通行密钥（Face ID、Touch ID、Windows Hello 或设备锁）或用它的 PIN 确认一项敏感操作，一次一个操作，也可以用一次 Face ID 开启一个通行期。它是解锁因子，不是身份因子：设备密钥与远程访问会话仍是登录方式，上文的登录因子不变。


**一张表。** `auth-classes.ts` 中的 `AUTH_CLASSES` 把每个 Remote 方法、插件 Fetch 路由、提示答复和 `/auth` 路由恰好放入四个类别之一：`free`（任何已批准的设备，无提示）、`face`（在操作发生的那一刻确认一次，或有效的 Face ID 通行期，除非该行标记为 `alwaysAsk`）、`computer`（只有电脑前的本人）或 `ticket`（只有凭电脑批准所签发的一次性注册票据才能使用的设备路由，例如 `register/options`、`register` 和 `add/request`）。手机在以前的 Careful 级别下只能在电脑上做的每项操作，现在都是 `face` 或 `computer`，因此只有 PIN 的设备做不了它此前做不了的任何事。规格 `tests/auth-classes.spec.ts` 对未列出的操作或路由、重复的行以及同时位于两个类别的行判定失败。

**注册。** 通行密钥以 `residentKey: required`、`userVerification: required`、`attestation: none`、平台认证器和以地址主机名作为依赖方 ID 创建。本人在电脑上批准配对时，home 签发一个绑定到该设备、监听器和会话的一次性注册票据；尚无通行密钥的已配对设备用 `POST /auth/passkey/add/request` 发起请求，显示 home 以标签 `delorun-passkey-v1` 派生的 8 位数字代码（每个输入带长度前缀），本人在电脑上输入它。没有有效票据时，`POST /auth/passkey/register/options` 与 `/register` 被拒绝。允许同步的通行密钥：绑定的是设备的会话，而不是认证器，因此断言只有在拥有该凭据的设备的有效会话上、在其监听器上才算数。

**逐操作断言。** `POST /auth/passkey/options` 接收要确认的操作（每个带名称和哈希）或一个提示答复，并返回一个 32 字节的挑战，home 将它与设备、会话、监听器和所问内容一起保留 60 秒；`allowCredentials` 只列出该设备的凭据。`POST /auth/passkey/verify` 应用上文的断言检查（用户在场与验证、来源、依赖方哈希、签名、计数器），并检查该凭据属于该会话的设备。通过的断言会签发一个授权凭证；当该设置大于 0 且该操作不是始终询问的操作时，还会开启一个 Face ID 通行期并答复 `pass: { startedAt, endsAt }`；失败的断言按 PIN 的计数器算一次错误尝试（第五次移除该设备，全 home 十次则暂停两种因子），而已过期、已使用或未知的挑战被拒绝且不计数，本人取消的确认面板同样不计数。`POST /auth/passkey/pin` 用正确的 PIN 签发同样的授权凭证，无论设备有没有通行密钥，但它从不签发 `auth/devices/remove` 或另一台设备的 `auth/passkey/remove`：移除另一台设备或另一台设备的通行密钥，需要来自本身持有通行密钥的设备的授权凭证。正确的 PIN 从不开启通行期。

**授权凭证。** home 把授权凭证保存在内存中，键由设备、监听器、操作和 home 收到的调用的 SHA-256 组成：Remote 调用为其参数的 JCS（RFC 8785）文本；Fetch 路由为其方法、路径和正文，由 home 读取，最多 1 MiB。授权凭证存活 30 秒，只在整个决策放行之后使用一次；没有参数的询问从不使用授权凭证。Fetch 调用在 `Delorun-Grant` 头中写明它的授权凭证，路由运行之前 home 会移除该头；它检查的哈希从不由客户端给出。提示答复的键由设备、监听器、智能体、调用 id、提示的授权标记（`full-access`、`workspace-management`、`external-agent` 或 `real-browser`）和答复值组成，因此针对“Allow once”的授权凭证从不准入持久允许，而引发两个提示的一次调用需要两个授权凭证；没有调用 id 的提示不能由持有授权凭证的设备答复。

**保持窗口。** 创建或附加到终端，或打开文件夹选择器的授权凭证，还会打开一个绑定到该终端或选择器的 id、以及其监听器上该设备的保持窗口，空闲上限 5 分钟，绝对上限 60 分钟；保持窗口准入该 id 的后续调用，从不准入另一个终端的输出或事件。设备的每个页面和标签页共享该保持窗口，因此重新加载或显示同一终端的第二个标签页，在保持窗口持续期间不会再询问。另一个 id 需要新的授权凭证（或有效的通行期）。

**每台设备**都由授权凭证准入 `face` 操作，以及标记为 `full-access`、`workspace-management`、`external-agent` 或 `real-browser` 的提示的授予型答复；持有通行密钥的设备也可以由它的 Face ID 通行期准入。PIN 页面解锁、在电脑上输入的代码、批准后的宽限期和危险模式在该类别中不准入任何东西，`POST /auth/pin/unlock` 对每台设备都以 `ELEVATION_REQUIRED` 拒绝。没有通行密钥的设备用它的 PIN 签发一次一个操作的授权凭证，每个操作一个，因此它能触及的恰好与有通行密钥的设备相同；只有持有通行密钥的设备能避免每个操作一次确认。

**通行期。** 当通行期设置大于 0 时，已配对设备上的一次 Face ID（带用户验证的通行密钥断言）为该设备开启一个通行期。通行期有效期间，该设备的 `face` 操作（安装、终端、设置写入、模型密钥、Changes 与更新、授予完全访问以外内容的批准答复，等等）无需逐次授权凭证即被准入，因此不出现 Face ID 确认面板。通行期绑定到设备和监听器（`GrantStore.openPass` 只以这两项为键；设备不持有页面解锁，携带页面解锁的调用不匹配任何通行期），从 Face ID 的那一刻起固定，不随使用而顺延，并且只存在于内存中。

**设置。** Settings → Face ID → “Ask again after”：Every time、5、15、30 或 60 分钟。“Every time”（0）表示每个操作一次 Face ID。本人的选择存放在 home-auth secrets 目录的 `face-id-pass.json` 中。在本人选择之前，适用部署默认值：home-auth 插件配置的 `faceIdPassMinutes` 字段，取 0、5、15、30 或 60 之一，默认 15；集合之外的值使加载失败。更改会结束所有有效的通行期，因此更短的时长或 Every time 立即生效。

**始终询问。** `AUTH_CLASSES` 的每个 `face` 行都在 `src/pass-policy.ts` 中声明通行期对它的作用，`admits` 或 `alwaysAsk`，对两者都未声明的 `face` 行，表检查失败。标记为 `alwaysAsk` 的行从不被通行期准入，即使在通行期内也需要针对该次调用的一次一个操作的授权凭证：移除另一台设备（`auth:/auth/devices/remove`，只限 Face ID，从不用 PIN）、移除通行密钥（`auth:/auth/passkey/remove`）、在 Face ID 设置中列出每台设备的通行密钥（`auth:/auth/passkey/devices`）、从设备更改通行期设置（`auth:/auth/passkey/pass (write)`，需要由通行密钥签发的授权凭证，从不用 PIN）、关闭 Changes 保护（`changes:protection-off`）、某个工作区的完全访问（`plugin-permission-defaults` 的 `setFullAccess`），以及授予完全访问的批准答复（`answer:full-access`，操作 `answer/full-access`）。对这样的答复做一次 Face ID 仍会开启通行期，因为只有始终询问的操作条目才会阻止它。确认始终询问操作的 Face ID 不会开启通行期。Reach 设置与 PIN 模式设置仍只限电脑，每个 `computer` 行也仍只限电脑。

**什么从不开启通行期。** PIN（`POST /auth/passkey/pin`），无论是在没有通行密钥的手机上，还是作为有通行密钥的手机的后备；来自电脑的代码；配对后的批准宽限期；危险模式。

**什么会结束它。** 它的结束时间；该设备在该监听器上 5 分钟没有任何请求（一次被准入的 HTTP 请求或一次 Remote 调用算一次请求；空闲结束从不延长通行期）；Lock now（`POST /auth/passkey/lock`），它结束该设备在每个标签页上的通行期，因此一个标签页隐藏那么久，其他标签页也会被锁定；studio 页面隐藏 5 分钟，客户端用定时器检查，并在页面返回时再次检查，因为手机会挂起隐藏的页面及其定时器，随后它先调用 Lock now，再做其他事；通行期设置的更改，无论来自设备还是在电脑上，都会结束所有有效的通行期；Peer 的 dispose；设备会话的结束或其退出登录；设备被移除；所有会话的轮换；重启。

**终端。** 终端的保持窗口不变：在通行期内，`terminal/create` 不经确认面板即被准入，并打开该终端的保持窗口，因此通行期结束后，终端仍在保持窗口的限制（5 分钟未使用，总共 60 分钟）之内保持打开。

**路由。** `GET /auth/passkey/pass` 答复 `{ minutes, choices: [0, 5, 15, 30, 60], pass: { startedAt, endsAt, remainingMs } | null }`，在电脑上 `pass` 为 null；studio 按 `remainingMs`（home 的时钟）倒计时，因此手机时钟的偏差不会移动结束时间。带 `{ minutes }` 的 `POST /auth/passkey/pass` 更改设置：在电脑上与那里的任何设置一样；从设备上只能凭针对操作 `auth/passkey/pass` 的、由通行密钥签发的授权凭证，其哈希是该请求体 JCS 文本的 SHA-256；集合之外的值为 `400 BAD_REQUEST`。有通行期有效时，`POST /auth/passkey/verify` 也答复 `pass: { startedAt, endsAt, remainingMs }`。studio 在通行期内发出的 Changes、更新或席位调用，如果被 home 拒绝（通行期在此期间已结束），会带着确认面板再次询问，并且 studio 在跳过确认面板之前，会再从 home 读取一次通行期。带 `{}` 的 `POST /auth/passkey/lock` 答复 `{ ended }`；它是 `free` 路由。

**在 studio 中。** 在有通行期有效的设备页面上，带 Lock now 按钮的标签“Unlocked · N min”显示在打开的 chat 上方（`conversation.session.banner` slot），按整分钟倒计时，到期时消失。电脑上从不显示它。

**`unlockModeEnabled`。** 当设置了 PIN 或注册了任何通行密钥时，被锁定的设备在解锁起作用之处被拒绝；这一个读数取代了密钥操作、密钥设备门禁和页面解锁令牌检查中以前仅看 PIN 的检查，因此有通行密钥而无 PIN 的 home，会拒绝没有授权凭证的密钥更改。

**管理。** 设备在 `GET /auth/passkey/devices` 列出每台设备的通行密钥，在 `POST /auth/passkey/remove` 移除其中一个，二者都是标记为 `alwaysAsk` 的 `face` 操作，因此通行期从不准入它们；在 `POST /auth/devices/remove` 移除另一台设备也是如此。移除一台设备会在同一次调用中移除它的通行密钥、授权凭证和保持窗口。在另一个地址注册的通行密钥不能在这个地址上断言，设备需要重新设置 Face ID。

**日志。** `passkey.enrolled`、`passkey.removed` 和 `passkey.backup-state-changed` 写明设备，从不写挑战、密钥或签名。home 记录 `home-auth: pass.started device=… listener=… minutes=…` 和 `home-auth: pass.ended device=… listener=… reason=<expired|lock-now|peer-ended|session-ended|device-removed|sessions-rotated>`；过期的通行期在 home 下一次查看它时记录。通行期准入的授予型答复记录 `home-auth: pass.used device=… listener=… answer=… grants=…`。通行期不是模型可见的，因此没有会话事件。

<a id="pin-mode"></a>
### PIN 模式

PIN 模式让持有已批准设备的本人用 PIN 或口令一次确认一个操作：在 `POST /auth/passkey/pin` 提交正确的 PIN，就像 Face ID 一样签发一次一个操作的授权凭证，PIN 是持有通行密钥的设备的后备因子。没有设备持有页面解锁：`POST /auth/pin/unlock` 对每台设备都以 `ELEVATION_REQUIRED` 拒绝，且不读取请求的任何内容，因此 PIN 不开启任何窗口或通行期，登录的其他方面也不变：设备密钥与远程访问会话保持原样。该模式的第 1 版只为 Tailscale 私有地址构建；通行密钥解锁、Funnel 与中继地址，以及从设备设置 PIN、开启该模式和配对设备，都没有构建，并且各自仍只限电脑。

- **状态。** `~/.delorun/secrets/home-auth/pin-mode.json` 保存 `enabled`、密钥的 `kind`、带参数的加盐 `scrypt` 哈希、空闲分钟数以及隐藏时锁定的选择。`pin-attempts.json` 保存每台设备以及全 home 的错误尝试，重启会保留它们。`reach-pin-settings.json`（0600）保存较早版本的页面解锁放宽过的设置，以及每个字段原先的值，就像 `reach-dangerous-settings.json` 对危险模式所做的那样；现在没有页面会写入记录，关闭该模式会把每个字段设回原值，除非本人此后更改过。设置行尚未描述的记录会保留；设回在启动时以及设置服务挂载时运行。写入失败时，每个字段记录一条警告（命名空间和字段，从不含值），并按 `pinSetBackRetrySeconds`（1 至 3600，默认 30）的定时器重试，该定时器只在模式关闭后仍有放宽在等待时运行；读取该模式不会启动通行期。`GET /auth/pin/mode` 把仍在等待的字段列为 `setBackWaiting`，`delorun devices pin status` 会写明它们。页面的设置写入在危险模式不会放宽之处被拒绝，无论该页面持有什么。设置文档和 `account/*` 对每个页面仍被拒绝。没有该文件、或 `enabled: false` 的 home，就是本页其他各处所描述的 home：PIN 授权凭证答复 `PIN_MODE_OFF`，PIN 不产生任何授权凭证。
- **密钥。** PIN 是 6 至 128 位数字，且不是重复（`111111`、`123123`）、连续（`345678`）或常见的 PIN。任何其他密钥都是 10 至 128 个字符的口令，且不是同一个字符的重复。两者都规范化为 NFC。home 以恒定时间比较，从不把密钥以明文写入日志、错误或文件。限制是 `@delorun/contract-oidc-passkeys` 的 `PIN_MODE_LIMITS`。
- **设置它。** 只有电脑前的本人设置、替换或清除 PIN，并开启或关闭该模式：`POST /auth/pin/set`、`/auth/pin/options`、`/auth/pin/off` 和 `/auth/pin/resume` 响应带着 studio 凭据到达回环监听器的请求，并以 `LOOPBACK_REQUIRED` 拒绝设备；[C19](c19-home-process.zh.md) 的 `pin.set`、`pin.options`、`pin.off` 和 `pin.resume` 请求对 `delorun` 同样如此。`pin-mode-change` 在 `LOOPBACK_REQUIRED_ACTIONS` 中。`POST /auth/pin/options` 接收 `idleMinutes`（1 至 60 的整数）和 `lockWhenHidden`，只更改该模式已有记录上的这两项，不需要 PIN 或口令：对这项设置，电脑已被信任。它不动哈希和 kind，在模式关闭时以 `PIN_MODE_OFF` 拒绝，对空更改、其他字段或超出范围的值以 `BAD_REQUEST` 拒绝，并用与其他每项更改相同的受保护写入写入。
- **不解锁。** `POST /auth/pin/unlock` 在设备路由检查（有效会话、studio 来源）之后、读取请求体之前，对设备答复 `403 ELEVATION_REQUIRED`：它不签发令牌、解锁或提权，也不计入任何尝试。`GET /auth/pin/state` 报告该模式（字段包括 `lockWhenHidden`），从不报告解锁。`Delorun-Unlock` 头或 `delorun-unlock.<token>` 子协议不指向任何运行中的解锁，因此什么也不准入；`POST /auth/pin/touch` 和 `POST /auth/pin/lock` 答复 `401 UNLOCK_INVALID`。
- **错误尝试。** 尝试在比较密钥之前被计数并写入，每台设备一次一个。设备的第五次错误尝试会像在电脑上移除一样移除该设备，因此它的会话和连接关闭，需要在电脑上重新批准。24 小时内全 home 十次错误尝试会暂停 PIN 和 Face ID，答复 `PIN_UNLOCKS_PAUSED`，直到本人在电脑上恢复它们。正确的密钥会清除该设备的计数。
- **日志。** 每次错误尝试、锁定、暂停、恢复、PIN 更改和模式更改都是一行日志，写明设备，从不写密钥。

错误代码 `PIN_INVALID`、`PIN_WEAK`、`PIN_MODE_OFF`、`PIN_NOT_ALLOWED_ON_ADDRESS`、`PIN_UNLOCKS_PAUSED` 和 `UNLOCK_INVALID` 并入[下文的错误](#errors)。`PIN_INVALID` 的回答携带结构化字段 `triesLeft`（数字）和 `removed`（布尔值，第五次失误时为真，此时已移除该设备），`PIN_UNLOCKS_PAUSED` 的回答在 `error` 和 `message` 之外还携带 `paused: true`，因此客户端从不解析句子。对于处于开启状态的页面，`GET /auth/pin/state` 携带 `lockWhenHidden`。

<a id="limits"></a>
### 上限

| 上限 | 取值 |
| --- | --- |
| 流程的 `state`、`nonce` 与 `code_verifier` | 各 32 个随机字节 |
| 流程生存期 | 10 分钟，只能使用一次 |
| 每个 home 的待处理流程 | 20 |
| 登录票据 | 32 字节，60 秒，只能使用一次 |
| 通行密钥质询 | 32 字节，5 分钟，只能使用一次 |
| 通行密钥注册超时 | 300,000 毫秒 |
| 注册会话 | 10 分钟 |
| ID 令牌时钟偏差 | 60 秒 |
| ID 令牌 `iat` 距今时长 | 10 分钟 |
| 重新认证 `auth_time` 距今时长 | 120 秒 |
| 密钥集与元数据 | 65,536 字节，10 秒超时，每 24 小时刷新 |
| 未知 `kid` 刷新 | 最多每 5 分钟一次 |

<a id="errors"></a>
### 错误

| 代码 | 触发条件 |
| --- | --- |
| `OIDC_DISCOVERY_FAILED` | 元数据无法读取、超出其上限，或指明另一个签发方。 |
| `OIDC_PKCE_UNSUPPORTED` | 元数据未列出 `S256`。 |
| `OIDC_ALGORITHM_UNSUPPORTED` | 未列出任何允许的签名算法，或令牌使用了其他算法。 |
| `OIDC_STATE_INVALID` | 未知、已使用或已过期的 `state`，或缺失或不一致的 `__Host-delorun-oidc` cookie。 |
| `OIDC_ISSUER_MISMATCH` | 不是该流程签发方的 `iss` 响应参数或令牌 `iss`，或缺少必需的 `iss` 参数。 |
| `OIDC_AUDIENCE_MISMATCH` | `aud` 不含客户端 ID，或具有多个受众而 `azp` 不等于客户端 ID。 |
| `OIDC_NONCE_MISMATCH` | `nonce` 不是该流程的 nonce。 |
| `OIDC_TOKEN_EXPIRED` | `exp` 已过，或 `iat` 过旧。 |
| `OIDC_UNKNOWN_KEY` | 缺少 `kid`，或 `kid` 在刷新后仍未知。 |
| `OIDC_SIGNATURE_INVALID` | 签名无法验证。 |
| `OIDC_SUBJECT_MISMATCH` | `iss` 与 `sub` 不是所有者已固定的身份。 |
| `OIDC_REAUTH_TOO_OLD` | `reauth` 上的 `auth_time` 缺失或距今超过 120 秒。 |
| `OIDC_PROVIDER_ERROR` | 提供方返回了错误。 |
| `PASSKEY_UNAVAILABLE` | 在不提供通行密钥的地址上使用通行密钥。 |
| `PASSKEY_ASSERTION_INVALID` | 未通过某项检查的断言，包括另一个地址的依赖方 ID 或来源。 |
| `PASSKEY_USER_VERIFICATION_REQUIRED` | 用户已验证标志未设置。 |
| `PASSKEY_COUNTER_REGRESSED` | 计数器没有增大。 |
| `TAILNET_IDENTITY_UNAVAILABLE` | 在 C7 的套接字变体之外使用 `tailnet` 因子，或为 Tailscale 私有地址之外的监听器或地址声明 `tailnet-membership`。 |
| `PIN_INVALID` | 不正确的 PIN 或口令；一台设备的第五次也会移除该设备。响应体还携带 `triesLeft`（数字）和 `removed`（布尔值，第五次为真），因此页面从不解析句子。 |
| `PIN_WEAK` | 违反 [PIN 模式](#pin-mode)规则的新 PIN 或口令。 |
| `PIN_MODE_OFF` | 模式关闭时的 PIN 授权凭证。 |
| `PIN_NOT_ALLOWED_ON_ADDRESS` | Tailscale 私有监听器之外的远程访问监听器上的 PIN 授权凭证。 |
| `PIN_UNLOCKS_PAUSED` | 24 小时内全 home 十次错误尝试之后的 PIN 或 Face ID 尝试，直到本人在电脑上恢复它们。响应体还携带 `paused: true`。 |
| `UNLOCK_INVALID` | 页面解锁令牌；没有设备持有运行中的页面解锁，因此每个令牌都是未知的。 |
| `LOOPBACK_REQUIRED` | 因子为 `tailnet-membership` 的会话答复提示或发送请求，而该操作只在 home 自己的电脑上授予（[tailnet 成员身份](#tailnet-membership)）。 |

<a id="delorun-issuer"></a>
### Delorun 签发方

Delorun 签发方让本人可以用 Delorun 账户登录，它不属于 Delorun，Delorun 不配置任何 Delorun 签发方（[路线图](../guide/roadmap.zh.md)）。这样的签发方作为第二个签发方遵循本页的每条规则，并且还遵循以下规则：

- 其重定向 URI 为 `https://<address>/auth/oidc/callback/delorun`，因此它永远不与本人的提供方共用重定向 URI。
- 它只用非对称密钥签署 ID 令牌，每个令牌头部都携带 `kid`，并且它发布一个密钥集。
- 它在用新签名密钥签名之前至少 24 小时，就在密钥集中发布该密钥；并在已退役密钥最后一次使用之后，至少在密钥集中保留它 24 小时。
- 其签名私钥是 Cloudflare Worker 机密，永远不放在代码仓库、配置文件或日志中。
- 其受众是托管服务为每个 home 分配的客户端 ID。

<a id="consumers"></a>
## 消费方

- `delorun/packages/home-auth/src/identity/`：通行密钥依赖方、OpenID Connect 依赖方、注册与 `tailnet` 因子。
- `delorun/packages/home-auth/`：会话创建中的登录票据、批准的重新认证与所有者记录。
- `delorun/apps/cli/` 中的 setup：客户端注册、动态注册与重定向 URI 列表。
- `delorun/packages/plugin-reach-ui/`：注册屏幕，以及说明某地址不提供通行密钥的提示。
- `delorun/packages/contract-oidc-passkeys/`：规则、声明、代码与上限。
- [C4](c04-admission.zh.md) 提供路由与会话，[C5](c05-device-approval.zh.md) 提供因子证明，[C7](c07-reach-providers.zh.md) 提供地址。

<a id="compatibility"></a>
## 兼容性

关于 `ts.net` 上通行密钥依赖方 ID 的 spike 结果未记录在本页，因此 `ts.net` 地址上不提供通行密钥，OpenID Connect 登录是这些地址的身份因子。通过的 spike 结果会使 `ts.net` 地址提供通行密钥，依赖方 ID 采用[已采纳的规则](#relying-party-ids)，方式是对本节作出一次记录该报告证据的变更：

1. `ts.net` 是否在公共后缀列表（Public Suffix List）中，并附该列表的版本。
2. Tailscale 私有网络地址上的页面与 Funnel 地址上的页面可以使用的依赖方 ID。
3. 对于 Chromium、Firefox 与 Safari 的当前版本，各附其版本与操作系统：通行密钥能否在其中注册与断言，分别使用平台认证器与安全密钥。
4. 在私有网络地址来源上注册的通行密钥，能否在同一台机器的 Funnel 地址来源上断言，因此 home 按地址的绑定是区分二者的控制措施。

只要通行密钥在上述任一浏览器中失败，当前约定就保持不变。添加一种重定向 URI 形式、一种算法或一项声明要求，属于对本约定的变更；移除已注册通行密钥所使用的算法，对受影响的通行密钥属于登录因子变更。

<a id="security"></a>
## 安全

要求：

- 每个通行密钥与重定向 URI 都绑定到一个 studio 地址：依赖方 ID 是该地址的主机名，永远不是父域，且断言携带该地址的来源。
- 通行密钥要求用户验证，且其计数器永不减小。
- 受众是 home 自己的客户端 ID；具有多个受众的令牌需要 `azp` 等于该客户端 ID。
- 所有者的签发方与主体在首次注册时固定，之后的每次登录、恢复与重新认证都必须与之匹配。
- 每个流程都携带一个绑定到浏览器、只能使用一次的 `state`，一个 `nonce`，以及一个 S256 PKCE verifier。
- 流程的令牌端点、密钥集与签发方只来自该流程的签发方；来自另一签发方的 `iss` 参数或令牌 `iss` 会被拒绝。
- ID 令牌以非对称算法签名，并使用签发方密钥集中的某个 `kid`；home 按固定间隔以及在遇到未知密钥时刷新该密钥集。
- 只有当提供方公布支持动态注册且本人选择使用时，才使用动态注册。
- 客户端密钥保存在密钥文件中，永远不放在配置行中。
- `tailnet-membership` 只为 Tailscale 私有地址声明，携带该因子的会话在授予之处被拒绝每一项属于 home 自己电脑的操作。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `a token from issuer B in a flow started with issuer A is refused` | 针对两个签发方替身，在以签发方 A 开始的流程中，携带签发方 B 的授权码、`iss` 参数或 ID 令牌的回调以 `OIDC_ISSUER_MISMATCH` 被拒绝，且不签发任何票据。 |
| `a wrong-audience token is refused` | 一个签名正确、但其 `aud` 缺少客户端 ID，或具有多个受众而 `azp` 不等于客户端 ID 的令牌，以 `OIDC_AUDIENCE_MISMATCH` 被拒绝。 |
| `a forged token is refused` | `alg` 为 `none` 的令牌、以签发方公钥作为密钥的 `HS256` 令牌，或由未知密钥签名的令牌，都被拒绝。 |
| `a token without a known kid is refused` | 没有 `kid`，或其 `kid` 在刷新后仍找不到的令牌，以 `OIDC_UNKNOWN_KEY` 被拒绝。 |
| `a replayed state or foreign browser is refused` | 重复使用已消耗 `state` 的回调，或到达时没有该流程 `__Host-delorun-oidc` cookie 的回调，以 `OIDC_STATE_INVALID` 被拒绝。 |
| `a wrong nonce or verifier fails` | `nonce` 不同的令牌被拒绝，且使用另一个 `code_verifier` 的令牌请求从替身处得不到令牌。 |
| `another subject is refused` | 针对已固定 `sub` 之外的 `sub` 的有效令牌，不创建登录票据。 |
| `a passkey assertion for another address's relying-party ID is refused` | 为一个地址的依赖方 ID 生成、却在另一个地址上出示的断言，以 `PASSKEY_ASSERTION_INVALID` 被拒绝。 |
| `a passkey without user verification is refused` | 没有用户已验证标志的断言被拒绝。 |
| `a regressed counter is refused` | 计数器不大于非零已存储计数器的断言被拒绝。 |
| `a passkey on a ts.net address is refused under the current contract` | `ts.net` 地址上的通行密钥注册选项与断言选项返回 `PASSKEY_UNAVAILABLE`。 |
| `tailnet-membership is refused on a Funnel or own-domain address` | 为 Funnel 监听器或自有域名地址声明 `tailnet-membership` 的提供方以 `TAILNET_IDENTITY_UNAVAILABLE` 被拒绝。 |
| `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent` | 来自 `tailnet-membership` 会话、对授予完全访问的提示给出的 `allowed-once` 答复以 `LOOPBACK_REQUIRED` 被拒绝；被升级的调用不运行，工作区不记录任何同意，而在回环 studio 上答复同一提示则会授予。 |
| `a tailnet-route session cannot start an external agent` | 来自 `tailnet-membership` 会话、对标记为 `external-agent` 的提示给出的 `allowed-once` 答复以 `LOOPBACK_REQUIRED` 被拒绝，因此该智能体不会启动；从该会话拒绝它会生效，而在回环 studio 上答复同一提示则会被应用。 |
| `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach` | 来自 `tailnet-membership` 会话的每一个此类请求都被拒绝，且 home 的设备与 reach 状态保持不变。 |
| `five wrong PINs remove the device and close its sessions` | 一台设备的第五个错误 PIN 会像在电脑上移除那样移除它，关闭其会话，重启会保留计数；二十个并行的猜测最多消耗五次。 |
| `ten wrong PINs across the home pause the PIN` | 24 小时内多台设备的十次错误尝试，会使正确的 PIN 得到 `PIN_UNLOCKS_PAUSED`，直到电脑恢复它。 |
| `the PIN routes refuse a Funnel listener, the loopback listener and a device that sets the PIN` | `PIN_NOT_ALLOWED_ON_ADDRESS`、对非设备路由的拒绝，以及 `LOOPBACK_REQUIRED`。 |
| `the PIN unlock is refused to every device` | 无论 PIN 正确、错误还是没有请求体，`POST /auth/pin/unlock` 都答复 `ELEVATION_REQUIRED`，不签发令牌或提权，也不计入任何尝试；伪造的 `Delorun-Unlock` 令牌什么也不准入。 |
| `a page that holds an old unlock gets no face action, answer or lift` | 没有通行密钥的设备上、持有运行中的页面解锁的页面，在没有授权凭证时，被拒绝每个 `face` 操作、每个保留的授予型答复和每次危险模式放宽；它的 PIN 授权凭证只准入一个操作一次。 |
| `with PIN mode off nothing changes` | PIN 授权凭证答复 `PIN_MODE_OFF`，不存在提权，被提权的操作像以前一样被拒绝。 |
| `the PIN is in no log, error or file in the clear` | PIN 文本不出现在日志行、响应体和文件中。 |
| `a stale re-authentication is refused` | `auth_time` 距今超过 120 秒，或 `nonce` 不是批准哈希的 `reauth` 令牌，不会批准。 |
| `a device chooses the preset a chat that has not started runs with` | 来自 `reach-device` Peer 的 `agentPresets/select` 返回所选的预设，且该 chat 记录 `agent-preset/selected`；写明完全访问的预设仍然会遇到工作区同意的拒绝，该同意只能在电脑上授予。 |
| `a device reads the files of its chat's workspace and no path outside it` | `workspaceFiles/list`、`read`、`readBytes` 和 `stat` 对真实路径位于 Session 工作区内的路径成功，对工作区外的路径、经由指向工作区外的符号链接的路径、进入 Delorun 主目录的路径以及不存在的路径，以 `loopback-required: <action> with a path outside the chat's workspace` 被拒绝；`workspaceFiles/changes` 仍被拒绝。 |
| `a device reads the installed plugins and cannot change them` | `pluginManager/listPlugins`、`listBundles`、`registries`、`history` 和 `pluginInventory/list` 成功，而 `installBundle`、`setPluginEnabled`、`setBundleEnabled`、`removeBundle` 和 `undo` 以 `loopback-required: <action>` 拒绝。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **`attestation: "none"` 下的用户验证。** home 读取认证器设置的用户已验证标志，但不验证认证器本身，因此该标志的可信程度只取决于作出断言的认证器。
- **本人的提供方。** OpenID Connect 提供方可以为被固定的主体签发有效令牌，控制本人在该处账户的攻击者也可以用它登录；此时仍然起作用的控制是设备批准。
- **共享的依赖方 ID。** 在 spike 结果使 `ts.net` 上可以使用通行密钥的情况下，同一台机器的私有地址与 Funnel 地址共享一个依赖方 ID；把它们的通行密钥区分开的是 home 中按地址的绑定，而不是浏览器。

- **已批准且已解锁的手机。** 在 Tailscale 私有地址上，已批准的设备只凭它的密钥登录。持有该设备且已解锁的人，拥有那些 chat，并可以在已授予的范围内驱动智能体：在电脑上被设为完全访问的工作区，仍然可以从它驱动，那里的命令可以做本人的用户能做的任何事，包括写入设备记录。这样的设备还拥有终端和 Changes 控件，每次使用都带有针对那一次调用的确认（Face ID 授权凭证，或作为一次一个操作授权凭证的 PIN），或在该设备开启的 Face ID 通行期之内。保护措施是手机自己的锁、在电脑上移除该设备，以及远程会话 12 小时的空闲限制。

<a id="decided-values"></a>
## 决定的取值

- 本人在 setup 期间在自己的 OpenID Connect 提供方处将 Delorun 注册为客户端，输入客户端 ID 与密钥，重定向 URI 为用于 `ts.net` 地址与自有域名地址的 `https://<address>/auth/oidc/callback`；只有当提供方公布支持动态注册且本人选择使用时，才使用动态注册。
- 通行密钥依赖方 ID：自有域名上为该地址的主机名；在 `ts.net` 上不提供，直到某个 spike 结果采纳主机名。
- 允许的 ID 令牌算法：`RS256`、`PS256`、`ES256` 与 `EdDSA`；通行密钥算法为 EdDSA、ES256 与 RS256。
- 流程：32 字节的 `state`、`nonce` 与 verifier，10 分钟生存期，每个 home 20 个待处理流程；票据 60 秒。Face ID 通行期取 0、5、15、30 或 60 分钟，默认 15，在本人选择之前由 `faceIdPassMinutes` 设置，页面隐藏 5 分钟后结束。
- 密钥集每 24 小时刷新一次，遇到未知 `kid` 时也刷新，但最多每 5 分钟一次。
