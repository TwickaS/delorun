---
description: "在此人自己的 tailnet 上远程访问的设计：只在 home 所在的电脑上通过一个简短的批准窗口批准设备，用已批准设备的密钥登录，远程会话可以做和不可以做什么，以及仍然存在的局限。"
---

# 在你自己的 tailnet 上远程访问

[English](reach.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

reach 让一个人通过自己的 Tailscale tailnet，从自己的手机或笔记本电脑打开自己的 studio，路径上没有任何 Delorun 的服务。新设备只能在 home 所在的电脑上、在此人于那里打开的一个简短的批准窗口期间获得批准。已批准的设备用它的设备密钥登录。远程会话可以观看、回复、开始 chat、批准普通提示并停止运行；它不能授予完全访问、批准或移除设备，也不能更改 reach 或保护。这些要等到此人在电脑旁才行，并且是 home 拒绝它们，而不是远程页面。准入规则见[约定 C4](../contracts/c04-admission.zh.md)，设备批准见[约定 C5](../contracts/c05-device-approval.zh.md)，reach 提供方见[约定 C7](../contracts/c07-reach-providers.zh.md)，身份因子见[约定 C14](../contracts/c14-oidc-passkeys.zh.md)。

## 目录

- [今天已有的内容](#what-exists-today)
- [设备会遇到的确切 Fetch 路由](#exact-fetch-routes-a-device-meets)
- [规则](#the-rules)
- [本设计不防护什么](#what-this-does-not-protect-against)
- [拒绝测试](#denial-tests)
- [从未在真实的 tailnet 或手机上运行](#never-run-on-a-real-tailnet-or-phone)
- [实现状态](#implementation-status)

<a id="what-exists-today"></a>

## 今天已有的内容

- **tailnet 私有的 reach 已构建，并且在此人开启之前是关闭的**，开启方式是 `delorun reach on tailscale`，或 setup 的 Full 模式中回答“是”。`@delorun/reach` 绑定 `127.0.0.1` 上一个固定的端口，该端口从 20000 到 32767 中选定一次，把它中继到 reach 监听器，并把 `tailscale serve` 配置到该端口，绝不通过 `sudo`。它拒绝为该地址启用 Funnel，并默认每分钟重新检查一次 Tailscale。在写入自己的 serve 规则之前，它会移除 serve 端口上的任何其他规则，`delorun reach on` 和 `off` 也这样做，所以较早一次运行留在 `tailscaled` 中的规则会在下次启动时被清除。setup 的 `--yes` 让 reach 保持关闭，而指名了 `none` 以外任何 reach 选项的 `--config` 文档会被拒绝。
- **设备在电脑上用匹配码批准。**此人在回环 studio 中或用 `delorun devices approve` 打开一个 5 分钟的批准窗口；手机的登录页面请求批准并显示一个 8 位数字代码；此人选择等待中的请求并输入该代码。回环形式需要 studio 自己的凭据和 origin。`delorun devices approve` 通过更新渠道、带着启动令牌访问 home 进程，Host 自己的渠道令牌无法替代它。窗口会在读取请求体之前就拒绝窗口之外的请求，最多有 5 个请求在等待，输错三次代码会取消那个请求。
- **设备用它的密钥登录。**已批准的手机用一个永不离开它的密钥对新的质询进行签名，home 创建一个身份因子为 `tailnet-membership` 的会话：闲置 12 小时，绝对 14 天，使用 24 小时之后滚动，并因任何批准或移除而轮换。移除设备会在移除返回之前结束它的会话并关闭它的连接。
- **设备会话被允许一份固定的列表。**会话代表一个 `reach-device` 主体发言，Gateway 的调用和事件要经过一个默认拒绝的策略。它可以做此人在电脑上所做的事，即阅读和驱动 chat、选择尚未开始的 chat 所运行的预设，以及阅读插件和 chat 自己工作区的文件，但它不能更改设置、插件、工作区、终端、凭据或账户。[C14](../contracts/c14-oidc-passkeys.zh.md#what-a-device-may-call) 保存分类，`reach-access.ts` 保存每个动作的原因。登录之后，设备只能访问一份固定的路径列表（studio 页面及其资源、`/api`、`/plugins`、`/auth` 和 `/delorun/reach/status`）；其他每个 web 路由、升级和回退都以 `403 LOOPBACK_REQUIRED` 作答，无论该路由自己是否检查任何东西。在 `/api` 之下，只有当确切的路由接纳非所有者调用方时，它才会回答设备：图片上传路由会，用于策略允许的 chat，信任账单路由会，用于读取。从设备回答的完全访问批准会被拒绝，提示仍保持打开，等待电脑。手机显示 “This needs you at your computer” 以及该动作的名称。
- **回环路由**，即所有者认领、设备列表、批准窗口、待处理请求、批准和移除，只在回环 studio 上、在 studio 的凭据之后作答，并拒绝指名了 reach 地址的 `Host`。
- studio 的“设备”部分列出设备、打开窗口，并根据 `GET /delorun/reach/status` 显示地址的状态。
- **尚未构建：**Funnel 和中继提供方、passkey、OpenID Connect、恢复套件、`delorun devices reset`、告警，以及带有闲置限制的回环凭据记录。
- 回环 studio 接纳上游的启动令牌及其无状态的 `dsh-auth-*` cookie，这些 cookie 在铸造 30 天后过期，没有闲置限制，也没有服务端记录，并在 `.credentials.yaml` 中的浏览器会话密钥改变之前一直有效；Delorun 从不改变它。每个持有这样一个 cookie 的浏览器都作为唯一的所有者行事。回环 studio 不发送内容安全策略。

<a id="exact-fetch-routes-a-device-meets"></a>

## 设备会遇到的确切 Fetch 路由

在 `/api` 之下，只有当确切的 Fetch 路由接纳该 Peer 时，它才会回答设备。CLI 组合的每个路由在这里都有一个决定，`delorun/apps/cli/tests/denial/reach/reach-paths.integration.spec.ts` 在某个路由没有决定时会失败。新路由会被拒绝，除非设备需要它来使用它已经可以读取的 chat、把此人引向电脑，或者因为 studio 在每个页面上都显示它。

| 路由 | 设备 | 原因 |
| --- | --- | --- |
| `/api/session/uploadFileBinary` | 逐次调用 | 远程访问决定 `fileUploads/upload`，`reach-device` 策略允许它，所以手机可以向它可以写入的 chat 附加文件。 |
| `/api/delorunChatStates.list`、`/api/delorunChatStates.set` | 拒绝 | 搁置和已处理状态在电脑上给 chat 列表排序；设备不需要它们就能渲染每个 chat。 |
| `/api/delorunOnboarding.keyTest` | 逐页 | 已批准的手机测试它的模型密钥；答案指出每家提供方及其结果，绝不包含密钥。已批准的设备无需解锁即被接纳，而 PIN 模式开启时只有用 PIN 解锁的页面才被接纳。密钥 Remote 对 `credentials/describe`、`credentials/set` 和 `credentials/unset` 的调用遵循同样的规则。 |
| `/api/delorunOnboarding.setupRecord` | 拒绝 | 终端 setup 记录的内容服务于电脑上的新手引导。 |
| `/api/delorunOnboarding.addWorkspace` | 拒绝，`LOOPBACK_ONLY` | 把文件夹添加为工作区是工作区管理，由 home 所在的电脑掌握；新手引导会在上游的门之前，对不在回环监听器上的请求拒绝它。 |
| `/api/delorunNetwork.list`、`/api/delorunNetwork.set` | 拒绝，`LOOPBACK_REQUIRED` | 工作区中沙箱命令的网络只在 home 所在的电脑上读取和更改；权限默认值会在上游的门之前，对不在回环监听器上的请求拒绝两者。 |
| `/api/delorunMainChat.open`、`/api/delorunMainChat.reports` | 拒绝 | 打开主 chat 会选择它的预设，报告数量标记电脑的侧边栏；设备通过 `session/page` 读取主 chat。 |
| `/api/delorunTrust.bill` | 只读 | 信任徽章显示在每个 studio 页面上，包括设备的页面，账单指出运行什么以及检查了什么，不含任何密钥。该路由接纳设备的 `GET`。 |
| `/api/delorunTrust.check` | 拒绝 | Check now 会对每个运行时文件做哈希并运行发布日志检查，只有 home 所在的电脑才启动它。 |
| `/api/delorunUpdateCheck.notice` | 拒绝 | 通知指出正在运行的发布版本以及更新会关闭多少个插件，而更新只在电脑上运行。 |
| `/api/delorunTrash.*` | 拒绝 | 移入、恢复或从回收站删除，不在设备规则之内。 |
| `/api/delorunPermission.workspaces`、`/api/delorunPermission.review`、`/api/delorunPermission.setFullAccess` | 拒绝，`LOOPBACK_REQUIRED` | 工作区的完全访问是一项完全访问授权，只有 home 所在的电脑才能给出；`@delorun/plugin-permission-defaults` 会在上游的门之前拒绝设备，那里的 studio 会提示在电脑上开启它。 |
| `/api/delorunMcpConsent.pending`、`/api/delorunMcpConsent.accept`、`/api/delorunMcpConsent.decline`、`/api/delorunMcpConsent.revoke` | 拒绝，`LOOPBACK_REQUIRED` | 接受或撤销 stdio MCP 服务器，决定它的命令是否在沙箱之外运行，这只由 home 所在的电脑决定；`@delorun/plugin-mcp-consent` 会在上游的门之前拒绝设备。 |
| `/api/delorunMcpConsent.waiting` | 接纳，通过该路由的 `admitPeer` | 它只回答等待此人同意的服务器的名称以及什么发生了变化，不含它们的命令、参数、文件夹或环境，所以手机会提示到电脑上批准它们。 |
| `/api/session.export`、`/api/session.markdown`、`/api/plugin-manager/detail-file`、`/api/file`、`/api/present.host`、`/api/present.open`、`/api/changes.summary`、`/api/changes.open`、`/api/changes.diff` | 拒绝 | 上游没有声明设备准入，所以只有所有者能访问它们。 |

<a id="the-rules"></a>

## 规则

### 路由

1. Tailscale 私有路由的 serve 目标是 `127.0.0.1` 上的 TCP 端口。Tailscale 的身份标头在准入之前被移除，并且在任何地方都不被信任，监听器检查 `Host`，C4 的 `Origin` 和 cookie 规则像在每个 reach 监听器上那样适用。
2. 到达时采用失败即关闭：没有监听器戳记的请求是 reach 请求，绝不是回环请求，提供方的监听器为每个请求加盖戳记。这在提供方被构建之前就成立。
3. 该路由有它自己的身份因子 `tailnet-membership`。它不携带任何证明：它只说明请求是通过提供方的 serve 目标到达的。会话记录存储该因子，并且该因子在 Funnel 或自有域名的地址上会被拒绝。提供方声明它的因子，所以以后的提供方声明它自己的因子。

### 登录与批准

4. 登录只靠已批准的设备密钥。在私有路由上，已批准的设备对新的质询给出有效签名，就会创建会话；C5 的质询、地址绑定和 `DEVICE_NOT_TRUSTED` 拒绝均适用。这条路由上没有 passkey，也没有 OpenID Connect。
5. 只有在批准窗口打开期间才接受批准请求。此人在 home 所在的电脑上打开一个窗口，方式是回环 studio 的 “Add a device” 或会等待的 `delorun devices approve`。窗口持续 5 分钟，并在第一次批准时关闭。在窗口之外，`POST /auth/device/request` 在不读取请求体的情况下以 `APPROVALS_CLOSED` 作答。窗口取代了这条路由上的常设请求队列，因为这条路由上的每个请求都有相同的源地址，所以按来源设置的限制就会成为一个共享的限制，任何 tailnet 设备都能把它填满。
6. 设备只在 home 所在的电脑上批准。批准者是回环 studio 会话或 `delorun devices approve`，它显示请求的标签、平台和时间，索要新设备上显示的八位数字匹配码，并把批准者记录为 `local`。home 进程只接受来自此人在 home 套接字上的自己命令的 `devices.approve`，并对 Host 的渠道令牌拒绝它，因为后者代表 reach 会话行事。

### 远程会话可以做什么

7. 私有路由上的会话可以观看、回复、开始 chat、批准普通提示并停止运行。
8. 它不可以做下列事情，并且 home 对每一项都以 `LOOPBACK_REQUIRED` 拒绝：通过逐次调用的升级或按工作区的同意授予完全访问；批准或移除设备；重置 home；使用恢复套件；注册身份因子；更改 reach 设置；或更改[更改](changes.zh.md)的保护设置。批准的答案把会话的因子带给授予权限的代码，所以拒绝不依赖于远程页面。远程 studio 显示 “This needs you at your computer” 以及该动作的名称。
9. 因此不可能在远程会话中安装插件：上游要求对 `plugin_manager` 的每个写入操作进行完全访问批准。

<a id="loopback-credentials"></a>

### 回环凭据

规则 10 到 12 尚未构建：上游的连接发出 `authenticator/minted`，没有提供方监听它，所以不存在记录、闲置限制或重置。

10. `@delorun/home-auth` 在上游的连接铸造每个回环凭据时记录它（`authenticator/minted` 事件，它携带凭据的 SHA-256 哈希而绝不含其值），并以 `401 SESSION_EXPIRED` 拒绝能通过验证但没有记录的回环凭据。
11. 回环凭据在最后一次使用 7 天之后，或铸造 30 天之后（以先到者为准）过期，并由 [C4](../contracts/c04-admission.zh.md#rotation-and-revocation) 的轮换事件替换。
12. `delorun devices reset` 替换上游 `.credentials.yaml` 中的浏览器会话密钥，所以在它之前铸造的每个回环 cookie 都会失效。

### 命令

13. `delorun reach status | on tailscale | off` 和 `delorun devices list | approve | elevate | remove | code`；`elevate` 回答设备解锁敏感操作的请求（见 [C14](../contracts/c14-oidc-passkeys.zh.md#elevation)）。`delorun reach on tailscale` 检查 `tailscale` 已安装并在运行、tailnet 已开启 HTTPS 证书，以及此人可以运行 `tailscale serve`；对于最后一项，它会打印此人自己要运行的那一条命令，Delorun 从不运行 `sudo`。没有所有者的 home 通过 home 套接字以本地人的身份被认领。

<a id="what-this-does-not-protect-against"></a>

## 本设计不防护什么

- **已批准、已解锁的手机。**它的持有者拥有这些 chat，并可以在电脑上已经授予的范围内驱动 agent。这一限制是局部的：此人已在电脑上设为完全访问的工作区，仍然可以从手机上操作，在那里运行的命令可以做此人的用户能做的任何事，包括写入设备记录。保护措施是手机自己的锁、在电脑上移除设备，以及远程会话的闲置超时。
- **回环 studio 中的脚本。**注入回环 studio 的脚本可以打开窗口并批准设备，而在这条路由上这不需要第二个因子。Delorun 不为回环 studio 设置自己的内容安全策略。
- **Tailscale。**除非开启了 Tailnet Lock，否则 Tailscale 可以把设备添加到 tailnet，并且它持有 `ts.net` 证书的密钥。被添加的设备仍然需要在 home 所在的电脑上获得批准。
- **请求来自哪里。**这条路由上的每个请求的来源都是 `127.0.0.1`，所以 home 无法验证批准请求的来源。窗口打开期间，任何 tailnet 设备都可以提出请求；匹配码把批准绑定到此人读取其屏幕的那台设备，没有任何东西显示是谁持有那台设备。
- **启动令牌。**在电脑上的批准依赖于 agent 无法读取启动令牌（C1 对其命令的约束）。以此人的用户身份在沙箱之外运行的进程可以读取令牌，并通过更新渠道打开批准窗口、用匹配码批准待处理请求、取消请求、移除设备并获得新的 studio 登录链接。当它同时控制提出请求的设备时，它会在无人在场的情况下批准该设备。
- **没有清理就停止的 home 进程。**`tailscaled` 会继续把地址转发到固定端口，直到下一次启动或 `delorun reach off`。在这段时间里，绑定该端口的另一个本地用户会向手机的 origin 提供服务（见 [C7](../contracts/c07-reach-providers.zh.md#what-this-does-not-prove)）。
- **没有外部评审。**对本设计或 reach 都没有进行过外部安全评审。

<a id="denial-tests"></a>

## 拒绝测试

- `an unapproved device on the tailnet route gets no session`
- `a request outside a window is refused unread`
- `a request without a listener stamp is not loopback`
- `a tailnet-route session cannot approve a device`
- `a tailnet-route session cannot grant full access by the escalation prompt or the workspace consent`
- `a tailnet-route session cannot remove a device, reset, enrol a factor or change reach`
- `the channel token cannot call devices.approve`
- `a forged Tailscale-User-Login changes nothing`
- `a foreign Host on the serve target is refused`
- `owner claim on the tailnet route is refused`
- `tailnet-membership is refused on a Funnel or own-domain address`
- `idle and absolute limits refuse a loopback credential`（尚未构建）
- `a loopback credential without a record is refused`（尚未构建）
- `a loopback cookie minted before devices reset is refused after it`（尚未构建）

<a id="never-run-on-a-real-tailnet-or-phone"></a>

## 从未在真实的 tailnet 或手机上运行

这些规格伪造了 `tailscale`，并通过回环驱动固定端口。下列内容从未在真实的 tailnet 或手机上运行过：

- `tailscale serve status --json` 的真实输出，如 `readServeRules` 所读取的；
- 该输出中用于 Funnel 检测和拒绝的 Funnel 字段；
- 较旧的 Tailscale 客户端上的 `--https=<port> off`，它可能采用另一种形式；
- 前台的 `tailscale serve` 会话，`readServeRules` 会读取但不会创建它们；
- 真实手机浏览器中的登录页面：IndexedDB 设备密钥、WebCrypto 签名和内容安全策略；
- 允许列表下手机上的 studio；
- 完全访问提示被拒绝时的答复通知；
- 从手机上传图片；
- 手机上 24 小时的令牌滚动；
- 使用真实启动 cookie 的“设备”部分；
- 真实手机页面上 1,000 个 chat 的列表的开销。

<a id="implementation-status"></a>

## 实现状态

基本原则 F11、F12 和 F13 指出已构建的拒绝（见[基本原则](../security/fundamentals.zh.md)）。passkey、OpenID Connect、恢复套件、重置、告警、Funnel 和中继提供方以及回环凭据记录尚未构建。

待办的后续工作：

- `@delorun/reach` 只读取它自己的地址和端口上的 serve 规则，所以另一个 serve 端口或到监听器端口的 TCP 转发不会被注意到，并且在 `tailscale serve status` 的输出多次无法读取之后它仍继续提供服务。
- 规则 10 到 12 的回环凭据记录。
- Gateway 决定非所有者 Peer 是否接收并可以回答全局资源上被转发的 waterfall，而不是根据引发它的 chat 来决定。
