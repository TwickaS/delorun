---
description: "Delorun 的按工作区权限默认值，供维护者修改新工作区以哪个预设开始、何时询问完全访问、防护会拒绝哪种模式切换，以及工作区中沙箱命令能访问哪个网络。"
---

# @delorun/plugin-permission-defaults

[English](README.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 概述

上游为整个部署组合一套权限：每个新 chat 都从同一个预设开始，选择 `danger-full-access` 立即生效。本插件改为让预设成为工作区的属性。新 chat 从本人为其文件夹选择的预设开始（无人选择过的工作区从 `workspace-write` 开始），与部署默认值无关，完全访问只在该工作区获得一次同意之后生效。本人在 home 自己的电脑上给出同意：在 studio 中选择完全访问时、在请求完全访问的审批卡片上、在设置的「权限」部分，或使用 `delorun workspace full-access`。同意写入 home 的受保护状态，因此它覆盖该文件夹，直到本人在那里选择另一个预设；显式选择更安全的预设会撤回它，所以回到完全访问时会再次询问。

拒绝未经同意的完全访问切换的防护，会在会话记录任何内容之前运行。因此被拒绝的切换不会追加 `sandbox/mode` 事件，也不会追加预设标识，会话继续解析它原本的模式，在同一个同步步骤中启动的命令仍在沙箱内运行。防护覆盖整个选择，而不只是模式变更：保持模式但放弃审批策略的预设同样会被拒绝，因此审批提示不是绕过同意的办法。按调用的 `sandbox_permissions` 升级不是模式切换：它走上游的按调用审批，本防护看不到它。拒绝的措辞指明工作区以及本人在哪里允许完全访问：审批卡片上的「Allow for this chat」、studio 的「设置」→「权限」，或带工作区文件夹的 `delorun workspace full-access "<folder>" on`（[`fullAccessRefusal`](src/index.ts)），所以模型读到的是这些话，而不是堆栈跟踪。

本插件还为每个工作区提供[沙箱命令的网络](#the-network-of-sandboxed-commands)，即 `open`、`allowlist` 或 `off`，`web_fetch` 也遵循它。

一切（包括路由）都位于开关 `permission_defaults` 之后，默认关闭；`@delorun/bundle-local` 在 `delorun` 启动的 CLI profile 中开启它，`@delorun/bundle-headless` 在 `delorun headless` 运行的 profile 中开启它，因此在没有授权的文件夹中运行的 headless 任务无法切换到完全访问；桌面应用运行不含它的上游 profile。关闭时插件不挂载任何内容：部署默认值按上游播种的方式抵达每个新 chat，每次模式切换都被记录，这正是对等组合所断言的。

<a id="which-preset-applies"></a>

## 哪个预设生效

三个层级决定一个 chat 的权限，由强到弱：

1. chat 自身的日志。chat 已持有的预设标识或旋钮事件优先于其工作区的默认值，因此恢复、fork 或播种的 chat 保留它记录的权限。显式的 `sandbox/mode` 切换也优先于预设标识（例如另一个界面的控件、已批准的升级或委派播种），当旋钮不匹配任何已配置的预设时，该 chat 随后报告 `custom`；本人再次选择时，`select()` 会重新确认所选预设。
2. 工作区的默认值。`select()` 记录它，而本插件只把它播种到新 chat：播种只作用于尚未持有任何权限选择、也从未被播种的 chat。
3. 部署默认值。`sandbox-policy` 的模式与审批策略的默认值位于两者之下：它们适用于工作区没有条目的 chat，以及 chat 从未覆盖的任何旋钮。

<a id="what-it-provides"></a>

## 提供什么

- `permissionDefaults`：开关背后的服务。`defaultPreset(cwd)` 与 `granted(cwd)` 读取工作区记录的预设以及它是否持有完全访问授权，`select(agent, preset)` 是界面为工作区选择预设的唯一写入路径，`review(session, mode)` 是防护的判断。条目保存在内存中，因此防护可以同步作答；在每次决定之前（完全访问切换、新建或恢复 chat 的预设、界面的列表），服务都会把存储文件的标识（设备、inode、大小、修改时间）与它读取时的标识比较，并在另一个进程更改了文件时同步地重新读取该文件。因此，被另一个 profile 的 Host、`delorun workspace full-access` 或正在运行的 `delorun headless` 任务撤回的授权，会在本服务的下一次决定时不再生效，失去授权的工作区中打开的 chat 随后立即被设回更安全的预设。该服务还监视存储的文件（[`src/watch.ts`](src/watch.ts)：对存储所在目录使用 `fs.watch`，该目录以私有目录模式创建，只关注存储的文件名，并做 100 毫秒的防抖），并在另一个进程写入之后通过 `reload()` 重新读取，所以 home 的每个 Host（无论哪个 profile）中打开的 chat 会在撤回后一秒内恢复，进程之间无需任何消息。无法启动或后来失败的监视，会在 Host 的日志中作为警告命名一次，此后只剩决定时的读取。正在运行的 `delorun headless` 任务不挂载此服务，所以它在下一次决定时读取存储。`storeProblem` 指出无法读取的存储。
- `sandboxModeGuard`：`@deepseek-ai/dsh-sandbox-policy` 会话模式接缝的模式切换钩子，挂载后 `setSandboxMode` 会拒绝在无人同意的工作区切换到完全访问。它是该接缝唯一的提供方，因此一个组合只开启本同意或另一个插件的防护，不会两者都开。
- 存储：[`src/store.ts`](src/store.ts) 保存格式与文件处理：每个工作区一条条目，以工作区的规范路径为键（[`src/workspace.ts`](src/workspace.ts)），位于 home 的 `secrets/` 目录下，模式 0600，只有持有它的锁文件 `workspaces.json.lock`（`@delorun/home` 的锁文件，最多等待 10 秒）时才会更改，所以一次更改绝不会覆盖它没有读到的另一个进程的更改；因此受限命令既不能读取这些同意，也不能为自己添加一条；在 Windows 上，运行器不限制读取，受限命令无法写入它们，但可以读取。符号链接的存储、比 0600 更宽松的存储，或保存其他格式的存储都会被拒绝，在本人修复之前任何同意都不作数。
- `select()` 通过组合的审批服务询问，说明文件夹以及完全访问放弃的边界，除授权之外的一切答复都以 `FullAccessConsentRefusedError` 拒绝：不记录任何内容，工作区保持更安全的预设。它在决定是否询问之前会再次读取存储，而它没有询问过的完全访问，只有在存储（在其锁之下再次读取）仍持有该授权时才会被记录；否则它以 `FullAccessConsentRefusedError` 拒绝且不记录任何内容，所以另一个进程撤回的授权会被再次询问。选择更安全的预设会撤回工作区的授权，因此之后的完全访问选择会重新询问；该工作区中其他以完全访问运行的打开的 chat 会回到更安全的预设，就像关闭完全访问时那样，而每个其他 Host 通过其监视读取这一变更。审批服务只在 chat 进行中的轮次内询问，因此没有任何 studio 界面调用它。

<a id="the-consent-surfaces"></a>

## 同意界面

studio 与 CLI 自行询问同意，并通过该服务记录答复，且只在 home 自己的电脑上进行。同意的措辞来自 [`fullAccessNote`](src/review.ts)：此后该工作区中的命令可以在沙箱外运行并写入任何位置，读取本人的账户能读取的一切（包括 Delorun 的 home 及其密钥与令牌），并连接 Docker 监管器与 Delorun 的更新通道；答复只覆盖该工作区。

- **服务调用。** `workspaces()` 列出界面显示的每个工作区（已注册的工作区、存储中持有的工作区以及打开的 chat 所在的文件夹），每个都带有其完全访问状态与一个审查 id（[`src/review.ts`](src/review.ts)）；`reviewChat(sessionId)` 是一个打开的 chat 的工作区。`setFullAccess({ workspace, reviewId, on, confirmed, chat })` 记录本人的答复（Host 无法验证是谁设置了 `confirmed`；它强制要求路由所检查的回环到达）；为 Delorun 从不添加为工作区的文件夹（文件系统根目录、home 文件夹、Delorun home、stock home，或包含其中之一的文件夹）开启完全访问，会像 CLI 那样以 `UNKNOWN_WORKSPACE` 拒绝：开启时记录授权与完全访问预设，并在带有 `chat`（询问同意时所在的打开的 chat）时把该 chat 切换为完全访问，使其不再询问；关闭时撤回授权，并把该工作区中每个以完全访问运行的打开的 chat 设回更安全的预设，这会追加该 chat 的 `sandbox/mode` 和 `permission/preset` 事件；home 的其他 Host 通过其监视读取这一变更。对于 `UNCONFIRMED`（没有 `confirmed: true`）、`UNKNOWN_WORKSPACE`、`UNKNOWN_CHAT`（`chat` 不是该工作区中打开的 chat）、`STALE_REVIEW`（同意展示之后该工作区的完全访问发生了变化）和 `STORE_REFUSED`，它以 `FullAccessChangeError` 拒绝且不记录任何内容。每次更改都先从磁盘读取存储，所以 CLI 写入的更改绝不会被撤销，并记录一行不含文件夹路径的日志。
- **重新读取存储。** `reload()` 在 `delorun workspace full-access` 或另一个 profile 的 Host 写入存储后读取它，把自上次设置以来没有读回任何决定的、失去授权的工作区中打开的 chat 设回更安全的预设，并返回条目的摘要，以及有多少工作区获得（`added`）和失去（`lost`）了授权。存储的监视调用它，home 进程为更新通道的 `permission.reload` 也调用它（[C19](../../docs/contracts/c19-home-process.zh.md)），而没有 Delorun 进程发送该消息。
- **路由。** 在 Connection 为 studio 提供服务的地方，`/api` 下有三条精确路由（[`src/wire.ts`](src/wire.ts)、[`src/routes.ts`](src/routes.ts)）：`GET /api/delorunPermission.workspaces`、`POST /api/delorunPermission.review` 与 `POST /api/delorunPermission.setFullAccess`。每条路由只回答经回环监听器到达且 `Host` 为回环地址的请求；远程访问设备在请求体被读取之前就以 `403 LOOPBACK_REQUIRED` 被拒绝（[C14](../../docs/contracts/c14-oidc-passkeys.zh.md#tailnet-membership)），只是在危险模式持续期间，已解锁的设备会被准入（[`@delorun/home-auth`](../home-auth/README.zh.md#dangerous-mode)）。studio 的同意、审批卡片的完全访问操作、其「权限」部分，以及上游权限控件所询问的 `permissionSwitchConsent` 问题，位于 [`@delorun/bundle-local`](../bundle-local/README.zh.md#the-consent-surfaces) 中。

<a id="the-network-of-sandboxed-commands"></a>

## 沙箱命令的网络

每个工作区还有一个供模型在沙箱中运行的命令使用的网络：`open`，即 stock 所提供的 host 网络；`allowlist`，只有本人列出的主机；或 `off`，没有网络。没有自己设置的工作区采用该行的默认值，除非 `network` 另有设定，否则为 `open`，所以全新安装的行为与 stock 相同。[`src/command-network.ts`](src/command-network.ts) 是 `delorunCommandNetwork` 服务：

- 它挂载 `@deepseek-ai/dsh-sandbox-policy` 的 `sandboxNetwork` 解析器，使每条受限命令的策略携带 `off`，或在 `allowlist` 下携带该列表对应的出站代理的套接字。`open` 不携带网络，即上游的策略保持不变，除非该工作区接受了抽象套接字的风险（见下）。沙箱在 bwrap 下强制执行 `off` 和 `allowlist`，并在 Landlock、Seatbelt 和 Windows 上拒绝此类工作区的每条命令（[sandbox-local](../../../packages/sandbox/sandbox-local/README.zh.md#network)）。
- 每个不同的允许列表对应一个[出站代理](src/egress-proxy.ts)，它在任何策略指名它之前就在 `secrets/permission-defaults/proxy/<pid>/` 下的 Unix 套接字上监听，并在没有设置指名其列表时关闭，所以运行中的命令会失去其列表不再包含的主机。它处理 `CONNECT host:port` 和绝对形式的 `http://` 请求；在任何查询之前，它拒绝列表不准入的主机或端口，拒绝解析到抓取防护矩阵所拒绝地址的列出名称，只连接它检查过的地址，发送纯 HTTP 请求时使用它检查过的 URL 的 `Host`，用命令会打印出来的一句话应答每次拒绝，并记录日志。它最多持有 `proxyMaxConnections` 个连接，多出的一个以 `503` 拒绝，并关闭空闲 `proxyIdleTimeoutMs` 的连接。它不读取隧道的字节，所以无法检查 TLS 握手或内层请求所指名的名称。条目是至少两个标签的主机名、匹配其域名之下所有名称但不匹配该域名本身的 `*.` 名称，或公网 IP 地址；它准入端口 80 和 443，而写成 `host:port` 的条目则改为准入那个端口（[`src/network.ts`](src/network.ts)）。
- 一个单调的工具守卫在 `off` 下拒绝 `web_fetch`，在 `allowlist` 下拒绝主机和端口不被任何条目准入的 URL；`web_fetch` 只跟随同源重定向，所以 URL 的主机就是每一跳的主机。
- 在 `open` 下，Linux 运行器会在 host 的抽象 Unix 套接字（显示服务器、会话总线）监听期间拒绝命令，因为命名空间是共享的，没有挂载规则能隐藏它；该检查在命令启动时运行，所以之后才开始监听的套接字不会被发现。工作区可以在 `open` 下通过 `acceptAbstractSockets` 接受这一风险，在「设置」→「网络」中设置（**Run commands even when desktop sockets are reachable**）；此后解析器携带沙箱的 `host` 网络，命令得以运行，沙箱报告为部分强制执行。接受这一风险会放宽网络，所以这一更改与任何其他放宽一样需要本人的确认；该设置与访问设置存放在一起，且只在 `open` 下有效。该行的 `acceptAbstractSockets` 在 `network` 为 `open` 期间，对没有自己设置的工作区给出同样的接受。在运行器会因此拒绝某条 `bash` 命令之前，`abstract-socket-consent.ts` 会通过已组合的审批服务对每个工作区询问本人一次（`bash` 与 `pwsh`，仅在本地沙箱提供方下，且仅当运行器自己的 `refuseAbstractSockets` 会拒绝时）（`grants: 'full-access'`，因此 Host 把回答保留在主目录所在的电脑上）；允许会通过 `acceptAbstractSockets()` 记录同样的接受，拒绝或 `unavailable` 回答（`delorun headless`）保留运行器的拒绝，且在重启之前不再询问，被取消的询问会再次询问；允许不会被记住，所以在设置中撤销之后，下一次拒绝会再次询问。
- [`src/network-store.ts`](src/network-store.ts) 将这些设置保存在 `secrets/permission-defaults/network.json`，模式 0600，遵循与权限存储相同的拒绝规则。在已存在的存储无法读取期间，每个工作区都按 `off` 计，且不记录任何更改。
- 两条 Fetch 路由为 studio 的「网络」部分提供服务：`GET /api/delorunNetwork.list` 与 `POST /api/delorunNetwork.set`。两者都通过 `@delorun/home-auth` 的 `requireComputerUnlessDangerous` 和 `routedPathname`，在读取请求体之前，以 `LOOPBACK_REQUIRED` 拒绝没有经回环监听器、以回环 `Host` 到达的请求，所以任何写法的路由都无法通过该检查；危险模式持续期间，持有解锁的远程访问设备可以通过。放宽网络的更改（改为限制更少的访问，或加入旧列表不准入的主机），在请求携带本人的确认之前以 `NETWORK_UNCONFIRMED` 拒绝；收紧则立即生效。模型没有能触及该设置的工具，插件管理也无法重新配置此行。

<a id="dangerous-mode"></a>

## 危险模式

设置了 `fullAccessEverywhere` 且存在有效的授权文件时，`granted(cwd)` 对每个工作区都为真，防护准入切换到完全访问，`select` 不经询问、也不带授权时间地记录工作区默认值。`everywhere()` 报告 `{ on, grantedAt?, problem? }`，工作区列表也携带它。当授权文件被移除或该行关闭它时，存储的监视会在一秒内读取这一变更，没有自己授权的工作区中打开的完全访问 chat 会回到更安全的预设。

两条路由为它服务。`GET /api/delorunPermission.everywhere` 读取状态，`POST /api/delorunPermission.everywhereOff` 移除授权文件；电脑自己的请求和带有运行中解锁的远程访问设备都可以调用任一条，因为读取和关闭只会收紧，其他每个设备在请求体被读取之前就被拒绝。已解锁的设备在该模式持续期间通过 `setFullAccess` 为工作区开启的完全访问，会记录在存储旁的 `device-grants.json` 中，并在该模式结束时撤回，即在下一次重新加载或启动时：该工作区记录更安全的预设，其打开的完全访问 chat 回到它。该模式关闭期间，这样的授权在读取时绝不计入，即使写入其撤回失败也是如此；下一次重新加载时的重试只是清理存储。电脑做出的授权，或工作区原本就持有的授权，则保持不变。没有路由能开启该模式：只有 `delorun setup` 通过 `@delorun/plugin-permission-defaults/store` 中的 `writeDangerousGrant` 写入授权文件。

<a id="configuration"></a>

## 配置

| 选项 | 默认 | 作用 |
| --- | --- | --- |
| `enabled` | `false` | Delorun 的 C16 开关 `permission_defaults`，在对等组合中关闭；开启时，插件按工作区为每个新 chat 播种，挂载拒绝无人同意的工作区使用完全访问的防护，并为每个工作区的沙箱命令提供其网络。 |
| `network` | `open` | 没有自己设置的工作区的网络：`open`、`allowlist` 或 `off`。 |
| `acceptAbstractSockets` | `false` | 当 `network` 为 `open` 时，没有自己设置的工作区是否接受 host 的抽象 Unix 套接字对其命令保持可达。`false` 会在这类套接字监听期间拒绝命令。 |
| `allowedHosts` | `[]` | 没有自己设置的工作区的列表，在 `allowlist` 下使用；无效的条目会使加载失败。 |
| `proxyConnectTimeoutMs` | `30000` | 出站代理等待到列出主机的连接建立的时长。 |
| `proxyMaxConnections` | `256` | 一个允许列表的出站代理同时持有的最大连接数；多出的一个以 `503` 拒绝。 |
| `proxyIdleTimeoutMs` | `300000` | 通过出站代理的连接在任一方向都没有字节传输多久之后，代理将其关闭。 |
| `fullAccessEverywhere` | `false` | 危险模式，只由 `delorun setup` 的第三个提示的回答写入。为 true 时，每个 chat 都可使用完全访问，无需工作区同意，也没有对话框，但前提是授权文件 `secrets/permission-defaults/full-access-everywhere.json` 同时存在且有效（模式 0600，不是符号链接，内容为 `{ v: 1, grantedAt, warning: 1 }`）；任何一半缺失，每个工作区自己的同意仍然有效，并在存储问题中指名被拒绝的文件。设备的设置写入和插件管理器都无法设置它。 |

<a id="tests"></a>

## 测试

`tests/watch.spec.ts` 覆盖监视：存储文件每一批更改只报告一次，其锁文件和临时文件不报告，不指名文件的更改，失败的监视被关闭并只报告一次，以及关闭时丢弃待处理的更改。`tests/store.spec.ts` 覆盖存储的路径、格式的往返、使存储不作数的各种拒绝（更宽松的模式、符号链接、其他格式）、条目查询，以及让一个目录成为一个工作区的工作区键。`tests/permission-defaults.spec.ts` 覆盖关闭状态的开关、新工作区获得的播种、每个文件夹询问一次的同意、不记录任何内容的拒绝、防护拒绝的模式切换、已持有授权的工作区，以及另一个进程撤回授权之后的完全访问选择（它会再次询问，或在撤回发生在选择读取存储之后时不记录任何内容）。`tests/surfaces.spec.ts` 覆盖这些界面的调用与路由：列出的工作区、让切换通过并只把询问同意时所在的 chat 切换为完全访问的授权、让打开的 chat 回退的撤回、CLI 写入后保留并重新读取的存储、由另一个 Host、由 chat 回到更安全的预设或由 CLI 的加锁写入造成的撤回（它会在一秒内让第二个 Host 中打开的完全访问 chat 回退，那里无需决定，也无需读取任何 profile 的令牌）、无法启动的监视（它会被记录并留下决定时的读取）、失败的重新读取（它会被记录），以及拒绝用例：远程访问设备、未确认的答复、过时的审查以及并非在该工作区中打开的 chat，都不记录任何内容。`tests/network.spec.ts` 覆盖允许列表条目、主机匹配、哪些更改属于放宽，以及网络存储；`tests/egress-proxy.spec.ts` 在真实套接字上运行代理，并把文档地址映射到本地监听器；`tests/command-network.spec.ts` 挂载该服务并覆盖解析器、存储、确认、被拒绝的存储、`web_fetch` 守卫和路由；`tests/egress.integration.spec.ts` 在真实的 bwrap 下通过整条链路运行受限命令，在 bwrap 不可用的地方跳过。

<a id="when-a-service-fails"></a>

## 服务失败时

权限服务或网络服务在 `enabled` 开启期间启动失败时，该行启动失败，并在根上下文中挂载：一个让每条受限命令都没有网络的解析器；以及，在失败行自己的服务被移除之后，一个在真正的守卫缺失时（无论哪个服务失败）拒绝 `danger-full-access` 的守卫。CLI 的已启动 Host 检查会把每个这样的替身报告为不健康的行。日志会指名该行和失败原因；该行再次启动时，这些应答会被移除。`enabled` 关闭时，该行不挂载任何内容，命令与 stock 一样共享 host 的网络。

该行拒绝自己的配置（无效的 `allowedHosts` 条目，或没有意义的代理上限 0）时，替身服务同样会挂载，热重载时亦然，而热重载不会运行启动检查。插件从未加载的行会在 Host 运行期间让这些接缝缺失；对这种情形，`delorun start` 的启动检查是唯一的保障。
