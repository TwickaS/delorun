---
description: "Delorun 的远程访问登录，供 admission seam 的维护者使用：在 home 受保护记录之上的所有者认领与设备列表、C4、C5 与 C14 所描述的 authenticator 提供方，以及在 Delorun 所发布 web 组合上证明 C4 监听器与分发规则的拒绝测试套件。"
---

# @delorun/home-auth

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本包承载 [约定 C4](../../docs/contracts/c04-admission.zh.md#authenticator) 的 authenticator 提供方，同时包含 [C5](../../docs/contracts/c05-device-approval.zh.md) 的所有者认领与设备批准、[C14](../../docs/contracts/c14-oidc-passkeys.zh.md) 的身份因子，以及 C4 的服务端远程访问会话。它提供 `authenticator`，包括以已批准设备的密钥登录、批准窗口与本地批准、`tailnet-membership` 身份因子，以及已批准设备可调用内容的允许列表，每个 CLI profile 都以 `delorun-home-auth` 行加载它。回环 studio 仍由上游的启动令牌与 cookie 准入，远程访问监听器只在远程访问提供方请求时才提供服务，因此远程访问关闭时，任何远程访问路由都不应答。前半部分是所有者认领与设备列表：`~/.delorun/secrets/home-auth/` 下的记录、应答这些记录的路由，以及结束设备在线会话的移除。C4 的准入拒绝测试套件证明准入 seam 的上游一半，它位于组合 studio 的 CLI 中，即 `delorun/apps/cli/tests/denial/`：上游的 connection 声明 `Authenticator` Service Definition，并通过 `ctx.connection.openReachListener` 打开远程访问监听器；web 服务器在任何路由、upgrade 或回退之前，运行每个远程访问监听器的分发器。约定的标识符、代码与限制来自 [`@delorun/contract-admission`](../contract-admission/README.zh.md)。

## 目录

- [所有者认领与设备列表](#the-owner-claim-and-device-list)
- [远程访问登录](#reach-sign-in)
- [准入拒绝测试套件](#the-admission-denial-suite)
- [危险模式](#dangerous-mode)
- [PIN 模式](#pin-mode)
- [Face ID 解锁](#face-id-unlock)
- [给提供方的说明](#notes-for-the-provider)
- [测试](#tests)

<a id="the-owner-claim-and-device-list"></a>
## 所有者认领与设备列表

`src/home-auth.ts` 是 `~/.delorun/secrets/home-auth/` 之上的协调者，`src/service.ts` 把它作为 `homeAuth` 服务挂载，并在 `ctx.effect()` 内把 `POST /auth/owner/claim`、`GET /auth/devices` 与 `POST /auth/devices/remove` 注册到 web 服务器。下面每条规则都由 `tests/` 下的一个 spec 固定：

- **所有者验证码**（`owner-code.json`）。128 位随机数写成 26 个 base32 字符，只打印一次，并且只以 SHA-256 摘要保存。验证码只能使用一次，并在打印后 10 分钟过期；错误的验证码会保留原有的验证码，新的验证码则取代它。
- **认领**（`owner.json`、`devices.json`）。只接受回环访问，且即使没有任何分发器标记请求，`Host` 指向远程访问地址也会被拒绝。认领记录的是监听器自身的 origin `http://127.0.0.1:3080`，无论请求使用哪种回环写法——`localhost`、`127.0.0.1`、`[::1]`、`.localhost` 名称、带或不带端口、经由 SSH 端口转发——并且会以 `BAD_REQUEST` 拒绝根本不是 authority 的 `Host`，因此攻击者写入的请求头永远不会成为设备的地址。一个 home 只有一个所有者：持有效新验证码的第二个认领者会以 `ALREADY_OWNED` 被拒绝，第一个所有者保有自己的 home；同时发起的两个认领会串行执行，因此恰好一个赢得所有者席位。验证码在写入任何记录之前就被消耗，因此认领过 home 的验证码不会再认领第二个 home；而记录了设备却没有所有者的 home 会以 `STORE_INVALID` 拒绝认领，而不是接管这些设备。
- **到达**。只有当请求不带任何远程访问监听器的标记、且由回环监听器自己的 socket 接受时，它才是回环请求：其本地端口是 web 服务器绑定的端口，其本地地址是回环地址。其他任何请求都绝不是回环请求（`a request without a listener stamp is not loopback` 这个 spec），因此漏掉标记的转发请求得不到任何东西。
- **设备路由的到达**。`GET /auth/devices` 与 `POST /auth/devices/remove` 只在回环监听器上应答：两者都在读取任何内容之前判断到达，对远程访问监听器准入的请求应答 `403 LOOPBACK_REQUIRED`，`Host` 指向其他地址会以 `421 HOST_MISMATCH` 被拒绝；移除还会以 `403 ORIGIN_MISMATCH` 拒绝来自其他 origin 的页面——`Origin` 不是请求自身的 origin，或 `Sec-Fetch-Site` 指向外部。正是这一点，使一个由解析到 `127.0.0.1` 的名称所提供的页面（DNS rebinding）无法读取 home 的记录或移除设备，也使跨站表单无法提交移除。回环上的每条设备路由——列表、移除、批准窗口、待处理请求与批准——还需要 studio 自己的凭据，`connection.requestRejection` 像对上游自己的路由一样检查它：浏览器已签名的启动 cookie，或在线的 API 凭据。没有它的请求以 `401 NOT_SIGNED_IN` 被拒绝，因此电脑上的其他程序、对话运行的命令或其他用户只能到达该端口，别无其他。状态变更还需要与 studio 自己的回环 origin 相同的 `Origin`；没有它的请求以 `403 ORIGIN_MISMATCH` 被拒绝。`delorun devices` 使用 home 套接字的 `devices.approve` 与 `devices.remove`，从不使用这些路由。任何路由都不返回匹配码：待处理列表只携带请求的标签、平台、地址与时间。
- **设备列表**。所有者与每一台受信任设备，不含密钥材料。未认领的 home 会以 `NO_OWNER` 拒绝列表与移除，而不是像拥有空设备列表那样应答。所有者记录与设备列表会相互核对，因此被复制过来、指名本 home 未记录的第一台设备的 `owner.json` 会以 `STORE_INVALID` 失败而不是成为所有者，任何列表、会话或移除都不会替它行事。
- **会话**（`sessions.json`）。令牌只下发一次，并以作为记录键的 SHA-256 摘要保存，因此复制该文件无法让任何人登录。会话只会为已记录、且记录地址与请求一致的设备签发：没有所有者的 home 以 `NO_OWNER` 拒绝，无法读取的所有者记录以 `STORE_INVALID` 拒绝，本 home 未记录的密钥——另一个 home 的设备、位于其他地址的设备，或刚被撤销的设备——以 `DEVICE_NOT_TRUSTED` 拒绝。只有当设备仍按其会话地址被记录时，会话才被视为在线，因此设备记录已消失的令牌不会再应答任何内容，即使它自己的记录仍然存在。
- **移除**。删除设备记录、使其令牌的每个在线会话失效、轮换其他每个会话、释放该设备的 Peer，并通过 `ctx.connection.closeReachConnections({ deviceId })` 关闭这些会话准入的远程访问连接，全部在返回之前完成；没有记录的设备同样会结束其会话。
- **限制**。一个 home 最多信任 32 台设备（`DEVICE_LIMIT_REACHED`，`429`），一台设备最多持有 16 个在线会话（`SESSION_LIMIT_REACHED`，`429`）；在统计上限之前会先丢弃已过期的会话记录，因此在会话过期后再次登录的设备永远不会被它们拒绝。登录质询路由每分钟最多向一个来源签发 `challenges.perSourcePerMinute`（默认 60）个质询，向一台受信任设备签发 `challenges.perDevicePerMinute`（默认 10）个，超出后以 `CHALLENGE_RATE_LIMITED`（`429`）拒绝；两个字段的范围都是 1 到 600，超出范围时加载失败。
- **记录**。每个文件都经 [约定 C1](../../docs/contracts/c01-home-layout.zh.md) 的受保护文件检查读取，因此其他用户可以读取的文件，或不是本包 JSON 的文件，会以 `STORE_INVALID` 拒绝，而不是被当作空内容读取并让一次认领覆盖它。

<a id="reach-sign-in"></a>
## 远程访问登录

`src/authenticator.ts` 是上游 `authenticator`（[C4](../../docs/contracts/c04-admission.zh.md#authenticator)）的提供方，服务把它作为子插件加载。它在回环监听器上保留上游的准入，并且只在远程访问提供方为某个远程访问监听器调用了 `homeAuth.serve()` 时才服务该监听器，使用该提供方声明的身份因子；只接受 Tailscale 私有监听器的 `ts.net` 地址上的 `tailnet-membership`（否则为 `TAILNET_IDENTITY_UNAVAILABLE`）。`admit` 在存储的内存副本上同步运行，每次变更都会在返回之前重新读取该副本；它给每个请求标记其监听器、应答登录前路由，并把 `__Host-delorun-session` cookie 准入为每台设备、每个监听器一个 Peer，它代表设备的 `reach-device` 主体，绝不代表所有者；超过 12 小时未使用或已满 14 天时拒绝为 `SESSION_EXPIRED`，在设备批准或移除之后拒绝为 `ROTATION_REQUIRED`；会话打开的远程访问连接在同样的时刻关闭，无需等待请求。在令牌已满 24 小时的会话上，不带 `Upgrade` 的请求会在 `setCookie` 中收到新令牌；旧令牌再准入 30 秒后被删除，两者都不延长绝对上限。

- **批准窗口与本地批准**（[C5](../../docs/contracts/c05-device-approval.zh.md#approval-window)）。回环上的 `POST /auth/devices/window`，或 home 套接字的 `devices.approve`，打开一个 5 分钟的窗口，并为本地的本人认领没有所有者的 home。窗口之外的 `POST /auth/device/request` 在读取请求体之前应答 `APPROVALS_CLOSED`。`GET /auth/devices/pending`、`POST /auth/devices/approve` 与 `POST /auth/devices/cancel` 是回环批准表单，位于 studio 的凭据之后；第三次错误的匹配码只取消该请求，`Approvals.cancel` 按本人的选择取消一个待处理请求（带 `cancelRequestId` 的 home 套接字 `devices.approve`），批准会记录批准者 `local`、轮换每个会话并关闭窗口。已满的 home 拒绝第六个请求，且不替换任何请求。带有控制字符或双向格式字符的标签或平台以 `BAD_REQUEST` 被拒绝。
- **登录**。`POST /auth/device/challenge` 与 `POST /auth/session` 校验对 `delorun-signin-v1`、地址以及一次性 60 秒质询的 ECDSA P-256 签名；在 Tailscale 私有监听器上，仅凭已批准设备的签名即可创建带因子 `tailnet-membership` 的完整会话。登录页面（`GET /auth/sign-in`）从 `assets/` 加载两个以内容哈希命名的资产，把设备密钥以不可导出的形式保存在 IndexedDB 中，并以与 `src/match-code.ts` 相同的推导计算匹配码。浏览器在没有有效会话时打开该地址的任何其他页面（地址本身、深层链接或输错的路径），都会以 `303` 被送到该页面，当目标是 `/auth` 之外的普通路径时，页面的 `next` 会保留它，因此设备登录后会落在那里。对于其他任何 `next`（包括绝对 URL 或省略协议的 URL），页面以 `303` 跳转到不带它的自身，因此绝不会把设备送离该地址。脚本的请求、状态变更与 upgrade 保持 `401` JSON 拒绝，回环监听器从不重定向。它的标记 `assets/sign-in.html` 不含文字，也不含内联脚本、样式或处理器；`assets/sign-in.js` 以英文和中文保存每段文字，按浏览器的语言选择，并为每种状态显示一个视图：检查设备、新设备的步骤与设备名称、要在电脑上输入的匹配码及其剩余时间（其间页面每 2.5 秒读取一次请求的状态）、正在登录，以及每种拒绝及其下一步（电脑上的批准已关闭、已有五个请求在等待、请求过多、设备的登录数已达上限、已取消、已过期、无法连接 home、浏览器不支持 WebCrypto 或 IndexedDB 密钥存储，以及带代码的其他任何拒绝）。studio 的包在登录之前不会加载，因此页面加载的样式表是一个资产：`@delorun/brand` 的 `tokens.css`、来自 `@delorun/brand/soft-surfaces` 的 studio 默认外观（Soft）的页面、卡片和文字颜色，以及 `assets/sign-in.css`；后者读取 `--dl-*` 颜色与字体栈，不含任何颜色字面量，所以该页面与人登录后进入的 studio 一致；`@delorun/plugin-theme` 的 `tests/soft-surfaces.spec.ts` 使这些颜色与 Soft 调色板保持一致。标记通过 `src/sign-in-template.ts` 从品牌取得标志和 `theme-color` 值。`gates:brand-drift` 覆盖 `assets/`，`tests/sign-in-contrast.spec.ts` 使每对文字颜色在两种配色方案下都保持 4.5:1。
- **home 自己电脑的拒绝**（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#tailnet-membership)）。窗口、批准与移除路由对远程访问会话应答 `403 LOOPBACK_REQUIRED` 并写明操作。提供方还提供上游的 `remoteAnswerGuard`：远程访问 Peer 对携带 `grants: "full-access"`（升级到 `danger-full-access`，包括 `plugin_manager` 的升级，或工作区的完全访问同意）或 `grants: "workspace-management"`（主对话的账户工具及其受防护的工具调用，以及 `@delorun/plugin-instruction-consent` 询问的指令层写入）的审批提示给出的授予性答复（除 `rejected`、`cancelled` 或 `unavailable` 之外的任何答复）会以 `LOOPBACK_REQUIRED` 被拒绝并写明 `full-access-escalation` 或 `workspace-management`，且不被应用，因此该提示对 home 电脑上的 studio 保持打开。来自设备的拒绝会被应用。其他只允许 home 自己的电脑使用的 Delorun 插件路由，会在其 `connection/request` 监听器中调用 `requireComputer`（`src/computer-only.ts`）：未经回环监听器、以回环 `Host` 到达的请求，或在没有挂载 `homeAuth` 时的任何请求，都会在路由读取其请求体之前被应答 `403 LOOPBACK_REQUIRED` 并写明操作。
- **弹窗配对**（C5，[弹窗配对](../../docs/contracts/c05-device-approval.zh.md#pop-up-pairing)）。`src/pairing.ts` 在一个 `resolvePairing` 步骤中解析插件的 `pairing` 配置（Delorun 的默认值；schema 保存各项界限，因此越界的值会使加载或设置写入失败；该部分是易变字段，每次使用时读取，所以更改无需重启即生效），并读取 `tailscale serve` 设置的 `Tailscale-User-Login` 与 `Tailscale-User-Name` 头。在批准窗口之外，`POST /auth/device/request` 只接受 `pairing.mayAskWithoutWindow` 允许的身份（`own-user` 与 `ServedListener.computerUser` 比较，后者由 `@delorun/reach` 从 `tailscale status --json` 读取），每个 Tailscale 用户最多 `pairing.pendingPerIdentity` 个在等待，全局上限为 5，其中无窗口的请求最多占 4 个，因此通过人所打开的窗口发来的请求总有余位；其他任何请求在读取请求体之前就应答 `APPROVALS_CLOSED`。这些头只是配额与显示提示，绝不是授权：请求仍然需要在电脑上输入匹配码。`GET /auth/devices/pending`（仅回环）返回每个请求的身份、无窗口标记和错误代码次数，以及 studio 的通知所遵循的 `pairing` 值。服务把 `pairing` 部分注册为仅限电脑的设置，因此远程访问设备不能写入它。
- **设备可以调用什么**（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#what-a-device-may-call)）。`src/reach-access.ts` 声明 `reach-device` 主体（其字段是设备 id 与其 Peer 所在的监听器），以及提供方通过上游的 `remoteAccess.registerPolicy` 为它注册的远程访问策略。上游的 Gateway 在分派远程访问 Peer 的每次调用之前、在向其转发每个事件之前，都会询问该策略。该策略默认拒绝：对在主体的监听器上持有 Peer 的设备，它在全局资源、Workspace 注册表中的每个 Workspace，以及属于某个 Workspace 或在 Host 中在线的每个 Session 上绑定 `REACH_ALLOWED_ACTIONS`（本人在电脑上对对话和工作区所做的事，依据所有者的规则：已批准的设备本来就能向 agent 发出提示）与 `REACH_ELEVATED_ACTIONS` 的操作；Session 或 Workspace 变更时重新计算快照。`createCondition` 按调用决定：提权操作以 `elevation-required: <action>` 被拒绝，除非设备在该监听器上持有提权；在已知工作区之外的 `session/create` 以 `CREATE_OUTSIDE_WORKSPACES` 同样被拒绝；可能关闭仅电脑开关（已挂载插件通过 `HomeAuthService.registerComputerOnlySwitch` 注册的字段，例如外部 agent 同意的 `enabled`，写入值不是该开关的字面量 `safeValue`（除非注册指明 `false`，否则为 `true`；同意的 `fullAccessStartsAgents` 就这样指明，使只有电脑才能把它打开），或参数无法读取）的设置写入以 `switchOffRefusal(label, safeValue)` 被拒绝；会放宽权限预设配置项 `defaultPreset` 的设置写入（沙箱模式或审批策略比当前预设更宽松、未知预设、删除该字段，或在当前预设无法读取时的任何更改，由 `defaultPermissionOf` 从运行中的预设读取）以 `DEFAULT_PERMISSION_REFUSAL` 被拒绝；针对受保护配置项（其模块由 `plugin-manager` 配置项的 `protectedPlugins` 列出，由 `protectedEntryIdsOf` 通过 `protectedPluginsIn` 从 Loader 读取，CLI 的更新检查共用这个读取函数）的 `pluginManager/setPluginEnabled` 以 `PROTECTED_ROW_REFUSAL` 被拒绝；其行经命令服务的解析器解析后不是 `REACH_DEVICE_COMMANDS` 中名称的 `commands/execute` 以 `UNLISTED_COMMAND_REFUSAL` 被拒绝，以上各项在持有提权时同样被拒绝；路径的真实路径位于对话工作区之外或 Delorun home（`HomeAuthService.delorunHome`，即 secrets 目录往上两级）之内的工作区文件调用也会被拒绝，后者本会被服务顺着路径（包括经由符号链接）读到任何位置。提权（`src/elevation.ts`，C14 的[提权](../../docs/contracts/c14-oidc-passkeys.zh.md#elevation)；`src/elevation-routes.ts` 在设备的远程访问监听器上提供请求、状态和锁定，只在 loopback 上提供电脑的列表、批准和撤销）保存在本配置文件 Host 的内存中，记在设备、监听器和发起请求的会话名下，只有在电脑上输入设备显示的 8 位代码才会开始，并在到期、电脑上撤销、设备锁定、会话结束、设备移除、监听器停止或 Host 停止时结束；结束时会关闭设备的远程访问连接，因为 Gateway 只在流打开时作出决定；每次开始、结束和被准入的调用都会记入日志。其他每个操作——`REACH_DENIED_ACTIONS` 中带原因的每一项，或没有任何表格列出的操作——都以 `remote-access/denied` 被拒绝，原因为 `loopback-required: <action>`；在策略无法指名的 Session 上（例如不属于任何 Workspace 且不在线的已存储 Session）执行允许或提权的操作，会以 `resource-unlisted: <action>` 被拒绝。
- **放宽的设置**（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#elevation)）：设备在危险模式下凭授权凭证所做的对默认预设的放宽或对同意开关的关闭，会在继续之前记入 `reach-dangerous-settings.json`（`src/dangerous-settings.ts`），`HomeAuthService` 在首次读取到该模式已结束时以及启动时，通过设置服务把先前的值设回；此后人更改过的字段保持不变。
- **终端**（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#elevation)）在 `AUTH_CLASSES` 中属于 `face` 类别：该条件对没有针对该次调用的授权凭证、也没有有效 Face ID 通行期的设备，在每个资源上拒绝每个 `terminal/*` 操作，无论危险模式、工作区的完全访问授权或早期版本的 `reach-terminal.json` 如何说。现在没有任何东西读取该文件；仍保留它的 home 继续工作，该文件可以删除。`src/full-access-grants.ts` 中声明的 `reachFullAccessGrants` 只提供危险模式的状态。
- **设备能到达哪些路径**（[C4](../../docs/contracts/c04-admission.zh.md#pre-login-allowlist)）。登录之后，`admit` 只放行目标是 `REACH_DEVICE_PATHS`（`src/reach-paths.ts`）上普通路径的远程访问请求，该表每个条目都带一个原因：studio 页面 `/`、它的 `/assets` 与安装时文件、`/api` 及其 `/api/remote.mux` upgrade、`/plugins` 下的客户端插件包、本包的 `/auth` 路由，以及 `/delorun/reach/status`。其他每个目标，无论属于哪条精确、前缀或 upgrade 路由或回退，都在其路由运行之前以 `403 LOOPBACK_REQUIRED` 被拒绝，时间在会话自身的拒绝之后，且不滚动会话，因此只检查请求是否已准入的路由（例如上游的 `open-in-app`）绝不会应答设备。目标在解析不改变任何内容、且不含空段与转义的 `/` 或 `\` 时才是普通路径；只匹配其路径，从不匹配其查询。在 `/api` 下，每条精确 Fetch 路由只有在准入该 Peer 时才应答设备，而 Delorun 的路由都不准入。`delorun/apps/cli/tests/denial/reach/reach-paths.integration.spec.ts` 启动整个 CLI 组合，以已登录设备的身份请求 web 服务器的每个注册项，当设备能到达某个未列出的注册项，或某条精确 Fetch 路由没有已记录的决定时失败。

此处未构建：通行密钥、OpenID Connect、恢复套件、重置、警报，以及 C4 所描述的回环凭据记录及其空闲上限。回环凭据是上游的启动 cookie 与 API 凭据，由上游的内置准入接受；不存在按凭据的记录，因此没有任何回环请求会因缺少记录而被拒绝。

<a id="the-admission-denial-suite"></a>
## 准入拒绝测试套件

`delorun/apps/cli/tests/denial/admission/` 在测试进程中启动 Delorun CLI profile 的 web 组合：上游的 web 模板（Delorun 的 profile 在其上扩展）以操作系统分配的端口运行 web 服务器。Delorun 自身的组合包层被排除在该组合之外；`delorun/apps/cli/tests/denial/reach/reach-paths.integration.spec.ts` 启动整个 CLI profile（包括 Delorun 的组合包及其 web 路由），并以已登录设备的身份请求每个注册项。随后，该套件加载一个替身提供方 `StandInHomeAuth`，它准入一个会话 cookie，并把回环监听器委托给 Connection 的内置准入；另有一个社区插件 fixture（测试前置数据），带有一条精确路由、一条前缀路由与一条 upgrade 路由。它打开全部三个远程访问监听器：`reach-tailscale-private` 与 `reach-tailscale-funnel` 位于 `127.0.0.1` 的端口上，`reach-self-hosted-relay` 则在本地 TCP 服务器交给它的字节流上运行，证书来自替身堆栈的测试 authority。

各测试的名称取自 C4 的拒绝表：

| 测试 | 证明什么 |
| --- | --- |
| `every route and upgrade answers 401 before sign-in on each reach listener` | 启动后的组合注册的每条精确路由、前缀路由、upgrade 路由以及回退，以及 fixture 插件的每条路由，在每个远程访问监听器上登录前都应答 401，且没有任何 fixture handler 运行；携带会话时，同一 fixture 路由与 upgrade 则会运行。 |
| `a plugin route is pre-login only when the profile lists it` | 提供方作为登录前请求应答的 fixture 路由，在监听器策略列出它之前会被拒绝，在列表被移除后会再次被拒绝。 |
| `a pre-login request never reaches the fallback or another route` | 一条位于允许列表中、却没有注册路由的路径会被拒绝，而不是由回退应答。 |
| `a cookie minted with upstream's secret is refused on a reach listener` | 上游以其密钥为远程访问监听器自身的 authority 签发、且在回环监听器上可以准入的 `dsh-auth-*` cookie，在远程访问监听器上会以 `UPSTREAM_COOKIE_REFUSED` 被拒绝，即使同时带有会话 cookie 也是如此。 |
| `launch tokens and /connect are refused on a reach listener` | 在 `token` 查询参数中携带的进程启动令牌，以及对 `/connect` 的请求，都会被拒绝，且不设置任何 cookie。 |
| `a loopback Host is refused on a reach listener` | `Host` 中的 `localhost`、`127.0.0.1` 与 `[::1]` 会被以 `HOST_MISMATCH` 拒绝，对请求与 upgrade 同样如此。 |
| `each listener refuses a Host its rule does not allow` | 每个远程访问监听器都拒绝其他监听器的地址以及外部名称；中继监听器拒绝与其名称不符的 SNI，返回 `SNI_MISMATCH`；回环监听器以上游的 403 拒绝外部 `Host`。 |
| `an upgrade with a foreign or absent Origin is refused` | 发往 `/api/remote.mux`、不带 `Origin`、带有其他 origin 或带有 `null` 的 upgrade 会被以 `ORIGIN_MISMATCH` 拒绝；监听器自身的 origin 则能到达 upgrade handler。 |
| `removes Tailscale identity headers before admission` | 提供方在任何远程访问监听器上、无论是请求还是 upgrade，都看不到 `Tailscale-*` 头，且 Gateway 的 WebSocket 仍接受该 upgrade。 |
| `no reach listener runs without home-auth` | 移除提供方会关闭每个远程访问监听器及其打开的连接；没有提供方时不会打开任何远程访问监听器，回环监听器则如上游一般准入；替换为一个不服务任何远程访问监听器的提供方后，也不会打开任何远程访问监听器。 |

一项类型级检查保证 C4 的 `Admission` 与 `ListenerPolicy` 类型可以赋值给上游 seam 的对应类型；一个 spec 保证分发器的拒绝状态与 C4 的状态相等。

<a id="the-reach-access-denial-suite"></a>
## 远程访问拒绝测试套件

`delorun/apps/cli/tests/denial/reach/` 启动同样的 web 组合，加载本包的服务，为一台已批准设备打开会话并通过提供方准入它，然后以返回的 Peer 调用 Gateway。`REACH_DENIED_ACTIONS` 列出的每一族操作都会被拒绝并写明操作，包括组合所描述的每个设置命名空间中的设置写入；读取对话列表、已脱敏的设置、插件列表以及对话自己工作区的文件，开始对话，发送消息，选择预设与停止运行都会成功，设备的事件流携带对话事件，不携带任何插件管理事件。该套件还列出组合注册的每个 Remote 方法及其转发的每个事件，当某个方法或事件两张表都未列出、或某个表条目没有对应项时失败，因此新方法默认被拒绝，其分类是一个需要做出的决定。

<a id="dangerous-mode"></a>
## 危险模式

危险模式成立期间，已登录的设备凭针对每次调用的授权凭证做电脑能做的事，但 `computer` 类别的操作除外。这一事实是 `HomeAuthService.dangerousMode()`，在被询问时从 [`@delorun/plugin-permission-defaults`](../plugin-permission-defaults/README.zh.md) 提供的 `reachFullAccessGrants` 服务读取：只有当该配置项设置了 `fullAccessEverywhere` 且 `delorun setup` 写入的授权文件有效时才为真；没有该插件，或其存储无法读取时为假。删除授权文件或关闭该配置项，会在下一次调用时恢复每一项拒绝。下面每项被解除的拒绝仍然需要针对该次调用的授权凭证（Face ID，或 PIN），对不是 `alwaysAsk` 的 `face` 行，设备有效的 Face ID 通行期可代替它。

| 拒绝 | 更安全的提示与与原版相同 | 危险模式 |
| --- | --- | --- |
| 把仅限电脑的开关移出其安全值的设置写入（`loopback-required: turning … off`，对安全值为 `false` 的开关则为 `… on`） | 拒绝，无论是否解锁 | 由针对该次调用的授权凭证决定 |
| 放宽新对话所用权限的设置写入 | 拒绝，无论是否解锁 | 由针对该次调用的授权凭证决定 |
| 针对受保护配置项的 `pluginManager/setPluginEnabled`（插件管理器仍会拒绝对防护插件本身的更改） | 拒绝，无论是否解锁 | 由针对该次调用的授权凭证决定 |
| 设备不运行的命令的 `commands/execute` | 拒绝，无论是否解锁 | 由针对该次调用的授权凭证决定 |
| 从设备应答的、标记为 `full-access`、`workspace-management`、`external-agent` 或 `real-browser` 的审批提示 | 只在带有针对该提示和取值的答复授权凭证（Face ID，或 PIN）时、或在该设备有效的 Face ID 通行期内给出；二者都没有时为 `LOOPBACK_REQUIRED`，无论设备持有什么解锁或宽限期 | 不变 |
| 审阅并授予工作区同意的 permission-defaults 路由（`delorunPermission.workspaces`、`.review`、`.setFullAccess`） | `.workspaces` 和 `.review` 对每台已批准的设备放行；`.setFullAccess` 需要针对该次调用的授权凭证 | 不变 |
| 网络路由（`delorunNetwork.list`、`.set`） | `.list` 对每台已批准的设备放行；`.set` 需要针对该次调用的授权凭证 | 不变 |
| MCP 同意路由（`delorunMcpConsent.pending`、`.accept`、`.decline`、`.revoke`） | `.accept` 需要针对该次调用的授权凭证；其他对每台已批准的设备放行 | 不变 |
| 外部 agent 同意路由（`delorunDelegationConsent.*`） | `.allow` 需要针对该次调用的授权凭证；其他对每台已批准的设备放行 | 不变 |
| 日常设置：对 `REACH_EVERYDAY_SETTINGS` 中命名空间（`ui-theme`、`ui-chat`、`ui-conversation`、`ui-settings-general`、`locale`、`delorun-theme`、`delorun-onboarding`、`delorun-sidebar`、`delorun-chat-states`、`delorun-cost-meter`、`delorun-thinking-rsvp`、`delorun-multiview`）的 `settings/update`、`/mutate` 或 `/replace` | 已批准的设备无需解锁即被放行，PIN 模式也不对其设限：它与发送消息等普通设备写入一样。仅限电脑的开关、受保护的配置项和默认权限仍然先行拒绝。两个命名空间的部分字段仍留在电脑上（`REACH_EVERYDAY_FIELDS`）：新手引导放行 `done`、`step` 和 `pausedStart`（不含 `plugins` 或 `optionalRows`），聊天状态不含 `maxRecords` 和 `pruneMinutes`；对 `delorun-sidebar` 的 `workspaceIcons` 写入任何不是有效图标的内容（标记、未知字段或未列出的形状）、对这些命名空间的 `settings/replace`，或无法读成具名字段的写入，都需要解锁 | 对其他任何命名空间的写入需要解锁（`elevation-required`） |
| 打开或关闭 Delorun 自己的插件：针对 `REACH_SHIPPED_ROWS` 中配置项的 `pluginManager/setPluginEnabled`，以及针对 `REACH_SHIPPED_BUNDLES` 中包的 `pluginManager/setBundleEnabled`（新手引导提供的可选配置项与推荐包）。插件元数据读取（`listBundles`、`listPlugins`）和推荐插件的用途（`/api/delorunOnboarding.recommend`）对每台已批准的设备放行 | 无需解锁即放行，无论是否 PIN 模式；受保护的配置项仍被拒绝 | 其他任何配置项或包需要解锁 |
| 安装包（`installBundle`）、移除包、更新、撤销与恢复、MCP 服务器变更、设备批准、列出与移除、PIN 设置、选项与关闭、远程访问、变更保护及其批准，以及信任与验证操作 | 对已批准的设备在未解锁时拒绝，或只能在电脑上进行（`loopback-required`） | 不变 |
| 提供方密钥（`credentials/describe`、`.set`、`.unset` 与两个 `credentials` 事件，`REACH_KEY_ACTIONS`）和密钥测试（`/api/delorunOnboarding.keyTest`），它们只回答是否存在、是否可写以及每个提供方的结果，绝不回答已保存的密钥或其任何部分或长度（`credentials/describe` 对设备省略 `masked`）；密钥操作只指名模型提供方声明过的引用（`UNDECLARED_KEY_REFUSAL`） | 已批准的设备在没有设置 PIN 且没有注册通行密钥时无需解锁即被放行；否则，保存或移除密钥需要针对该次调用的授权凭证（没有则为 `elevation-required`），而一旦存在 PIN 或任何通行密钥，密钥测试对每台设备都应答 `403` | 与未解锁的设备相同 |
| 在电脑上的应用中打开对话的文件夹（`session/openWorkspacePath`、`session/workspacePathApplications`） | `loopback-required` | 不变 |
| 路径位于对话工作区之外的工作区文件调用（`workspaceFiles/*`、`officeKit/render`） | `loopback-required: … with a path outside the chat's workspace` | 由针对该次调用的授权凭证决定；Delorun home 仍不可到达。解除的范围等于该模式下完全访问已经给予对话的范围 |

上面的每条同意与权限路由都按 `src/route-access.ts`（`PLUGIN_ROUTE_ACCESS`）中的某个访问级别注册，`tests/route-access.spec.ts` 会在已注册的路由未列入其中、或其注册与级别不符时失败。`R` 路由放行任何已批准的设备，无需解锁（`admitApprovedDevice`）。`U` 路由只放行已解锁的设备，对锁定的设备应答 `403 ELEVATION_REQUIRED`（`gateByUnlock`，它接受 `renews: true` 或 `false` 以及 `{ grace: false }`）。`C` 路由无论设备是否解锁，都以 `403 LOOPBACK_REQUIRED` 拒绝设备（`requireComputerOrDevice` 放行电脑或已批准的设备，`requireComputer` 只放行电脑）。`K` 路由放行没有 PIN 锁的设备（`admitKeyDevice`）。危险模式不再解除其中任何一项：`REACH_DANGEROUS_ACTIONS` 为空，`session/openWorkspacePath` 和 `session/workspacePathApplications` 只能在电脑上进行。远程访问策略决定各个操作；`COMPUTER_ONLY` 列出只能在电脑上进行的那些，`dsh-base`、`dsh-sdk-minimal`、`dsh-headless`、`bundle-local`、`bundle-headless`、`bundle-studio` 和 `bundle-webhooks` 这几个 bundle（`COMPUTER_ONLY_BUNDLES`）也只能在电脑上进行，测试会对照每个已发布的补丁检查这一点。设备在任何模式下都不能写入 `home-auth`、远程访问、`sandbox-local` 和 `sandbox-policy` 这几行的设置，也不能写入 webhook 服务器行（`@delorun/bundle-webhooks/server`）的设置，它决定 GitHub webhook 端点监听的地址（`PROTECTED_ROW_REFUSAL`）。`mcpManager/watch` 需要解锁，因为它的 `lastError` 是自由文本。对已登录的设备，`/auth/devices` 不含 `address`、`approvedBy` 和所有者的 `firstDeviceId`，并增加 `current` 和 `unlocks`。

**解锁。**由电脑批准的解锁，在最后一个需要它的操作之后持续 `elevationMinutes`（`HomeAuth.touchUnlock`、`Elevations.touch`），自开始起绝不超过 `unlockCapMinutes`（1 到 1440，默认 480；`elevationMinutes` 超过它的监听器会在启动时被拒绝）。只有 `RENEWING_ACTIONS` 中的操作（改变状态的调用）和已连接终端中的输入（`src/typed-renewal.ts`，每分钟最多一次）会续期。`ELEVATED_READS` 中的读取和监听、终端重新连接（`terminal/attach`、`retain`）、被轮询的解锁路由（`renews: false`），以及在解锁检查之后被条件拒绝的调用，都绝不会续期；有提升权限的操作如果既不在这个列表也不在那个列表中，测试就会失败。来自 PIN 的页面解锁和批准宽限期都不会滑动。新批准的设备以 `approvalGraceMinutes`（0 到 60，默认 15；`POST /auth/elevation/end-grace` 会结束它）的批准宽限期开始，所以从手机上设置不需要解锁提示。宽限期永远不会打开终端（`GRACE_REFUSED_ACTIONS`，即所有提权的 `terminal/*` 操作），也永远不涵盖对受保护行的设置写入（任何插件管理器 `protectedPlugins` 行的命名空间，包括条目 id 和行 `id` 两种形式；在宽限期结束之前以 `GRACE_PROTECTED_ROW_REFUSAL` 拒绝，它不指明任何授权凭证），而 `gateByUnlock(…, { grace: false })` 让四项不经设置写入就放宽同意或守卫行的操作（接受 MCP、允许委派、`setFullAccess`、设置网络允许列表）需要代码或 PIN 解锁。开启 PIN 模式后没有宽限期：不会启动，正在运行的在模式开启时会被隐藏（`elevationOf`、`elevationState`）。服务器放行锁定的页面访问每条 `R` 路由；只有在 `U` 路由或操作（`403 ELEVATION_REQUIRED`，对操作则是 `elevation-required:`）以及密钥操作时才询问 PIN，客户端在该操作处提示。

这些在每种模式下都留在电脑上：打开该模式（只有 `delorun setup` 写入授权，任何路由或调用都不写）、批准设备与打开批准窗口、设备登录、批准或撤销解锁、移除设备，以及 home 的重置、恢复套件和远程访问设置。账户操作和打开设置文档保留在 `REACH_DENIED_ACTIONS` 中。`tests/dangerous-mode.spec.ts` 在两种模式下证明每项被解除的拒绝，并在批准、登录、移除设备或更改远程访问的路由读取该模式时失败。

<a id="pin-mode"></a>
## PIN 模式

PIN 模式让持有已批准设备的人像 Face ID 那样，用 PIN 或口令一次确认一个操作（[C14，“PIN 模式”](../../docs/contracts/c14-oidc-passkeys.zh.md#pin-mode)）。第 1 版只服务 Tailscale 私有地址。在人于电脑上设置 PIN 之前该模式关闭；关闭期间，本包的每条路由与每项拒绝都如上所述。没有任何设备持有页面解锁（A483）：`POST /auth/pin/unlock` 不读取请求就对每台设备应答 `403 ELEVATION_REQUIRED`，因此没有通行密钥的设备恰好能触及有通行密钥的设备所能触及的。

- **存储。** `src/pin-mode.ts` 保存 `pin-mode.json`（模式是否开启、秘密的类型、带参数的加盐 `scrypt` 哈希、空闲分钟数）和 `pin-attempts.json`（每台设备及整个 home 的错误尝试次数），两者都通过受保护文件辅助函数以 0600 权限写入。`reach-pin-settings.json`（与 `reach-dangerous-settings.json` 相同的账本，0600）保存早期构建中的页面解锁所放宽的设置；现在没有任何东西再记录这类设置，模式关闭时会把每一项设回，除非人此后更改过它。
- **授权凭证。** `POST /auth/passkey/pin`（`src/passkey-auth.ts`）通过 `src/pin-unlocks.ts` 校验秘密，并为有通行密钥或没有通行密钥的设备签发与通行密钥断言相同的一次一个操作的授权凭证。没有任何解锁窗口、来自电脑的代码、批准宽限期或危险模式能代替它准入 `face` 操作或保留的授予型答复，正确的 PIN 也从不开启 Face ID 通行期。
- **令牌。** `src/unlock-token.ts` 仍在任何路由看到请求之前，从每个头视图读取并剥离 `Delorun-Unlock` 头和 `delorun-unlock.<token>` WebSocket 子协议；没有任何路由签发令牌，因此页面发送的令牌会以 `401 UNLOCK_INVALID` 被拒绝。
- **错误尝试。** 尝试在比较秘密之前计数并写入，每台设备一次一个。第五次错误尝试会像在电脑上移除一样移除该设备。24 小时内整个 home 十次错误尝试会暂停 PIN 和 Face ID，直到电脑恢复。重启保留两个计数。
- **路由。** `src/pin-routes.ts` 为私有监听器上的设备应答 `GET /auth/pin/state`，并拒绝 `POST /auth/pin/unlock`；`/touch` 和 `/lock` 不指明任何运行中的解锁。`GET /auth/pin/mode` 与 `POST /auth/pin/set`、`/options`、`/off` 和 `/resume` 只应答电脑旁的人；设备以 `LOOPBACK_REQUIRED` 被拒绝。`/options` 只更改已开启模式的空闲分钟数（1 到 60）和隐藏时锁定，不涉及秘密，模式关闭时以 `PIN_MODE_OFF` 被拒绝。
- **未构建的部分。** Funnel 与中继地址，以及从设备设置 PIN。

`tests/pin-mode.spec.ts` 用缺少它就会失败的测试证明每项防御：对每台设备都拒绝解锁（无论 PIN 正确、错误或没有请求体），不计数也不签发任何东西；伪造的令牌什么也不准入；以及通过 PIN 授权凭证的：比较之前计数、设备移除、二十次并行猜测至多消耗五次、整个 home 的暂停、地址规则、PIN 更改或模式关闭之后旧 PIN 被拒绝、对已移除的设备、已结束的会话或已停止的监听器不签发任何东西，以及 PIN 不出现在任何文件、日志或应答中。`tests/authenticator.spec.ts` 证明持有旧解锁令牌的、没有通行密钥的页面得不到 `face` 操作，也得不到保留的答复，`tests/dangerous-settings.spec.ts` 证明它不解除任何东西。

<a id="face-id-unlock"></a>
## Face ID 解锁

已配对设备用通行密钥或其 PIN 以一次一个操作的授权凭证确认 `face` 操作，或用一次 Face ID 开启一个通行期。`auth-classes.ts` 存放 `AUTH_CLASSES`，这一张表把每个操作和路由放入 `free`、`face` 或 `computer`，并在通行期从不准入的 `face` 行上带有 `alwaysAsk` 标记；Fetch 路由通过 `gateByClass`（`auth-gate.ts`）声明它的行；远程访问策略和 `checkAnswer` 读取同样的授权凭证（`grants.ts`）。通行密钥保存在 `passkeys.ts`，在 `passkey-auth.ts` 中注册和断言，由 `passkey-routes.ts` 提供服务。规则见 C14“Face ID 解锁”。`unlockModeEnabled()`（已设置 PIN 或已注册任何通行密钥）是锁定设备拒绝背后唯一的读数。拒绝规格是 `tests/denial/face-grants.spec.ts`、`tests/denial/face-pass.spec.ts` 和 `tests/denial/passkey-auth.spec.ts`，它们使用软件认证器（`tests/fixtures/virtual-authenticator.ts`）。

**通行期。** 当通行期设置大于 0 时，已配对设备上的一次 Face ID（带用户验证的通行密钥断言）为该设备开启一个通行期。通行期有效期间，该设备的 `face` 操作（安装、终端、设置写入、模型密钥、Changes 与更新，以及授予完全访问以外内容的批准答复）无需逐次授权凭证即被准入，因此不出现 Face ID 确认面板。通行期绑定到设备和监听器（`GrantStore.openPass` 只以这两项为键；设备不持有页面解锁，携带页面解锁的调用不匹配任何通行期），从 Face ID 的那一刻起固定，不随使用而顺延，并且只存在于内存中。`src/pass-setting.ts` 把本人在 Settings → Face ID → “Ask again after”（Every time、5、15、30 或 60 分钟）中的选择保存在 secrets 目录的 `face-id-pass.json` 中；在本人选择之前，适用配置字段 `faceIdPassMinutes`（取 0、5、15、30 或 60 之一；默认 15；任何其他值使加载失败）。“Every time”（0）不开启通行期：每个操作一次 Face ID。更改会结束所有有效的通行期。

**什么从不开启通行期。** PIN（`POST /auth/passkey/pin`），无论是在没有通行密钥的手机上，还是作为有通行密钥的手机的后备；来自电脑的代码；配对后的批准宽限期；危险模式。没有 Face ID 的手机对每个操作确认一次 PIN。

**始终询问的行。** `src/pass-policy.ts` 在 `PASS_ADMITS` 或 `PASS_ALWAYS_ASK` 中把 `AUTH_CLASSES` 的每个 `face` 行各列出一次；`checkAuthTable` 报告两者都没有的 `face` 行，`stalePassEntries` 报告不指向任何 `face` 行的条目。标记为 `alwaysAsk` 的行从不被通行期准入，即使在通行期内也需要针对该次调用的一次一个操作的授权凭证：`auth:/auth/devices/remove`（仍只限 Face ID，从不用 PIN）、`auth:/auth/passkey/remove`、`auth:/auth/passkey/devices`、`auth:/auth/passkey/pass (write)`（需要由通行密钥签发的授权凭证，从不用 PIN）、`changes:protection-off`、`route:plugin-permission-defaults/src/routes.ts#PERMISSION_ROUTES.setFullAccess` 和 `answer:full-access`（操作 `answer/full-access`，授予完全访问的批准答复；对这样的答复做一次 Face ID 仍会开启通行期，因为只有始终询问的操作条目才会阻止它）。确认其中任何一项的 Face ID 都不会开启通行期。Reach 设置与 PIN 模式设置仍只限电脑，`computer` 行也是如此。

**路由。** `GET /auth/passkey/pass` 应答 `{ minutes, choices, pass }`，其中 `pass` 为 `{ startedAt, endsAt, remainingMs }` 或 `null`（在电脑上总是 `null`）。带 `{ minutes }` 的 `POST /auth/passkey/pass` 更改该设置：在电脑上与那里的任何设置一样；从设备上只能凭针对操作 `auth/passkey/pass` 的、由通行密钥签发的授权凭证，其哈希是该请求体 JCS 文本的 SHA-256；取值在选项之外时为 `400 BAD_REQUEST`。有通行期有效时，`POST /auth/passkey/verify` 也应答 `pass: { startedAt, endsAt, remainingMs }`。带 `{}` 的 `POST /auth/passkey/lock` 应答 `{ ended }`；它是 `free` 路由，结束该设备自己的通行期。

**什么会结束它。** 它的结束时间；该设备在该监听器上 5 分钟没有任何请求（`touchPass` 来自 `admitToken` 和每次 Remote 调用；空闲结束从不延长通行期）；Lock now，它结束该设备在每个标签页上的通行期，因此一个标签页隐藏那么久，其他标签页也会被锁定；studio 页面隐藏 5 分钟，客户端用定时器检查，并在页面返回时再次检查，因为手机会挂起隐藏的页面及其定时器，随后它先调用 Lock now，再做其他事；通行期设置的更改，无论来自设备还是在电脑上（原因 `setting-changed`）；Peer 的 dispose；设备会话的结束或其退出登录；设备被移除；所有会话的轮换；重启。

**终端。** 终端的保持窗口不变：在通行期内，`terminal/create` 不经确认面板即被准入，并打开该终端的保持窗口，因此通行期结束后，终端仍在保持窗口的限制（5 分钟未使用，总共 60 分钟）之内保持打开。

**日志。** `home-auth: pass.started device=… listener=… minutes=…`、`home-auth: pass.ended device=… listener=… reason=<expired|idle|lock-now|setting-changed|peer-ended|session-ended|device-removed|sessions-rotated>`（过期或空闲的通行期在 home 下一次查看它时记录），以及对通行期所准入的授予型答复记录的 `home-auth: pass.used device=… listener=… answer=… grants=…`。通行期不是模型可见的，因此没有会话事件。

<a id="notes-for-the-provider"></a>
## 给提供方的说明

- **登录前资产路由。** 处理 `GET /auth/assets/<asset>` 的 handler 会把该段与一张固定的已构建资产名表进行匹配。它从不先解码该段再把它拼接到目录路径上，因为解码后的 `..` 或分隔符会使路径离开资产目录。
- **认领的到达。** 认领路由在读取请求体之前就判断请求从何处到达，其拒绝语句会点名回环监听器与 SSH 端口转发；远程访问监听器在任何路由被查询之前，通过 `reachClaimRefusal()` 应答同样的拒绝。
- **设备路由的到达。** 列表与移除在读取任何内容之前判断到达，两者都会拒绝 `Host` 指向其他地址的请求；移除还会拒绝来自其他 origin 的页面。设备只能在 home 自己的电脑上被列出、批准与移除，因此远程访问会话的请求会被应答 `LOOPBACK_REQUIRED`。
- **撤销。** 移除设备或结束会话时，会在返回之前调用 `ctx.connection.closeReachConnections({ deviceId })` 或 `({ sessionId })`，使不携带 Peer 的流与已升级的 socket（例如 `/plugins/events` 与插件 upgrade 路由）随会话一同结束；对设备的 Peer 执行 dispose（资源释放），会结束替它发言的流。
- **过期与轮换。** 轮换触发时，会在写入轮换标记之前以 `({ sessionId })` 关闭每个会话的远程访问连接。每个会话还有一个 unref 的计时器，对应其空闲上限、绝对上限，以及（对于被滚动替换的令牌）其 30 秒宽限期结束这三者中最早的一个；计时器触发时，若此后没有任何请求被准入，它就关闭该会话的连接，无论是否有请求到达，停止服务会清除每个计时器。使用是指以该会话的令牌准入的 HTTP 请求或 upgrade：先前已准入的连接上的字节从不到达 `admit`，因此打开的流或 WebSocket 不会让任何东西保持在线。客户端在打开的 WebSocket 上发送的帧也不计入，因为远程访问分发器与本提供方都看不到它们，而连接层无法区分 Remote 调用与应答 Gateway 心跳 Ping 的自动 Pong；所提供的 studio 通过 HTTP 发送其一元调用，因此使用它的本人会让会话保持在线。连接按会话关闭，从不按设备关闭，因为一台设备最多持有 16 个会话。被重新登录替换的会话会保留其打开的连接，直到它自己的空闲或绝对上限，因此登录自身的响应绝不会被切断。
- **回环凭据。** 上游的 connection 对每次回环签发发出 `authenticator/minted`，时间在它写出设置该凭据的响应之前。本包不监听该事件；记录回环凭据的提供方必须在该响应写出之前记录每次签发。

<a id="tests"></a>
## 测试

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/home-auth` 运行本包的 spec，`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/cli/tests/denial` 运行拒绝测试套件，后者启动组合后的 studio，因此位于 CLI 中、`@delorun/bundle-local` 之上。它通过上游包的已发布入口导入这些包，因此需要当前的 `pnpm run build:artifacts` 产物；构建过期时，Delorun 的检查运行器会启动该构建。`tests/sign-in-page.spec.ts` 在 jsdom 中以页面自己的标记、针对一个假的 home 运行登录页面的脚本。`node_modules/.bin/tsx delorun/packages/home-auth/scripts/sign-in-screens.ts --out <directory>` 通过本包的路由处理器，在远程访问内容安全策略与 Playwright 对 home 的桩之下，为页面的每种状态截图（浅色与深色、手机与桌面宽度以及中文），加上 `--engine webkit` 时在 WebKit 中截图；遇到控制台错误或策略违规时失败。
