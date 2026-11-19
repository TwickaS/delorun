---
description: "约定 C14：远程访问地址可使用的身份因子；每个地址的通行密钥依赖方 ID，以及 ts.net 规则的两种情形；本人自己的 OpenID Connect 提供方，包括客户端注册与每个地址的重定向 URI；必需声明；每个 home 的受众；在首次注册时固定的所有者身份；nonce、PKCE、签发方检查与混淆防护；签名密钥 ID 与轮换；以及作为后续功能的 Delo Run 签发方。"
---

# 约定 C14：OpenID Connect 与通行密钥

[English](c14-oidc-passkeys.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

<a id="summary"></a>
## 摘要

远程访问（reach）在设备批准（device approval）之外还要求一个身份因子（identity factor）：通行密钥，或在本人（the person）自己的 OpenID Connect 提供方处登录。home 是两者的依赖方（relying party）。本页定义每个远程访问地址可使用哪些因子、每个地址的通行密钥依赖方 ID、home 如何在本人的提供方处注册为客户端、带有 nonce、PKCE 与签发方（issuer）检查的授权流程、home 要求的声明与受众、它固定的所有者身份、它如何获取并轮换签名密钥，以及约束 Delo Run 签发方的规则，该签发方是一项后续功能（fast-follow）。因子从不替代设备批准（[C5](c05-device-approval.zh.md)）。类型包 [`@delorun/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.zh.md) 承载这些规则、声明、代码与上限。

<a id="status"></a>
## 状态

本页的通行密钥与 OpenID Connect 因子尚未构建：home 没有通行密钥依赖方，也没有 OpenID Connect 客户端。Tailscale 私有路由的 `tailnet-membership` 因子已构建。

- **已构建并已接入：** 设置的答案模式指明 `reach.identityFactor`，并在 `--config` 文档中拒绝 `null` 以外的任何值（[C11](c11-setup-answers.zh.md)）。
- **未构建：** 带用户验证与计数器的通行密钥注册与断言；在本人提供方处的客户端注册；带 `state`、`nonce`、PKCE 与签发方检查的授权流程；ID 令牌检查与签名密钥轮换；固定的所有者主体；重新认证；Delo Run 签发方。

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
  - [手机权限](#phone-powers)
  - [PIN 模式](#pin-mode)
  - [上限](#limits)
  - [错误](#errors)
  - [Delo Run 签发方](#delo-run-issuer)
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
- **解锁**：除非设备持有本人在电脑上批准的[解锁](#elevation)，否则以 `403` 和原因 `elevation-required: <action>` 拒绝。各项操作及其让本人能做什么见同一文件中的 `REACH_ELEVATED_ACTIONS`；只有列在其中的操作才可提权。位于已知工作区之外文件夹中的 `session/create` 由策略的条件提权，原因为 `CREATE_OUTSIDE_WORKSPACES`。
- **从不**：无论是否解锁，都以 `403 LOOPBACK_REQUIRED` 和原因 `loopback-required: <action>` 拒绝。各项操作及其原因见同一文件中的 `REACH_DENIED_ACTIONS`；没有任何配置能改变该表格。
- **只有电脑能给出的授权**：在授予之处而不是调用之处被拒绝（[tailnet 成员身份](#tailnet-membership)）。

在允许的操作之内，策略的条件对每次调用保持两条规则。工作区文件调用（`workspaceFiles/*`、`officeKit/render`）只有在它指名的每个路径（含字节读取的基准文件）的真实路径都位于该 chat 工作区的真实路径之内、且在 Delorun 主目录之外时才被准入；含 `..` 段或以 `~` 开头的路径，以及不存在的路径，无论是否解锁都会被拒绝。`session/create` 在其指名 Host 所列出的某个 Workspace，或其真实路径是某个已列出 Workspace 的路径的文件夹时被允许，可使用任何预设；指名其他文件夹，或既没有指名 Workspace 也没有指名文件夹（Host 自己的工作目录）的调用需要解锁。选择预设本身不授予任何访问：工作区的完全访问同意仍然是电脑上的答复，每个批准提示也仍然适用。

<a id="elevation"></a>
### 提权

提权（在 studio 的措辞中是解锁，即「sudo 模式」）让一台设备在几分钟内执行提权操作，由本人在 home 自己的电脑上批准。`@delorun/home-auth` 在 [`elevation.ts`](../../packages/home-auth/src/elevation.ts) 中把它保存在内存里，限制为 `@delorun/contract-oidc-passkeys` 的 `ELEVATION_LIMITS`。

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
| 终端 | `terminal/*` | 终端是电脑上沙箱之外的 shell。它总是需要[手机权限](#phone-powers)设为 Full 并且解锁：任何开关、完全访问授权或危险模式都不能免除其中任何一项，批准宽限期也不是解锁。 |
| 外部工具服务器 | `mcpManager/probe`、`restart`、`watch` | 它们启动并观察 home 为其外部工具服务器配置的命令。 |
| 文件夹 | `directoryPicker/*`、`workspace/create`、位于已知工作区之外文件夹中的 `session/create` | 文件夹决定 chat 的命令可以写入哪里。 |
| 动态插件代码 | `dynamicCordisRunner/*`、`event:cordis/*` | 它在 Host 中运行模型编写的插件代码。 |

**从不**

| 族 | 操作 | 原因 |
| --- | --- | --- |
| 账户 | `account/*`、`event:deepseek-account/*` | 账户登录在 Delorun 中是关闭的，账户更改属于电脑。 |
| 电脑自己的屏幕 | `settings/openSettingsDocument`、`session/openWorkspacePath`、`session/workspacePathApplications` | 它们会在电脑上打开应用，设备用不到。 |
| 授权与设备 | 完全访问升级、工作区的完全访问同意、`workspace-management` 提示、设备批准与移除、启动、批准或延长解锁 | 电脑上的路由和答复守卫会拒绝其中每一项（[tailnet 成员身份](#tailnet-membership)）；它们都不是可由表格列出的 Remote 方法。 |

- **路由。** 设备在 `GET /auth/elevation` 读取状态（`none` 与 `pending` 带有 `unlockMinutes`，即其监听器上一次解锁持续的分钟数，使工作室在解锁前就能说明时长），在 `POST /auth/elevation/request` 发起请求，在 `POST /auth/elevation/lock` 锁定，每个路由都要求请求到达的远程访问监听器上的有效会话，`POST` 只接受 studio 自己的源。电脑在 `GET /auth/elevation/pending` 列出，在 `POST /auth/elevation/approve` 批准，在 `POST /auth/elevation/revoke` 撤销；设备访问这些路由会以 `LOOPBACK_REQUIRED` 被拒绝。
- **被放宽的设置。** 危险模式成立期间，已解锁的设备可以放宽默认预设，并关闭 `DANGEROUS_LIFTABLE_SWITCHES` 所列的开关。策略在调用继续之前，把每次这样的写入连同字段的先前值和调用所设的值，记录在 `~/.delorun/secrets/home-auth/reach-dangerous-settings.json` 中。当该模式不再成立时（在第一次发现它已结束的读取时，以及在启动时），home 通过设置服务把先前值写回去，除非该字段已不再保存所记录的设备值，因为本人在电脑上更改了它。失败的写入保留其记录并被重试。
- **终端。** 每个 `terminal/*` 操作总是需要[手机权限](#phone-powers)设为 Full 并且解锁，对每个 Session 和全局资源都是如此：危险模式、工作区的完全访问授权，以及终端将打开的文件夹，都不起任何作用。早先版本在 `~/.delorun/secrets/home-auth/reach-terminal.json` 中保留一个终端开关；现在没有任何东西读取该文件，仍有该文件的 home 继续工作，该文件可以删除。已打开的终端会一直运行到结束。
- **请求。** 已登录的设备从自己的 studio 发起请求。home 把请求记在该设备、监听器和请求到达的会话名下，设备显示一个 8 位数字代码。请求等待 5 分钟，一个 home 最多保留 5 个，同一设备在同一监听器上的新请求会替换它正在等待的请求。设备持有解锁期间，其状态显示的是解锁而不是代码，因此设备无法延长自己的解锁。
- **批准。** 只有在 home 电脑前的本人能批准，方法是在 `delorun devices elevate` 中输入设备上的代码（它调用 [C19](c19-home-process.zh.md) 的 `devices.elevate`）、在 studio 的 Settings 的 Devices 中输入，或通过电脑路由；第三次输错会取消请求。批准和撤销是 `LOOPBACK_REQUIRED_ACTIONS` 中的 `elevation-approve` 和 `elevation-revoke`，设备会被拒绝。
- **时长。** 解锁持续远程访问行的 `elevationMinutes`，默认 15 分钟，最多 60 分钟；更大的值会在监听器开始服务时被拒绝。没有任何操作能延长解锁：新的批准会替换它。
- **范围。** 解锁绑定到它的设备、监听器和 profile。`reach-device` 主体指明设备及其 Peer 所在的监听器，策略只在该监听器上询问设备的解锁。一个 profile 的 Host 把自己的解锁保存在内存中，从不放在共享的 secrets 目录里，因此另一个 profile 的 Host 看不到任何解锁，重启会结束它们。
- **检查。** 设备绑定的条件在每个提权操作之前读取解锁，调用与事件、快照或列表筛选一视同仁，并且即使计时器尚未触发，也会拒绝已过期的解锁。解锁准入的每次调用都会连同设备、监听器、操作和解锁 id 记入日志。Gateway 只在流打开时作出决定，因此解锁结束时 home 会关闭该设备的远程访问连接，studio 随后不带解锁地重新连接。
- **结束。** 解锁在到期时、本人在电脑上撤销时、设备锁定时、新的批准替换时、发起请求的会话结束时（其期限或轮换；滚动会延续它）、设备被移除时、监听器停止时以及 Host 停止时结束。每次开始和结束都会连同设备、监听器、解锁 id 和原因（`ELEVATION_END_REASONS`）记入日志。

<a id="phone-powers"></a>
### 手机权限

手机权限（Phone powers）决定已解锁的手机可以做多少事。本人在电脑上从两个级别中选择一个；设备从不更改它。

- **Careful** 是默认级别。无论是否解锁、是否处于危险模式，设备都永远得不到 `terminal/*` 操作，[C21](c21-changes.zh.md#who-may-do-what-from-where) 为 Full 列出的 studio Changes 部分的控件也留在电脑上。
- **Full** 让已解锁的设备可以执行 Careful 留在电脑上的操作。每次使用都需要本人输入的[解锁](#elevation)，即来自电脑的验证码或 PIN。批准宽限期从不算数：它不是这些操作的解锁，处于宽限期的设备会被告知先解锁。「永远不」表中的操作在两个级别下都留在电脑上。
- **Careful 涵盖什么、不涵盖什么。** Careful 把终端、关闭 Changes 的保护、更改 Delorun 自己的文件以及其他只限 Full 的 Changes 操作留在电脑上。它不涵盖已解锁的手机在上述规则准许处给出的批准：接受 MCP 服务器、允许外部 agent 和给工作区完全访问在两个级别下都可以，而且每一项都仍可能在沙箱之外启动程序。
- **记录。** 级别保存在 `~/.delorun/secrets/home-auth/` 中的 `phone-powers.json`，模式 0600，内容为 `{"v":1,"level","setAt","chosen"}`：`level` 为 `careful` 或 `full`，`setAt` 是写入时间（毫秒），`chosen` 只在本人选择了该级别时为 true。存在但无法读取的记录（因为其模式比 0600 宽松，或者它不是这种记录）在文件被修复或重写之前应用 Careful。
- **读取。** Host 在每次访问检查时读取级别，并在文件的标识、大小或修改时间变化时再次读取，因此命令的写入无需重启即可生效。Careful 下的拒绝是 `loopback-required: <action> needs Phone powers set to Full at the computer`，在解锁检查之前决定，因此任何解锁、PIN 页面或模式都不能解除它。
- **首次启动。** Host 在没有记录的 home 中首次启动时，写入 `@delorun/home-auth` 的 `phonePowersOnUpgrade` 字段所指定的级别（默认 `careful`），带 `chosen: false`，并记录该 home 尚未作出选择。studio 会在电脑上提醒本人，直到他们作出选择。已有记录（无论能否读取）的 home 保留它，因此之后更改该字段不会改变任何已经启动过的 home。
- **选择。** `delorun setup` 在打开远程访问之后询问级别，预选之前的回答，否则预选 home 记录的级别（因此新的 profile 从其 home 的级别开始），否则预选 Careful，远程访问关闭时什么也不问；`delorun setup --yes --phone-powers <level>`，或 `--config` 文档中的 `phonePowers`，会在无人值守时记录它（[C11](c11-setup-answers.zh.md)），并且只在没有记录、或记录已经是 Full 的 home 中选择 Full，因为级别属于 home，而新的 profile 可能与手机已配对的 home 共用。`delorun devices powers [careful|full]` 在已完成 setup 的 home 上显示或设置级别；在那里设置 Full 需要终端，因此脚本无法扩大手机可以做的事，设置 Careful 则不需要。电脑上的 studio 用 `GET /auth/phone-powers` 读取它，用 `POST /auth/phone-powers {"level"}` 设置它。已登录的设备可以 `GET` 该级别，并以只读方式显示。设备的 `POST` 无论是否解锁都以 `403 LOOPBACK_REQUIRED` 拒绝。

这些表是 [`reach-access.ts`](../../packages/home-auth/src/reach-access.ts) 中的 `FULL_POWERS_ACTIONS` 和 `phonePowersRefusal`，记录是 [`phone-powers.ts`](../../packages/home-auth/src/phone-powers.ts)，路由是 [`phone-powers-routes.ts`](../../packages/home-auth/src/phone-powers-routes.ts)。

<a id="pin-mode"></a>
### PIN 模式

PIN 模式让持有已批准设备的人，用 PIN 或口令解锁它，而不必在电脑上输入代码。它增加了第二种[提权](#elevation)，即页面解锁，除此之外不改变登录的任何其他方面：设备密钥和远程访问会话保持原样。该模式的第 1 版只为 Tailscale 私有地址构建；通行密钥解锁、Funnel 与中继地址，以及从设备设置 PIN、开启该模式和配对设备都尚未构建，它们仍然留在电脑上。

- **状态。** `~/.delorun/secrets/home-auth/pin-mode.json` 保存 `enabled`、密钥的 `kind`、带盐的 `scrypt` 哈希及其参数、空闲分钟数和隐藏时锁定的选择。`pin-attempts.json` 保存每台设备和全 home 的错误尝试，重启会保留它们。`reach-pin-settings.json`（0600）记录已解锁页面放宽的设置，及每个字段的先前值，与 `reach-dangerous-settings.json` 对危险模式的做法相同；关闭该模式会把每一项设回去，除非本人此后已更改它。其设置行尚未被描述的记录会保留；设回操作在启动时以及设置服务挂载时运行。失败的写入为每个字段记录一条警告（命名空间和字段，从不记录值），并按 `pinSetBackRetrySeconds`（1 至 3600，默认 30）的计时器重试，该计时器只在该模式关闭之后有放宽在等待时运行；读取该模式不会开始任何一轮。`GET /auth/pin/mode` 把仍在等待的字段列为 `setBackWaiting`，`delorun devices pin status` 写明它们。用 `/auth/pin/options` 设置更短的空闲时间，也会结束在该时间内运行的解锁的空闲。已锁定页面的设置写入被拒绝，已解锁页面的设置写入在记录无法保存时被拒绝。设置文档和 `account/*` 对每个页面保持拒绝。没有该文件，或 `enabled: false` 的 home，与本页其他各处描述的 home 完全一样：下面每个路由都回答 `PIN_MODE_OFF`，PIN 不会引起任何提权。
- **密钥。** PIN 是 6 至 128 位数字，且不是重复（`111111`、`123123`）、连续（`345678`）或常见的 PIN。任何其他密钥都是 10 至 128 个字符的口令，且不是同一个字符的重复。两者都规范化为 NFC。home 以恒定时间比较，从不把密钥以明文写入日志、错误或文件。限制是 `@delorun/contract-oidc-passkeys` 的 `PIN_MODE_LIMITS`。
- **设置它。** 只有在电脑前的本人才能设置、替换或清除 PIN，并开启或关闭该模式：`POST /auth/pin/set`、`/auth/pin/options`、`/auth/pin/off` 和 `/auth/pin/resume` 回答在回环监听器上带 studio 凭据到达的请求，并以 `LOOPBACK_REQUIRED` 拒绝设备；[C19](c19-home-process.zh.md) 的 `pin.set`、`pin.options`、`pin.off` 和 `pin.resume` 请求为 `delorun` 做同样的事。`pin-mode-change` 在 `LOOPBACK_REQUIRED_ACTIONS` 中。更改 PIN 会结束每个页面解锁。`POST /auth/pin/options` 接受 `idleMinutes`（1 至 60 的整数）和 `lockWhenHidden`，只更改该模式已持有的记录上的这两项，不需要 PIN 或口令：电脑对该设置已经是受信任的。它不触动哈希、种类和页面解锁，在该模式关闭时以 `PIN_MODE_OFF` 拒绝，对空更改、其他字段或超出范围的值以 `BAD_REQUEST` 拒绝，并与其他每项更改一样用受保护的写入来写入。
- **解锁。** 带 `{ "secret": "…" }` 的 `POST /auth/pin/unlock`，来自 studio 自己的源并处于 Tailscale 私有监听器的有效会话之下，回答 `{ token, unlockId, endsAt, idleEndsAt }`。令牌是 32 个随机字节，只出现一次，home 只保留其 SHA-256 摘要。解锁属于持有令牌的那一个页面：它是该设备、监听器和会话的一条记录，只有该页面自己的 Peer 持有它（[C4「页面解锁」](c04-admission.zh.md#page-unlock)），因此它从不准入该设备的其他页面，重新加载会从锁定开始。设备范围的 `elevationOf` 从不返回它。已解锁页面的 Peer 持有解锁表格中的操作，并且如同危险模式解除这些限制那样，解除对受保护插件行、未列出的命令、`REACH_DANGEROUS_ACTIONS` 以及 chat 工作区之外的工作区路径的拒绝，并可以回答完全访问、工作区管理和外部智能体的授权；同一设备的已锁定标签页不持有其中任何一项。设置写入保持危险模式所留下的样子。危险模式对已解锁设备开放的同意与权限路由，对未处于危险模式的已解锁页面也开放；改变远程访问或网络暴露、批准或移除设备、更改 PIN 或关闭该模式的路由，在第 1 版中仍留在电脑上。在会话滚动之后的 30 秒内用旧 cookie 解锁的页面，绑定到延续它的会话。在另一个远程访问监听器上，该路由回答 `PIN_NOT_ALLOWED_ON_ADDRESS`，在回环监听器上它不是设备路由。
- **使用令牌。** 页面在其 `/api` 请求上以 `Delorun-Unlock` 头发送令牌，在 `/api/remote.mux` 升级请求上以 WebSocket 子协议 `delorun-unlock.<token>` 发送，从不放在 URL 中；home 在下游读取请求之前剥离这两者（[C4「页面解锁」](c04-admission.zh.md#page-unlock)）。`POST /auth/pin/touch` 把空闲结束时间向后推，但不超过上限；`POST /auth/pin/lock` 结束解锁；`GET /auth/pin/state` 报告该模式（其字段中有 `lockWhenHidden`），并对持有令牌的页面报告其解锁。与另一台设备、监听器或会话的 cookie 一起出示的令牌，或 home 不认识的令牌，得到 `401 UNLOCK_INVALID`；由错误的一方出示的令牌还会结束其解锁。
- **结束。** 每次结束都会关闭该解锁所在会话的远程访问连接，设备的其他页面以各自的令牌重新连接。在没有触碰 `idleMinutes`（默认 15，最多 60）之后、在 12 小时的绝对上限、在锁定时、在 PIN 更改或该模式关闭时，以及在提权会有的每种结束时：其会话结束、其设备被移除、其监听器或 Host 停止。
- **错误尝试。** 尝试在比较密钥之前计数并写入，每台设备一次一个。一台设备的第五次错误尝试会像在电脑上移除一样移除该设备，因此其会话和连接关闭，它需要在电脑上再次获得批准。全 home 在 24 小时内的十次错误尝试会暂停 PIN 解锁，回答 `PIN_UNLOCKS_PAUSED`，直到本人在电脑上恢复它们。正确的密钥会清除该设备的计数。
- **日志。** 每次解锁的开始和结束都是一次提权的开始和结束。每次错误尝试、锁定、暂停、恢复、PIN 更改和模式更改都是一行日志，写明设备而从不写明密钥。

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
| `PIN_MODE_OFF` | 该模式关闭时的 PIN 解锁。 |
| `PIN_NOT_ALLOWED_ON_ADDRESS` | Tailscale 私有监听器之外的远程访问监听器上的 PIN 解锁。 |
| `PIN_UNLOCKS_PAUSED` | 全 home 在 24 小时内十次错误尝试之后的 PIN 解锁，直到本人在电脑上恢复它们。响应体还携带 `paused: true`。 |
| `UNLOCK_INVALID` | 未知、已结束，或与另一台设备、监听器或会话一同出示的页面解锁令牌。 |
| `LOOPBACK_REQUIRED` | 因子为 `tailnet-membership` 的会话答复提示或发送请求，而该操作只在 home 自己的电脑上授予（[tailnet 成员身份](#tailnet-membership)）。 |

<a id="delo-run-issuer"></a>
### Delo Run 签发方

Delo Run 签发方让本人可以用 Delo Run 账户登录，它不属于 Delorun，Delorun 不配置任何 Delo Run 签发方（[路线图](../guide/roadmap.zh.md)）。这样的签发方作为第二个签发方遵循本页的每条规则，并且还遵循以下规则：

- 其重定向 URI 为 `https://<address>/auth/oidc/callback/delorun`，因此它永远不与本人的提供方共用重定向 URI。
- 它只用非对称密钥签署 ID 令牌，每个令牌头部都携带 `kid`，并且它发布一个密钥集。
- 它在用新签名密钥签名之前至少 24 小时，就在密钥集中发布该密钥；并在已退役密钥最后一次使用之后，至少在密钥集中保留它 24 小时。
- 其签名私钥是 Cloudflare Worker 机密，永远不放在代码仓库、配置文件或日志中。
- 其受众是 Delo Run 为每个 home 分配的客户端 ID。

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
| `ten wrong PINs across the home pause unlocks` | 若干台设备在 24 小时内共十次错误尝试之后，正确的 PIN 得到 `PIN_UNLOCKS_PAUSED`，直到电脑恢复。 |
| `the PIN routes refuse a Funnel listener, the loopback listener and a device that sets the PIN` | `PIN_NOT_ALLOWED_ON_ADDRESS`、对非设备路由的拒绝，以及 `LOOPBACK_REQUIRED`。 |
| `a page-unlock token from another device, session or listener is refused` | `UNLOCK_INVALID`，并且解锁结束。 |
| `a page unlock ends idle, at its cap, on lock and when the PIN changes` | 此后 `elevationOf` 不准入任何内容。 |
| `with PIN mode off nothing changes` | 解锁回答 `PIN_MODE_OFF`，不存在任何提权，提权类操作像以前一样被拒绝。 |
| `the PIN is in no log, error or file in the clear` | PIN 文本不出现在日志行、响应体和文件中。 |
| `a stale re-authentication is refused` | `auth_time` 距今超过 120 秒，或 `nonce` 不是批准哈希的 `reauth` 令牌，不会批准。 |
| `a device chooses the preset a chat that has not started runs with` | 来自 `reach-device` Peer 的 `agentPresets/select` 返回所选的预设，且该 chat 记录 `agent-preset/selected`；写明完全访问的预设仍然会遇到工作区同意的拒绝，该同意只能在电脑上授予。 |
| `a device reads the files of its chat's workspace and no path outside it` | `workspaceFiles/list`、`read`、`readBytes` 和 `stat` 对真实路径位于 Session 工作区内的路径成功，对工作区外的路径、经由指向工作区外的符号链接的路径、进入 Delorun 主目录的路径以及不存在的路径，以 `loopback-required: <action> with a path outside the chat's workspace` 被拒绝；`workspaceFiles/changes` 仍被拒绝。 |
| `a device reads the installed plugins and cannot change them` | `pluginManager/listPlugins`、`listBundles`、`registries`、`history` 和 `pluginInventory/list` 成功，而 `installBundle`、`setPluginEnabled`、`setBundleEnabled`、`removeBundle` 和 `undo` 以 `loopback-required: <action>` 拒绝。 |
| `needs an unlock for a terminal in every workspace at the Full level, whatever a stale terminal switch file, a full-access grant or dangerous mode says` | 在 Full 级别，没有解锁的设备的每个 `terminal/*` 操作都以 `elevation-required` 拒绝，已解锁的设备则被准许（`delorun/apps/cli/tests/denial/reach/reach-access.spec.ts`）。 |
| `keeps a terminal at the computer under Careful, for an unlocked phone in dangerous mode too` | 在 Careful 下，无论是否解锁，每个 `terminal/*` 操作都以 `loopback-required` 拒绝（`reach-access.spec.ts`）。 |
| `cannot be changed by a phone, unlocked or not` | 设备的 `POST /auth/phone-powers` 以 `LOOPBACK_REQUIRED` 拒绝，记录不变（`reach-access.spec.ts`）。 |
| `applies the unchosen level, Careful, while no choice is recorded`, `applies Careful and says why for a record it cannot read, and reads a repaired one`, `refuses a record whose mode is laxer than 0600` | 不存在、损坏或暴露的记录从不扩大手机可以做的事（`delorun/packages/home-auth/tests/phone-powers.spec.ts`）。 |
| `records the upgrade level once, as not chosen, and never over an existing record` | 首次启动写入的记录，以及保留的已有记录（`phone-powers.spec.ts`）。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **`attestation: "none"` 下的用户验证。** home 读取认证器设置的用户已验证标志，但不验证认证器本身，因此该标志的可信程度只取决于作出断言的认证器。
- **本人的提供方。** OpenID Connect 提供方可以为被固定的主体签发有效令牌，控制本人在该处账户的攻击者也可以用它登录；此时仍然起作用的控制是设备批准。
- **一部已批准且已解锁的手机。** 在 Tailscale 私有地址上，已批准设备仅凭其密钥即可登录。持有该已解锁设备的人拥有对话，并可以在已被授予的范围内驱动 agent：在电脑上被设为完全访问的工作区仍然可以从它驱动，其中的命令可以做本人用户能做的任何事，包括写入设备记录。在[手机权限](#phone-powers)为 Full 时，已解锁的设备还拥有终端以及 Careful 留在电脑上的 Changes 控件，每次使用都需要本人输入的解锁。防护手段是手机自身的锁、在电脑上移除该设备，以及远程会话 12 小时的空闲上限。

- **共享的依赖方 ID。** 在 spike 结果使 `ts.net` 上可以使用通行密钥的情况下，同一台机器的私有地址与 Funnel 地址共享一个依赖方 ID；把它们的通行密钥区分开的是 home 中按地址的绑定，而不是浏览器。

<a id="decided-values"></a>
## 决定的取值

- 本人在 setup 期间在自己的 OpenID Connect 提供方处将 Delorun 注册为客户端，输入客户端 ID 与密钥，重定向 URI 为用于 `ts.net` 地址与自有域名地址的 `https://<address>/auth/oidc/callback`；只有当提供方公布支持动态注册且本人选择使用时，才使用动态注册。
- 通行密钥依赖方 ID：自有域名上为该地址的主机名；在 `ts.net` 上不提供，直到某个 spike 结果采纳主机名。
- 允许的 ID 令牌算法：`RS256`、`PS256`、`ES256` 与 `EdDSA`；通行密钥算法为 EdDSA、ES256 与 RS256。
- 流程：32 字节的 `state`、`nonce` 与 verifier，10 分钟生存期，每个 home 20 个待处理流程；票据 60 秒。
- 密钥集每 24 小时刷新一次，遇到未知 `kid` 时也刷新，但最多每 5 分钟一次。
