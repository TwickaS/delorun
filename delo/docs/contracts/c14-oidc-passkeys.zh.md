---
description: "约定 C14：远程访问地址可使用的身份因子；每个地址的通行密钥依赖方 ID，以及 ts.net 规则的两种情形；本人自己的 OpenID Connect 提供方，包括客户端注册与每个地址的重定向 URI；必需声明；每个 home 的受众；在首次注册时固定的所有者身份；nonce、PKCE、签发方检查与混淆防护；签名密钥 ID 与轮换；以及作为后续功能的 Delo Run 签发方。"
---

# 约定 C14：OpenID Connect 与通行密钥

[English](c14-oidc-passkeys.md) | 中文

<a id="summary"></a>
## 摘要

远程访问（reach）在设备批准（device approval）之外还要求一个身份因子（identity factor）：通行密钥，或在本人（the person）自己的 OpenID Connect 提供方处登录。home 是两者的依赖方（relying party）。本页定义每个远程访问地址可使用哪些因子、每个地址的通行密钥依赖方 ID、home 如何在本人的提供方处注册为客户端、带有 nonce、PKCE 与签发方（issuer）检查的授权流程、home 要求的声明与受众、它固定的所有者身份、它如何获取并轮换签名密钥，以及约束 Delo Run 签发方的规则，该签发方是一项后续功能（fast-follow）。因子从不替代设备批准（[C5](c05-device-approval.zh.md)）。类型包 [`@delo/contract-oidc-passkeys`](../../packages/contract-oidc-passkeys/README.zh.md) 承载这些规则、声明、代码与上限。

<a id="status"></a>
## 状态

本页的通行密钥与 OpenID Connect 因子尚未构建：home 没有通行密钥依赖方，也没有 OpenID Connect 客户端。Tailscale 私有路由的 `tailnet-membership` 因子已构建。

- **已构建并已接入：** 设置的答案模式指明 `reach.identityFactor`，并在 `--config` 文档中拒绝 `null` 以外的任何值（[C11](c11-setup-answers.zh.md)）。
- **未构建：** 带用户验证与计数器的通行密钥注册与断言；在本人提供方处的客户端注册；带 `state`、`nonce`、PKCE 与签发方检查的授权流程；ID 令牌检查与签名密钥轮换；固定的所有者主体；重新认证；Delo Run 签发方。

下文中被此列表称为未构建或未被任何部分接入的要求与拒绝测试，在某项变更构建并接入它们之前不保护任何人。[远程访问设计](../design/reach.md)规定私有 tailnet 路由仅凭已批准的设备密钥登录，不使用通行密钥或 OpenID Connect；本页为 `tailscale-private` 列出身份因子之处，以该设计为准。

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

- **注册选项。** `POST /auth/passkey/register/options` 返回：`rp` `{ id: <relying-party ID>, name: "Delo" }`；`user` `{ id: <the home's owner handle>, name: "owner", displayName: <device label> }`，其中所有者句柄是每个 home 固定的 32 个随机字节；`pubKeyCredParams` EdDSA（-8）、ES256（-7）与 RS256（-257）；`authenticatorSelection` `{ residentKey: "required", userVerification: "required" }`；`attestation: "none"`；列出本地址凭据的 `excludeCredentials`；一个 32 字节的质询；以及 300,000 毫秒的超时。
- **存储。** `~/.delo/secrets/home-auth/passkeys.json` 按凭据保存：凭据 id、COSE 公钥与算法、地址、依赖方 ID、签名计数器、传输方式、创建时间以及注册设备的 id。
- **断言选项。** `POST /auth/passkey/options` 返回一个 32 字节的质询、监听器所在地址的依赖方 ID、列出该地址凭据的 `allowCredentials`，以及 `userVerification: "required"`。
- **断言检查。** home 只在以下条件全部满足时接受断言：`clientDataJSON.type` 为 `webauthn.get`；其质询由 home 签发，且未使用、未过期；其来源与监听器的地址完全相等；`rpIdHash` 等于该地址依赖方 ID 的 SHA-256 哈希；用户在场与用户已验证标志均已设置；该凭据已为该地址注册；签名可用存储的密钥验证；已存储的计数器非零时小于所呈现的计数器，随后 home 存储所呈现的计数器。
- **质询。** 通行密钥质询在 5 分钟后过期，且只能使用一次。

