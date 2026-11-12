---
description: "Delo 的威胁模型：绝不比 stock DSH 更不安全的目标、Delo 改变的默认值、哪些命令带有 Delo 的保护、资产、各方能看到和能做的事、每个信任边界上当前已构建的防护及规定它的约定、Delo 不防范的内容，以及变更如何保持该模型成立。"
---

# Delo 威胁模型

[English](threat-model.md) | 中文

Delo 尚无发布；本页描述本仓库中的代码。

## 摘要

本页说明 Delo 保护什么、防范谁、如何防范，以及在哪些地方无法防范。它在上游的[安全声明](../../../SAFETY.zh.md)与[进程沙箱参考](../../../docs/subsystems/sandbox.zh.md)之上扩展出 Delo 的资产、各方、信任边界与局限，上游这两份文档原样适用于 Delo。每个边界都陈述已构建的防护，并链接规定它的约定；尚未构建的防护会被标明为未构建，并附上保存其规则的设计或约定。疑似漏洞请通过 [SECURITY.md](../../../SECURITY.md) 报告。

## 目录

- [目标](#goal)
- [Delo 的保护在哪里适用](#where-delos-protections-apply)
- [资产](#assets)
- [各方与信任](#parties-and-trust)
- [边界及其防护](#boundaries-and-their-defences)
- [Delo 不防范的内容](#what-delo-does-not-protect-against)
- [变更如何保持本页成立](#how-changes-keep-this-true)

<a id="goal"></a>

## 目标

Delo 的目标是在任何路径上都不比 stock DSH 更不安全，并且在它改变默认值的地方更安全。Delo 运行指定 DSH 版本的上游代码，保留上游的批准、权限与沙箱决策，包括没有应答者的批准请求会被拒绝这一规则（[批准](../../../docs/subsystems/approval.zh.md)）。Delo 在这些决策之外增加保护，每项改变批准、拒绝或提权的 Delo 变更都遵循[下文的规则](#how-changes-keep-this-true)。[对等组合](../contracts/c16-parity-composition.zh.md)关闭所有模型可见的 Delo 变更并回放上游录制的场景，因此 stock 行为始终可以达到并受到检查。

上游的安全声明原样适用于 Delo：沙箱、批准与权限控制能降低风险，但不保证隔离。在原生（native）工作区中，命令以本人（the person）自己的权限运行。

CLI profile 改变了以下默认值。[对等清单](../reference/parity.zh.md)列出每一项及其证据。

| 默认值 | stock DSH | Delo 的 CLI profile | 对安全的影响 |
| --- | --- | --- | --- |
| 原生命令的限制 | 沙箱限制文件写入；读取、Unix 套接字与网络保持开放 | 在 bwrap、Landlock 与 Seatbelt 上，沙箱还拒绝受限命令在 Delo 的 home 下写入、在其下读取（三个豁免除外）；在 bwrap 与 Seatbelt 上，还拒绝其连接更新通道的套接字与 Docker context 的套接字（[C1](../contracts/c01-home-layout.zh.md)）；在 Windows 上只限制写入 | 在 Linux 与 macOS 上更安全；没有任何东西按机器报告哪些规则成立 |
| 完全访问 | 新工作区以 `workspace-write` 开始，完全访问无需同意 | 沿用 stock 的 `workspace-write` 默认值；把工作区的预设切换为完全访问会被拒绝，直到本人在 home 的电脑上为该工作区授权：通过 studio 的同意（它写明 Delo 的 home、其密钥与令牌以及其通道），或使用 `delorun workspace full-access`；按调用的提权经过上游的批准提示，该提示不提及 Delo 的 home | 对预设切换更安全；按调用的提权与 stock 相同；“与 stock 相同”会关闭该拒绝 |
| `web_fetch` 的目标 | 在所有模式下无需确认即抓取回环、链路本地与私有网络主机（[web-fetch-http](../../../packages/web/web-fetch-http/README.zh.md)） | 抓取防护在任何连接之前拒绝这些目标（包括云元数据地址），并给出模型可读的类型化原因 | 更安全；设置的提示答复会保持它开启 |
| 计划任务 | 一次获批的调用就能创建无人值守、反复运行的轮次 | 创建或编辑任务时会写明重复规则、目标会话及其权限预设并询问；当目标 chat 的预设与获批的预设不同时，投递会被拒绝 | 在设置的默认提示答复下更安全；“与 stock 相同”会关闭它 |
| 指令层文件 | 模型对 skill、预设或 `AGENTS.md` 的写入，即使需要批准，也只作为文件写入批准 | 通过文件工具的写入会询问，并写明其效果（该文本会作为指令加载到其范围内今后的每个 chat）与差异；shell 命令或 PTC 代码的写入不经询问。审查按目标已存在目录的设备号与 inode，将其与 skill 提供方和 profile 启动器读取的根目录比对，因此链接或不同的大小写会得到相同的答复，并在卷不区分大小写时对不存在的部分折叠大小写；硬链接只在它指向指令文件本身时才询问，指向其他位置的链接文件则不询问。这是针对文件工具写入的提示，而不是针对拥有 shell 的模型的边界 | 仅对文件工具更安全；“与 stock 相同”会关闭它 |
| MCP 服务器 | 每个服务器命令都作为可信代码在 agent（智能体）沙箱之外运行 | 新的 stdio 服务器会被拒绝，并写明其命令、参数、工作目录以及已配置环境变量的名称；审查只显示会改变运行内容的变量（`PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`PYTHONPATH`、`DYLD_*`）的值。一次接受属于一个服务器名称并覆盖其完整启动：其中任何部分发生变化（例如 `PATH`、`NODE_OPTIONS` 或 `LD_PRELOAD`）都会再次询问并写明变化的变量，其他服务器名称从不共享它，在审查工作目录与环境之前或在按服务器名称保存接受之前记录的接受不被采纳，并且无论顺序如何，服务器行都会等待同意行。本人在主机的电脑上通过工作室的「设置 > 权限」或 `delorun mcp accept` 接受被暂停的服务器，两者显示相同的启动信息，并在同一处拒绝它，或在同一处或用 `delorun mcp revoke` 撤销其接受，该服务器随即保持停止，直到其启动变化；远程设备只能读取等待中服务器的名称及变化，它的每个答复都会被拒绝 | 更安全；新的 stdio 服务器在一次接受后启动；“与 stock 相同”会关闭该拒绝 |
| `plugin_manager` 下的防护插件 | 在完全访问下，该工具无需提示即可运行，并能停用、重新配置或移除除插件管理自身组件之外的每个插件 | 插件管理还保护 Delo 的同意与防护插件、更新闸门、更新检查、`dsh-sandbox-local` 与 `dsh-sandbox-policy`。在所有模式下，该工具都会拒绝这样的变更：根据 profile 变更前后的组合行判断，它会丢弃、替换、重新配置、停用或复制一个受保护的行，把其 id 给另一行，或添加一个受保护模块的行，无论是通过 `set_plugin`、`configure`、组合包的安装、选择、取消选择或移除、`undo` 还是 `restore`；它还拒绝提供受保护模块的包。完全访问的命令仍可直接编辑 profile 的文件，嵌套在另一个组合包依赖中的遮蔽包不受检查；防护包的版本豁免无法通过撤销或恢复去除 | 更安全 |
| 数据共享 | 桌面分析与 DeepSeek 会话日志上传默认开启 | 会话日志上传关闭；Delo 没有自己的遥测。桌面分析属于桌面应用，桌面应用是上游的，保持其开启 | 在 CLI profile 中更安全 |
| studio 附加功能 | stock 外观 | Delo 的主题、设置布局、chat 状态、侧栏与入门引导；不挂载主 chat | 不改变批准或限制 |
| home 目录 | `~/.dsh` | `~/.delo`，在 Linux 与 macOS 上权限模式为 0700；`delorun` 从不读取或写入 `~/.dsh` | 分开两个 home |

对等注册表还为容器拒绝标记、无需提权的 `plugin_manager` 读取操作、`preset_inspect` 与 profile 历史声明了开关；CLI profile 不开启其中任何一个，因此每一项都保持 stock 行为。

<a id="where-delos-protections-apply"></a>

## Delo 的保护在哪里适用

- **CLI profile。** 由 `delorun setup` 创建、由 `delorun` 或 `delorun start` 启动的 profile：上游的 web 模板加上 `@delo/bundle-local` 与 `@delo/bundle-studio`。本页称为已构建的每项保护都在这里适用。
- **`delorun headless`。** 它启动 home 的 `headless` profile：上游的 `headless` 模板加上 `@delo/bundle-headless`，运行在 C1 的沙箱 overlay 之下。抓取防护、指令写入、MCP 与计划任务的同意、完全访问同意以及回合闸门都适用，插件管理无法关闭它们，DeepSeek 的会话日志上传也与 CLI profile 一样关闭。会询问本人的防护会拒绝，因为该 profile 不组合任何批准应答者。对于没有在 home 的电脑上记录完全访问授权的工作目录，完全访问同意会拒绝完全访问；在参数或 `DSH_PERMISSION_MODE` 中请求完全访问也会在启动之前被提前拒绝。组合会拒绝不含该组合包的 `headless` profile，并且任务只在 Delo 检查过该组合包的行与服务之后才开始。该模板不挂载 MCP 客户端，也不挂载计划任务运行时；MCP 与计划任务的同意保护的是本人自己的 patch 添加的客户端或运行时。
- **`delorun plugin`。** 它运行上游的 pnpm 操作，不带 Delo 的任何行：没有受保护的 home、没有被拒绝的套接字、没有同意、没有抓取防护，也没有隐私默认值。让每个启动 Host 的命令都应用 Delo 的层，见[原生限制设计](../design/native-confinement.md#every-way-a-host-boots)。
- **桌面应用。** 它是上游的，未作改动，Delo 的任何行都不适用于它。
- **Windows。** 沙箱只限制写入。受限命令可以读取整个 home，包括 Delo 的密钥、上游的凭据文件与启动令牌，并且不会对 home 运行任何权限模式或访问列表检查。

<a id="assets"></a>

## 资产

- **本人的文件与工作区**：机器上的工作区根目录。
- **模型提供方密钥与其他密钥**：home 下上游的 `.credentials.yaml`（它还保存浏览器会话密钥）与 `.env`；`~/.delo/secrets/` 下 Delo 的文件，其中保存 `delorun export` 创建的 home 密钥以及 Delo 同意插件的同意记录。
- **会话**：chat 历史（其中常含密钥），以及附件、全文索引、溢出文件与浏览器中的草稿。
- **Delo 的 home**：`~/.delo`，包括其密钥、每次启动的令牌、更新通道的套接字、已验证的发布根与检查点，以及运行时仓库（runtime store）。
- **发布完整性**：已签名的发布清单、运行时文件与 npm 启动器，以及为它们签名的离线 root 与 targets 密钥。
- **插件供应**：已安装的插件，上游的插件管理器在 profile 的 `pnpm-lock.yaml` 中记录其版本与 tarball 完整性。

<a id="parties-and-trust"></a>

## 各方与信任

### 本人

本人拥有 home 与机器。凡是其操作系统用户能看到和能做的事，本人都能看到和做到：home 下的每个文件、每个 chat 与密钥，以及在其账户能运行时的 `delorun` 与 Docker。`delorun verify` 只做报告，不改变任何内容。本人批准提权、同意与更新；Delo 自己的提示会在本人作答之前说明其效果，按调用的提权提示则是上游的。

### 模型及其工具调用

模型能看到系统提示、chat 的历史、工具描述与工具结果。这些文本中的任何一段都可能带有通过网页、文件、仓库、issue、其他 chat 或工具输出注入的指令。导入的 chat 不会进入任何模型请求，因为没有任何东西打开导入的 chat（[C8](../contracts/c08-archive-and-trash.zh.md#untrusted-imported-chats)）。模型可以调用其预设提供的工具，每次都经过上游的批准与工作区的沙箱模式，也可以请求只有本人才能批准的提权；它看不到提权提示。它的命令以本人自己的权限运行。在 CLI profile 中，它们按 [C1](../contracts/c01-home-layout.zh.md) 的规定受到限制，它的 `web_fetch` 调用也只能到达抓取防护允许的目标。它运行的 shell 命令或 PTC 代码可以在可写根目录中写入指令文件，而无需指令同意。

### 插件

插件是本人安装的代码，其可信程度以本人的安装为限。Host 插件在 harness 进程中以 harness 的权限运行：它能读取 Host 读取的内容，包括 Host 加载的凭据以及 home 进程（home process）在内存中持有的启动令牌，并能向更新通道发送其固定请求集合中的任何请求。客户端插件在 studio 页面中以浏览器的权限运行。Delo 不对插件做沙箱隔离，也不审计插件。Delo 在安装时与启动时检查每个插件的 DSH 与 Delo 版本要求（[C17](../contracts/c17-plugin-versions.zh.md)）；除上游的锁文件之外它不固定任何东西，插件索引与撤销列表尚未构建（[C13](../contracts/c13-catalogue-revocation.zh.md)）。每个 MCP 服务器命令都按上游所述，作为可信代码在 agent 沙箱之外运行；在 CLI profile 中，新的 stdio 服务器，或命令、参数、工作目录或环境发生变化的服务器，会被拒绝。

### 同一用户下的其他本地进程

在沙箱之外运行的本人用户进程，可以读取和修改 home 下的一切、读取启动令牌，并在本人能运行 `delorun` 与 `docker` 时运行它们。凭借启动令牌，它可以使用更新通道的每个操作（[C19](../contracts/c19-home-process.zh.md#the-update-channel)），包括 `devices.approve`、`devices.remove` 与 `studio.open-token`：它可以打开批准窗口并用匹配码批准待处理的设备请求、取消请求、移除设备，以及获取新的 studio 登录链接。当它还控制着一台请求批准的设备时，它可以在无人在场的情况下批准该设备，该设备随后通过远程访问（reach）登录。Host 自己的通道令牌对这些操作会被拒绝，受限命令也无法读取令牌文件或访问该套接字（[C1](../contracts/c01-home-layout.zh.md#sockets-and-the-start-token)）；这种限制是让 agent 无法执行同样操作的唯一保障，而在沙箱之外运行的命令（例如在 `danger-full-access` 下获批的命令）拥有这些能力。Delo 不声称防范这样的进程。home 的权限模式防范的是其他用户，而不是它，也不存在 root 所有的辅助程序。只有当篡改没有同时改动启动器、已存储的 root 或 `trust/runtime-files/` 下运行时的身份记录时，启动器的启动检查才能发现被改动的运行时文件。

### 机器上的其他用户

在 Linux 与 macOS 上，其他非管理员用户无法读取 home（其目录权限模式为 0700、受保护文件为 0600），也无法连接更新通道的套接字（位于 0700 目录内、权限模式为 0600）。在 Windows 上，Delo 不检查任何访问列表，home 的访问权限就是操作系统为本人 profile 中新目录赋予的权限。其他用户可以与 studio 的回环监听器建立 TCP 连接，该监听器接受启动令牌与上游的签名 cookie（[C4](../contracts/c04-admission.zh.md#sessions)）。在 CLI profile 中，启动令牌是一次性的：`delorun` 以本人的启动令牌从 home 进程获取每个启动令牌，它在 60 秒后过期，第一次出示即被消耗（[C4](../contracts/c04-admission.zh.md#sessions)）。它仍然在交给浏览器启动器的 URL 中传递，而在没有 `hidepid` 的 Linux 上，其他用户可以读取该启动器的命令行，因此另一个用户可以在浏览器第一次请求之前的几秒内抢先使用它。以这种方式获得或从浏览器复制的 cookie 在 30 天内都能被准入。`delorun headless` 与桌面应用运行上游的 profile，其中启动令牌在 Host 进程的整个生命周期内都可重复使用。管理员或 root 能做本人能做的一切。在 rootful Docker 引擎上，`docker` 组成员身份等同于 root。

<a id="the-network"></a>

### 网络

网络上的一方能看到机器的连接。安装与更新会获取发布的公开签名文件，而每次通过 npm 启动器启动时，只要网络可达，都会检查发布日志。这些请求不携带个人数据，它们会向其主机暴露机器的 IP 地址、请求时间与 Delo 版本。这些文件都通过签名验证，因此其主机不受信任：被改动的文件无法通过验证，被扣留的文件会在安装或更新时因其 timestamp 过期而被发现。没有任何设置可以关闭发布日志检查。studio 监听回环地址；只有在本人开启 Tailscale 私有远程访问之后，它才同时监听本人的 tailnet，在此之前该访问保持关闭。

### Tailscale、本人自己的中继与 OIDC 提供方

远程访问关闭时，任何 Tailscale 节点、中继或身份提供方都不在通往 studio 的路径上。开启 Tailscale 私有远程访问时，由 Tailscale 承载流量：其协调服务能看到机器的名称、机器与每台设备的 IP 地址、连接时间与流量大小，除非开启 Tailnet Lock，它可以向 tailnet 添加设备，并获取 `ts.net` 证书。被添加的设备可以打开登录页面并请求批准，在本人于电脑上批准之前无法打开任何 chat。自托管中继与 OpenID Connect 提供方尚未构建，因此两者都不在任何路径上。[远程访问设计](../design/reach.md)以及约定 [C5](../contracts/c05-device-approval.zh.md)、[C6](../contracts/c06-relay-protocol.zh.md)、[C7](../contracts/c07-reach-providers.zh.md) 与 [C14](../contracts/c14-oidc-passkeys.zh.md) 说明了每一方能看到和能做的事，并各自附有已存在内容的状态。

### Delo Run 项目

Delo Run 持有离线的 root 与 targets 密钥以及在线的 timestamp 密钥。它可以发布一个已签名并记录在公开日志中的版本。在本人确认之前，没有客户端会安装它：npm 启动器只安装到空的运行时仓库中，`delorun update` 也只在本人确认后才应用。更新从不转到更低的发布：运行时仓库在安装任何内容之前，以 `TARGET_LOWER` 拒绝低于正在运行版本的通道发布或请求的版本，`delorun update` 拒绝这样的报告，只有 `delorun recover rollback` 能回退。timestamp 命令拒绝降低通道版本，客户端也拒绝比自己已存储的更旧的 timestamp，因此不持有密钥的通道宿主只能扣住更新的发布，且只到它最后提供的 timestamp 在签发 3 天后过期为止；在此期间启动仍运行已安装的发布（[C2](../contracts/c02-release-manifest.zh.md#freshness-and-rollback-protection)）。Delo Run 无法进入 home：通往 studio 的任何路径上都没有 Delo 基础设施，它也不持有 home 的任何密钥。本人对 Delo Run 的剩余信任包括其发布，以及提供其元数据的 `delorun.com` 名称。

### 上游与依赖作者

上游的代码就是 harness，因此其作者如同 harness 一样受到信任。Delo 合并上游的每次发布，为每个改动的文件记录结论，并重新运行对等回放与插件语料。依赖由锁文件固定，签名命令在签名之前会根据公告源检查锁文件。带标签源码或固定依赖中的恶意改动会被重建复现并签名；签名与日志条目表明发布来自何处，而不表明它没有缺陷。

### 持有被盗设备的一方

本人批准过的设备，只要处于解锁状态且其会话仍然有效，就会让持有者获得 chat 以及允许列表所允许的操作：无请求 12 小时后失效，最长 14 天。本人在电脑上移除丢失的设备，这会立即结束其会话。home 电脑上持有回环 cookie 的浏览器 profile，自签发起最长 30 天内都能以本人身份被准入，跨越重启仍然有效，且没有任何命令可以撤销它。运行 home 的计算机被盗时，持有者获得本人用户持有的一切；在这种情况下，Delo 依靠操作系统的登录与磁盘加密。

<a id="boundaries-and-their-defences"></a>

## 边界及其防护

每一节写明边界、已构建的防护以及规定它的约定。

- [原生命令的限制](#confinement-of-native-commands)
- [home 的控制通道](#the-homes-control-channels)
- [容器隔离](#container-isolation)
- [准入与监听器](#admission-and-listeners)
- [设备批准](#device-approval)
- [远程访问方式](#reach-providers)
- [登录](#sign-in)
- [发布、日志与重建](#releases-the-log-and-the-rebuild)
- [插件索引与撤销](#the-catalogue-and-revocation)
- [更新与回滚](#updates-and-rollback)
- [导出文件与不受信任的 chat](#archives-and-untrusted-chats)
- [日志与遮盖](#logs-and-redaction)
- [验证](#verification)
- [对等](#parity)
- [web_fetch 抓取防护](#the-web_fetch-guard)
- [数据共享](#data-sharing)

<a id="confinement-of-native-commands"></a>

### 原生命令的限制

[C1](../contracts/c01-home-layout.zh.md) 定义了 CLI profile 在上游沙箱之上为每个在 `read-only` 或 `workspace-write` 下运行的命令添加的六条规则；第六条 `wsl-interop` 见下文。前五条是：不得在 home 下写入（`home-write`），不得在其下读取，`runtimes/`、`skills/` 与 `dsh-runtimes/` 除外（`home-read`），不得读取启动令牌（`token-read`），不得连接 home 的通道（`home-connect`），也不得连接位于真实路径的 Docker 套接字（`docker-connect`）。

- bwrap 强制执行全部五条。Landlock 强制执行 `home-write`、`home-read` 与 `token-read`，无法表达两条套接字规则。Seatbelt 强制执行全部五条。windows-acl 只强制执行 `home-write`。
- Delo 的密钥保存在 `secrets/` 下的文件中，在 Linux 与 macOS 上文件权限模式为 0600、所在目录为 0700，从不放在读取豁免、profile、命令行、命令的环境变量或日志中。上游的凭据文件位于 home 下，受 `home-read` 约束。Delo 不使用操作系统的密钥存储，因为受限命令可以通过 D-Bus 访问 Linux Secret Service，也能运行 macOS 钥匙串项目所信任的 `node` 可执行文件。
- 当某个可写根目录等于 home、位于 home 内或包含 home 时，`workspace-write` 会被拒绝。
- 其他 Unix 套接字（例如 ssh-agent 套接字、D-Bus 与显示服务器）以及网络，对受限命令仍然可达。Docker Desktop 除 context 套接字之外的控制套接字不被拒绝。
- `danger-full-access` 的批准提示是上游的；它不说明完全访问能触及 Delo 的 home。
- 没有任何东西按机器报告哪些规则成立：启动时不运行探测，`delorun verify` 把 `confinement-rule` 检查报告为未运行。
- 在 WSL 下，互操作（interop）会让受限命令启动 Windows 程序，该程序在每个 Linux 命名空间、挂载规则与受保护的 home 之外，以本人的 Windows 账户运行，并能读取 Windows 进程的命令行。`delorun start` 把 WSL 的互操作目录 `/run/WSL` 指定为逃逸套接字目录（`wsl-interop`）；在它存在的地方，bwrap 会隐藏它，因此不会有 Windows 程序通过互操作套接字启动，无论是按路径、按裸名称、作为副本、通过 `/init` 还是设置了 `WSL_INTEROP`；Landlock 无法隐藏它，因此改为拒绝每个受限命令。在 bwrap 下，一个 seccomp 过滤器还会拒绝 vsock 套接字（互操作套接字之下 WSL 与 Windows 之间的传输）以及 io_uring（其请求创建的套接字该过滤器看不到）（`vsock`）；它适用于内核提供 vsock 的任何虚拟机，在那里需要 io_uring 的程序会失败，通过 `socketcall` 创建套接字的 32 位程序得不到套接字。抽象 Unix 套接字在每种方言上都仍可访问；WSL 不在任何抽象套接字上监听，而本人运行的、在抽象套接字上监听的程序是可访问的（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)）。
- harness 自身会在工作区的仓库上运行 git，以记录每个回合改动的文件。每条这样的命令都在 Session 的沙箱中运行，可写根目录为 Session 的可写根目录加上插件的快照目录；当 Session 为 `read-only` 时，只有该目录可写；只有当 Session 的命令不受限制时它才不受限制地运行，沙箱无法限制的命令，或没有挂载沙箱的受限 Session，不记录任何内容。快照目录位于每个用户的缓存目录中，在 Delo 的 home 之外；除非某个 Session 的可写根目录包含它，任何方言都不会把它授予受限命令。每次快照与复制都先将其与每个活动 Session 的可写根目录比对，有重叠时不记录任何内容；harness 在每次使用之前检查其中每个目录的设备号与 inode，它在那里的文件操作会拒绝最后一级路径组件是链接的情况、命名管道以及不是它创建的条目。通过已批准的完全访问提权运行的命令不在此范围内。每条命令都在移除每个继承的 `GIT_*` 变量的情况下运行，并带有命令范围的配置，关闭文件系统监视器、钩子、仓库配置定义的每个过滤器与 diff 驱动、分页器、编辑器、凭据助手与传输，因此受限命令写入的 `.git/config`、`.gitattributes`、钩子或 `.git` 文件不会启动任何程序（[workspace-changes](../../../packages/deliverables/workspace-changes/README.zh.md#understand-the-implementation)）。stock 不受限制地运行这些命令，且仓库的配置生效。
- 本人自己的 git 与编辑器没有加固。在 `workspace-write` 下，受限命令可以写入仓库的 `.git/config`、钩子与属性文件，下次本人在沙箱之外于该仓库中运行 git 或编辑器的 git 集成时，这类设置指定的程序会以本人的完全权限运行。一项让这些文件对受限命令保持只读的[设计选项](../design/workspace-git-state.md)尚待决定。
- 文件工具自行应用 `home-read` 与 `home-write`。`read`、`read_image`、`apply_patch` 与 `str_replace_editor` 拒绝位于 home 下或通往 home 的其他路径（读取豁免除外），本地文件系统会确认它打开的文件或目录就是它检查过的那个，因此在检查与打开之间被替换为指向 home 的链接的工作区目录会导致读取失败：在 Linux 上依据描述符自身的路径，在其他平台上依据其设备号与 inode，在这两次查找之间换入又恢复的链接不会被发现。写入围栏拒绝 home 以及提供方找到的 home 的其他每个挂载。`glob` 与 `grep` 在 ripgrep 启动之前解析其根目录，并在 `read-only` 下以受限方式运行 ripgrep，因此方言的 `home-read` 在搜索的每一层深度都成立，与命令相同；在没有运行器能限制的地方，搜索会失败；在不限制任何读取的 Windows 上，搜索期间换入又恢复的链接不会被发现。这些工具还可以读取 `spill/`，那里保存对 chat 而言过长的工具输出，溢出提示会告诉模型去读取它；受限命令则不能。溢出文件只写入 `spill/`（权限模式 0700，若更宽松则收紧）：当 home 无法容纳它时，输出留在 chat 中，而不是写入受限命令可能读取的临时目录。
- harness 通过其子进程服务启动的命令与其他进程继承其环境，但不包括上游过滤器丢弃的条目：保存凭据的名称，例如 `*_TOKEN`、`*_CREDENTIALS`、`*PASSPHRASE*`、`MYSQL_PWD`、`KUBECONFIG` 与 `KRB5CCNAME`，以及含有带用户信息的 URL 的值，包括仅含令牌的 `https://<token>@host` 或 Sentry DSN。像 `PATH` 这样的搜索列表只丢弃其中指向凭据文件或 agent 套接字的元素。以过滤器不认识的名称和形式出现的凭据会被继承。
- 有些工具会在工作区中于沙箱之外启动程序：Claude Code 与 ACP 子 agent 工具启动其 agent 进程，stdio 语言服务器工具启动语言服务器，均不受限制。这些程序以本人的完全权限读取工作区的文件与配置，因此受限命令在那里写入的文件可以改变它们的行为。

探测、检查、提示的说明、Docker Desktop 的控制套接字目录、Windows，以及 `delorun headless` 下的相同规则，见[原生限制设计](../design/native-confinement.md)。

<a id="the-homes-control-channels"></a>

### home 的控制通道

更新通道（[C19](../contracts/c19-home-process.zh.md)）监听套接字 `run/<profile>/update.sock`。它只接受携带本次 home 进程启动令牌的请求：该令牌为来自操作系统随机源的 256 位数据，以恒定时间比较，从不出现在命令行、环境变量、响应或日志中。它不转发请求：更新请求不携带路径、归档、URL 或命令，因此持有令牌的调用方只能选择一个版本：由 home 进程从渠道获取并验证的版本，或已安装在运行时仓库中的版本。这种保护依赖于对 agent 命令的限制（如 C1 所述），并且只在方言拒绝读取令牌的地方成立。[C9](../contracts/c09-runtime-supervisor.zh.md) 的 Docker 监管器通道不监听，因为没有命令启动监管器，Windows 上也不存在命名管道。

<a id="container-isolation"></a>

### 容器隔离

Docker 工作区尚未构建。[C9](../contracts/c09-runtime-supervisor.zh.md) 规定了它们以及将创建它们的监管器；监管器包已存在，而 `delorun start` 从不启动它。

<a id="admission-and-listeners"></a>

### 准入与监听器

[C4](../contracts/c04-admission.zh.md) 定义准入。回环监听器在 CLI profile 中为 `127.0.0.1:3080`，运行上游的准入并开启一次性启动令牌：启动令牌在 60 秒内只能使用一次，`/connect`，以及无状态的签名 cookie，它们在签发 30 天后过期，没有闲置限制、没有服务器端记录，也不可撤销。能读取 home 的 `.credentials.yaml` 的一方无需任何启动令牌即可签出这样的 cookie。每个持有 cookie 的浏览器都以唯一所有者的身份行事，回环 studio 不发送内容安全策略。设置的 `--yes` 与 `--config` 形式从不开启远程访问（[C11](../contracts/c11-setup-answers.zh.md)）；`delorun reach on tailscale` 以及设置 Full 模式中的“是”答复会开启它。开启远程访问时，远程访问监听器的分发器在任何路由、升级或回退之前认证每个请求。回环凭据是上游的启动 cookie 与 API 凭据，由上游内置的准入接受；不存在按凭据的记录，因此没有任何东西会因为缺少记录而拒绝有效凭据。以 7 天闲置限制记录每个回环凭据，见[远程访问设计](../design/reach.md#loopback-credentials)，尚未构建。

<a id="device-approval"></a>

### 设备批准

[C5](../contracts/c05-device-approval.zh.md) 规定设备批准，每个 CLI profile 都加载的 `@delo/home-auth` 为 Tailscale 私有路由构建了它。新设备只能在 home 的电脑上获得批准：本人在那里打开一个 5 分钟的批准窗口，并输入设备屏幕上显示的 8 位匹配码来批准该设备，可以在回环上的 studio 中进行（需要 studio 自己的凭据），也可以通过更新通道使用 `delorun devices approve`（需要启动令牌）。home 无法验证请求来自何处，因为该路由上每个请求的来源都是 `127.0.0.1`；匹配码把批准绑定到本人读取过其屏幕的那台设备，它并不证明谁持有该设备。远程访问会话不能批准或移除设备、打开窗口或认领 home（[基本原则](fundamentals.md) F12 与 F13）。通行密钥、恢复套件、重置与告警尚未构建。

<a id="reach-providers"></a>

### 远程访问方式

Tailscale 私有提供方已构建（[C7](../contracts/c07-reach-providers.zh.md)）：它通过 `tailscale serve` 提供一个固定的本地端口，拒绝 Funnel，移除其端口上不属于它的 serve 规则，并每分钟重新检查 Tailscale。Funnel 与自有域名提供方尚未构建，自托管中继的服务器已构建，但没有任何 home 连接它（[C6](../contracts/c06-relay-protocol.zh.md)）。规格测试伪造 `tailscale`；[远程访问设计](../design/reach.md#never-run-on-a-real-tailnet-or-phone)列出了尚未在真实 tailnet 或手机上验证的内容。

<a id="sign-in"></a>

### 登录

回环 studio 使用 `delorun open` 提供的启动令牌登录。远程访问会话仅凭已批准设备的密钥登录，即身份因子 `tailnet-membership`（[C14](../contracts/c14-oidc-passkeys.zh.md#tailnet-membership)）。C14 还规定了通行密钥与 OpenID Connect 身份因子，它们尚未构建。

<a id="releases-the-log-and-the-rebuild"></a>

### 发布、日志与重建

[C2](../contracts/c02-release-manifest.zh.md) 与 [C18](../contracts/c18-release-log.zh.md) 定义发布完整性。

- 离线的 targets 密钥为每个发布清单签名，离线的 root 密钥为每个角色的密钥及每次轮换签名。在线的 timestamp 密钥只为新鲜度签名，其文件在签发 3 天后过期；客户端拒绝过期或更旧的 timestamp。
- 安装或更新需要发布日志中经过验证的包含证明，并由 root 所列的见证者共同签名。每次启动时，经过验证的发布日志失败，或缺失已存储的完整性包，都会阻止启动；离线或未知的在线检查从不阻止启动。安装时在线检查未完成的发布，会在更新报告中显示为 `unchecked`，`delorun update --yes` 不会确认它。
- targets 密钥持有者只通过 `sign-release.ts` 为公开发布签名；以下任一项不满足时它会拒绝：在 CI 之外、使用公开配方从带标签源码重建的匹配重建记录，提交位于发布分支上，targets 密钥列在 `delo/release/production-keys.json` 中，以及标签带有 `delo/release/allowed-signers` 所列密钥的签名；这两个文件都按发布分支提交的内容读取。timestamp 命令拒绝该登记册未列出的 timestamp 密钥；登记册发布时为空，因此在所有者记录密钥之前，生产签名一直停止。`local-release.ts` 为它自己的通道签名一个未经重建的发布：其清单把构建者写为 `local release (no independent rebuild)`，它拒绝 `delo/release/production-keys.json` 中列出的 root 或密钥，从生产发布位置获取的启动器会拒绝它的清单。
- 签名命令根据 GitHub Advisory Database 检查锁文件，遇到没有有效接受的公告时拒绝。
- 在签名、摘要与日志检查通过之前，任何文件都不会进入 `~/.delo/runtimes/`。每次启动时，npm 启动器都会根据已签名的文件列表检查每个已安装的运行时文件：它对每个文件计算哈希，或将文件的身份与上次计算哈希后记录的身份比较，并默认至少每 7 天对每个文件计算一次哈希。不改变文件变更时间的存储损坏，由该完整检查或 `delorun verify` 发现，而不是由下一次启动发现。
- npm 启动器是安装前的信任锚：`npx delorun` 会在任何 Delo 检查之前运行 npm 提供的启动器。每次启动都以启动器附带的最新 root 为锚，从不以更旧的已存储 root 为锚，因此被附带 root 撤销的 targets 密钥不再能通过验证。设置会安装固定为当前运行的启动器版本的 `delorun` 命令，[信任页面](../guide/trust.zh.md#checking-it-yourself)说明了如何通过带外方式核查该版本。

发布工作流尚不存在：每 24 小时重新签名 timestamp、带构建证明且不使用令牌地发布到 npm，以及安装脚本，见[发布工作流设计](../design/release-workflow.md)。桌面应用的更新器是上游的，不检查任何 Delo 签名或日志条目（[更新与回滚设计](../design/update-and-rollback.md#the-desktop-app)）。

<a id="the-catalogue-and-revocation"></a>

### 插件索引与撤销

插件索引与撤销列表尚未构建（[C13](../contracts/c13-catalogue-revocation.zh.md)）：除上游的锁文件之外，Delo 不固定任何插件版本，也无法停用任何已安装的版本。[C17](../contracts/c17-plugin-versions.zh.md) 对 DSH 或 Delo 版本要求未满足或无法读取的插件，在安装时拒绝、在启动时停用，并且从不为此导入插件代码。Delo 不审计插件。

<a id="updates-and-rollback"></a>

### 更新与回滚

[C3](../contracts/c03-update-report.zh.md) 与 [C19](../contracts/c19-home-process.zh.md) 定义 CLI home 的更新如何应用。在更新之前，`delorun update` 会显示目标版本将停用、移除或改变的每个插件、组合包与 profile 行，以及 chat 数据的格式是否改变，把 Delo 无法预测的内容标记为未验证且从不算作安全，并在本人确认之前不应用任何内容。先写入快照；切换会等到旧运行时上没有 chat 运行，期间新回合会被拒绝；120 秒内的健康检查失败时会自动回滚，本人之后也可以用 `delorun recover` 回滚。`delorun recover restore` 立即应用某个 profile 历史版本，不经批准提示，也不运行安装时的插件检查。桌面应用通过上游的更新器更新。

<a id="archives-and-untrusted-chats"></a>

### 导出文件与不受信任的 chat

[C8](../contracts/c08-archive-and-trash.zh.md) 定义导出文件与回收站。导入会先在暂存区验证整个归档，然后才写入任何内容，并且从不覆盖工作区或 chat。定制内容是封闭 schema 下的数据：不会求值任何 `!!js` 表达式，不接受任何 `insert` 行，也没有任何行能设置沙箱模式、凭据引用、远程访问方式或出口。没有导入方 home 能担保的签名的归档，只有在本人将其作为未验证内容接受之后才会导入。不会应用任何定制行，导入的 chat 保存在没有任何东西读取它们的地方，因此它们不会进入任何模型请求。把导入的 chat 作为不受信任的 chat 打开以及应用定制内容，见[导入 chat 设计](../design/imported-chats.md)。清除会从 C8 所列的每个存储中移除条目，请求图片缓存除外；在 studio 中清除会移除该浏览器中该 chat 的草稿，而从 `delorun trash` 清除或在保留期结束时清除不会触及任何草稿。

<a id="logs-and-redaction"></a>

### 日志与遮盖

[C20](../contracts/c20-operational-logs.zh.md) 定义 Delo 的运行日志。每条记录在写入之前都经过遮盖器，它会替换已登记的密钥值（即启动令牌与中继密钥）、名称表明是密钥的字段以及所列的凭据形式。不匹配任何所列形式且未登记的密钥，例如形式未被识别的模型密钥，可能进入日志。Delo 自己的记录不包含 chat 文本、提示、模型输出、工具参数或文件内容。日志文件位于 home 下，权限模式为 0600，CLI profile 中的受限命令不能写入它们，并且在 `home-read` 被强制执行的地方也不能读取它们。每次 `delorun` 调用都会删除 14 天之前写入的日志；运行更久的 home 进程会保留它们，直到下一次调用。

<a id="verification"></a>

### 验证

[C15](../contracts/c15-verification-checks.zh.md) 定义 `delorun verify`。它运行两项检查：`release-signature`，它把已存储的 root 锚定到启动器附带的 root 上，并检查清单的签名、timestamp 的新鲜度与发布日志包，除非指定 `--offline`，还会进行在线日志检查；以及 `runtime-files`，它根据已签名的文件列表对每个已安装文件计算哈希。C15 列表中的其他每项检查都报告为未运行。检查以本人的权限运行，每份报告都说明以该权限运行的程序可以改变这些检查。结果为 `pass`、`fail`、`not-enforced` 或 `unknown`；`not-enforced` 与 `unknown` 从不算作通过。没有任何东西读取验证模式：`delorun verify` 以 `warn` 报告且不阻止任何内容，启动器在经过验证的签名、文件或发布日志失败时总是停止。任何详情都不包含密钥、令牌、cookie、私钥或文件内容。

<a id="parity"></a>

### 对等

[C16](../contracts/c16-parity-composition.zh.md) 定义对等组合。其 overlay 只在回放流程设置 `DSH_SNAPSHOT_PATCH` 时加载；任何随产品发布的 profile、配置或命令行选项都不会选择它。在对等组合中，抓取防护、沙箱以及搜索、`read` 与 `present` 工具的受保护 home、计划任务、指令层、MCP 与完全访问的同意以及更新闸门都处于关闭状态，它们提供的保护在那里不存在；CLI profile 保持每一项开启。

<a id="the-web_fetch-guard"></a>

### web_fetch 抓取防护

在 CLI profile 中，抓取防护让 `web_fetch` 与 HTTP 抓取提供方在任何连接之前拒绝回环、链路本地与私有网络目标（包括云元数据地址），并给出模型可读的类型化原因；该工具仍保留在模型的工具列表中（[决策](../../../.agents/notes/proposed/feature/2026-11-06-delo-web-fetch-private-targets.zh.md)）。它检查每次重定向，并且只连接到它批准过的地址。它限制的是 `web_fetch` 的目标，而不是命令能访问什么。

<a id="data-sharing"></a>

### 数据共享

Delo 没有自己的遥测。在 CLI profile 中，DeepSeek 的会话日志上传在本人于设置的“隐私”分区中开启之前保持关闭，DeepSeek 的反馈发送已被移除；设置流程无法开启上传（[C11](../contracts/c11-setup-answers.zh.md)）。在 `delorun headless` 下，会话日志上传同样默认关闭，桌面应用保留上游的分析。每当安装、更新或启动发布时，发布检查都会运行；如[网络](#the-network)一节所述，它们的请求会向其主机暴露机器的 IP 地址与版本。更新检查每天获取一次发布渠道的签名文件，并在已过去一天时于启动时获取，直到在设置的“隐私”分区中关闭；它不发送任何标识符。新增一个默认开启的、发往 Delo 主机的请求，需要负责人批准，并在网络测试的允许列表 [`network-requests.json`](../../apps/tools/src/checks/network-requests.json) 中登记，该列表写明 Delo 未经请求发出的每个请求及其主机、用途、开关与披露；当随产品发布的、发起网络请求的源文件未被列出时，其规格测试会失败，但它发现不了在已列出的文件中新增的请求。`delorun verify` 把 `data-sharing` 检查报告为未运行。

<a id="what-delo-does-not-protect-against"></a>

## Delo 不防范的内容

下面每项局限都写在拥有它的约定中。`delorun verify` 只报告发布的签名、日志状态与文件，因此其他局限都不会按机器报告。

| 局限 | 仍然可能发生的事 |
| --- | --- |
| CLI profile 之外的命令 | 在 `delorun plugin` 下，命令可以读取整个 home（包括启动令牌与上游的凭据文件）并连接更新通道；任何同意、抓取防护或隐私默认值都不适用。在 `delorun headless` 下，受限命令受沙箱 overlay 的规则约束，而以完全访问运行的命令（需要在 home 的电脑上为该工作目录记录授权）不受限制 |
| Windows 不限制读取 | 受限命令可以读取 home 的密钥、上游的凭据文件与启动令牌，因此令牌无法阻止它们访问更新通道；不检查 home 的权限模式与访问列表；在 ripgrep 完成之前换入搜索路径又恢复的链接可以触及 home |
| 隐藏 home 其他挂载的文件系统 | 当 home 位于 btrfs、bcachefs 或 overlayfs 上，或挂载表未列出其设备时，提供方找不到它的其他挂载，命令只在 home 自身的路径上受到保护，因此同一文件系统的第二个挂载对受限命令与文件工具仍然可达；提供方把其别名覆盖报告为 `unknown`，目前还没有任何东西显示这一点（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)） |
| Landlock 无法拒绝对路径名套接字的连接 | 在只有 Landlock 的系统上，受限命令可以连接更新通道（通道会因其无法读取启动令牌而拒绝它），也可以连接 rootful Docker 套接字，这等同于 root |
| 经 TCP 或 SSH 访问 Docker | 任何有网络访问的命令都能访问该引擎 |
| Docker Desktop 的控制套接字 | Docker Desktop 控制目录中除 context 套接字之外的套接字，对受限命令仍然可达 |
| 其他 Unix 套接字与网络 | 受限命令可以访问 ssh-agent 套接字、D-Bus、显示服务器以及任何网络主机 |
| 模型发起的写入指令文件的命令 | shell 命令或 PTC 代码可以在可写根目录中修改 `AGENTS.md`、skill 或预设，而无需指令同意 |
| 已提权的命令 | `danger-full-access` 下的命令不受限制：它可以读取 home 下的每个密钥与启动令牌，并访问更新通道；上游的提示不说明这一点 |
| 沙箱之外的同一用户进程 | 它们可以读取和修改 home 下的一切、签发回环凭据、运行 `delorun` 与 `docker`、凭启动令牌使用更新通道（批准设备、移除设备、获取 studio 登录链接），并改动启动器、已存储的 root 与检查本身 |
| macOS 与 Windows 上的进程内存 | home 进程内存的保护依赖操作系统的规则，没有 Delo 测试检查它 |
| 回环 studio 的凭据 | 在 CLI profile 中，启动令牌在 60 秒内只能使用一次，但它会出现在浏览器启动器的命令行中，另一个用户或 Landlock 与 Seatbelt 下的受限命令可以在这一分钟内抢先于浏览器使用它；cookie 在 30 天内都能被准入，跨越重启仍然有效且无法撤销；能读取 `.credentials.yaml` 的一方可以签出 cookie；每个持有者都以所有者身份行事，且不适用任何内容安全策略 |
| 插件 | 插件以 harness 的权限运行；除上游的锁文件之外，Delo 不固定任何东西，也无法撤销任何东西 |
| 对时钟的信任 | 被调慢的时钟会接受已超过实际过期时间的发布 timestamp 或日志检查点；被调快的时钟会拒绝新的元数据，拒绝信息会写明过期时间与本地时间 |
| 从不联网的 home | 其发布相对于日志一直是 `unchecked`，展示给它的不同日志视图不会被发现 |
| 见证者的独立性 | 检查的是所列见证者的共同签名；它独立于日志与 Delo 与否，取决于 root 列出了哪些见证者 |
| 日志条目或重建能说明什么 | 已记录、已重建的发布来自带标签的源码；它仍可能含有缺陷或漏洞，重建也无法证实签名者的机器与工具链未被攻破 |
| 公告覆盖范围 | 公告检查不覆盖 Node 二进制、原生插件的工具链，也不覆盖没有公开公告的漏洞 |
| 被扣住的发布 | 不持有密钥的通道宿主无法让 home 转到更低的发布，运行时仓库与 `delorun update` 会拒绝；它可以让 home 停留在其发布上，直到它最后提供的 timestamp 在签发 3 天后过期，在此期间启动仍保留已安装的发布 |
| 遮盖 | 未登记且不匹配任何所列形式的密钥可能进入日志；捕获的输出可能包含 chat 与文件文本，直到保留期限或清除将其移除 |
| 日志保留 | 过期记录会一直保留，直到下一次 `delorun` 调用或 `delorun logs --prune` |
| 清除后的残留 | 已清除 chat 的片段会留在进程日志中，直到其保留期限将其移除，除非本人在清除时清理它们；缩放后的图片留在请求图片缓存中；另一个浏览器 profile 中的草稿，以及从 `delorun trash` 清除后的每份草稿，都会保留 |
| 抓取防护的作用范围 | 命令可以访问任何地址；通过已配置代理或远程抓取提供方发出的请求，会在防护之外解析其目标 |
| studio 源上的代码 | 客户端插件或注入的脚本以浏览器对 studio 的全部权限运行；回环 studio 不强制执行 Trusted Types |
| 对等组合 | 其开关关闭的保护在那里不存在；任何随产品发布的 profile 都不会选择它 |

<a id="how-changes-keep-this-true"></a>

## 变更如何保持本页成立

- 改变批准、拒绝或提权的变更，在[差异台账](../../upstream-patches.json)中是一条 `security` 类条目，附带负责人的结论，并包含一项在变更前失败、变更后通过的拒绝测试（[决策](../../../.agents/notes/implemented/process/2026-11-06-delo-never-less-safe-than-stock.zh.md)）。Delo 对 stock 检查的豁免范围很窄，写明它覆盖的检查与情形，并置于一个在对等组合中关闭的开关之后。
- 涉及信任边界的变更（登录、设备、中继、运行时、导出文件、更新或签名）在其 brief 中标记为 Lead，并接受逐行审查；安全路径由人类代码所有者批准（[规则](../../../AGENTS.md)）。
- 拒绝测试针对本地替身运行，从不联系真实服务。
- 本页与它所陈述的边界、某一方的权限或某项局限在同一次变更中修改，某次变更构建的防护也在该次变更中于本页从未构建改为已构建。
- 安全报告通过 [SECURITY.md](../../../SECURITY.md) 提交，从不通过公开 issue。
