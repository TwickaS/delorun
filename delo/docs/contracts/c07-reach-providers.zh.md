---
description: "约定 C7：远程访问提供方的 Service Definition 及其状态、每种远程访问方式发布的可见性说明、配置行、Tailscale serve 目标及其当前的回退方案与 spike 通过后采用的套接字变体、身份请求头、使用独立监听器的 Funnel、带有 Let's Encrypt 所实施的 CAA 记录与质询规则的自有域名远程访问，以及作为后续功能的 Delo 中继客户端。"
---

# 约定 C7：远程访问提供方

[English](c07-reach-providers.md) | 中文

<a id="summary"></a>
## 摘要

远程访问提供方（reach provider）开启或关闭一种远程访问方式：它把 [C4](c04-admission.zh.md#listeners) 的一个远程访问监听器连接到外部，并发布该方式的提供方能看到什么、能做什么。Delo 1.0 有三种远程访问方式：Tailscale 私有、Tailscale Funnel，以及位于本人（the person）自有域名上的自托管中继。它们都不使用 Delo 的基础设施。本页定义提供方的 Service Definition 及其状态、可见性说明、配置行、Tailscale serve 目标及其回退方案（即当前约定）与 spike 通过后采用的套接字变体、对 Tailscale 身份请求头的处理、Funnel 的独立监听器，以及自有域名远程访问及其 CAA 记录与质询规则。类型包 [`@delo/contract-reach-providers`](../../packages/contract-reach-providers/README.zh.md) 承载方式 id、状态、行、错误码与所指定的证书颁发机构。

<a id="contents"></a>
## 目录

- [摘要](#summary)
- [约定](#contract)
  - [远程访问方式](#reach-options)
  - [提供方 Service Definition](#provider-service-definition)
  - [状态](#states)
  - [可见性说明](#visibility-notes)
  - [配置行](#configuration-rows)
  - [Tailscale serve 目标](#tailscale-serve-target)
  - [身份请求头](#identity-headers)
  - [Funnel](#funnel)
  - [自有域名远程访问](#own-domain-reach)
  - [错误](#errors)
  - [Delo 中继客户端](#delo-relay-client)
- [消费方](#consumers)
- [兼容性](#compatibility)
- [安全](#security)
  - [本约定不能证明的内容](#what-this-does-not-prove)
- [决定的取值](#decided-values)

<a id="contract"></a>
## 约定

<a id="reach-options"></a>
### 远程访问方式

| 方式 id | 监听器 | TLS 终止于 | 身份因子 | 地址 |
| --- | --- | --- | --- | --- |
| `tailscale-private` | `reach-tailscale-private` | home 上的 `tailscaled` | 通行密钥或 OpenID Connect 登录；只有在[套接字变体](#tailscale-serve-target)下才可使用 tailnet 身份 | `https://<machine>.<tailnet>.ts.net`，serve 端口不是 443 时带上该端口 |
| `tailscale-funnel` | `reach-tailscale-funnel` | home 上的 `tailscaled` | 通行密钥或 OpenID Connect 登录 | `https://<machine>.<tailnet>.ts.net`，Funnel 端口不是 443 时带上该端口 |
| `self-hosted-relay` | `reach-self-hosted-relay` | home 的远程访问监听器，使用其自己的证书 | 通行密钥或 OpenID Connect 登录 | 本人自有域名上的 `https://<name>` |

方式 id 即 setup 回答（[C11](c11-setup-answers.zh.md)）中的 id。设备批准（device approval，[C5](c05-device-approval.zh.md)）适用于每种方式。某个地址可以使用哪种身份因子（identity factor），由 [C14](c14-oidc-passkeys.zh.md#relying-party-ids) 定义。

<a id="provider-service-definition"></a>
### 提供方 Service Definition

该能力 seam 有三种角色。Service Definition 是由 `@delo/reach` 声明的 Cordis 服务 `reach`，带有一个提供方注册表。其 Service Providers 是上述三个提供方，各由 `@delo/reach` 注册。其消费方是 `@delo/plugin-reach-ui` 中的远程访问屏幕、在远程访问提供方变更时轮换会话的 `@delo/home-auth`、`@delo/certificates`，以及 [C15](c15-verification-checks.zh.md) 的验证检查。

- **`reach.register(provider)`** 为一个方式 id 注册一个提供方，并返回 disposer（资源释放函数）。同一 id 的第二个提供方在加载时失败。
- **`provider.resolve(rows)`** 把该方式的配置行转换为一个 `ReachSpec`：地址、监听器、端口，以及提供方原本会使用默认值的每个取值。它在加载时运行，因此缺失或无效的行会在加载时以其错误码失败。
- **`provider.start(spec, listener)`** 把已启动的远程访问监听器连接到外部，并在提供方到达 `ready` 或某个拒绝状态时完成。
- **`provider.stop()`** 断开连接，并在提供方到达 `off` 时完成。
- **`provider.visibility(spec)`** 返回该方式针对该 spec 的[可见性说明](#visibility-notes)。
- **`reach/state`** 是每次状态变化时发出的事件，携带方式 id、状态及其原因。

只有在每项前提条件都成立时，`start` 才会运行：home 有所有者（[C5](c05-device-approval.zh.md#owner-claim)）；[C14](c14-oidc-passkeys.zh.md) 允许该地址使用的某个身份因子已注册，或在开启该方式的过程中注册；本人以交互方式开启了该方式，从不通过 `--yes` 或 `--config`（[C11](c11-setup-answers.zh.md)）；并且该方式自身在下文中的检查通过。

<a id="states"></a>
### 状态

| 状态 | 含义 |
| --- | --- |
| `off` | 监听器已停止，没有任何内容通过此方式到达 home。 |
| `starting` | 监听器已启动，提供方正在连接它。 |
| `ready` | 地址能到达监听器。 |
| `degraded` | 提供方失去了连接，正在重新连接；监听器不拒绝任何它在其他情况下会准入的内容。 |
| `blocked` | 某项前提条件或检查失败，例如缺少 CAA 记录或出现无法解释的证书。提供方已断开连接，状态写明原因。 |
| `stopping` | 提供方正在断开连接。 |
| `failed` | 提供方因一个无法重试的错误而停止；状态写明该错误。 |

`starting` 转为 `ready`、`blocked` 或 `failed`；`ready` 转为 `degraded`、`blocked` 或 `stopping`；`degraded` 转为 `ready`、`blocked` 或 `stopping`；`blocked` 在其原因消除时转为 `starting`，或转为 `stopping`；`failed` 在本人重试时转为 `starting`；`stopping` 转为 `off`。`off` 与其他任一状态之间的每次变化都是一次远程访问提供方变更，会轮换每个会话（[C4](c04-admission.zh.md#rotation-and-revocation)）。

<a id="visibility-notes"></a>
### 可见性说明

每个提供方发布一份说明，setup 与远程访问屏幕在该方式开启之前显示它，并在该方式开启期间把它显示在该方式旁边。说明列出本人以外的每一方能看到什么、能做什么。studio 以界面语言显示下列文本，并填入占位符。

**Tailscale 私有。**

> 此方式不使用任何 Delo 基础设施。只有你的 tailnet 上的设备能打开此地址。Tailscale 的协调服务能看到此 home 的名称、此 home 与每台设备的 IP 地址、连接时间以及流量大小。除非开启 Tailnet Lock，否则 Tailscale 可以向你的 tailnet 添加设备。Tailscale 控制 `ts.net` 并为此地址获取证书，因此任何应用都无法固定此地址的 TLS 密钥。每台设备仍需批准，登录需要你的通行密钥或登录提供方。

**Tailscale Funnel。**

> 此方式不使用任何 Delo 基础设施。互联网上的任何人都能打开此地址；保护它的是你的通行密钥或登录提供方，以及设备批准。Tailscale 的 Funnel 服务器与协调服务能看到此 home 的名称、此 home 与每台连接设备的 IP 地址、连接时间以及流量大小，并把加密流量转交给此 home，由 Tailscale 的软件在此 home 上终止 TLS。除非开启 Tailnet Lock，否则 Tailscale 可以向你的 tailnet 添加设备。Tailscale 控制 `ts.net` 并为此地址获取证书，因此任何应用都无法固定此地址的 TLS 密钥。

**自托管中继。**

> 此方式不使用任何 Delo 基础设施。你位于 `<tunnel host>` 的中继能看到此地址的名称、此 home 与每台连接设备的 IP 地址、连接时间以及流量大小，并转发它无法读取的加密流量；TLS 在此 home 上终止。只要你的域名的 CAA 记录只允许此 home 的 Let's Encrypt 账户获取证书（`accounturi`），并且此 home 自己响应其证书质询，流量就是端到端加密的。Let's Encrypt 与你的 DNS 提供商仍能影响你的域名的证书；此 home 通过 `<certificate source>` 检查公开证书日志，`<certificate source>` 能看到此 home 的 IP 地址与域名，并且要等到某个日志收录一张证书之后才能检测到该证书。

<a id="configuration-rows"></a>
### 配置行

这些行是 home 的 profile 中 `@delo/reach` 插件 `Config` 的字段。它们是远程访问行：导出文件从不携带它们（[C8](c08-archive-and-trash.zh.md)），setup 只在其交互形式中写入它们。

| 行 | 类型 | 默认值 | 校验 |
| --- | --- | --- | --- |
| `tailscalePrivate.enabled` | 布尔值 | `false` | — |
| `tailscalePrivate.address` | studio 地址 | 无 | 必须等于 `https://` 加上 `tailscale status --json` 所报告的本机 `ts.net` 名称，端口不是 443 时带上该端口。 |
| `tailscalePrivate.servePort` | 整数 | `443` | 1 到 65535。 |
| `tailscaleFunnel.enabled` | 布尔值 | `false` | — |
| `tailscaleFunnel.address` | studio 地址 | 无 | 同 `tailscalePrivate.address`，但带上 Funnel 端口。 |
| `tailscaleFunnel.funnelPort` | 整数 | `8443` | `443`、`8443` 或 `10000`，即 Funnel 接受的端口；两种方式都开启时，须不同于 `servePort`。 |
| `selfHostedRelay.enabled` | 布尔值 | `false` | — |
| `selfHostedRelay.address` | studio 地址 | 无 | `https://<name>`，使用本人域名下的一个 DNS 名称，且不带端口。 |
| `selfHostedRelay.tunnelUrl` | URL | 无 | 本人中继的 `wss://<tunnel host>/v1/tunnel`（[C6](c06-relay-protocol.zh.md#relay-configuration)）。 |
| `certificates.ctSource` | URL | [C6 默认值](c06-relay-protocol.zh.md#certificate-monitoring) | 一个 `https` URL。 |

没有任何行设定监听器的地址（[C4](c04-admission.zh.md#listeners)）。各方式的密钥位于 `~/.delo/secrets/reach/` 与 `~/.delo/secrets/certificates/` 之下（[C1](c01-home-layout.zh.md#secrets)），从不位于某一行中。

<a id="tailscale-serve-target"></a>
### Tailscale serve 目标

**当前约定：回退方案。**Tailscale 私有目标是 `127.0.0.1` 上由操作系统分配给 `reach-tailscale-private` 的一个 TCP 端口。提供方用 `tailscale serve --bg --https=<servePort> http://127.0.0.1:<bound port>` 配置它，用 `tailscale serve --https=<servePort> off` 移除它。在回退方案下：

- 身份请求头在任何监听器上都不受信任，包括此监听器；
- tailnet 私有远程访问与公开远程访问一样，需要通行密钥或 OpenID Connect 身份因子，`tailnet` 身份因子会以 `TAILNET_IDENTITY_UNAVAILABLE` 被拒绝；
- 所有者认领只在回环监听器上被接受（[C5](c05-device-approval.zh.md#owner-claim)）；
- 连接到目标端口的本地进程，只会像任何远程设备那样被准入。

**套接字变体，仅在 spike 通过时采用。**若[兼容性](#compatibility)一节下记录的 spike 结果对某个平台通过，该平台上的目标就是 Unix 套接字 `~/.delo/run/<profile>/serve.sock`（[C1](c01-home-layout.zh.md)），它由 home 进程（home process）创建，并在绑定后设为模式 0600。提供方用 spike 记录的命令配置它。对每个已接受的连接，home 读取对端的凭据（Linux 上为 `SO_PEERCRED`，macOS 上为 `getpeereid`），除非对端的用户是 `tailscaled` 运行时所用的用户，且该用户不是本人的用户，否则关闭该连接。在该变体下，身份请求头只在此套接字上受信任，在此套接字上的认领可以设定 tailnet 登录允许列表，并且 `tailnet` 身份因子可用于 `tailscale-private`。若启动时对端凭据条件不成立，例如因为 `tailscaled` 以本人的用户运行，提供方就在该 home 上使用回退方案，并在其状态中写明这一点。

**Spike 证据。**只有当已提交的报告记录了以下全部内容时，一个 spike 结果才会为一个平台采用该变体：

1. 操作系统及其版本，以及来自 `tailscale version` 的 Tailscale 客户端版本。
2. 配置与移除 serve 目标所用的确切命令。
3. 来自 `stat` 的套接字模式与所有者，以及来自 `ps` 的 `tailscaled` 运行时所用的用户。
4. 另一台 tailnet 设备上的浏览器通过该套接字目标收到了来自 home 的响应。
5. 可达性测试：分别从任何沙箱之外的本人用户进程、该平台具有的每种沙箱方言下的受限命令（[C1](c01-home-layout.zh.md)）、另一个本地用户的进程，以及默认 Docker 网络上的容器，向该套接字发送 HTTP 请求，并记录每项的结果。只有当其中没有任何一个收到响应，且 home 把每一个都记录为被对端凭据检查拒绝时，该变体才算通过。
6. 由上述每个进程发送的伪造 `Tailscale-User-Login` 请求头没有到达任何处理程序。

若套接字目标不能工作，或第 5 步中任何进程收到了响应，回退方案仍是该平台上的约定。

<a id="identity-headers"></a>
### 身份请求头

Tailscale 身份请求头是名称以 `Tailscale-` 开头（不区分大小写）的请求头，例如 `Tailscale-User-Login`、`Tailscale-User-Name` 与 `Tailscale-User-Profile-Pic`。每个远程访问监听器都在准入之前移除它们（[C4](c04-admission.zh.md#dispatch-order)），回环监听器忽略它们。唯一的例外是套接字变体的套接字上已通过对端凭据检查的连接。在那里，`Tailscale-User-Login` 指明 tailnet 登录名；位于 tailnet 登录允许列表上的登录名可以使用 `tailnet` 身份因子登录，所有者在该套接字上的认领设定允许列表的第一项。

<a id="funnel"></a>
### Funnel

Funnel 始终以它自己的监听器 `reach-tailscale-funnel` 为目标，该监听器位于 `127.0.0.1` 上它自己的 TCP 端口；Funnel 从不以私有目标为目标。提供方用 `tailscale funnel --bg --https=<funnelPort> http://127.0.0.1:<bound port>` 配置它，用 `tailscale funnel --https=<funnelPort> off` 移除它。在任何变体下，Funnel 监听器都不信任任何身份请求头。当 tailnet 策略未授予本机 `funnel` 属性时，提供方以 `FUNNEL_NOT_PERMITTED` 拒绝启动；当 `funnelPort` 等于某个已启用的 `servePort` 时，提供方以 `PORT_CONFLICT` 拒绝启动。

<a id="own-domain-reach"></a>
### 自有域名远程访问

自有域名远程访问即自托管中继方式。本约定指定的证书颁发机构是 Let's Encrypt。

- **指定的 CA。**CAA 签发者域名是 `letsencrypt.org`，home 的 ACME 客户端只使用目录 `https://acme-v02.api.letsencrypt.org/directory`。home 的 ACME 账户密钥是位于 `~/.delo/secrets/certificates/acme-account.pem` 的 ECDSA P-256 密钥，其账户 URL 记录在 `~/.delo/secrets/certificates/account.json` 中。
- **必需的 CAA 记录。**该地址名称的相关 CAA 记录集（按 RFC 8659 所述，从该名称向根逐级上溯查找）包含 `0 issue "letsencrypt.org; accounturi=<the home's account URL>; validationmethods=tls-alpn-01"`。该记录集中的每个 `issue` 与 `issuewild` 属性都指明 `letsencrypt.org` 及该 `accounturi`；同时指明其他签发者或其他账户的记录集不通过。setup 会显示需要添加的确切记录。
- **所检查的参数。**Let's Encrypt 的 CAA 文档列出 RFC 8657 参数 `accounturi` 与 `validationmethods`，因此检查 `own-domain-caa`（[C15](c15-verification-checks.zh.md)）断言这两个参数，不断言任何其他参数。端到端的表述只依赖 `accounturi` 以及下文的质询规则。
- **检查时机。**提供方在启动之前、每次 ACME 订单之前以及每 24 小时检查该记录。记录缺失或不匹配时，在每种验证模式下提供方都会以 `CAA_MISSING` 或 `CAA_MISMATCH` 进入 `blocked`，因此该域名上的远程访问保持关闭。
- **质询规则。**中继位于路径中时，home 只使用 TLS-ALPN-01，由其自己的远程访问监听器通过其经密钥证明的隧道响应（[C6](c06-relay-protocol.zh.md#sni-routing)）。它从不发起 HTTP-01 或 DNS-01 质询。若该名称的 `_acme-challenge` 记录是指向 Delo 控制的区域（`delo.run`、`delorun.com`）的 CNAME，提供方会以 `CHALLENGE_DELEGATED` 进入 `blocked`。Delo 不承接任何委托的质询。
- **TLS 密钥。**home 为每个名称在 `~/.delo/secrets/certificates/<name>/key.pem` 中保留一个 TLS 密钥，跨续期保持不变，并在证书到期前 30 天续期。

<a id="errors"></a>
### 错误

| 代码 | 触发条件 |
| --- | --- |
| `TAILSCALE_NOT_INSTALLED` | home 的路径中没有 `tailscale`。 |
| `TAILSCALE_NOT_LOGGED_IN` | Tailscale 客户端未登录任何 tailnet。 |
| `TAILSCALE_ADDRESS_MISMATCH` | 配置的地址与 Tailscale 报告的名称不同。 |
| `FUNNEL_NOT_PERMITTED` | tailnet 策略未授予 `funnel` 属性。 |
| `PORT_CONFLICT` | `funnelPort` 等于某个已启用的 `servePort`。 |
| `NO_OWNER` | home 没有所有者。 |
| `NO_IDENTITY_FACTOR` | 未注册任何 C14 允许该地址使用的身份因子。 |
| `TAILNET_IDENTITY_UNAVAILABLE` | 在回退方案下使用 `tailnet` 身份因子。 |
| `CAA_MISSING` | 没有相关的 CAA 记录集，或没有任何记录集指明 `letsencrypt.org`。 |
| `CAA_MISMATCH` | 记录集指明了其他签发者或账户，或缺少某个必需参数。 |
| `CHALLENGE_DELEGATED` | `_acme-challenge` 是指向 Delo 控制的区域的 CNAME。 |
| `RELAY_UNREACHABLE` | 中继的隧道主机没有应答。 |
| `RELAY_REFUSED` | 中继拒绝了令牌或握手（[C6](c06-relay-protocol.zh.md#errors)）。 |
| `CERTIFICATE_UNEXPLAINED` | 一张未申请的证书无法得到解释（[C6](c06-relay-protocol.zh.md#certificate-monitoring)）。 |

<a id="delo-relay-client"></a>
### Delo 中继客户端

Delo 中继（Delo relay）客户端是一项后续功能：Delo 1.0 不注册任何 `delo-relay` 提供方，setup 也不提供该方式。添加它时，它通过同一个 Service Definition 以方式 id `delo-relay` 注册，发布一份写明 Delo Run 能看到什么、能做什么的可见性说明，其中包括 Delo 可以为某个 `delo.run` 名称获取一张公开记录的证书，并遵循 [C6 中关于 Delo 中继的规则](c06-relay-protocol.zh.md#delo-relay)。

<a id="consumers"></a>
## 消费方

- `delo/packages/reach/`：Service Definition、三个提供方、serve 与 Funnel 配置，以及中继客户端。
- `delo/packages/certificates/`：ACME 客户端、CAA 检查与质询规则。
- `delo/packages/plugin-reach-ui/`：远程访问屏幕与可见性说明。
- `delo/packages/home-auth/`：远程访问提供方变更时的轮换，以及 `tailnet` 身份因子。
- `delo/packages/contract-reach-providers/`：方式 id、状态、行、错误码与指定的 CA。
- [C11](c11-setup-answers.zh.md) 用于方式 id，[C15](c15-verification-checks.zh.md) 用于 `reach-binding` 与 `own-domain-caa`，[C8](c08-archive-and-trash.zh.md) 用于导出文件中的远程访问行。

<a id="compatibility"></a>
## 兼容性

方式 id、状态名、行名与错误码是固定的。新方式是一个新 id，带有它自己的提供方与可见性说明；对说明措辞的修改就是对本约定的修改，因为人们依赖这些说明。

关于 Tailscale serve 目标的 spike 结果未记录在本页，因此回退方案在每个平台上都是约定。通过的 spike 结果只为其报告所列的平台与 Tailscale 客户端版本采用套接字变体，方式是修改本节并记录该报告的证据。早于所记录版本的 Tailscale 客户端保持回退方案，并且每次启动时都会检查对端凭据条件。

在对等组合（[C16](c16-parity-composition.zh.md)）中，每种远程访问方式都处于关闭状态，开启远程访问不会增加任何模型可见的输入。

<a id="security"></a>
## 安全

要求：

- 每个提供方发布其可见性说明，说明写明 home 与每台设备的 IP 地址、连接时间与流量大小；对于 Tailscale，说明写明除非开启 Tailnet Lock，否则 Tailscale 可以添加设备，并写明 `ts.net` 证书由 Tailscale 获取。
- 在回退方案（即当前约定）下，身份请求头在任何监听器上都不受信任，tailnet 私有远程访问需要通行密钥或 OpenID Connect 身份因子；只要 `tailscaled` 以外的本地进程能访问 serve 目标，也适用回退方案。
- 在套接字变体下，身份请求头只在模式为 0600 的 serve 套接字上、且只对用户与 `tailscaled` 的用户相同的对端受信任，在其他任何地方都被丢弃；tailnet 登录允许列表在所有者认领时设定。
- Funnel 以它自己的监听器为目标，该监听器不信任任何身份请求头。
- 自有域名远程访问要求存在其 `accounturi` 指明 home 的 Let's Encrypt 账户的 CAA 记录，`delorun verify` 只断言 Let's Encrypt 文档所列的参数。
- 中继位于路径中时，home 不发起任何由 home 以外的一方响应的质询，也不会把任何质询委托给 Delo。
- 远程访问方式只能以交互方式开启，且须在显示其可见性说明之后，并具备所有者与允许的身份因子。

拒绝测试：

| 测试名 | 证明的行为 |
| --- | --- |
| `forged identity headers on a loopback port are ignored` | 向每个远程访问监听器的端口以及回环监听器发送的、带有伪造 `Tailscale-User-Login` 请求头的请求，到达准入时不再带有这些请求头；在回退方案下，serve 目标上同样如此。 |
| `forged identity headers on the Funnel listener are ignored` | `reach-tailscale-funnel` 上伪造的 `Tailscale-*` 请求头在任一变体下都不会使任何人登录。 |
| `the tailnet factor is refused under the fallback` | 使用 `tailnet` 身份因子注册或登录会以 `TAILNET_IDENTITY_UNAVAILABLE` 失败。 |
| `a same-user process gets no response from the serve socket` | 在套接字变体下，来自本人用户的进程的连接会在读取任何请求之前被对端凭据检查关闭。 |
| `an own domain without the CAA record fails verify and stays off` | 没有 CAA 记录，或记录指明其他账户或签发者时，`delorun verify` 的 `own-domain-caa` 失败，并且自托管中继提供方在每种验证模式下都保持 `blocked`。 |
| `with a relay in the path the home starts no off-home challenge` | 针对 ACME 替身，中继位于路径中时 home 发起的每个质询都是由 home 的远程访问监听器响应的 TLS-ALPN-01，且 home 不发起任何 HTTP-01 或 DNS-01 质询。 |
| `a challenge delegated to Delo blocks the provider` | 指向 `delo.run` 的 `_acme-challenge` CNAME 使提供方以 `CHALLENGE_DELEGATED` 进入 `blocked`。 |
| `Funnel and serve cannot share a port` | 以相同端口启用两种方式会以 `PORT_CONFLICT` 失败。 |

<a id="what-this-does-not-prove"></a>
### 本约定不能证明的内容

- **CAA `validationmethods` 检查。** `own-domain-caa` 断言 `validationmethods=tls-alpn-01`，因为 Let's Encrypt 支持 RFC 8657 参数，远程访问工作包的证书测试会对照 Let's Encrypt 文档所述的行为确认这一点。该检查通过 home 的解析器读取记录；在签发时起作用的控制是证书颁发机构自己的查询。
- **Windows。** Windows 没有针对 Unix 套接字的对端凭据检查，因此没有套接字变体：无论 spike 在其他平台上记录什么，Windows 上的约定都是回退方案。
- **Tailscale。** 除非开启 Tailnet Lock，否则 Tailscale 的协调服务可以向 tailnet 添加设备，并且 Tailscale 获取 `ts.net` 证书；Delo 的任何检查都无法检测这两者。
- **回退方案下的本地进程。** 在回退方案下，任何本地进程都可以连接 Tailscale 私有目标；它随后只会像远程设备那样获得准入，因此本约定不阻止它尝试登录。

<a id="decided-values"></a>
## 决定的取值

- 指定的证书颁发机构：Let's Encrypt，CAA 签发者域名为 `letsencrypt.org`，ACME 目录为 `https://acme-v02.api.letsencrypt.org/directory`，并断言 `accounturi` 与 `validationmethods=tls-alpn-01`。
- CAA 记录在启动之前、每次 ACME 订单之前以及每 24 小时检查一次；证书在到期前 30 天续期。
- Tailscale 私有目标：在每个平台上都是 `127.0.0.1` 上的一个 TCP 端口（回退方案），直到某个 spike 结果为某个平台采用套接字变体。
- 默认端口：Tailscale 私有为 443，Funnel 为 8443。
