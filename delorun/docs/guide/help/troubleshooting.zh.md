---
description: "Delorun 故障排查：如何读懂一次拒绝、退出码，以及按代码和修复办法列出的常见拒绝，涵盖 home 及其文件、启动、模型密钥、安装与发布检查、更新与回退、保护与插件、远程访问和归档。"
---

# 故障排查

[English](troubleshooting.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

当 `delorun` 无法完成你要求的事情，或手机无法登录你的 studio 时，本页帮助你摆脱困境。当 `delorun` 无法做某件事时，它会打印一条拒绝信息：它做了什么或没做什么、为什么（带有错误代码）、以及你可以怎么做。大多数拒绝不会改变任何东西，所以你可以修复原因后再运行同一条命令。

请在本页中搜索信息里的确切措辞或代码来找到你的情况。每个条目都以修复办法结尾，或指出去哪里寻求帮助，[当这里没有你的情况时](#when-nothing-here-fits)说明如何提问。你不需要事先具备其他任何东西。[home](../../reference/glossary.zh.md#home)、[profile](../../reference/glossary.zh.md#profile) 和[沙箱](../../reference/glossary.zh.md#sandbox)等词在第一次出现时会链接到[术语表](../../reference/glossary.zh.md)。

## 目录

- [读懂一次拒绝](#reading-a-refusal)
- [home 及其文件](#the-home-and-its-files)
- [第一天](#the-first-day)
- [启动与停止](#starting-and-stopping)
- [studio 端口被占用](#the-studio-port-is-busy)
- [setup 与模型密钥](#setup-and-the-model-key)
- [安装与发布检查](#installs-and-release-checks)
- [更新与回退](#updates-and-rollback)
- [修复程序并保留你的数据](#repair)
- [最后手段：手工操作](#by-hand)
- [保护与插件](#protections-and-plugins)
- [远程访问与设备](#remote-access-and-devices)
- [手机无法登录时显示什么](#what-a-phone-shows-when-it-cannot-sign-in)
- [归档、导入与回收站](#archives-imports-and-the-trash)
- [工作区列表](#the-workspace-list)
- [当这里没有你的情况时](#when-nothing-here-fits)
- [报告未列出的问题](#report-a-problem-that-is-not-listed)
- [移除 Delorun](#remove-delorun)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="reading-a-refusal"></a>

## 读懂一次拒绝

拒绝信息在你的终端中分三部分出现：第一行说明发生了什么，`Why:` 指出错误代码以及它所涉及的路径或值，`What you can do:` 按顺序列出修复办法。拒绝信息从不显示堆栈跟踪，并且像 Delorun 的日志那样隐藏密钥和令牌。信息中把这个产品称为 “Delorun”。

```text
Delorun stopped before using /home/you/.delorun.
Why: HOME_MODE: /home/you/.delorun has mode 0755, which other users can reach; it must be 0700
What you can do:
  Fix it with: chmod 700 /home/you/.delorun
```

运行 `delorun` 命令的修复办法会重复你给出的 `--profile <name>`，所以你可以照原样复制。修复原因之后，再次运行被拒绝的命令；你应该会看到它在没有拒绝的情况下完成。

`delorun` 以四种退出码之一退出，脚本可以依赖它们：

| 退出码 | 含义 |
| --- | --- |
| 0 | 命令完成了你要求的事，或发现它已经完成。 |
| 1 | 命令失败；标准错误输出说明原因。 |
| 2 | 命令行有误：未知的命令、选项或值。 |
| 3 | 命令需要该 profile 的 Delorun 正在运行，而它没有运行。 |

没有自己的代码就失败的命令，以 `delorun <command>:` 开头，并在同一句话里说明该怎么做。

<details>
<summary>边界情况</summary>

- 如果在你修复原因之后拒绝仍然重复，那么请运行 `delorun doctor` 并阅读它的各行，然后再试。
- 如果拒绝指出的文件你找不到，那么它在你的 Delorun home 内，即 `~/.delorun` 或 `DELORUN_HOME` 所指的文件夹：在那里用 `ls -la` 列出它。
- 如果你运行 `delorun headless`，那么本该询问你的同意或完全访问问题会改为被拒绝；拒绝信息会指出首先要允许什么（见[保护与插件](#protections-and-plugins)）。
- 如果拒绝信息说 “Report this”，那么 Delorun 发现了它无法解释的东西：见[当这里没有你的情况时](#when-nothing-here-fits)。

</details>

<a id="the-home-and-its-files"></a>

## home 及其文件

| 代码 | 含义 | 该怎么做 |
| --- | --- | --- |
| `HOME_MODE` | 你的 [Delorun home](../../reference/glossary.zh.md#home)或其中的某个私有文件夹可被其他用户访问、是指向别处的快捷方式（符号链接）、不是文件夹，或属于另一个用户。 | 运行拒绝信息打印出的 `chmod 700` 命令。对于快捷方式或另一个所有者，请把它移走，让 `delorun` 重新创建该文件夹。 |
| `SECRET_FILE_MODE` | 其他用户可以读取的密钥文件、是快捷方式或属于另一个用户的密钥文件，或在 Delorun 读取它时被替换的文件。 | 运行拒绝信息打印出的 `chmod 600` 命令。Delorun 从不替你更改这些权限。 |
| `HOME_INVALID` | `DELORUN_HOME` 不是绝对路径且不以 `~` 开头，或它指向磁盘根目录或你的用户文件夹本身。 | 把 `DELORUN_HOME` 设为一个专用文件夹，例如 `~/.delorun`。 |
| `HOME_IS_DSH_HOME` | `DELORUN_HOME` 指向 DeepSeek Harness 的 home `~/.dsh` 或其中的某个文件夹。 | 选择另一个文件夹；Delorun 保持 `~/.dsh` 不动。 |
| `SOCKET_PATH_TOO_LONG` | home 的路径对于 `delorun` 命令与正在运行的 Delorun 通信所用的本地通道来说太长。 | 用 `DELORUN_HOME` 选择更短的 home。 |

修复到位之后，你应该会看到命令在没有拒绝的情况下运行。[你的 Delorun home](../customising/home.zh.md)介绍了 home 及其权限。

在你运行 `delorun` 的文件夹或你的 Delorun home 中的 `.env` 文件，不得设置以 `DELORUN_` 开头的名称，因为这些名称决定了 Delorun 信任哪个 home、profile 和发布版本。拒绝信息会指出该文件。请从中删除这些名称，如果需要，改为在你的 shell 中设置。

<a id="the-first-day"></a>

## 第一天

这些是人们在 Delorun 运行起来之前会遇到的问题。每一条都以修复方法结尾。

- **`Delorun needs Node 24.9 or newer to start`。**消息会说出你现有的 Node 版本。系统包管理器（例如 Ubuntu 的 `apt`）常常只提供较旧的 Node，所以请从 [nodejs.org](https://nodejs.org) 或用 nvm 之类的版本管理器安装当前的 Node，打开一个新终端，用 `node --version` 检查，然后再次运行命令。每个 `delorun` 命令都运行在 Node 上，所以安装之后 Node 也必须保留；没有它时，shell 会打印 `env: 'node': No such file or directory`。
- **`npm install -g delorun` 以 `EACCES` 或 “permission denied” 失败。**你的 Node 位于只有管理员才能写入的文件夹中，这在 Linux 上的系统级 Node 很常见。请改为安装到你自己的文件夹：使用 setup 打印的那一行，并加上 `--prefix ~/.local`：`npm install -g --prefix ~/.local delorun@<version>`。然后把 `~/.local/bin` 加入你的 `PATH`（`export PATH="$HOME/.local/bin:$PATH"`，并把同一行写进你的 shell 启动文件使其长期有效），打开一个新终端，并用 `command -v delorun` 检查。用 nvm 这样装在你主目录里的 Node 永远不会遇到这个问题。
- **studio 没有在你的浏览器中打开。**运行 `delorun open`。如果它说 `No browser took the studio link`，请运行 `delorun open --print` 并打开它打印的链接。打印出的链接只能登录一次，一分钟后失效，所以请再次运行命令获取新的链接。在没有浏览器的电脑上，见[没有浏览器的电脑](../get-started/install.zh.md#a-computer-without-a-browser)。
- **每个命令都被拒绝，且 `delorun doctor` 显示 `fail sandbox: bubblewrap (bwrap) is not installed`。**在 Linux 上，Delorun 用 bubblewrap 限制命令。没有它时，命令会退回到 Landlock，而 Landlock 无法隐藏你的登录会话或 tmux 之类的终端复用器保存在 `/tmp` 中的套接字，所以只要存在这样的套接字，Delorun 就拒绝每一个命令。请安装 `bubblewrap` 软件包（在 Ubuntu 和 Debian 上是 `sudo apt install bubblewrap`），然后运行 `delorun doctor` 并重新启动。如果 `doctor` 随后说 bubblewrap 无法创建沙箱，见[保护与插件](#protections-and-plugins)。
- **`delorun doctor` 显示 `warn docker`。**Docker 是可选的。这条警告表示 Docker 没有安装或没有响应，而使用你电脑自己文件夹的工作区无需它也能工作。

<a id="starting-and-stopping"></a>

## 启动与停止

- **`Delorun is already running for the profile default`。**`delorun start` 发现 Delorun 正在运行，什么也没做；这不是故障。请用 `delorun open` 打开 studio。
- **`HOME_UNRESPONSIVE`。**有一个进程声称正在运行这个 profile（它持有该 profile 的锁文件），但在 2 秒内没有应答。请停止那个进程，或者如果它不是 `delorun`，则删除拒绝信息指出的锁文件，然后再次运行 `delorun start`。
- **`Delorun is running for the profile … and uses the stores this command changes`。**`delorun trash`、`export` 和 `import` 之类的命令会更改正在运行的 Delorun 所使用的 chat 数据。请像拒绝信息所说的那样，先运行 `delorun stop`。
- **`another process … holds the home lock`，或 `Delorun did not go ahead: another process uses the chat data`。**另一条 `delorun` 命令正在更改相同的数据。请等它完成，然后再次运行你的命令。
- **`Delorun is being repaired; wait for it to finish`。**`delorun repair` 正在运行并替换程序，所以在它结束之前无法启动。请等它完成，然后再次运行你的命令。如果没有修复在运行（它被终止了），下一次启动会报告遗留的标记、删除它并继续。
- **`the CLI profile default is not set up`。**运行 `delorun setup`。
- **`Delorun found no folder for the default workspace`。**Delorun 为默认工作区尝试的所有文件夹都无法使用；拒绝信息列出每个文件夹及其原因。请像拒绝信息所示，在你的 profile 的 `cordis.patch.yml` 中指定你自己的文件夹，然后重新启动。
- **`UNAUTHENTICATED`。**正在运行的 Delorun 拒绝了一条没有携带其当前启动令牌的命令，这通常意味着该 profile 还有另一个 Delorun 在运行。运行 `delorun status` 查看是哪一个。
- **`STUDIO_UNAVAILABLE`。**`delorun open` 无法从正在运行的 Delorun 获得登录链接。运行 `delorun status` 查看它是否在运行以及 studio 在哪里监听；如果它没有运行，请用 `delorun start` 启动。
- **`Delorun started no new turn: its start check did not finish`。**Delorun 在启动时对其发布版本的检查尚未完成。`delorun status` 和 `delorun logs` 会显示启动正在做什么；请用 `delorun start` 启动 Delorun，然后再次发送消息。
- **`delorun start: Delorun did not start. Delorun stopped with exit code 1 before it was running.`**后台进程在启动时停止了。最常见的原因是 studio 端口被占用；见 [studio 端口被占用](#the-studio-port-is-busy)。
- **`delorun start: Delorun did not start. Delorun was not running after … seconds.`**后台进程仍在启动或卡住了。运行 `delorun logs` 查看原因，然后运行 `delorun doctor`。

<a id="the-studio-port-is-busy"></a>

### studio 端口被占用

studio 在你自己的电脑上监听一个端口，除非你的 profile 另行设置，否则是 3080。当另一个程序已经在使用该端口时，后台进程无法启动。你会看到：

```text
delorun start: Delorun did not start. Delorun stopped with exit code 1 before it was running.
Another program is using the studio's port. Choose another port with delorun setup profile, or set the port to 0 in the profile so Delorun picks a free one.
Run delorun logs to see why, then delorun doctor to check your setup.
```

要确认原因，请运行 `delorun doctor`。它会打印一条失败的 `port` 行，以 “is in use by another process, so the studio cannot listen on it; stop that process, or choose another port with delorun setup profile” 结尾。如果你自己的 Delorun 已经在为该 profile 运行，则该行改为说明端口正被 Delorun 的 studio 使用，并显示通过。

要修复它，请停止另一个程序，或运行 `delorun setup profile`（为另一个 profile 添加 `--profile <name>`），并在 “Port for the studio” 处回答一个 1024 到 65535 之间的空闲端口。然后再次运行 `delorun start`。你应该会看到 “Delorun is running in the background for the profile default” 和 studio 的地址，`delorun doctor` 则把 `port` 显示为通过。

<details>
<summary>边界情况</summary>

- 如果端口空闲而出现同样的消息，那么进程是因为别的原因停止的：请阅读消息所指的日志，或运行 `delorun logs home`。
- 如果 `delorun doctor` 说端口 “cannot be bound” 且代码不是 `EADDRINUSE`，那么系统拒绝打开该端口（代码指出原因）：请选择另一个端口。
- 如果你给 `delorun doctor` 传入 `--port`，那么它会检查那个端口，而不是 profile 的端口。

</details>

<details>
<summary>进一步了解</summary>

- 要让系统在每次启动时选择一个空闲端口，请在你的 Delorun home 中 `profiles/<profile>/cordis.patch.yml` 的 `webserver` 条目里，把 studio 的 `port` 设为 `0`；`delorun setup profile` 只提供 1024 到 65535 的端口，并替你写入该条目。请保留该条目的其他键。`delorun status` 随后会显示地址，`delorun doctor` 会报告每次启动都取一个空闲端口。

</details>

<a id="setup-and-the-model-key"></a>

## setup 与模型密钥

- **`The key was not checked successfully: …`。**setup 在保存键入的密钥之前会与[提供方](../../reference/glossary.zh.md#provider)核对，而这次检查失败了；后面跟着原因。请选择 **Enter the key again**，或选择 **Continue without a successful check** 仍然保存它，同时要知道密钥错误时 chat 无法回答。之后你可以用 `delorun setup key` 更改它。
- **`the key in DEEPSEEK_API_KEY was not accepted`。**你带 `--check-key` 运行了 setup，并使用从环境中读取的密钥，而提供方拒绝了它。请检查密钥并再次运行 `delorun setup`。
- **`DEEPSEEK_API_KEY is not set in this terminal`。**你选择从环境变量读取密钥，而这个终端没有该变量。请设置它（例如在你的 shell 启动文件中写 `export DEEPSEEK_API_KEY=your-key`），然后运行 `delorun stop` 和 `delorun start`。
- **`DEEPSEEK_BASE_URL is not a URL`。**请修正或取消设置 `DEEPSEEK_BASE_URL`；没有有效的地址，setup 无法检查密钥。
- **`the setup run for default is unfinished and needs the model key`。**用 `--yes` 或 `--config` 启动的 setup 在拿到密钥之前停止了。请在终端中运行 `delorun setup` 来完成它。
- **`… holds …, which setup no longer asks`。**`delorun setup --config` 文档中写了 setup 不再有的答案。请从文档中删除它。
- **`… is not a setup record; remove it to set up again`。**未完成的 setup 的记录已损坏。请删除它所指的文件并运行 `delorun setup`。

<a id="installs-and-release-checks"></a>

## 安装与发布检查

npm 启动器和 `delorun update` 在安装每个[发布版本](../../reference/glossary.zh.md#release)之前都会验证它，并拒绝无法通过验证的发布版本；此时不会安装任何东西。[安装与首次运行](../get-started/install.zh.md)说明了它们检查什么。

| 代码 | 含义 | 该怎么做 |
| --- | --- | --- |
| `DOWNLOAD_FAILED` | 下载没有完成。 | 检查连接并再次运行同一条命令。 |
| `INSTALL_VERIFY_FAILED` | 发布版本的签名或其已签名的文件列表与下载的内容不符。 | 当发布页面列出更新的发布版本时，再次运行同一条命令；如果重复出现，请报告。 |
| `RELEASE_LOG_FAILED` | 发布版本在公开发布日志中的条目未能通过验证。 | 同上。`delorun verify` 显示每一项检查。 |
| `ARCHIVE_REFUSED` | 运行时压缩包中含有 Delorun 不安装的东西。 | 同上。 |
| `PLATFORM_NOT_RELEASED` | 发布版本没有适用于这台电脑的系统和处理器的运行时。 | 使用发布版本所列平台的电脑。 |
| `RELEASE_NOT_OFFERED` | 你要求的发布版本不是你的渠道所发布的。 | 指定一个已发布的发布版本，或省略发布版本以安装当前版本。 |
| `NO_TRUSTED_ROOT` | 这个启动器没有可用于验证发布版本的密钥。 | 运行 `npx delorun@latest`，它附带当前的发布根。 |
| `TRUST_STATE_INVALID` | Delorun 用来记住已验证过哪些发布版本的文件无法读取。 | 把拒绝信息所指的文件移开，然后再次运行命令。 |
| `NO_ACTIVE_RUNTIME` | 没有已安装的运行时被标记为活动的，或活动的那个已丢失。 | 运行 `npx delorun@latest repair`（见[修复](#repair)），或者在 `delorun` 仍能启动时运行 `delorun recover rollback`。 |
| `RUNTIME_INCOMPATIBLE` | 已安装的运行时需要更新的启动器，或启动器需要更新的运行时。 | 按补救办法操作：更新运行时，或更新启动器。 |
| `STORE_BUSY` | 另一条 `delorun` 命令正在更改已安装的运行时。 | 等它完成。 |

有两种拒绝来自公开发布日志本身。“Delorun could not reach the release log” 表示网络故障：请检查连接并重试。“The release log answered with something Delorun does not accept” 表示日志的应答前后不一致：如果重复出现，请报告。没有任何设置可以关闭发布日志检查（见[发布检查](../safety-and-updates/safety.zh.md#release-checks)）。

<a id="updates-and-rollback"></a>

## 更新与回退

[更新](../safety-and-updates/updates.zh.md)介绍了更新本身。下面是你最可能看到的拒绝；除非另有说明，每一种都不会改变任何东西。

| 代码 | 含义 | 该怎么做 |
| --- | --- | --- |
| `CHANNEL_UNREACHABLE` | 无法访问发布渠道；没有下载任何东西。 | 检查连接并重试。 |
| `GIT_UNAVAILABLE` | Delorun 在更新之前用 git 保存你的 [profile](../../reference/glossary.zh.md#profile)的历史，以便能够回退，而 git 在这里无法运行。 | 安装 git 并再次运行 `delorun update`。 |
| `REPORT_EXPIRED` | 你确认的报告已超过十分钟或未知。 | 再次运行 `delorun update` 阅读新的报告。 |
| `CHATS_RUNNING`、`DRAIN_TIMEOUT` | 有 chat 正在运行，或没有及时完成，所以更新没有开始。 | 等 chat 完成，然后再次运行命令。 |
| `UPDATE_IN_PROGRESS` | 已有一次更新或回退正在运行。 | 等待，然后用 `delorun status` 检查。 |
| `DATA_COPY_NO_SPACE` | 更新所保留的 chat 数据副本在磁盘上放不下。 | 腾出空间，或运行 `delorun update --no-data-copy`。 |
| `HEALTH_CHECK_FAILED` | 新的发布版本在启动之后没有通过它的健康检查。 | 运行 `delorun recover status` 查看 profile 所处的状态。 |
| `ROLLBACK_NEEDS_DATA_COPY` | 回退会把较新的发布版本写下的 chat 数据交给较旧的发布版本，而较旧数据的副本不存在。 | 保留这个发布版本，只用 `delorun recover rollback --profile-only` 恢复 profile，或用 `delorun recover safe-mode` 在安全模式下启动。 |
| `ROLLBACK_TARGET_UNUSABLE`、`NO_PREVIOUS`、`NO_UPDATE_RECORD` | 要回退到的发布版本缺失或未通过检查，或没有记录任何更新。 | 运行 `delorun recover status`。 |
| `HOST_STOP_FAILED` | studio 没有及时停止，所以发布版本没有切换，原来的仍在运行。 | 再次运行同一条命令。 |
| `REPORT_TARGET_UNVERIFIED` | 发布版本未通过验证，所以没有生成更新报告。 | 运行 `delorun verify`。 |

`delorun update --yes` 会拒绝会关闭或移除某些东西、会合并你对 Delorun 自身文件的改动、或含有 Delorun 无法预测的项目的报告，发布日志检查没有通过时它也会拒绝：请不带 `--yes` 运行 `delorun update`，并逐项决定。当更新正在等待运行中的 chat 结束时，新消息会收到 “Delorun started no new turn: an update is waiting for running chats”；待 Delorun 恢复后再次发送。

以 “Delorun refused the change and left the profile as it was” 开头的拒绝，保护的是你添加到 profile 的东西，所以没有丢失任何内容。它的代码指出本来会丢失什么：

| 代码 | 本来会丢失或更改什么 |
| --- | --- |
| `ROW_NOT_CARRIED` | 你添加到 profile 的[插件](../../reference/glossary.zh.md#plugin)条目（一行）。 |
| `CONFIGURATION_NOT_CARRIED` | 你为插件写下的设置。 |
| `LOCAL_PLUGIN_NOT_CARRIED` | 你从这台电脑上的文件夹安装的插件。 |
| `BUNDLE_LIST_NOT_CARRIED` | profile 的 bundle 列表的顺序或成员。 |
| `UNNAMED_CHANGE` | 更新报告没有点名的任何东西。 |
| `EJECTED_PLUGIN_REINSTATED` | 你弹出的插件会回来。 |
| `PROFILE_UNREADABLE` | profile 文件无法读取，所以无法检查任何东西；请修复拒绝信息所指的文件。 |
| `RESTORE_REFUSED`、`RECOVER_REFUSED` | 撤销、恢复、回退或 `delorun recover` 操作无法按要求完成。 |

它的修复办法来自下面这个列表：不进行这次更新；保留该项目并等待携带它的发布版本；更新插件；让插件保持关闭；[弹出](../../reference/glossary.zh.md#eject)插件，这会把它的条目和设置保留在你的 profile 中；用 `delorun recover restore <version>` 恢复某个 profile 历史版本；用 `delorun recover rollback` 回退；或用 `delorun recover safe-mode` 在[安全模式](../../reference/glossary.zh.md#profile-history)下启动。请先运行 `delorun recover status` 查看 profile 所处的状态。以 “Delorun could not write the profile snapshot it takes before a change”（`SNAPSHOT_FAILED`）开头的拒绝，表示什么都没有改变，因为让更改可以撤销的快照无法写入。

<a id="repair"></a>

## 修复程序并保留你的数据

如果 Delorun 因为已安装的程序未通过检查而无法启动，或 `delorun update` 无法运行，请替换程序并保留你创建的一切：

```sh
npx delorun@latest repair
```

请在终端中运行它。Delorun 会像更新那样检查它安装的发布版本，询问 `Replace the installed program … with …? Your chats, settings and keys stay. [y/N]`，并把旧程序放进 `runtimes.set-aside-<time>/` 而不是删除它。`delorun recover status` 会列出它，你满意之后用 `delorun recover discard runtimes.set-aside-<time>` 将其移除。你的 chat、设置、密钥、设备和信任记录都不会被触动。修复没有 `--yes`，并且在 Delorun 运行期间会拒绝：请先用 `delorun stop` 停止它。

<details>
<summary>边界情况</summary>

- **`DATA_NEWER`。**更新的 Delorun 写下了你的 chat，而你要求的发布版本可能无法读取它们。请安装更新的发布版本（`npx delorun@latest repair`），或用 `npx delorun@latest repair --release <old version> --restore-copy` 放回更新时做的副本。今天的 chat 会被搁置，绝不会被删除。
- **`DATA_UNREADABLE`。**home 记录了是哪个发布版本写下了你的 chat，而 Delorun 无法把它与你要求的发布版本比较，因为该发布版本的数据格式或某个版本无法读取。不会改变任何东西。请安装写下你的 chat 的那个发布版本或更新的发布版本（`npx delorun@latest repair`）。
- **`DATA_COPY_NEWER`。**用于 `--restore-copy` 的副本不是该发布版本能读取的格式，或其格式无法读取。不会改变任何东西。请改为安装更新的发布版本。
- **`TARGET_LOWER`。**该发布版本比这个 home 已安装过的某个发布版本更旧。请用 `delorun recover rollback` 回退。
- **`NO_TERMINAL`。**请在终端中运行该命令，因为 Delorun 必须询问你。
- **`RESET_TRUST_REFUSED`。**只有当你运行的启动器附带的发布密钥比这个 home 所信任的更新时，`--reset-trust` 才有效。请从 npm 安装最新的启动器并重试。
- **`--reset-trust`。**把 home 的 `trust/` 移到 `trust.set-aside-<time>/`，使 home 只信任启动器中的密钥。请只在你自己从 npm 安装的启动器上使用它。
- **`--from <folder or https address>`。**用你从发布页面下载的文件而不是渠道来验证发布版本；适用同样的签名、发布日志和摘要检查。如果渠道无法确认该发布版本是最新的，或者你指定的 `--release` 比这个 home 见过的更旧，Delorun 会先在终端中询问你；其他任何检查都不会放宽。关于 `delorun update` 上的同一个选项，见[用你下载的文件更新](../safety-and-updates/updates.zh.md#update-from-files-you-downloaded)。
- **修复与启动同时进行。**修复会持有每个 profile 的锁直到完成，所以此时启动的 Delorun 会以该 profile 被持有的消息停止；修复结束后再次启动它。它从不运行被搁置的程序。
- **没有数据格式记录。**在 Delorun 开始记录之前创建的 home 没有这项记录。修复会这样说明，假定你的 chat 采用它所安装的发布版本的格式，并继续进行。
- 每次运行都会向 `logs/repair.log` 添加一行。

</details>

<a id="by-hand"></a>

## 最后手段：手工操作

只有当 `npx delorun@latest repair` 无法运行时才使用这个办法。它不需要任何 Delorun 代码。

1. 停止 Delorun：`delorun stop`，或结束运行 `@delorun/cli` 的 `node` 进程。
2. 备份你的数据。用 `cp -a ~/.delorun ~/delorun-backup-$(date +%F)` 复制整个 home 时，也会复制 `runtimes/`，其中保存着每个已安装的发布版本，每个约 1.5 GB，所以请检查 `df -h ~` 显示有这么多空闲空间。第 4 步会重新安装这些程序，所以你可以不含 `runtimes/`：`mkdir ~/delorun-backup-$(date +%F) && tar -C ~/.delorun --exclude=./runtimes -cf - . | tar -C ~/delorun-backup-$(date +%F) -xf -`。`delorun export` 只保存单个 chat 或工作区，所以它不是设置和密钥的备份。
3. 把程序移到一边，而不是你的数据：`mv ~/.delorun/runtimes ~/.delorun/runtimes.broken`，如果 `~/.delorun/staging` 存在，也一并移开。
4. 重新安装：`npx delorun@latest`。程序存储为空，所以启动器会安装并检查当前的发布版本并启动它。你的 chat、设置、密钥和 profile 都不受影响。

<details>
<summary>边界情况</summary>

- 如果启动器以 `TRUST_STATE_INVALID` 或已存储根的错误拒绝，请同时把 `~/.delorun/trust` 移开，并再次执行第 4 步。home 随后只信任 npm 的启动器附带的密钥。
- 如果新的发布版本无法读取你的 chat，请把 `sessions/` 和 `storages/` 移开，放入 `data-copies/<version>/` 中的副本，并用 `delorun import` 带回单独导出的 chat。

</details>

<a id="protections-and-plugins"></a>

## 保护与插件

- **`the profile default would boot without protections Delorun requires`。**你的 profile 中的某项设置关闭了一项保护，例如沙箱或 Delorun 的某个防护措施。拒绝信息列出每一项及设置它的文件。请删除这些设置，或用 `delorun recover safe-mode` 在不带你的插件的情况下启动。
- **`the profile default could not load Delorun's bundle`** 或 **`plugins of Delorun's bundles did not start`。**Delorun 宁可停止也不在没有防护措施和隐私设置的情况下启动，因为否则 profile 会以 DeepSeek Harness 自己的默认值运行。拒绝信息指出每个包、原因和修复办法。
- **`the landlock sandbox cannot deny the sockets in "<directory>"`。**你的 Linux 系统没有可用的 bubblewrap，所以命令会在 Landlock 下运行，而 Landlock 无法隐藏你的登录会话的套接字，只要存在这样的目录，Delorun 就会拒绝每一条沙箱中的命令。如果拒绝信息说要安装 bubblewrap，请安装 `bubblewrap` 包并重新启动。如果它说 bubblewrap 的检查没有及时完成，说明 Delorun 启动时你的电脑很忙：请再次启动。如果它说 bubblewrap 已安装但无法创建沙箱，`delorun doctor` 会在它的 `sandbox` 行显示原因，或运行 `bwrap --ro-bind / / true` 查看原因；在 Ubuntu 上，通常的原因是它对用户命名空间的 AppArmor 限制（`kernel.apparmor_restrict_unprivileged_userns`），而[为 `bwrap` 编写的 profile](#letting-bubblewrap-run-under-ubuntus-apparmor-restriction) 可以仅对 `bwrap` 解除它。对整个系统关闭该限制也行得通，但会降低它对每个程序的保护。
- **`the sandbox row sets the runner itself`** 或 **`is configured with expressions`。**Delorun 在启动时把它的 home 保护添加到沙箱的设置中，所以这些设置必须把沙箱的选择留给 Delorun，并使用普通的 YAML 值。请删除拒绝信息所指出的内容。
- **`delorun headless: … asks for full access in "<folder>", which you have not granted full access`。**headless 任务要求在[沙箱](../../reference/glossary.zh.md#sandbox)之外、在你尚未设为[完全访问](../../reference/glossary.zh.md#full-access)的文件夹中运行，所以它没有启动。请在你的电脑上运行 `delorun workspace full-access <folder> on`，或在 studio 的“设置”→“安全”→“权限”中开启它，然后再次运行该任务。或者不带完全访问运行该任务。
- **`full access for the workspace "<folder>" needs one consent for that workspace first`。**模型试图在你尚未允许的[工作区](../../reference/glossary.zh.md#workspace)中把 chat 切换为完全访问。[同意](../../reference/glossary.zh.md#consent)是你在自己的电脑上给出的一个“是”。它仍停留在更安全的预设上。请用批准卡片的 **Allow for this chat**、在“设置”→“安全”→“权限”中，或用消息打印的 `delorun workspace full-access <folder> on` 命令来允许；见[完全访问](../safety-and-updates/safety.zh.md#full-access)。
- **“Approve this at your computer”。**你试图在手机上允许完全访问、[MCP 服务器](../../reference/glossary.zh.md#mcp-server)或另一项权限更改。这些回答只在运行 Delorun 的那台电脑上才被接受。请在那里操作；见[已批准的手机能做什么、不能做什么](../everyday-use/reach.zh.md#what-an-approved-phone-can-and-cannot-do)。
- **`This needs your confirmation: …`。**手机在没有确认的情况下回答了一个会授予某些权限的提示，例如完全访问或某个外部 agent。请再次回答，并在手机询问时用 Face ID 或你的 PIN 确认，或在你的电脑上回答（见[用 Face ID 确认](../everyday-use/reach.zh.md#confirm-with-face-id)）。
- **`The network setting could not be read, so every workspace's commands have no network`。**保存网络设置的文件已损坏或其他用户可以读取它。“设置”→“安全”→“网络”会指出问题。请修复或删除它所指的文件；在此之前这些工作区都视为 Off。
- **某条命令因为工作区网络是 Allowlist 或 Off 而被拒绝。**你的沙箱无法强制执行这些设置（只有 Linux 上的 bubblewrap 可以），所以 Delorun 拒绝该命令，而不是带着你的网络运行它。请在“设置”→“安全”→“网络”中把工作区设回 Open（见[网络设置](../safety-and-updates/safety.zh.md#the-network-setting)）。
- **`Delorun could not use the Docker engine`。**Docker 没有应答，或以拒绝信息所指的 HTTP 状态拒绝了请求。请启动 Docker 并再次运行命令。

<a id="letting-bubblewrap-run-under-ubuntus-apparmor-restriction"></a>

### 让 bubblewrap 在 Ubuntu 的 AppArmor 限制下运行

从 Ubuntu 23.10 起，AppArmor 禁止程序创建用户命名空间，除非有 profile 允许，并且 `kernel.apparmor_restrict_unprivileged_userns` 的值为 1。bubblewrap 需要它们，所以 `delorun doctor` 的 `sandbox` 行会失败，每条沙箱中的命令都会被拒绝。仅为 `bwrap` 编写的 profile 可以允许它们。请把下面的内容保存为 `/etc/apparmor.d/bwrap`，如果 `command -v bwrap` 打印的路径与 `/usr/bin/bwrap` 不同，则替换之：

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

用 `sudo apparmor_parser -r /etc/apparmor.d/bwrap` 加载它，检查 `bwrap --ro-bind / / true` 在没有错误的情况下退出，然后重新启动 Delorun。这样任何程序都可以通过 `bwrap` 创建用户命名空间，这正是该限制所要阻止的，但其他所有程序仍受限制。

<a id="remote-access-and-devices"></a>

## 远程访问与设备

| 代码 | 含义 | 该怎么做 |
| --- | --- | --- |
| `APPROVALS_UNAVAILABLE` | 正在运行的 Delorun 没有加载远程访问。 | 运行 `delorun reach on tailscale`，然后重启 Delorun。 |
| `LOOPBACK_REQUIRED` | 设备请求并非来自这台电脑上你自己的 `delorun`。 | 在这台电脑上用 `delorun devices approve` 批准设备。 |
| `APPROVAL_FAILED` | 批准或取消没有成功。 | 运行 `delorun devices approve`，并再次从设备上提出请求。 |
| `REMOVAL_FAILED` | 设备没有被移除。 | 检查 `delorun devices list`。 |
| `ELEVATION_FAILED` | 设备上的敏感操作没有解锁，或解锁没有结束。 | 运行 `delorun devices elevate` 并再次查看列表。 |
| `PIN_FAILED` | PIN 模式没有改变，例如因为 PIN 太弱。 | 选择至少 6 位且不是重复或连续数字的 PIN，或至少 10 个字符的口令。 |

这些条目来自你电脑上的 `delorun reach` 和 `delorun devices`。[用手机访问 studio](../everyday-use/reach.zh.md)说明了远程访问需要什么。

`delorun reach on tailscale` 和 `delorun reach off` 把 Tailscale 的问题打印为 `delorun reach: <what happened> (<CODE>)`，`reach on` 还会加上 “Remote access stays off.” 在这样的拒绝之后不会开启任何东西。

| 代码 | 消息开头 | 该怎么做 |
| --- | --- | --- |
| `TAILSCALE_NOT_INSTALLED` | “Tailscale is not installed on this computer.” | 从 tailscale.com/download 安装它，登录，然后再次运行命令。 |
| `TAILSCALE_NOT_LOGGED_IN` | “Tailscale is not running and signed in to a tailnet on this computer.” | 运行 `tailscale up`，登录，然后再次运行命令。同一个代码也报告其他 `tailscale serve` 失败；此时消息会以 “tailscale serve failed:” 开头，后面是 Tailscale 自己的话。 |
| `TAILSCALE_HTTPS_DISABLED` | “Your tailnet does not have HTTPS certificates turned on.” | 在 Tailscale 管理控制台的 DNS 页面中开启 HTTPS，然后再次运行命令。 |
| `TAILSCALE_SERVE_NOT_PERMITTED` | “Your user may not configure tailscale serve yet.” | 运行它打印的那一条命令 `sudo tailscale set --operator=$USER`，然后再次运行命令。Delorun 从不替你运行它。 |
| `TAILSCALE_FUNNEL_ON` | “Tailscale Funnel is on for …, which would put this studio on the public internet, so remote access stays off.” | 运行它打印的 `tailscale funnel --https=<port> off` 命令，然后再次运行 `delorun reach on tailscale`。 |
| `TAILSCALE_SERVE_CONFLICT` | “Tailscale still serves …” 或 “tailscale … failed (…), so Tailscale may still serve …” | 停止占用该端口的 `tailscale serve` 或 `tailscale funnel`，或运行消息打印的命令，然后再次运行命令。 |
| `TAILSCALE_ADDRESS_MISMATCH` | “The configured address … is not this machine's Tailscale address …” | 你电脑的 Tailscale 名称变了。请再次运行 `delorun reach on tailscale`。 |

以 “Delorun could not read or change what Tailscale serves for remote access” 开头的拒绝，在它的 `Why:` 行中携带同样的代码。

如果 `delorun reach on tailscale` 说 “the running Delorun did not make the address ready. Fix what the line above names, then run delorun reach on tailscale again”，请阅读它上面的那一行，修复它，然后再次运行命令。如果它说 “the running Delorun did not apply it” 或 “did not close its remote listener”，请用它打印的命令重启 Delorun。

这些消息来自 `delorun devices`：

- **`Delorun isn't running. Start it with: delorun start`。**`delorun devices approve` 和 `delorun devices elevate` 需要正在运行的 Delorun。请运行 `delorun start`，然后再次运行该命令。
- **`delorun devices: No device asked for approval before the window closed. Run delorun devices approve again`。**5 分钟内没有人提出请求。请再次运行命令，然后在手机上打开你的地址并选择 **Ask for approval**。
- **`That request is no longer waiting.`**请求自行结束了（它过期了，或在手机上被取消了）。命令会再次列出等待中的请求；请选择另一个，或再次从手机上提出请求。
- **`That code is not the one the device shows. Try again.`**你可以再次输入。第三次输错之后请求会被取消；请再次从手机上提出请求以获得新代码。
- **`Remote access is off for this profile, so a phone cannot reach your studio: turn it on with delorun reach on tailscale`。**`delorun devices approve` 在等待，但没有手机能连到你。请运行 `delorun reach on tailscale`。
- **`DEVICE_NOT_TRUSTED`，“This home does not trust that device on this address. Ask for approval at the home's computer”。**home 拒绝了来自一台它在这个地址上不信任的设备的登录：它被移除了，或它是为另一个地址批准的。请再次从手机上请求批准，并在你的电脑上批准它（见[批准设备](../everyday-use/reach.zh.md#approve-a-device)）。

<a id="what-a-phone-shows-when-it-cannot-sign-in"></a>

### 手机无法登录时显示什么

手机上的登录页面在标题中指出问题。

| 手机显示 | 该怎么做 |
| --- | --- |
| “Your computer isn’t ready yet” | 批准窗口已关闭。请在你的电脑上运行 `delorun devices approve`，或在“设置”→“设备”中选择 **Add a device**，然后选择 **Try again**。 |
| “Too many devices waiting” | 已有五台设备在等待。请在你的电脑上取消你不认识的设备，然后再次提出请求。 |
| “This code expired” | 代码有效期为 5 分钟。请选择 **Ask again**；如果批准已关闭，请先在你的电脑上重新打开批准。 |
| “Request cancelled” | 你的电脑取消了它，或代码输错了三次。请选择 **Ask again** 获取新代码。 |
| “Too many tries” | 等待一分钟，然后再试。 |
| “This device has too many sign-ins” | 请在你的电脑上的“设置”→“设备”中移除这台设备，并再次批准它。 |
| “Can’t reach your computer” | 检查手机在 Tailscale 应用中已连接，并且 Delorun 在你的电脑上运行（`delorun status`）。 |
| “This browser can’t sign in” | 请在最新的 Safari、Chrome、Edge 或 Firefox 中打开该页面，不要使用隐私窗口。 |
| “Something went wrong” 并带有 “Error code: …” | 选择 **Try again**。如果持续出现，请重启你电脑上的 Delorun，并把代码报告给 support@delorun.com。 |

当解锁请求失败时，手机会显示以下之一：“The code expired before your computer approved it.”（选择 **Try again**）、“Your computer declined the request, or it was cancelled there.”（如果你确实想解锁，请再次提出请求）、“Your computer can't be reached right now. Check that Delorun is running there.”，或 “Too many requests are waiting at your computer. Answer them there, then try again.”（在你的电脑上打开“设置”→“设备”，或运行 `delorun devices elevate`）。

<details>
<summary>边界情况</summary>

- 如果手机根本打不开该地址，那么请检查手机的 Tailscale 应用已连接，然后在你的电脑上运行 `delorun reach status`：它会显示地址是否已就绪。
- 如果已批准的手机在你更改 profile 或地址之后不再登录，那么它只为旧地址获得了批准：请再次批准它。
- 如果你误移除了一部手机，那么请再次批准它；其他东西都不会丢失。
- 如果在远程访问开启期间断电，那么如果你与他人共用电脑，请运行 `delorun reach off`（见[关闭远程访问](../everyday-use/reach.zh.md#turn-remote-access-off)）。

</details>

<a id="archives-imports-and-the-trash"></a>

## 归档、导入与回收站

- **“Delorun refused the archive and changed nothing.”**`delorun import` 在写入任何东西之前先检查归档；代码指出它拒绝的条目。
- **“Delorun stopped at the stock DeepSeek Harness home import.”**从 `~/.dsh` 的导入被拒绝，或启动时发现一个它无法移除的被中断的导入；代码和详情会说明是哪一种。[从 DeepSeek Harness 切换](../get-started/switching.zh.md)介绍了导入。
- **`TRASH_ITEM_NOT_FOUND`。**回收站中没有该 id 的项目；`delorun trash list` 显示它里面有什么。

<a id="the-workspace-list"></a>

## 工作区列表

Delorun 把你的[工作区](../../reference/glossary.zh.md#workspace)保存在一个文件中，即你的 home 里的 `storages/workspace.json`。损坏的文件从不会阻止 Delorun 启动。Delorun 会带着它能读取的每条工作区记录启动，把其余的移到旁边一个名为 `workspace.json.quarantined-<date and time>.json` 的文件中，写入清理后的列表，并记录一条指出该文件和每条记录的警告。`delorun doctor` 会列出被搁置的文件。Delorun 从不删除被搁置的文件。如果整个文件都无法读取，Delorun 会在没有任何工作区的情况下启动，并把整个文件搁置。你的文件夹和 chat 不会被触动。

在每次更改列表之前，Delorun 都会把之前良好的文件保留为 `workspace.json.previous`。

- **检查它。**`delorun doctor` 有一行 `workspaces`。它打开该文件而不改变它，对可读的列表打印 `pass`，当有记录将被搁置或之前已有记录被搁置时打印 `warn`，对无法读取的文件打印 `fail`，并指出损坏的记录和被搁置的文件。
- **带回之前的列表。**停止 Delorun（`delorun stop`），然后运行 `delorun recover workspaces`。它显示当前文件和之前的副本各包含什么，要求你确认（`--yes` 供脚本回答），把当前文件移到一边，并在原位写入之前的副本。它不删除任何东西，副本仍然保留。请在你自己的电脑上运行；Delorun 运行期间它不会运行。
- **用 studio 重命名。**agent 在你允许之后用它的 `rename_workspace` 工具重命名工作区，所以从不需要手工编辑该文件。如果你自己编辑 `workspace.json`，请先停止 Delorun。

<a id="when-nothing-here-fits"></a>

## 当这里没有你的情况时

运行 `delorun doctor`。它会检查 Docker、模型密钥的格式、你的 home、studio 的端口、沙箱（`sandbox` 一行）、工作区列表（`workspaces`）、profile 是否会在没有其保护的情况下运行（`dangerous-mode`）、发布日志检查、最近一次更新检查、最近一次从 DeepSeek Harness home 的导入（`import`）、你的更改以及你的 CLI profile 的插件，并为每一项打印一行。运行 `delorun logs home` 阅读正在运行的 Delorun 的最近记录；[Delorun 的日志存放在哪里](logs.zh.md)解释了每一份日志。

说 “Report this” 的拒绝，表示 Delorun 发现了它无法解释的东西。请连同拒绝信息的文本一起报告。

<a id="report-a-problem-that-is-not-listed"></a>

### 报告未列出的问题

在 studio 侧边栏底部或“设置”→“关于”中选择 **Report a problem**。它会打开一份简短的 GitHub issue 审阅，其中已填好你的 Delorun 版本、系统和最近的错误，并已去除密钥。你先阅读，然后在浏览器中打开或复制它；Delorun 自己不会发送任何东西。你也可以在 chat 里请助手“Help me report this”，它会起草一份 issue 供你发送。

手动报告时请包含：

- `delorun --version` 给出的版本；
- `delorun doctor` 的输出；
- 能重现问题的最少步骤；
- `delorun logs` 的相关行。请先阅读并去掉任何私密内容。

问题请发到 [GitHub Discussions](https://github.com/twickas/delorun/discussions)，缺陷请使用 [issue 模板](https://github.com/twickas/delorun/issues/new/choose)，或发送到 support@delorun.com。[SUPPORT.md](../../../../SUPPORT.md) 列出了各个途径。疑似漏洞只能私下报告，方式见 [SECURITY.md](../../../../SECURITY.md)。

<details>
<summary>进一步了解</summary>

- `delorun verify` 显示每一项发布版本和设置检查，`delorun recover status` 显示更新之后 profile 所处的状态（见[日常使用](../everyday-use/daily-use.zh.md#check-the-release-and-your-setup)）。
- `delorun logs --follow` 随着事情发生跟踪正在运行的 Delorun 的日志。
- `delorun start` 和其他命令接受 `--profile <name>`，以对 `default` 以外的 profile 操作。

</details>

<a id="remove-delorun"></a>

## 移除 Delorun

1. 如果你开启过手机访问，请运行 `delorun reach off`。它会移除把你的手机转发到 studio 的 Tailscale 规则。
2. 运行 `delorun stop`。
3. 移除 `delorun` 命令：`npm uninstall -g delorun`，如果你是那样安装的，则加上 `--prefix ~/.local`。
4. 只有在你不再需要自己的数据时，才删除你的 Delorun home，即 `~/.delorun` 或 `DELORUN_HOME` 所指的文件夹。

home 保存着你的 chat、工作区列表、设置、密钥、已批准的设备和已安装的 Delorun 发布版本。删除它会丢掉这一切且无法撤销；请先用 `delorun export` 保存你想留下的 chat（见[日常使用](../everyday-use/daily-use.zh.md#trash-export-and-import)）。你的工作区文件夹（包括 Documents 文件夹中的默认工作区 `Delorun/default-workspace`）以及 DeepSeek Harness 的 `~/.dsh` 都在它之外，会保留下来。如果你把 home 留在原处，再次安装 Delorun 时会从你停下的地方继续。

<a id="next"></a>

## 接下来

- 修复之后要检查你的设置，请运行 `delorun doctor`，然后运行 `delorun status`。
- 要了解 Delorun 保护什么，请阅读 [Delorun 保护什么](../safety-and-updates/safety.zh.md)。
- 要了解日志如何帮助你，请阅读 [Delorun 的日志存放在哪里](logs.zh.md)。
- 要设置远程访问，请阅读[用手机访问 studio](../everyday-use/reach.zh.md)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

每个代码都属于某个约定，该约定定义何时引发它：[home 布局约定](../../contracts/c01-home-layout.zh.md)涵盖 home 和安装，[home 进程约定](../../contracts/c19-home-process.zh.md)涵盖启动、更新和设备，[远程访问提供方约定](../../contracts/c07-reach-providers.zh.md)涵盖 Tailscale 代码，[更新报告约定](../../contracts/c03-update-report.zh.md)涵盖更新报告和回退。保护你的 profile 的那些代码列在 [profile-safety README](../../../packages/profile-safety/README.zh.md) 中。
