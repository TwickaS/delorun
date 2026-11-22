---
description: "Delorun 的威胁模型：绝不比 stock DSH 更不安全的目标、Delorun 改变的默认值、哪些命令带有 Delorun 的保护、资产、各方能看到和能做的事、每个信任边界上当前已构建的防护及规定它的约定、Delorun 不防范的内容，以及变更如何保持该模型成立。"
---

# Delorun 威胁模型

[English](threat-model.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

Delorun 尚无发布；本页描述本仓库中的代码。

## 摘要

本页说明 Delorun 保护什么、防范谁、如何防范，以及在哪些地方无法防范。它在上游的[安全声明](../../../SAFETY.zh.md)与[进程沙箱参考](../../../docs/subsystems/sandbox.zh.md)之上扩展出 Delorun 的资产、各方、信任边界与局限，上游这两份文档原样适用于 Delorun。每个边界都陈述已构建的防护，并链接规定它的约定；尚未构建的防护会被标明为未构建，并附上保存其规则的设计或约定。疑似漏洞请通过 [SECURITY.md](../../../SECURITY.md) 报告。

## 目录

- [目标](#goal)
- [Delorun 的保护在哪里适用](#where-deloruns-protections-apply)
- [资产](#assets)
- [各方与信任](#parties-and-trust)
- [边界及其防护](#boundaries-and-their-defences)
- [Delorun 不防范的内容](#what-delorun-does-not-protect-against)
- [变更如何保持本页成立](#how-changes-keep-this-true)

<a id="goal"></a>

## 目标

Delorun 的目标是在任何路径上都不比 stock DSH 更不安全，并且在它改变默认值的地方更安全。Delorun 运行指定 DSH 版本的上游代码，保留上游的批准、权限与沙箱决策，包括没有应答者的批准请求会被拒绝这一规则（[批准](../../../docs/subsystems/approval.zh.md)）。Delorun 在这些决策之外增加保护，每项改变批准、拒绝或提权的 Delorun 变更都遵循[下文的规则](#how-changes-keep-this-true)。[对等组合](../contracts/c16-parity-composition.zh.md)关闭所有模型可见的 Delorun 变更并回放上游录制的场景，因此 stock 行为始终可以达到并受到检查。

上游的安全声明原样适用于 Delorun：沙箱、批准与权限控制能降低风险，但不保证隔离。在原生（native）工作区中，命令以本人（the person）自己的权限运行。

CLI profile 改变了以下默认值。[对等清单](../reference/parity-with-deepseek-harness/parity.zh.md)列出每一项及其证据。

| 默认值 | stock DSH | Delorun 的 CLI profile | 对安全的影响 |
| --- | --- | --- | --- |
| 原生命令的限制 | 沙箱限制文件写入；读取、Unix 套接字与网络保持开放 | 沙箱还拒绝受限命令在 Delorun 的 home 下写入，并拒绝其在 home 下读取（bwrap、Landlock 与 Seatbelt 上的三个豁免除外），在 bwrap 与 Seatbelt 上还拒绝其连接更新通道的套接字与 Docker context 的套接字（[C1](../contracts/c01-home-layout.zh.md)）；在 Windows 上只限制写入 | 在 Linux 与 macOS 上更安全；没有任何东西按机器报告哪些规则成立 |
| 沙箱命令的网络 | 命令可以访问任何主机 | 每个工作区的网络为 `open`、`allowlist` 或 `off`，除非本人或 profile 的配置另行选择，否则为 `open`；`allowlist` 只通过 Delorun 的出站代理访问所列主机，`off` 什么也访问不到，`web_fetch` 遵循同一设置。两者都在 bwrap 上成立；在 Landlock、Seatbelt 和 Windows 上，设为其中任一种的工作区会拒绝每个命令 | 默认与 stock 相同；对设为 `allowlist` 或 `off` 的工作区更安全 |
| 完全访问 | 新工作区以 `workspace-write` 开始，完全访问无需同意 | 沿用 stock 的 `workspace-write` 默认值；把工作区的预设切换为完全访问会被拒绝，直到本人在 home 的电脑上为该工作区授权：通过 studio 的同意（它写明 Delorun 的 home、其密钥与令牌以及其通道），或使用 `delorun workspace full-access`；撤回授权会在一秒之内把每个运行中 profile 里该工作区已打开的完全访问 chat 设回 `workspace-write`，因为每个 Host 都监视权限存储（监视无法运行之处，则在该 Host 的下一次权限决定时），且无需任何 Host 读取另一个 profile 的令牌，并在运行中的 `delorun headless` 任务的下一次权限决定时对其生效；审批卡片上的「Allow for this chat」选择会切换该 chat，并在卡片已无法答复时不记录任何内容；按调用的提权经过上游的批准提示，该提示不提及 Delorun 的 home | 对预设切换更安全；按调用的提权与 stock 相同；「Ask less」会关闭该拒绝 |
| `web_fetch` 的目标 | 在所有模式下无需确认即抓取回环、链路本地与私有网络主机（[web-fetch-http](../../../packages/web/web-fetch-http/README.zh.md)） | 抓取防护在任何连接之前拒绝这些目标（包括云元数据地址），并给出模型可读的类型化原因 | 更安全；设置的提示答复会保持它开启 |
| 计划任务 | 一次获批的调用就能创建无人值守、反复运行的轮次 | 创建或编辑任务时会写明重复规则、目标会话及其权限预设并询问；当目标 chat 的预设与获批的预设不同时，投递会被拒绝 | 在设置的默认提示答复下更安全；“与 stock 相同”会关闭它 |
| 指令层文件 | 模型对 skill、预设或 `AGENTS.md` 的写入，即使需要批准，也只作为文件写入批准 | 通过文件工具的写入会询问，并写明其效果（该文本会作为指令加载到其范围内今后的每个 chat）与差异；shell 命令或 PTC 代码的写入不经询问。审查按目标已存在目录的设备号与 inode，将其与 skill 提供方和 profile 启动器读取的根目录比对，因此链接或不同的大小写会得到相同的答复，并在卷不区分大小写时对不存在的部分折叠大小写；硬链接只在它指向指令文件本身时才询问，指向其他位置的链接文件则不询问。这是针对文件工具写入的提示，而不是针对拥有 shell 的模型的边界 | 仅对文件工具更安全；“与 stock 相同”会关闭它 |
| MCP 服务器 | 每个服务器命令都作为可信代码在 agent（智能体）沙箱之外运行 | 新的 stdio 服务器会被拒绝，并写明其命令、参数、工作目录和已配置环境变量的名称，以及它们所解析到的绝对可执行文件和规范目录（即启动它所用的路径）；审查只显示会改变运行内容的变量（`PATH`、`NODE_OPTIONS`、`LD_PRELOAD`、`LD_LIBRARY_PATH`、`PYTHONPATH`、`DYLD_*`）的值。一次接受属于一个服务器名称并覆盖其完整启动：其中任何部分发生变化（包括 Host 的工作目录或 `PATH` 的变化，例如 `PATH`、`NODE_OPTIONS` 或 `LD_PRELOAD`）都会再次询问并写明变化的变量或路径，其他服务器名称从不共享它，格式不同的接受存储会被整体拒绝（在 Windows 上，查找使用 `PATH` 和 `PATHEXT`，而不先搜索工作目录，`.cmd` 垫片连同运行它的规范 `COMSPEC` 一起审查，因此 `COMSPEC` 的变化会再次询问），并且无论顺序如何，服务器行都会等待同意行。一次接受还会按规范路径和内容的 SHA-256 固定该启动所运行的文件：可执行文件（每个符号链接，例如 `node_modules/.bin` 条目，都被跟随到文件本身），以及每个指名现有普通文件的参数，无论它是单独出现，还是作为 `--option=value` 参数（例如 `--import=./hook.js`）的值，例如 `node server.js` 所运行的脚本；被重写的文件、被重新指向的链接，或现在或不再指名某个文件的参数，会以 `contents` 变化再次询问，在每次引导时以及每次重新连接重新生成服务器之前都如此，并且被允许的服务器以固定的可执行文件的规范路径生成，因此当某个 chat 重写了固定的文件或重新指向可执行文件的链接并随后杀死该服务器时，在被更改的文件运行之前会再次询问本人。保持未固定的是：程序自己加载的文件（`server.js` 导入的模块、包的其余部分、共享库、解释器自己的模块、`python -m` 指名的模块、`NODE_OPTIONS` 指名的文件）、参数指名的目录、`#!` 行在 `PATH` 上查找的解释器、包运行器（`npx`、`pnpm dlx`、`bunx`、`uvx`、`pipx run`）每次启动时下载的代码，以及在最后一次检查与生成之间，对固定文件的原地重写或对某个参数所经过的链接的重新指向，下一次审查会发现这些。本人在 home 所在的电脑上，通过 studio 的 Settings、Permissions 或 `delorun mcp accept` 接受被暂停的服务器，二者显示相同的启动信息，以及它所解析到的可执行文件、目录和命令 shell，其启动现已解析到别处的审查的答复会被当作过期而拒绝；并在那里或用 `delorun mcp revoke` 拒绝它或撤销其接受，该服务器随即保持停止，直到其启动变化；远程设备只能读取等待中服务器的名称及变化，它的每个答复都会被拒绝。工作目录或固定文件位于 profile 的某个工作区或临时目录中的服务器，仍会从那里加载未固定的文件，这些文件会在下一次启动或重新连接时运行 chat 之后写入那里的任何内容；审查在本人答复之前写明这些路径，但不拒绝它们。具有完全访问权限的 chat 可以写入其他位置，审查检测不到 | 更安全；新的 stdio 服务器在一次接受后启动；「Ask less」会关闭该拒绝 |
| `plugin_manager` 下的防护插件 | 在完全访问下，该工具无需提示即可运行，并能停用、重新配置或移除除插件管理自身组件之外的每个插件 | 插件管理还保护 Delorun 的同意与防护插件、更新闸门、更新检查、插件安装检查、`dsh-sandbox-local` 与 `dsh-sandbox-policy`。在所有模式下，该工具都会拒绝这样的变更：根据 profile 变更前后的组合行判断，它会丢弃、替换、重新配置、停用或复制一个受保护的行，把其 id 给另一行，或添加一个受保护模块的行，无论是通过 `set_plugin`、`configure`、组合包的安装、选择、取消选择或移除、`undo` 还是 `restore`；它还拒绝提供受保护模块的包。完全访问的命令仍可直接编辑 profile 的文件，嵌套在另一个组合包依赖中的遮蔽包不受检查；防护包的版本豁免无法通过撤销或恢复去除 | 更安全 |
| 对从文件夹链接的插件和对 harness 的更改 | 从文件夹链接的插件从该文件夹加载，编辑在下一次重新组合时无需审查即加载 | Changes 保护默认关闭：插件从 home 之下该文件夹内容的副本加载，每次启动以及 Delorun 运行期间的每次保存，都无需审查就加载该文件夹的新内容，本人对 harness 自身文件的编辑在下一次启动时应用，智能体的 `plugin_manager` 调用像 stock 那样运行；每项更改都被记录并可以撤销。使用 `delorun changes protection on` 时，更改只有在本人应用之后才加载（[C21](../contracts/c21-changes.zh.md#the-protection-setting)） | 默认的审查与 stock 相同，但每项更改都被记录；保护开启时更安全 |
| 数据共享 | 桌面分析与 DeepSeek 会话日志上传开启 | 会话日志上传关闭；Delorun 没有自己的遥测。桌面分析属于桌面应用，桌面应用是上游的，保持其开启 | 在 CLI profile 中更安全 |
| studio 附加功能 | stock 外观 | Delorun 的主题、设置布局、chat 状态、侧栏与新手引导；不挂载主 chat | 不改变批准或限制 |
| home 目录 | `~/.dsh` | `~/.delorun`，在 Linux 与 macOS 上权限模式为 0700；`delorun` 从不读取或写入 `~/.dsh` | 分开两个 home |

对等注册表还为容器拒绝标记、无需提权的 `plugin_manager` 读取操作、`preset_inspect` 与 profile 历史声明了开关；CLI profile 不开启其中任何一个，因此每一项都保持 stock 行为。

<a id="where-deloruns-protections-apply"></a>

## Delorun 的保护在哪里适用

- **CLI profile。** 由 `delorun setup` 创建、由 `delorun` 或 `delorun start` 启动的 profile：上游的 web 模板加上 `@delorun/bundle-local` 与 `@delorun/bundle-studio`。本页称为已构建的每项保护都在这里适用。
- **`delorun headless`。** 它启动 home 的 `headless` profile：上游的 `headless` 模板加上 `@delorun/bundle-headless`，运行在 C1 的沙箱 overlay 之下。抓取防护、指令写入、MCP 与计划任务的同意、完全访问同意、每个工作区的网络设置、Changes 保护开启期间对智能体插件更改的暂缓以及回合闸门都适用，插件管理无法关闭它们，DeepSeek 的会话日志上传也与 CLI profile 一样关闭。会询问本人的防护会拒绝，因为该 profile 不组合任何批准应答者。对于没有在 home 的电脑上记录完全访问授权的工作目录，完全访问同意会拒绝完全访问；在参数或 `DSH_PERMISSION_MODE` 中请求完全访问也会在启动之前被提前拒绝。组合会拒绝不含该组合包的 `headless` profile，并且任务只在 Delorun 检查过该组合包的行与服务之后才开始。启动前步骤 `changes` 使 profile 从文件夹链接的每个插件回到 Changes 所保持的内容，保护关闭时无需审查即加载该文件夹的内容并记录它，保护开启时智能体的 `plugin_manager` 安装、更新和移除像在 CLI profile 中那样等待本人审查（[C21](../contracts/c21-changes.zh.md#the-agent-and-plugins)）；headless 运行不实时重新加载插件文件夹。该模板不挂载 MCP 客户端，也不挂载计划任务运行时；MCP 与计划任务的同意保护的是本人自己的 patch 添加的客户端或运行时。
- **`delorun plugin`。** 它运行上游的 pnpm 操作，不带 Delorun 的任何行：没有受保护的 home、没有被拒绝的套接字、没有同意、没有抓取防护，也没有隐私默认值。在 pnpm 运行之前，它把 profile 的包设为从 pnpm 的存储中复制；操作成功之后，它按 profile 中 `delorun-plugin-install-check` 行的设置，对操作安装的内容运行[插件安装检查](#plugins)。让每个启动 Host 的命令都应用 Delorun 的层，见[原生限制设计](../design/native-confinement.zh.md#every-way-a-host-boots)。
- **桌面应用。** 它是上游的，未作改动，Delorun 的任何行都不适用于它。
- **Windows。** 沙箱只限制写入。受限命令可以读取整个 home，包括 Delorun 的密钥、上游的凭据文件与启动令牌，并且不会对 home 运行任何权限模式或访问列表检查。

<a id="assets"></a>

## 资产

- **本人的文件与工作区**：机器上的工作区根目录。
- **模型提供方密钥与其他密钥**：home 下上游的 `.credentials.yaml`（它还保存浏览器会话密钥）与 `.env`；`~/.delorun/secrets/` 下 Delorun 的文件，其中保存 `delorun export` 创建的 home 密钥以及 Delorun 同意插件的同意记录。
- **会话**：chat 历史（其中常含密钥），以及附件、全文索引、溢出文件与浏览器中的草稿。
- **Delorun 的 home**：`~/.delorun`，包括其密钥、每次启动的令牌、更新通道的套接字、已验证的发布根与检查点，以及运行时仓库（runtime store）。
- **发布完整性**：已签名的发布清单、运行时文件与 npm 启动器，以及为它们签名的离线 root 与 targets 密钥。
- **插件供应**：已安装的插件。profile 的 `pnpm-lock.yaml` 记录每个版本的 tarball 完整性或 git 提交，pnpm 只在获取 tarball 时用它核对，之后从不检查已安装的文件。Delorun 的安装记录在[安装检查](#plugins)通过时写入，记下每个来自 npm、tarball 或 git 的插件每个已安装文件的 SHA-256，每次启动和 `delorun verify` 都用它比对已安装的文件。

<a id="parties-and-trust"></a>

## 各方与信任

### 本人

本人拥有 home 与机器。凡是其操作系统用户能看到和能做的事，本人都能看到和做到：home 下的每个文件、每个 chat 与密钥，以及在其账户能运行时的 `delorun` 与 Docker。`delorun verify` 只做报告，不改变任何内容。本人批准提权、同意与更新；Delorun 自己的提示会在本人作答之前说明其效果，按调用的提权提示则是上游的。

### 模型及其工具调用

模型能看到系统提示、chat 的历史、工具描述与工具结果。这些文本中的任何一段都可能带有通过网页、文件、仓库、issue、其他 chat 或工具输出注入的指令。导入的 chat 不会进入任何模型请求，因为没有任何东西打开导入的 chat（[C8](../contracts/c08-archive-and-trash.zh.md#untrusted-imported-chats)）。模型可以调用其预设提供的工具，每次都经过上游的批准与工作区的沙箱模式，也可以请求只有本人才能批准的提权；它看不到提权提示。它的命令以本人自己的权限运行。在 CLI profile 中，它们按 [C1](../contracts/c01-home-layout.zh.md) 的规定受到限制，它的 `web_fetch` 调用也只能到达抓取防护允许的目标。它运行的 shell 命令或 PTC 代码可以在可写根目录中写入指令文件，而无需指令同意。

<a id="plugins"></a>

### 插件

插件是本人安装的代码，其可信程度以本人的安装为限。Host 插件在 harness 进程中以 harness 的权限运行：它能读取 Host 读取的内容，包括 Host 加载的凭据以及 home 进程（home process）在内存中持有的启动令牌，并能向更新通道发送其固定请求集合中的任何请求。客户端插件在 studio 页面中以浏览器的权限运行。Delorun 不对插件做沙箱隔离，也不读取插件代码。Delorun 在安装时与启动时检查每个插件的 DSH 与 Delorun 版本要求（[C17](../contracts/c17-plugin-versions.zh.md)）；除上游的锁文件之外它不固定任何东西，插件索引与撤销列表尚未构建（[C13](../contracts/c13-catalogue-revocation.zh.md)）。插件安装检查（[`@delorun/plugin-install-check`](../../packages/plugin-install-check/README.zh.md)）在安装被解析进锁文件之后、其任何文件下载或任何安装脚本运行之前运行，在插件管理与 `delorun plugin` 中都是如此，并在选入、启用或恢复组合包之前再次运行，即在其代码加载之前：对插件及其安装向锁文件新增的每个包，它对缺少完整性或 git 来源没有完整提交、明文 `http:` 注册表或下载 URL、GitHub 安全公告、发布不到 24 小时的版本，以及与 profile 或 Delorun 已有名称相近的名称发出警告；对已知的严重（critical）公告，它拒绝安装，直到本人用 `--allow-advisory` 或 studio 的「仍然安装」允许。公告或注册表查询失败时，警告检查未能运行。本人列为可信的 scope 或 git 所有者的插件只显示严重公告，链接的或本地的文件夹不检查。每次启动按文件标识比对每个已记录插件的文件，`delorun verify` 对每个文件计算哈希；插件被改动是警告，不是拒绝。上游在首个注册表失败时询问的 npmmirror 回退默认关闭，直到本人在设置 → 隐私中或用 `delorun plugin mirror on` 开启；在 studio 中，由镜像解析的包，其锁文件完整性与主注册表列出的不同时会被拒绝，主注册表无法核对时需要本人接受。插件的安装脚本只在本人允许的构建中由 pnpm 运行，且在检查通过之后运行。每个 MCP 服务器命令都按上游所述，作为可信代码在 agent 沙箱之外运行；在 CLI profile 中，新的 stdio 服务器，或命令、参数、工作目录、环境或固定文件发生变化的服务器，会被拒绝，在重新连接之前同样如此。

<a id="other-local-processes-under-the-same-user"></a>

### 同一用户下的其他本地进程

在沙箱之外运行的本人用户进程，可以读取和修改 home 下的一切、读取启动令牌，并在本人能运行 `delorun` 与 `docker` 时运行它们。凭借启动令牌，它可以使用更新通道的每个操作（[C19](../contracts/c19-home-process.zh.md#the-update-channel)），包括 `devices.approve`、`devices.remove` 与 `studio.open-token`：它可以打开批准窗口并用匹配码批准待处理的设备请求、取消请求、移除设备，以及获取新的 studio 登录链接。当它还控制着一台请求批准的设备时，它可以在无人在场的情况下批准该设备，该设备随后通过远程访问（reach）登录。Host 自己的通道令牌对这些操作会被拒绝，受限命令也无法读取令牌文件或访问该套接字（[C1](../contracts/c01-home-layout.zh.md#sockets-and-the-start-token)）；这种限制是让 agent 无法执行同样操作的唯一保障，而在沙箱之外运行的命令（例如在 `danger-full-access` 下获批的命令）拥有这些能力。它还可以写入运行时的已批准 harness 记录 `changes/harness/<runtime>/approved.json`、`changes/store/` 之下的内容存储以及 harness 的更改日志（[C1](../contracts/c01-home-layout.zh.md#the-home-tree)）：下一次启动随后会在每项启动检查都通过的情况下，从组合树运行其代码，因为组合树是对照该记录检查的（[C21](../contracts/c21-changes.zh.md#harness-edits)），只有 `delorun verify` 和 `delorun changes list` 打印的已批准 harness 文件列表才会显示它。Changes 保护关闭（默认）时，它连这些都不需要：它写入 harness 可写副本或已链接插件文件夹中的文件，会在下一次启动时无需审查就加载，并被如此记录（[C21](../contracts/c21-changes.zh.md#loading-without-review)）。Delorun 不声称防范这样的进程。home 的权限模式防范的是其他用户，而不是它，也不存在 root 所有的辅助程序。只有当篡改没有同时改动启动器、已存储的 root 或 `trust/runtime-files/` 下运行时的身份记录时，启动器的启动检查才能发现被改动的运行时文件。

### 机器上的其他用户

在 Linux 与 macOS 上，其他非管理员用户无法读取 home（其目录权限模式为 0700、受保护文件为 0600），也无法连接更新通道的套接字（位于 0700 目录内、权限模式为 0600）。在 Windows 上，Delorun 不检查任何访问列表，home 的访问权限就是操作系统为本人 profile 中新目录赋予的权限。其他用户可以与 studio 的回环监听器建立 TCP 连接，该监听器接受启动令牌与上游的签名 cookie（[C4](../contracts/c04-admission.zh.md#sessions)）。在 CLI profile 中，启动令牌是一次性的：`delorun` 以本人的启动令牌从 home 进程获取每个启动令牌，它在 60 秒后过期，第一次出示即被消耗（[C4](../contracts/c04-admission.zh.md#launch-tokens)）。它仍然在交给浏览器启动器的 URL 中传递，而在没有 `hidepid` 的 Linux 上，其他用户可以读取该启动器的命令行，因此另一个用户可以在浏览器第一次请求之前的几秒内抢先使用它。以这种方式获得或从浏览器复制的 cookie 在 30 天内都能被准入。`delorun headless` 与桌面应用运行上游的 profile，其中启动令牌在 Host 进程的整个生命周期内都可重复使用。管理员或 root 能做本人能做的一切。在 rootful Docker 引擎上，`docker` 组成员身份等同于 root。

<a id="the-network"></a>

### 网络

网络上的一方能看到机器的连接。安装与更新会获取发布的公开签名文件，而每次通过 npm 启动器启动时，只要网络可达，都会检查发布日志。这些请求不携带个人数据，它们会向其主机暴露机器的 IP 地址、请求时间与 Delorun 版本。这些文件都通过签名验证，因此其主机不受信任：被改动的文件无法通过验证，被扣留的文件会在安装或更新时因其 timestamp 过期而被发现。没有任何设置可以关闭发布日志检查。studio 监听回环地址；只有在本人开启 Tailscale 私有远程访问之后，它才同时监听本人的 tailnet，在此之前该访问保持关闭。

### Tailscale、本人自己的中继与 OIDC 提供方

远程访问关闭时，任何 Tailscale 节点、中继或身份提供方都不在通往 studio 的路径上。开启 Tailscale 私有远程访问时，由 Tailscale 承载流量：其协调服务能看到机器的名称、机器与每台设备的 IP 地址、连接时间与流量大小，除非开启 Tailnet Lock，它可以向 tailnet 添加设备，并获取 `ts.net` 证书。被添加的设备可以打开登录页面并请求批准，在本人于电脑上批准之前无法打开任何 chat。自托管中继与 OpenID Connect 提供方尚未构建，因此两者都不在任何路径上。[远程访问设计](../design/reach.zh.md)以及约定 [C5](../contracts/c05-device-approval.zh.md)、[C6](../contracts/c06-relay-protocol.zh.md)、[C7](../contracts/c07-reach-providers.zh.md) 与 [C14](../contracts/c14-oidc-passkeys.zh.md) 说明了每一方能看到和能做的事，并各自附有已存在内容的状态。

### Delorun 项目

Delorun 项目持有离线的 root 与 targets 密钥以及在线的 timestamp 密钥。它可以发布一个已签名并记录在公开日志中的版本。在本人确认之前，没有客户端会安装它：npm 启动器只安装到空的运行时仓库中，`delorun update` 也只在本人确认后才应用。更新从不转到更低的发布：运行时仓库在安装任何内容之前，以 `TARGET_LOWER` 拒绝低于正在运行版本的通道发布或请求的版本，`delorun update` 拒绝这样的报告，只有 `delorun recover rollback` 能回退。timestamp 命令拒绝降低通道版本，客户端也拒绝比自己已存储的更旧的 timestamp，因此不持有密钥的通道宿主只能扣住更新的发布，且只到它最后提供的 timestamp 在签发 3 天后过期为止；在此期间启动仍运行已安装的发布（[C2](../contracts/c02-release-manifest.zh.md#freshness-and-rollback-protection)）。该项目无法进入 home：通往 studio 的任何路径上都没有 Delorun 基础设施，它也不持有 home 的任何密钥。本人对 Delorun 项目的剩余信任包括其发布，以及提供其元数据的 `delorun.com` 名称。

### 上游与依赖作者

上游的代码就是 harness，因此其作者如同 harness 一样受到信任。Delorun 合并上游的每次发布，为每个改动的文件记录结论，并重新运行对等回放与插件语料。依赖由锁文件固定，签名命令在签名之前会根据公告源检查锁文件。带标签源码或固定依赖中的恶意改动会被重建复现并签名；签名与日志条目表明发布来自何处，而不表明它没有缺陷。

### 持有被盗设备的一方

本人批准过的设备，只要处于解锁状态且其会话仍然有效，就会让持有者获得 chat 以及允许列表所允许的操作：无请求 12 小时后失效，最长 14 天。允许列表是刻意放宽的：已批准的设备本来就可以向智能体发送提示，因此风险不高于一条提示的每项操作都被允许，持有者可以读取并驱动 chat、选择其预设和模型、整理 chat 和工作区、设置目标和计划的跟进，并读取其工作区的文件。它本身不授予任何访问：预设不授予任何东西，工作区的完全访问仍然由电脑给出答复，每个批准提示也仍然适用。设置写入、斜杠命令、插件更改、终端（在每个文件夹中，包括完全访问工作区）、文件夹选择器、新文件夹和动态插件代码，需要本人在电脑上通过输入设备显示的代码批准的解锁；解锁默认持续 15 分钟，最长 60 分钟，不准入另一个监听器或另一个 profile 上的任何东西，并在结束时关闭该设备的连接。凭据、账户、完全访问授权和设备批准，无论是否解锁，都仍然由电脑掌握（[C14](../contracts/c14-oidc-passkeys.zh.md#elevation)）。本人在电脑上移除丢失的设备，这会立即结束其会话。home 电脑上持有回环 cookie 的浏览器 profile，自签发起最长 30 天内都能以本人身份被准入，跨越重启仍然有效，且没有任何命令可以撤销它。运行 home 的计算机被盗时，持有者获得本人用户持有的一切；在这种情况下，Delorun 依靠操作系统的登录与磁盘加密。

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

[C1](../contracts/c01-home-layout.zh.md) 定义了 CLI profile 在上游沙箱之上为每个在 `read-only` 或 `workspace-write` 下运行的命令添加的规则；`wsl-interop`、`vsock` 与会话规则见下文。前五条是：不得在 home 下写入（`home-write`），不得在其下读取，`runtimes/`、`skills/` 与 `dsh-runtimes/` 除外（`home-read`），不得读取启动令牌（`token-read`），不得连接 home 的通道（`home-connect`），也不得连接位于真实路径的 Docker 套接字（`docker-connect`）。

- bwrap 强制执行全部五条。Landlock 强制执行 `home-write`、`home-read` 与 `token-read`，无法表达两条套接字规则。Seatbelt 强制执行全部五条。windows-acl 只强制执行 `home-write`。
- Delorun 的密钥保存在 `secrets/` 下的文件中，在 Linux 与 macOS 上文件权限模式为 0600、所在目录为 0700，从不放在读取豁免、profile、命令行、命令的环境变量或日志中。上游的凭据文件位于 home 下，受 `home-read` 约束。Delorun 不使用操作系统的密钥存储，因为受限命令可以通过 D-Bus 访问 Linux Secret Service，也能运行 macOS 钥匙串项目所信任的 `node` 可执行文件。
- 当某个可写根目录等于 home、位于 home 内或包含 home 时，`workspace-write` 会被拒绝。
- 本人的会话服务监听着本人用户的进程无需任何其他凭据即可使用的套接字，其中一些会在每个命名空间和挂载规则之外启动程序：通过会话总线或用户管理器的 `systemd/private` 使用 `systemd-run --user`，会以宿主的网络和整个 home（包括 Delorun 的 `secrets/`）把任何程序作为用户单元启动；tmux 或 screen 服务器在本人的终端中运行命令；X 服务器接收本人其他窗口的输入。另一些以本人的权限行事：ssh-agent 和 gpg-agent 用本人的密钥签名，密钥环交出机密，系统总线承载本人会话的 polkit 授权。Docker Desktop 的后端 API 和 tailscaled 的 LocalAPI 以 `docker` 组和 tailscaled 操作员的权限行事。`delorun start` 把它们的目录（`/run/user/<uid>`、`/run/dbus`、`/tmp/tmux-<uid>`、`/run/screen`、`/tmp/.X11-unix`、`/mnt/wslg`、`/mnt/wsl/docker-desktop/shared-sockets`、`~/.docker/desktop`）指定为逃逸套接字目录（`session-escape`），拒绝 `/run/docker-cli.sock` 和 tailscaled 的套接字（`daemon-connect`）以及 `SSH_AUTH_SOCK` 所指名的 agent 套接字（`agent-connect`），并设置 `privateTmp`，因此 bwrap 给每个受限命令一个不含宿主文件和套接字的 `/tmp`（`private-tmp`）。bwrap 隐藏每个目录及其每个其他挂载，Seatbelt 在每次包装时拒绝当时存在的条目，而无法隐藏它们的 Landlock，在其中任一目录存在期间拒绝每个受限命令，在 WSL 下也是如此。其他位置的套接字仍然可达，例如本人 home 之下的套接字、抽象套接字（其中包括 Linux 桌面上 X 服务器的抽象套接字，以及 `dbus-launch` 在抽象地址上启动的会话总线，通过它 `systemd-run --user` 可以在沙箱之外启动程序）、除 Docker 之外授予 root 的、由组拥有的守护进程套接字、Docker Desktop 在其引擎套接字之外的 macOS 控制目录，以及网络为 `open` 的工作区的网络（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)）。
- 每个工作区对其沙箱命令都有一个网络设置，由 `@delorun/plugin-permission-defaults` 保存在 home 的受保护状态中（[C1](../contracts/c01-home-layout.zh.md#confinement-rules)、[指南](../guide/safety-and-updates/prompt-injection.zh.md)）。`off` 让每个命令在它自己的网络命名空间中启动，里面只有回环，这也切断了它与抽象 Unix 套接字和宿主回环服务的联系。`allowlist` 加入 Delorun 的出站代理，它监听 home 之下的一个套接字（bwrap 把它绑定进命令，每个列表一个）；命令的代理变量指向它，自己打开网络而忽略这些变量的程序什么也访问不到。代理在任何查找之前，先对照列表检查名称和端口，拒绝解析到抓取防护所拒绝的地址的已列出名称，只连接它检查过的地址，用它检查过的主机发送明文 HTTP 请求，限制其连接数，关闭空闲的连接，并记录每次拒绝；除非条目写明其他端口，否则条目允许 80 和 443 端口。它不读取隧道的字节，因此位于同一地址之后、提供多个名称的已列出主机，可以在 TLS 握手或内部请求中被要求提供其中另一个名称。在两种设置下，bwrap 还会隐藏守护进程借以为命令解析名称或发送流量的套接字：systemd-resolved 的 varlink 目录、nscd、avahi、snapd、CUPS、系统 D-Bus 和 tailscaled（`sandbox-local` 的 `networkDeniedSockets` 和 `networkDeniedSocketDirectories`），因此命令无法访问这些守护进程，也无法通过 DNS 把数据发出去。该命名空间不会切断路径名套接字：上面的条目称为可达的那些仍然可达，其后的守护进程可以为命令打开连接，例如本人 home 之下的 ssh ControlMaster 套接字，或在 gpg 没有运行时目录处的 gpg 的 `S.dirmngr`。抽象地址上的会话总线在两种设置下都无法到达，因为该命名空间持有它自己的抽象套接字。Landlock、Seatbelt 和 windows-acl 都无法表达这两种设置，因此它们拒绝这种工作区的每个命令，而不是带着网络运行它。该设置只在 home 所在的电脑上的 studio 中读取和更改；放宽它需要本人在那里确认，模型没有为此提供的工具，插件管理也无法重新配置它的行。无法读取的网络存储会把每个工作区都算作 `off`。完全访问下的命令无论设置如何都能访问网络；终端或作业在结束之前保持它被包装时的网络，但其列表被移除的那个会失去它的代理。
- `danger-full-access` 的批准提示是上游的；它不说明完全访问能触及 Delorun 的 home。
- 没有任何东西按机器报告哪些规则成立：启动时不运行探测，`delorun verify` 把 `confinement-rule` 检查报告为未运行。
- 在 WSL 下，互操作（interop）会让受限命令启动 Windows 程序，该程序在每个 Linux 命名空间、挂载规则与受保护的 home 之外，以本人的 Windows 账户运行，并能读取 Windows 进程的命令行。`delorun start` 把 WSL 的互操作目录 `/run/WSL` 指定为逃逸套接字目录（`wsl-interop`）；在它存在的地方，bwrap 会隐藏它，因此不会有 Windows 程序通过互操作套接字启动，无论是按路径、按裸名称、作为副本、通过 `/init` 还是设置了 `WSL_INTEROP`；Landlock 无法隐藏它，因此改为拒绝每个受限命令。在 bwrap 下，一个 seccomp 过滤器还会拒绝 vsock 套接字（互操作套接字之下 WSL 与 Windows 之间的传输）以及 io_uring（其请求创建的套接字该过滤器看不到）（`vsock`）；它适用于内核提供 vsock 的任何虚拟机，在那里需要 io_uring 的程序会失败，通过 `socketcall` 创建套接字的 32 位程序得不到套接字。抽象 Unix 套接字在每种方言上都仍可访问；WSL 不在任何抽象套接字上监听，而本人运行的、在抽象套接字上监听的程序是可访问的（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)）。
- harness 自身会在工作区的仓库上运行 git，以记录每个回合改动的文件。每条这样的命令都在 Session 的沙箱中运行，可写根目录为 Session 的可写根目录加上插件的快照目录；当 Session 为 `read-only` 时，只有该目录可写；只有当 Session 的命令不受限制时它才不受限制地运行，沙箱无法限制的命令，或没有挂载沙箱的受限 Session，不记录任何内容。快照目录位于每个用户的缓存目录中，在 Delorun 的 home 之外；除非某个 Session 的可写根目录包含它，任何方言都不会把它授予受限命令。每次快照与复制都先将其与每个活动 Session 的可写根目录比对，有重叠时不记录任何内容；harness 在每次使用之前检查其中每个目录的设备号与 inode，它在那里的文件操作会拒绝最后一级路径组件是链接的情况、命名管道以及不是它创建的条目。通过已批准的完全访问提权运行的命令不在此范围内。每条命令都在移除每个继承的 `GIT_*` 变量的情况下运行，并带有命令范围的配置，关闭文件系统监视器、钩子、仓库配置定义的每个过滤器与 diff 驱动、分页器、编辑器、凭据助手与传输，因此受限命令写入的 `.git/config`、`.gitattributes`、钩子或 `.git` 文件不会启动任何程序（[workspace-changes](../../../packages/deliverables/workspace-changes/README.zh.md#git-hardening)）。stock 不受限制地运行这些命令，且仓库的配置生效。
- 本人自己的 git 与编辑器没有加固。在 `workspace-write` 下，受限命令可以写入仓库的 `.git/config`、钩子与属性文件，下次本人在沙箱之外于该仓库中运行 git 或编辑器的 git 集成时，这类设置指定的程序会以本人的完全权限运行。一项让这些文件对受限命令保持只读的[设计选项](../design/workspace-git-state.zh.md)尚待决定。
- 文件工具自行应用 `home-read` 与 `home-write`。`read`、`read_image`、`apply_patch` 与 `str_replace_editor` 拒绝位于 home 下或通往 home 的其他路径（读取豁免除外），本地文件系统会确认它打开的文件或目录就是它检查过的那个，因此在检查与打开之间被替换为指向 home 的链接的工作区目录会导致读取失败：在 Linux 上依据描述符自身的路径，在其他平台上依据其设备号与 inode，在这两次查找之间换入又恢复的链接不会被发现。写入围栏拒绝 home 以及提供方找到的 home 的其他每个挂载。`glob` 与 `grep` 在 ripgrep 启动之前解析其根目录，并在 `read-only` 下以受限方式运行 ripgrep，因此方言的 `home-read` 在搜索的每一层深度都成立，与命令相同；在没有运行器能限制的地方，搜索会失败；在不限制任何读取的 Windows 上，搜索期间换入又恢复的链接不会被发现。这些工具还可以读取它们自己 chat 在 `spill/` 之下的目录，那里保存对该 chat 而言过长的工具输出，溢出提示会告诉模型去读取它，但不能读取其他任何 chat 的目录，这也使派生出的 chat 无法读取它继承的溢出文件；受限命令则完全不能读取 `spill/`。溢出文件只写入 `spill/`（权限模式 0700，若更宽松则收紧）：当 home 无法容纳它时，输出留在 chat 中，而不是写入受限命令可能读取的临时目录。
- harness 通过其子进程服务启动的命令与其他进程继承其环境，但不包括上游过滤器丢弃的条目：保存凭据的名称，例如 `*_TOKEN`、`*_CREDENTIALS`、`*PASSPHRASE*`、`MYSQL_PWD`、`KUBECONFIG` 与 `KRB5CCNAME`，以及含有带用户信息的 URL 的值，包括仅含令牌的 `https://<token>@host` 或 Sentry DSN。像 `PATH` 这样的搜索列表只丢弃其中指向凭据文件或 agent 套接字的元素。以过滤器不认识的名称和形式出现的凭据会被继承。
- 有些工具会在工作区中于沙箱之外启动程序：Claude Code 与 ACP 子 agent 工具启动其 agent 进程，stdio 语言服务器工具启动语言服务器，均不受限制。这些程序以本人的完全权限读取工作区的文件与配置，因此受限命令在那里写入的文件可以改变它们的行为。
- 外部智能体（例如 Claude Code 或 Codex）还以其自己的设置以及本人自己的登录和账户运行，并且可以读取和更改 Delorun 的 home。在 C16 开关 `external_agent_consent` 开启时（Delorun 的 profile 中就是如此，直到本人在 home 自己的电脑上的 Settings、External agents 中将其关闭；远程访问设备不能写入设置，setup 的提示回答也不会改变它），`@delorun/plugin-delegation-consent` 在智能体运行之前审查每次启动：`read-only` chat、没有工作区文件夹的 chat 和没有沙箱策略的组合从不启动它，位于 chat 工作区之外的运行目录被拒绝，并且只有在本人于 home 自己的电脑上允许该次运行，或已为该工作区允许该智能体之后，智能体才会启动；远程访问设备不能回答该询问。每次运行在其时限（默认 30 分钟）之后停止，并且无论目标如何拼写，模型的 `plugin_manager` 都不能安装、启用或配置任何外部智能体包（每个 `@deepseek-ai/dsh-subagent-*` 包，进程内的除外，包括 ACP 的）；具有完全访问权限的 chat 仍然可以用命令安装一个。智能体一旦启动就不受限制：审查决定它是否运行，而不是它做什么（[插件](../../packages/plugin-delegation-consent/README.zh.md)）。

探测、检查、提示的说明、Docker Desktop 的控制套接字目录、Windows，以及 `delorun headless` 下的相同规则，见[原生限制设计](../design/native-confinement.zh.md)。

<a id="the-homes-control-channels"></a>

### home 的控制通道

更新通道（[C19](../contracts/c19-home-process.zh.md)）监听套接字 `run/<profile>/update.sock`。它只接受携带本次 home 进程启动令牌的请求：该令牌为来自操作系统随机源的 256 位数据，以恒定时间比较，从不出现在命令行、环境变量、响应或日志中。它不转发请求：更新请求不携带路径、归档、URL 或命令，因此持有令牌的调用方只能选择一个版本：由 home 进程从渠道获取并验证的版本，或已安装在运行时仓库中的版本。这种保护依赖于对 agent 命令的限制（如 C1 所述），并且只在方言拒绝读取令牌的地方成立。[C9](../contracts/c09-runtime-supervisor.zh.md) 的 Docker 监管器通道不监听，因为没有命令启动监管器，Windows 上也不存在命名管道。

<a id="container-isolation"></a>

### 容器隔离

Docker 工作区尚未构建。[C9](../contracts/c09-runtime-supervisor.zh.md) 规定了它们以及将创建它们的监管器；监管器包已存在，而 `delorun start` 从不启动它。

<a id="admission-and-listeners"></a>

### 准入与监听器

[C4](../contracts/c04-admission.zh.md) 定义准入。回环监听器在 CLI profile 中为 `127.0.0.1:3080`，运行上游的准入并开启一次性启动令牌：启动令牌在 60 秒内只能使用一次，`/connect`，以及无状态的签名 cookie，它们在签发 30 天后过期，没有闲置限制、没有服务器端记录，也不可撤销。能读取 home 的 `.credentials.yaml` 的一方无需任何启动令牌即可签出这样的 cookie。每个持有 cookie 的浏览器都以唯一所有者的身份行事，回环 studio 不发送内容安全策略。设置的 `--yes` 与 `--config` 形式从不开启远程访问（[C11](../contracts/c11-setup-answers.zh.md)）；`delorun reach on tailscale` 以及设置 Full 模式中的“是”答复会开启它。开启远程访问时，远程访问监听器的分发器在任何路由、升级或回退之前认证每个请求。回环凭据是上游的启动 cookie 与 API 凭据，由上游内置的准入接受；不存在按凭据的记录，因此没有任何东西会因为缺少记录而拒绝有效凭据。以 7 天闲置限制记录每个回环凭据，见[远程访问设计](../design/reach.zh.md#loopback-credentials)，尚未构建。

<a id="device-approval"></a>

### 设备批准

[C5](../contracts/c05-device-approval.zh.md) 规定设备批准，每个 CLI profile 都加载的 `@delorun/home-auth` 为 Tailscale 私有路由构建了它。新设备只能在 home 的电脑上获得批准：本人在那里打开一个 5 分钟的批准窗口，并输入设备屏幕上显示的 8 位匹配码来批准该设备，可以在回环上的 studio 中进行（需要 studio 自己的凭据），也可以通过更新通道使用 `delorun devices approve`（需要启动令牌）。home 无法验证请求来自何处，因为该路由上每个请求的来源都是 `127.0.0.1`；匹配码把批准绑定到本人读取过其屏幕的那台设备，它并不证明谁持有该设备。远程访问会话不能批准或移除设备、打开窗口或认领 home（[基本要求](fundamentals.zh.md) F12 与 F13）。通行密钥、恢复套件、重置与告警尚未构建。

<a id="reach-providers"></a>

### 远程访问方式

Tailscale 私有提供方已构建（[C7](../contracts/c07-reach-providers.zh.md)）：它通过 `tailscale serve` 提供一个固定的本地端口，拒绝 Funnel，移除其端口上不属于它的 serve 规则，并每分钟重新检查 Tailscale。Funnel 与自有域名提供方尚未构建，自托管中继的服务器已构建，但没有任何 home 连接它（[C6](../contracts/c06-relay-protocol.zh.md)）。规格测试伪造 `tailscale`；[远程访问设计](../design/reach.zh.md#never-run-on-a-real-tailnet-or-phone)列出了尚未在真实 tailnet 或手机上验证的内容。

<a id="sign-in"></a>

### 登录

回环 studio 使用 `delorun open` 提供的启动令牌登录。远程访问会话仅凭已批准设备的密钥登录，即身份因子 `tailnet-membership`（[C14](../contracts/c14-oidc-passkeys.zh.md#tailnet-membership)）。C14 还规定了通行密钥与 OpenID Connect 身份因子，它们尚未构建。

<a id="releases-the-log-and-the-rebuild"></a>

### 发布、日志与重建

[C2](../contracts/c02-release-manifest.zh.md) 与 [C18](../contracts/c18-release-log.zh.md) 定义发布完整性。

- 离线的 targets 密钥为每个发布清单签名，离线的 root 密钥为每个角色的密钥及每次轮换签名。在线的 timestamp 密钥只为新鲜度签名，其文件在签发 3 天后过期；客户端拒绝过期或更旧的 timestamp。
- 安装或更新需要发布日志中经过验证的包含证明，并由 root 所列的见证者共同签名。每次启动时，经过验证的发布日志失败，或缺失已存储的完整性包，都会阻止启动；离线或未知的在线检查从不阻止启动。安装时在线检查未完成的发布，会在更新报告中显示为 `unchecked`，`delorun update --yes` 不会确认它。
- targets 密钥持有者只通过 `sign-release.ts` 为公开发布签名；以下任一项不满足时它会拒绝：在 CI 之外、使用公开配方从带标签源码重建的匹配重建记录，提交位于发布分支上，targets 密钥列在 `delorun/release/production-keys.json` 中，以及标签带有 `delorun/release/allowed-signers` 所列密钥的签名；这两个文件都按发布分支提交的内容读取。timestamp 命令拒绝该登记册未列出的 timestamp 密钥；登记册发布时为空，因此在所有者记录密钥之前，生产签名一直停止。`local-release.ts` 为它自己的通道签名一个未经重建的发布：其清单把构建者写为 `local release (no independent rebuild)`，它拒绝 `delorun/release/production-keys.json` 中列出的 root 或密钥，从生产发布位置获取的启动器会拒绝它的清单，除非它是在预览根下验证的 0.x 版本。在 1.0 之前，维护者在维护者的电脑上构建并签署版本，没有独立重建，所以上面的重建检查不适用于它们；1.0 版本或更晚的根下的版本会被拒绝。
- 签名命令根据 GitHub Advisory Database 检查锁文件，遇到没有有效接受的公告时拒绝。
- 在签名、摘要与日志检查通过之前，任何文件都不会进入 `~/.delorun/runtimes/`。每次启动时，npm 启动器都会根据已签名的文件列表检查每个已安装的运行时文件：它对每个文件计算哈希，或将文件的身份与上次计算哈希后记录的身份比较，并默认至少每 7 天对每个文件计算一次哈希。不改变文件变更时间的存储损坏，由该完整检查或 `delorun verify` 发现，而不是由下一次启动发现。本人批准 harness 编辑时，一次启动所运行的组合树，是对照已签名的文件列表和 `changes/harness/` 之下已批准的 harness 记录检查的，两者都从 home 读取，因此它能发现被改动的树文件，但发现不了被同一用户的进程重写的记录（见上文同一用户的其他本地进程）。
- npm 启动器是安装前的信任锚：`npx delorun` 会在任何 Delorun 检查之前运行 npm 提供的启动器。每次启动都以启动器附带的最新 root 为锚，从不以更旧的已存储 root 为锚，因此被附带 root 撤销的 targets 密钥不再能通过验证。设置会安装固定为当前运行的启动器版本的 `delorun` 命令，[信任页面](../guide/safety-and-updates/trust.zh.md#checking-it-yourself)说明了如何通过带外方式核查该版本。

发布工作流尚不存在：每 24 小时重新签名 timestamp、带构建证明且不使用令牌地发布到 npm，以及安装脚本，见[发布工作流设计](../design/release-workflow.zh.md)。桌面应用的更新器是上游的，不检查任何 Delorun 签名或日志条目（[更新与回滚设计](../design/update-and-rollback.zh.md#the-desktop-app)）。

<a id="the-catalogue-and-revocation"></a>

### 插件索引与撤销

插件索引与撤销列表尚未构建（[C13](../contracts/c13-catalogue-revocation.zh.md)）：除上游的锁文件之外，Delorun 不固定任何插件版本，也无法停用任何已安装的版本。[C17](../contracts/c17-plugin-versions.zh.md) 对 DSH 或 Delorun 版本要求未满足或无法读取的插件，在安装时拒绝、在启动时停用，并且从不为此导入插件代码。Delorun 不读取插件代码；[安装检查](#plugins)读取锁文件、公告源与注册表的发布时间，并记录每个已安装的文件。

<a id="updates-and-rollback"></a>

### 更新与回滚

[C3](../contracts/c03-update-report.zh.md) 与 [C19](../contracts/c19-home-process.zh.md) 定义 CLI home 的更新如何应用。在更新之前，`delorun update` 会显示目标版本将停用、移除或改变的每个插件、组合包与 profile 行，以及 chat 数据的格式是否改变，把 Delorun 无法预测的内容标记为未验证且从不算作安全，并在本人确认之前不应用任何内容。先写入快照；切换会等到旧运行时上没有 chat 运行，期间新回合会被拒绝；120 秒内的健康检查失败时会自动回滚，本人之后也可以用 `delorun recover` 回滚。`delorun recover restore` 立即应用某个 profile 历史版本，不经批准提示，也不运行安装时的插件检查。桌面应用通过上游的更新器更新。

<a id="archives-and-untrusted-chats"></a>

### 导出文件与不受信任的 chat

[C8](../contracts/c08-archive-and-trash.zh.md) 定义导出文件与回收站。导入会先在暂存区验证整个归档，然后才写入任何内容，并且从不覆盖工作区或 chat。定制内容是封闭 schema 下的数据：不会求值任何 `!!js` 表达式，不接受任何 `insert` 行，也没有任何行能设置沙箱模式、凭据引用、远程访问方式或出口。没有导入方 home 能担保的签名的归档，只有在本人将其作为未验证内容接受之后才会导入。不会应用任何定制行，导入的 chat 保存在没有任何东西读取它们的地方，因此它们不会进入任何模型请求。把导入的 chat 作为不受信任的 chat 打开以及应用定制内容，见[导入 chat 设计](../design/imported-chats.zh.md)。清除会从 C8 所列的每个存储中移除条目，请求图片缓存除外；在 studio 中清除会移除该浏览器中该 chat 的草稿，而从 `delorun trash` 清除或在保留期结束时清除不会触及任何草稿。

<a id="logs-and-redaction"></a>

### 日志与遮盖

[C20](../contracts/c20-operational-logs.zh.md) 定义 Delorun 的运行日志。每条记录在写入之前都经过遮盖器，它会替换已登记的密钥值（即启动令牌与中继密钥）、名称表明是密钥的字段以及所列的凭据形式。不匹配任何所列形式且未登记的密钥，例如形式未被识别的模型密钥，可能进入日志。Delorun 自己的记录不包含 chat 文本、提示、模型输出、工具参数或文件内容。日志文件位于 home 下，权限模式为 0600，CLI profile 中的受限命令不能写入它们，并且在 `home-read` 被强制执行的地方也不能读取它们。每次 `delorun` 调用都会删除 14 天之前写入的日志；运行更久的 home 进程会保留它们，直到下一次调用。

<a id="verification"></a>

### 验证

[C15](../contracts/c15-verification-checks.zh.md) 定义 `delorun verify`。它运行两项检查：`release-signature`，它把已存储的 root 锚定到启动器附带的 root 上，并检查清单的签名、timestamp 的新鲜度与发布日志包，除非指定 `--offline`，还会进行在线日志检查；以及 `runtime-files`，它根据已签名的文件列表对每个已安装文件计算哈希。C15 列表中的其他每项检查都报告为未运行。检查以本人的权限运行，每份报告都说明以该权限运行的程序可以改变这些检查。结果为 `pass`、`fail`、`not-enforced` 或 `unknown`；`not-enforced` 与 `unknown` 从不算作通过。没有任何东西读取验证模式：`delorun verify` 以 `warn` 报告且不阻止任何内容，启动器在经过验证的签名、文件或发布日志失败时总是停止。任何详情都不包含密钥、令牌、cookie、私钥或文件内容。

<a id="parity"></a>

### 对等

[C16](../contracts/c16-parity-composition.zh.md) 定义对等组合。其 overlay 只在回放流程设置 `DSH_SNAPSHOT_PATCH` 时加载；任何随产品发布的 profile、配置或命令行选项都不会选择它。在对等组合中，抓取防护、沙箱以及搜索、`read` 与 `present` 工具的受保护 home、计划任务、指令层、MCP 与完全访问的同意以及更新闸门都处于关闭状态，它们提供的保护在那里不存在；CLI profile 保持每一项开启。

<a id="the-web_fetch-guard"></a>

### web_fetch 抓取防护

在 CLI profile 中，抓取防护让 `web_fetch` 与 HTTP 抓取提供方在任何连接之前拒绝回环、链路本地与私有网络目标（包括云元数据地址），并给出模型可读的类型化原因；该工具仍保留在模型的工具列表中（[决策](../../../.agents/notes/proposed/feature/2026-11-06-delorun-web-fetch-private-targets.zh.md)）。它检查每次重定向，并且只连接到它批准过的地址。`web_fetch` 还遵循调用它的工作区的网络设置：在 `off` 下每次调用都被拒绝，在 `allowlist` 下主机未被列出的 URL 在任何查找之前就被拒绝，这通过一个任何其他监听器的答复都无法转为许可的工具防护实现。该防护限制的是 `web_fetch` 的目标，工作区的网络限制的是其沙箱命令能访问什么。

<a id="data-sharing"></a>

### 数据共享

Delorun 没有自己的遥测。在 CLI profile 中，DeepSeek 的会话日志上传在本人于设置的“隐私”分区中开启之前保持关闭，DeepSeek 的反馈发送已被移除；设置流程无法开启上传（[C11](../contracts/c11-setup-answers.zh.md)）。在 `delorun headless` 下，会话日志上传同样默认关闭，桌面应用保留上游的分析。每当安装、更新或启动发布时，发布检查都会运行；如[网络](#the-network)一节所述，它们的请求会向其主机暴露机器的 IP 地址与版本。更新检查每天获取一次发布渠道的签名文件，并在已过去一天时于启动时获取，直到在设置的“隐私”分区中关闭；它不发送任何标识符。新增一个默认开启的、发往 Delorun 主机的请求，需要负责人批准，并在网络测试的允许列表 [`network-requests.json`](../../apps/tools/src/checks/network-requests.json) 中登记，该列表写明 Delorun 未经请求发出的每个请求及其主机、用途、开关与披露；当随产品发布的、发起网络请求的源文件未被列出时，其规格测试会失败，但它发现不了在已列出的文件中新增的请求。`delorun verify` 把 `data-sharing` 检查报告为未运行。

<a id="what-delorun-does-not-protect-against"></a>

## Delorun 不防范的内容

下面每项局限都写在拥有它的约定中。`delorun verify` 只报告发布的签名、日志状态与文件，因此其他局限都不会按机器报告。

| 局限 | 仍然可能发生的事 |
| --- | --- |
| CLI profile 之外的命令 | 在 `delorun plugin` 下，命令可以读取整个 home（包括启动令牌与上游的凭据文件）并连接更新通道；任何同意、抓取防护或隐私默认值都不适用。在 `delorun headless` 下，受限命令受沙箱 overlay 的规则约束，而以完全访问运行的命令（需要在 home 的电脑上为该工作目录记录授权）不受限制 |
| Windows 不限制读取 | 受限命令可以读取 home 的密钥、上游的凭据文件与启动令牌，因此令牌无法阻止它们访问更新通道；不检查 home 的权限模式与访问列表；在 ripgrep 完成之前换入搜索路径又恢复的链接可以触及 home |
| 隐藏 home 其他挂载的文件系统 | 当 home 位于 btrfs、bcachefs 或 overlayfs 上，或挂载表未列出其设备时，提供方找不到它的其他挂载，命令只在 home 自身的路径上受到保护，因此同一文件系统的第二个挂载对受限命令与文件工具仍然可达；提供方把其别名覆盖报告为 `unknown`，目前还没有任何东西显示这一点（[C1](../contracts/c01-home-layout.zh.md#what-this-does-not-prove)） |
| Landlock 无法拒绝对路径名套接字的连接 | 在没有逃逸套接字目录（例如容器）、只有 Landlock 的系统上，受限命令可以连接更新通道（通道会因其无法读取启动令牌而拒绝它）、rootful Docker 套接字（这等同于 root）以及 ssh-agent；在存在逃逸套接字目录之处，Landlock 拒绝每个受限命令 |
| 经 TCP 或 SSH 访问 Docker | 任何有网络访问的命令都能访问该引擎 |
| macOS 上 Docker Desktop 的控制套接字 | Docker Desktop 的 macOS 控制目录中除其引擎套接字之外的套接字，对受限命令仍然可达 |
| 其他 Unix 套接字与网络 | 受限命令可以访问 C1 所隐藏目录之外的套接字，例如本人 home 之下的套接字、抽象套接字（其中包括 Linux 桌面上 X 服务器的抽象套接字，以及 `dbus-launch` 在抽象地址上启动的会话总线），在网络为 `allowlist` 或 `off` 的工作区中除外；除 Docker 之外授予 root 的、由组拥有的守护进程套接字；以及在网络为 `open` 的工作区中，任何网络主机 |
| 没有任何网络设置能关闭的出口 | 完全访问下的命令、插件、MCP 服务器、子智能体工具的智能体和语言服务器在每种设置下都能访问网络；`web_search` 把它的查询发送给所配置的搜索提供方；回环上的 studio 会加载回复所链接的图片；模型可以把数据放进它的回复、文件和提交消息中，它们在本人分享时离开；在 `allowlist` 下，命令可以向每个已列出的主机发送数据，通配条目让它查找该域名之下的任何名称（[指南](../guide/safety-and-updates/prompt-injection.zh.md#what-no-setting-closes)） |
| 模型发起的写入指令文件的命令 | shell 命令或 PTC 代码可以在可写根目录中修改 `AGENTS.md`、skill 或预设，而无需指令同意 |
| 已提权的命令 | `danger-full-access` 下的命令不受限制：它可以读取 home 下的每个密钥与启动令牌，并访问更新通道；上游的提示不说明这一点 |
| 危险模式，本人所选的限制 | 带终端的手机，或在完全访问工作区中向 chat 发送提示的手机，拥有电脑的权限：shell 可以运行 `delorun devices approve`、`elevate` 和 `code`。危险模式从不免除终端所需的解锁，因此只有已解锁的手机才能打开终端。在 setup 的 **Never ask (dangerous)** 提示回答下（它在警告和键入短语 `full access everywhere` 之后写入），任何 chat 都可以无需同意就切换到完全访问，无论是来自电脑上的 studio、通过远程访问登录的手机、计划任务、机器人还是 `delorun headless`；持有运行中解锁的已登录设备随后也做电脑所做的事，包括提供方密钥和终端（已保存的密钥从不发送给设备），但开启该模式、批准设备或解锁、移除设备、更改远程访问设置以及登录除外；其命令随后不受限制地运行，拥有本表第一行之下的一切，并且指令文件、MCP 服务器和计划任务的同意处于关闭状态。它既需要 profile 的 `fullAccessEverywhere` 设置，也需要只有 `delorun setup` 写入的授权文件；全新安装时它是关闭的，`--yes` 从不选择它，并且 root 用户会被拒绝。模型读到的文本可以要求完全访问，而没有任何东西会询问你 |
| `delorun start --inspect` 的调试器 | 当 Node 的检查器监听 `127.0.0.1:9229` 时，这台计算机上任何能到达该端口的进程（包括智能体在沙箱内运行的命令）都可以在沙箱之外以 Delorun 的身份运行代码，因此 C1 的限制保证不成立。启动会先询问，所用的问题会说明这一点并以否开始，或在没有终端时接受 `--inspect --yes`；安全模式拒绝它，`delorun status` 在它监听期间显示它 |
| 沙箱之外的同一用户进程 | 它们可以读取和修改 home 下的一切、签发回环凭据、运行 `delorun` 与 `docker`、凭启动令牌使用更新通道（批准设备、移除设备、获取 studio 登录链接），并改动启动器、已存储的 root 与检查本身 |
| macOS 与 Windows 上的进程内存 | home 进程内存的保护依赖操作系统的规则，没有 Delorun 测试检查它 |
| 回环 studio 的凭据 | 在 CLI profile 中，启动令牌在 60 秒内只能使用一次，但它会出现在浏览器启动器的命令行中，另一个用户或 Landlock 与 Seatbelt 下的受限命令可以在这一分钟内抢先于浏览器使用它；cookie 在 30 天内都能被准入，跨越重启仍然有效且无法撤销；能读取 `.credentials.yaml` 的一方可以签出 cookie；每个持有者都以所有者身份行事，且不适用任何内容安全策略 |
| 插件 | 插件以 harness 的权限运行；除上游的锁文件之外，Delorun 不固定任何东西，也无法撤销任何东西。安装检查只知道已公布的公告，对其余情况发出警告；安装记录能发现插件之外做出的改动，而不是插件自身代码以本人身份做出的改动 |
| 从源码检出运行 | 源码检出是开发者模式，而不是已安装的发布：包括 Delorun 自己的 bundle 在内的整个 harness 都从检出处运行，因此在仓库内工作的模型可以编辑 Host 所运行的代码；Changes 不处理该检出自己的包（[C21](../contracts/c21-changes.zh.md#loading-approved-content)） |
| Changes 保护关闭（默认） | 没有任何东西在更改加载之前审查它。在完全访问工作区中工作的模型、下载的程序，或写入已链接插件文件夹的本人用户的任何进程，会在下一次启动时，或在 Delorun 运行期间立即，改变 harness 所运行的代码，而沙箱之外的进程可以通过 harness 的可写副本做同样的事；受限工作区的命令和文件工具的写入仍然只去往沙箱允许的地方，因此它们可以更改可写根目录之内的插件文件夹，但从不能更改 `~/.delorun`。每个这样的更改都被记录为未经审查而加载，由 `delorun verify`、`delorun doctor` 和 `delorun changes list` 写明，并用 `delorun changes undo` 撤销；本人已撤销或丢弃的内容不会再次加载（[C21](../contracts/c21-changes.zh.md#the-protection-setting)） |
| 完全访问与 Changes | 具有完全访问权限的工作区以本人自己的权限运行命令，因此在那里工作的模型可以像本人一样关闭保护并批准更改：终端检查在模型自己的伪终端中通过，只有沙箱对 home 的写入规则能阻止受限的模型（[C21](../contracts/c21-changes.zh.md#who-may-do-what-from-where)，F16） |
| 已批准的插件代码 | 在 Changes 下被批准的插件以 harness 的权限运行；应用之前显示的风险摘要是对该更改的启发式判断，而不是对代码的限制（[C21](../contracts/c21-changes.zh.md#the-risk-summary)） |
| 插件链接的已安装包 | Changes 按哈希复制已批准插件的已安装包，连同每个包所列且安装在它旁边的依赖，因此对工作区 `node_modules` 的写入不会改变所运行的内容。在没有这种列表的情况下导入的模块（例如被 pnpm 提升的包），由活动目录的父目录解析，其中包括本人的主文件夹，受限命令可能在那里放置一个。在 `warn` 和 `off` 下，超过 50,000 个文件或 512 MiB 的插件从其已安装包的安装位置加载它们，并且每次 `warn` 启动都写明它，并说明它们何时位于主文件夹之下；在 `block` 下它不加载（[C21](../contracts/c21-changes.zh.md#loading-approved-content)） |
| Delorun 运行期间的重新加载 | 在每次重新组合之前，Host 把指名文件夹的 `link:` 依赖（如恢复、撤销或 `delorun plugin --profile default add link:<folder>` 所写入的）移到插件的活动目录，并拒绝其链接或活动目录与 Changes 所保持的内容不同的重新组合。该检查由 `@delorun/plugin-changes` 提供；没有配置该行的 profile 在其下一次启动之前不经检查就重新加载，而被配置为把活动目录当作模块源来监视的 profile 会在没有该检查的情况下替换模块，不过只有 Delorun 才写入活动目录（[C21](../contracts/c21-changes.zh.md#reloads-and-restores)） |
| 已批准内容的存储 | 存储保留记录所引用的内容；早于已批准记录的 profile 历史版本，可能指名了已被回收移除的内容，恢复它不会为该插件加载任何内容，直到本人再次应用某项更改（[C21](../contracts/c21-changes.zh.md#collecting-the-store)） |
| 工作会话 | 工作会话持续期间（最长 480 分钟），无论插件的文件夹持有什么，无论是谁写入的（本人、经过每个 chat 询问之后的智能体，或另一个进程），都无需审查即加载。没有本人参与而结束的会话不批准任何内容，`done` 只批准它所显示的版本（[C21](../contracts/c21-changes.zh.md#work-sessions)） |
| 模型发起的写入插件文件夹的命令 | shell 命令或 PTC 代码可以在没有插件写入询问的情况下更改已批准插件的文件夹，该询问只涵盖文件工具；保护开启时，该更改在本人应用之前不加载，保护关闭时，它在下一次启动时、或在 Delorun 运行期间于文件夹稳定时无需审查即加载，而在该插件的工作会话期间它实时加载（[C21](../contracts/c21-changes.zh.md#the-agent-and-plugins)） |
| 对时钟的信任 | 被调慢的时钟会接受已超过实际过期时间的发布 timestamp 或日志检查点；被调快的时钟会拒绝新的元数据，拒绝信息会写明过期时间与本地时间 |
| 从不联网的 home | 其发布相对于日志一直是 `unchecked`，展示给它的不同日志视图不会被发现 |
| 见证者的独立性 | 检查的是所列见证者的共同签名；它独立于日志与 Delorun 与否，取决于 root 列出了哪些见证者 |
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

- 改变批准、拒绝或提权的变更，在[差异台账](../../upstream-patches.json)中是一条 `security` 类条目，附带负责人的结论，并包含一项在变更前失败、变更后通过的拒绝测试（[决策](../../../.agents/notes/implemented/process/2026-11-06-delorun-never-less-safe-than-stock.zh.md)）。Delorun 对 stock 检查的豁免范围很窄，写明它覆盖的检查与情形，并置于一个在对等组合中关闭的开关之后。
- 涉及信任边界的变更（登录、设备、中继、运行时、导出文件、更新或签名）在其 brief 中标记为 Lead，并接受逐行审查；安全路径由人类代码所有者批准（[规则](../../../AGENTS.md)）。
- 拒绝测试针对本地替身运行，从不联系真实服务。
- 本页与它所陈述的边界、某一方的权限或某项局限在同一次变更中修改，某次变更构建的防护也在该次变更中于本页从未构建改为已构建。
- 安全报告通过 [SECURITY.md](../../../SECURITY.md) 提交，从不通过公开 issue。

<a id="consent-and-network-seams-when-their-service-fails"></a>

## 服务失败时的同意与网络接缝

已开启但其服务未能启动的同意或网络行，会以关闭方式失败：MCP 客户端拒绝每个 stdio 服务器，外部智能体和计划任务的同意挂载一个拒绝每次启动或投递的服务，而按工作区的网络让受限命令没有网络。行的开关关闭时，该接缝不存在，其行为与 stock 相同。替身携带一个 `delorun` 的启动检查会读取的标记，因此该检查仍把该行报告为失败，并且 Host 不会作为健康的 Host 启动。被替身拒绝的计划任务保持暂停，直到该行恢复工作。只有当该行的插件加载、而其服务启动失败或其配置被拒绝时（包括热重载时），才会挂载替身。其插件从未加载（例如包加载失败）或其 `inject` 从未解析的接缝，在 Host 运行期间保持不存在，直到重启之前适用 stock 行为；`delorun start` 处的启动检查是对这两种情形的唯一覆盖，并且它拒绝启动 Host。