<a id="client-registration"></a>
### 客户端注册

在 setup 期间，或在本人开启远程访问时，本人在自己的 OpenID Connect 提供方处将 Delo 注册为客户端，并输入三个值：签发方 URL、客户端 ID 与客户端密钥。setup 列出需要注册的重定向 URI：为 home 的每个 `ts.net` 地址与自有域名地址各列一个 `https://<address>/auth/oidc/callback`。

- **发现。** home 通过 `https` 读取 `<issuer>/.well-known/openid-configuration`。该文档的 `issuer` 必须与输入的签发方完全相等，`response_types_supported` 必须包含 `code`，`code_challenge_methods_supported` 必须包含 `S256`，`id_token_signing_alg_values_supported` 必须包含 [ID 令牌检查](#id-token-checks)中的一种算法；否则 setup 以相应的代码拒绝。
- **动态注册。** 只有当提供方的元数据含有 `registration_endpoint` 且本人选择使用它时，home 才按 RFC 7591 的描述注册自身：`client_name` 为 `Delo`，重定向 URI 为上述各项，`grant_types` 为 `["authorization_code"]`，`response_types` 为 `["code"]`，`token_endpoint_auth_method` 为 `client_secret_basic`，`application_type` 为 `web`；当提供方要求初始访问令牌且本人输入了它时，附带该令牌。
- **存储。** `~/.delo/secrets/home-auth/oidc-client.json` 保存签发方、客户端 ID、客户端密钥、重定向 URI，以及动态注册之后的注册访问令牌。任何配置行都不保存它们。
- **每个 home 一个客户端。** home 的客户端注册归它自己所有：两个 home 永远不共用一个客户端 ID，因此客户端 ID 就是指明该 home 的受众。
- **添加地址。** 添加地址会在提供方处添加其重定向 URI：由本人添加，或由 home 通过其注册访问令牌更新动态注册。

<a id="authorization-flow"></a>
### 授权流程

1. **开始。** 带 `purpose`（`enrol`、`sign-in`、`recovery` 或 `reauth`）与设备 id 的 `GET /auth/oidc/start` 创建一个绑定到监听器地址的流程，包含：一个 32 字节的 `state`、一个 32 字节的 `nonce`、一个 32 字节的 PKCE `code_verifier`、签发方、用途、设备 id 与创建时间。home 在内存中保存该流程，把 cookie `__Host-delo-oidc` 设为一个 32 字节的随机值（流程记录该值的哈希），并重定向到签发方的 `authorization_endpoint`，附带 `response_type=code`、`client_id`、该地址的 `redirect_uri`、`scope=openid`、`state`、`nonce`、`code_challenge`（verifier 的 SHA-256 哈希）与 `code_challenge_method=S256`。对于 `reauth`，它另外添加 `prompt=login` 与 `max_age=0`，且 `nonce` 为设备发送的批准哈希。
2. **回调。** 只有当 `state` 指向本地址一个待处理且未过期的流程，并且 `__Host-delo-oidc` cookie 与该流程匹配时，`GET /auth/oidc/callback` 才被接受。当提供方的元数据设置了 `authorization_response_iss_parameter_supported` 时，响应必须携带等于该流程签发方的 `iss`（RFC 9207）；在任何情况下，出现的 `iss` 都必须与之相等。无论结果如何，流程都在回调时被消耗。
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

所有者在本人提供方处的身份，在所有者认领身份因子时被固定：由所有者的一台设备完成的首次 OpenID Connect 注册（[C5](c05-device-approval.zh.md#owner-claim)）会把签发方与 `sub` 记录到 `~/.delo/secrets/home-auth/owner.json`。之后的每次登录、恢复与重新认证都必须出示这一对值，为另一个地址进行的 `enrol` 流程也必须如此。更改它属于登录因子变更，只有在新身份上完成 `enrol` 流程之后，从实时会话中的受信任设备（trusted device）发起时才被接受；它会轮换每个会话（[C4](c04-admission.zh.md#rotation-and-revocation)）。`delorun devices reset` 会移除该固定（[C5](c05-device-approval.zh.md#reset)）。

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

对于每一项只在 home 自己的电脑上授予的操作，home 以 `403 LOOPBACK_REQUIRED` 拒绝因子为 `tailnet-membership` 的会话：授予完全访问，无论是升级到 `danger-full-access`（包括 `plugin_manager` 的升级）还是某个工作区的完全访问同意；授予标记为 `workspace-management` 的提示（主对话的工作区工具及其其他询问，以及指令层写入）；允许、拒绝或撤销某个 stdio MCP 服务器的启动，设备只能读取等待中服务器的名称以及每个服务器发生了什么变化；打开批准窗口以及批准或移除设备；重置；恢复套件；注册身份因子；以及更改远程访问设置。拒绝发生在授予操作的地方，而不是客户端：授予完全访问的批准提示携带 `grants: "full-access"`，以该因子准入的 Peer 的答复不会被应用，因此该提示保持打开，留给 home 自己电脑上的工作室。远程工作室会提示在电脑上批准该操作。观看、回复、开始对话、答复其他所有提示以及停止运行都是允许的，因此无法从手机安装插件。同一规则适用于工作室调用的每个 Remote 方法：设备的 Peer 代表其 `reach-device` 主体，该主体的远程访问策略允许[设备可以调用什么](#what-a-device-may-call)一节列出的方法和转发事件，并以 `remote-access/denied` 和原因 `loopback-required: <action>` 拒绝其他所有方法；该策略及其两张表格位于 [`@delo/home-auth`](../../packages/home-auth/README.zh.md)。

<a id="what-a-device-may-call"></a>
### 设备可以调用什么

所有者对设备的规则是：人在手机上能做的，就是在电脑上能做的，只有需要由电脑在场做出决定的操作除外。`@delo/home-auth` 把 Delo 默认配置的每个 Remote 方法和每个转发事件归入三类之一，reach 访问拒绝测试套件在某个操作不被任何表格列出、或某个表格条目没有对应操作时失败。

- **允许**：设备做人在电脑上做的事。各项操作及其原因见 [`reach-access.ts`](../../packages/home-auth/src/reach-access.ts) 中的 `REACH_ALLOWED_ACTIONS`。
- **保留给 home 自己的电脑**：以 `403 LOOPBACK_REQUIRED` 和原因 `loopback-required: <action>` 拒绝。各项操作及其原因见同一文件中的 `REACH_DENIED_ACTIONS`。
- **只能由电脑授予的授权**：在授予之处而不是调用之处被拒绝（[tailnet 成员身份](#tailnet-membership)）。

| 类别 | 操作 | 分类 | 原因 |
| --- | --- | --- | --- |
| 对话、工作区、后台任务、目标与计划，读取 | `session/*` 的读取、`workspace/follow`、`job/*`、`goals/get`、`schedule/*` 的读取 | 允许 | 读取对话、工作区或计划既触不到任何密钥，也不改变任何运行。 |
| 对话，写入 | `session/create`、`session/fork`、`session/prompt`、`session/updateQueue`、`session/cancel`、`session/rename`、`workspace/pinSession`、`workspace/unpinSession`、`fileUploads/upload`、`userQuestions/answer`、`subagents/*` | 允许 | 回复、停止运行、答复提问以及整理对话列表，正是人在电脑上做的事。 |
| 代理预设 | `agentPresets/list`、`agentPresets/read`、`agentPresets/select` | 允许 | 预设决定尚未开始的对话以哪些插件和工具运行。选择预设本身不授予任何访问：工作区的完全访问同意仍然是电脑上的答复，每个批准提示也仍然适用。 |
| 对话自己工作区的文件 | `workspaceFiles/list`、`workspaceFiles/read`、`workspaceFiles/readBytes`、`workspaceFiles/stat`、`officeToPdf/render`、`officeToPdf/generation`、`fileReferences/list` | 允许，仅限相对路径 | 工作区文件服务只读，对每一页、每个字节窗口、完整文件和列表都设有上限，检查文件类型并拒绝最终符号链接。它把列出的目录限制在工作区根目录内，只有调用给出不走出工作区的相对路径时才准入文件读取。 |
| 设置与模型，读取 | `settings/describe`、`permissionPresets/catalog`、`llm/listProviders`、`llm/listConfigurableProviders`、`session/modelCatalog` | 允许 | 已脱敏的设置和提供方名称不携带任何密钥。 |
| 插件与配置历史，读取 | `pluginManager/listPlugins`、`listBundles`、`listVersionExemptions`、`listVersions`、`readBundleDetail`、`inspect`、`registries`、`history`、`waitForInstall`、`pluginInventory/list`、`pluginRegistryProbe/fastest` | 允许 | 设备展示已安装的插件和发生过什么变化；每一项安装、启用、移除或回退操作仍然保留。 |
| 转发事件，读取 | `event:api-session/*`、`event:commands/change`、`event:goal/*`、`event:llm/*`、`event:permission-presets/*`、`event:settings/document-updated`、`event:schedule/changed`、`event:agent-preset/selected`、`event:plugin-manager/changed`、`event:plugin-market/changed` | 允许 | 设备本就可读的界面所需的刷新信号。 |
| 批准提示 | `event:approval/request` | 允许，授予除外 | 答复守卫会拒绝授予完全访问或工作区管理的答复（[tailnet 成员身份](#tailnet-membership)）。 |
| 插件与配置历史，写入 | `pluginManager/installBundle`、`updateBundle`、`removeBundle`、`setBundleEnabled`、`setPluginEnabled`、`setVersionExemption`、`cancelInstall`、`undo`、`restore` | 保留 | 插件管理会安装或启用任何沙箱之外在 Host 中运行的代码，而配置历史可以关掉守卫插件。 |
| 设置，写入 | `settings/mutate`、`settings/replace`、`settings/update`、`settings/openSettingsDocument`、`session/selectModel`、`session/initializeDefaultModel` | 保留 | 设置写入会改变 Host 的配置，且任何设置命名空间都不能从设备写入。 |
| 密钥与账户 | `credentials/*`、`llm/discoverModels`、`account/*`、`event:credentials/*`、`event:deepseek-account/*` | 从不 | 密钥是 home 的秘密，账户登录属于本人。 |
| 终端、目录与电脑 | `terminal/*`、`directoryPicker/*`、`session/openWorkspacePath`、`session/workspacePathApplications` | 保留 | 终端是沙箱之外的 shell，目录选择器浏览电脑，其余会在电脑上打开应用。 |
| 工作区与对话列表 | `workspace/create`、`workspace/delete`、`workspace/initializeDefault`、`workspace/insertBefore`、`workspace/rename`、`workspace/archiveSession`、`workspace/unarchiveSession`、`workspace/insertSessionBefore`、`workspaceFiles/changes` | 保留 | 注册或移除文件夹以及 Changes 界面的工作树属于电脑，归档或重排对话不在设备规则内。 |
| 斜杠命令、目标与计划，写入 | `commands/execute`、`goals/create`、`goals/edit`、`goals/pause`、`goals/resume`、`goals/complete`、`goals/clear`、`schedule/create`、`schedule/edit`、`schedule/run`、`schedule/deleteInactive` | 保留 | 斜杠命令可以改变设置、插件或配置，而计划任务会在无人值守时运行提示。 |
| 动态插件代码 | `dynamicCordisRunner/*`、`event:cordis/*` | 保留 | 它会在 Host 中运行模型编写的插件代码。 |
| 反馈 | `sessionFeedback/record`、`messageFeedback/*` | 保留 | 反馈会离开 home，Delo 已将其关闭。 |
| 授权 | 完全访问升级、工作区的完全访问同意、`workspace-management` 提示 | 从不 | 工作区的同意和升级都是本人在电脑上给出的答复，无论设备被允许调用什么。 |

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
| `OIDC_STATE_INVALID` | 未知、已使用或已过期的 `state`，或缺失或不一致的 `__Host-delo-oidc` cookie。 |
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
| `LOOPBACK_REQUIRED` | 因子为 `tailnet-membership` 的会话答复提示或发送请求，而该操作只在 home 自己的电脑上授予（[tailnet 成员身份](#tailnet-membership)）。 |

<a id="delo-run-issuer"></a>
### Delo Run 签发方

Delo Run 签发方让本人可以用 Delo Run 账户登录，它是一项后续功能，随 Delo 中继（Delo relay）一同推出：Delo 1.0 不配置任何 Delo Run 签发方。添加它时，它作为第二个签发方遵循本页的每条规则，并且还遵循以下规则：

- 其重定向 URI 为 `https://<address>/auth/oidc/callback/delo-run`，因此它永远不与本人的提供方共用重定向 URI。
- 它只用非对称密钥签署 ID 令牌，每个令牌头部都携带 `kid`，并且它发布一个密钥集。
- 它在用新签名密钥签名之前至少 24 小时，就在密钥集中发布该密钥；并在已退役密钥最后一次使用之后，至少在密钥集中保留它 24 小时。
- 其签名私钥是 Cloudflare Worker 机密，永远不放在代码仓库、配置文件或日志中。
- 其受众是 Delo Run 为每个 home 分配的客户端 ID。

<a id="consumers"></a>
## 消费方

- `delo/packages/home-auth/src/identity/`：通行密钥依赖方、OpenID Connect 依赖方、注册与 `tailnet` 因子。
- `delo/packages/home-auth/`：会话创建中的登录票据、批准的重新认证与所有者记录。
- `delo/apps/cli/` 中的 setup：客户端注册、动态注册与重定向 URI 列表。
- `delo/packages/plugin-reach-ui/`：注册屏幕，以及说明某地址不提供通行密钥的提示。
- `delo/packages/contract-oidc-passkeys/`：规则、声明、代码与上限。
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
| `a replayed state or foreign browser is refused` | 重复使用已消耗 `state` 的回调，或到达时没有该流程 `__Host-delo-oidc` cookie 的回调，以 `OIDC_STATE_INVALID` 被拒绝。 |
| `a wrong nonce or verifier fails` | `nonce` 不同的令牌被拒绝，且使用另一个 `code_verifier` 的令牌请求从替身处得不到令牌。 |
| `another subject is refused` | 针对已固定 `sub` 之外的 `sub` 的有效令牌，不创建登录票据。 |
| `a passkey assertion for another address's relying-party ID is refused` | 为一个地址的依赖方 ID 生成、却在另一个地址上出示的断言，以 `PASSKEY_ASSERTION_INVALID` 被拒绝。 |
| `a passkey without user verification is refused` | 没有用户已验证标志的断言被拒绝。 |
| `a regressed counter is refused` | 计数器不大于非零已存储计数器的断言被拒绝。 |
| `a passkey on a ts.net address is refused under the current contract` | `ts.net` 地址上的通行密钥注册选项与断言选项返回 `PASSKEY_UNAVAILABLE`。 |
| `tailnet-membership is refused on a Funnel or own-domain address` | 为 Funnel 监听器或自有域名地址声明 `tailnet-membership` 的提供方以 `TAILNET_IDENTITY_UNAVAILABLE` 被拒绝。 |
| `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent` | 来自 `tailnet-membership` 会话、对授予完全访问的提示给出的 `allowed-once` 答复以 `LOOPBACK_REQUIRED` 被拒绝；被升级的调用不会运行，工作区也不记录同意，而同一提示在 loopback 工作室上答复则授予。 |
| `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach` | 来自 `tailnet-membership` 会话的每一个此类请求都被拒绝，且 home 的设备与 reach 状态保持不变。 |
| `a device chooses the preset a chat that has not started runs with` | 来自 `reach-device` Peer 的 `agentPresets/select` 返回所选的预设，且该对话记录 `agent-preset/selected`；请求完全访问的预设仍然会遇到工作区同意的拒绝，而该同意只在电脑上授予。 |
| `a device reads the files of its chat's workspace and no path outside it` | `workspaceFiles/list`、`read`、`readBytes` 和 `stat` 对 Session 工作区内的相对路径成功，对绝对路径和走出工作区的相对路径以 `loopback-required: <action> with a path outside the chat's workspace` 拒绝；`workspaceFiles/changes` 保持拒绝。 |
| `a device reads the installed plugins and cannot change them` | `pluginManager/listPlugins`、`listBundles`、`registries`、`history` 和 `pluginInventory/list` 成功，而 `installBundle`、`setPluginEnabled`、`setBundleEnabled`、`removeBundle` 和 `undo` 以 `loopback-required: <action>` 拒绝。 |
| `a stale re-authentication is refused` | `auth_time` 距今超过 120 秒，或 `nonce` 不是批准哈希的 `reauth` 令牌，不会批准。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **`attestation: "none"` 下的用户验证。** home 读取认证器设置的用户已验证标志，但不验证认证器本身，因此该标志的可信程度只取决于作出断言的认证器。
- **本人的提供方。** OpenID Connect 提供方可以为被固定的主体签发有效令牌，控制本人在该处账户的攻击者也可以用它登录；此时仍然起作用的控制是设备批准。
- **一部已批准且已解锁的手机。** 在 Tailscale 私有地址上，已批准设备仅凭其密钥即可登录。持有该已解锁设备的人拥有对话，并可以在已被授予的范围内驱动 agent：在电脑上被设为完全访问的工作区仍然可以从它驱动，其中的命令可以做本人用户能做的任何事，包括写入设备记录。防护手段是手机自身的锁、在电脑上移除该设备，以及远程会话 12 小时的空闲上限。

- **共享的依赖方 ID。** 在 spike 结果使 `ts.net` 上可以使用通行密钥的情况下，同一台机器的私有地址与 Funnel 地址共享一个依赖方 ID；把它们的通行密钥区分开的是 home 中按地址的绑定，而不是浏览器。

<a id="decided-values"></a>
## 决定的取值

- 本人在 setup 期间在自己的 OpenID Connect 提供方处将 Delo 注册为客户端，输入客户端 ID 与密钥，重定向 URI 为用于 `ts.net` 地址与自有域名地址的 `https://<address>/auth/oidc/callback`；只有当提供方公布支持动态注册且本人选择使用时，才使用动态注册。
- 通行密钥依赖方 ID：自有域名上为该地址的主机名；在 `ts.net` 上不提供，直到某个 spike 结果采纳主机名。
- 允许的 ID 令牌算法：`RS256`、`PS256`、`ES256` 与 `EdDSA`；通行密钥算法为 EdDSA、ES256 与 RS256。
- 流程：32 字节的 `state`、`nonce` 与 verifier，10 分钟生存期，每个 home 20 个待处理流程；票据 60 秒。
- 密钥集每 24 小时刷新一次，遇到未知 `kid` 时也刷新，但最多每 5 分钟一次。
