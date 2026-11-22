---
description: "Delorun 中的提示词注入与数据外泄：一次攻击需要的三个条件，工作区的网络设置（开放、允许列表、关闭）为沙箱中的命令和 web_fetch 关闭了什么，无论怎样设置仍然开放的途径，以及实用建议。"
---

# 提示词注入与数据外泄

[English](prompt-injection.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页帮助你决定每个工作区应当拥有多少网络访问，使模型读到的文字无法让它把你的私有数据送出去。你需要先让 Delorun 运行起来（见[安装与首次运行](../get-started/install.zh.md)），并至少有一个[工作区](../../reference/glossary.zh.md#workspace)。

模型读到的任何文字都可能携带指令：网页、仓库中的文件、issue、软件包的 README、工具的输出，或另一个 chat。这称为[提示词注入](../../reference/glossary.zh.md#prompt-injection)。模型无法可靠地区分这些指令和你的指令，Delorun 也不能。能把文字送到模型面前的攻击者，可以要求它找出私有数据，并发送到攻击者能读到的地方。Delorun 不会阻止模型读取这类文字。它让你拿走那条出路：每个工作区都有一个[网络设置](../../reference/glossary.zh.md#network-setting)，即**开放**、**允许列表**或**关闭**，用来限制它的命令和 `web_fetch` 能够访问的范围。本页说明每种设置关闭了什么、无论怎么选仍然开放的是什么，以及如何选择。

## 目录

- [三个条件](#the-three-ingredients)
- [网络设置](#the-network-setting)
- [每种设置关闭了什么](#what-each-setting-closes)
- [任何设置都关不上的途径](#what-no-setting-closes)
- [实用建议](#practical-advice)
- [更改设置](#changing-the-setting)
- [给想深入了解的人](#for-the-technically-curious)

<a id="the-three-ingredients"></a>

## 三个条件

用这种方式窃取数据，需要同时具备下面三个条件。去掉任何一个，攻击就会失败。

1. **模型能触及的私有数据。**工作区中的文件、`.env` 文件、命令能读取的你主目录下的密钥，以及 chat 自己的历史记录。在 Linux（包括 WSL2）上，[沙箱](../../reference/glossary.zh.md#sandbox)会让命令远离 Delorun 的 [home](../../reference/glossary.zh.md#home)（`~/.delorun`），但命令仍能读取你磁盘上其余你有权读取的内容。在沙箱无法强制限制读取的地方，例如 Delorun 0.1.0 不支持的原生 Windows，命令也能读取 Delorun 的 home。
2. **到达模型的不受信任的文字。**`web_fetch` 返回的网页、不是你写的文件、依赖项的源代码、issue 或 pull request、命令的输出，以及 [MCP 服务器](../../reference/glossary.zh.md#mcp-server)的回复。
3. **一条出路。**任何把数据放到攻击者能读到的地方的东西：向攻击者的服务器发请求的命令、对携带数据的网址执行的 `web_fetch`、发送数据的[插件](../../reference/glossary.zh.md#plugin)或 MCP 服务器，或者被放进你之后要分享的内容里的数据。

在真实工作中，前两个条件通常都存在。网络设置作用于第三个条件。

<a id="the-network-setting"></a>

## 网络设置

每个工作区有三种设置之一。你没有为其选择过的工作区使用默认值，除非你的配置另有规定，默认值为**开放**。

| 设置 | 沙箱中的命令 | `web_fetch` |
| --- | --- | --- |
| 开放 | 可访问任何主机，与 stock DeepSeek Harness 相同 | 可获取任何公共地址；[抓取防护](../../reference/glossary.zh.md#fetch-guard)会拒绝私有、回环和链路本地地址 |
| 允许列表 | 只能访问你列出的主机 | 只能获取主机在列表上的地址 |
| 关闭 | 无网络 | 被拒绝 |

该设置适用于模型在沙箱中运行的每一条命令，包括终端、后台任务和 `run_code` 程序，无论该 chat 使用哪种[权限预设](../../reference/glossary.zh.md#permission-preset)。在[完全访问](../../reference/glossary.zh.md#full-access)下运行的命令在沙箱之外运行，无论设置如何都能访问网络。

在允许列表下，命令只能通过 Delorun 运行的一个小型代理访问网络，该代理会对照你的列表检查每个主机。大多数工具无需额外帮助就能使用它：`curl`、通过 HTTPS 的 `git`、`npm`、`pip`、`cargo` 以及 Node 自带的 HTTP 客户端。忽略命令所获得的代理设置的工具完全没有网络。

一个条目可以是下列之一：

- 主机名，例如 `registry.npmjs.org`；
- 通配符，例如 `*.npmjs.org`，它匹配 `npmjs.org` 之下的每个名称，但不匹配 `npmjs.org` 本身；
- 公网 IP 地址。

一个条目允许 80 和 443 端口。要允许其他端口，请在冒号后写出，例如用于 Git over SSH 的 `github.com:22`；这样的条目只允许该端口。条目中没有 `https://`，也没有路径。避免对任何人都能发布网站的域名使用通配符，例如 `*.github.io`、`*.workers.dev`、`*.vercel.app` 或 `*.herokuapp.com`：它会放进由其他人控制的主机，因此命令可能把你的数据发送到攻击者在那里搭建的站点。请改为列出确切的主机。

代理会拒绝指向私有、回环或链路本地地址的已列出名称，所以列表中的名称无法被指向你的路由器或你电脑上的某项服务。每次拒绝都会以一句点名该主机的话返回给模型，并由 Delorun 记入日志。

Delorun 只在沙箱能做到的地方强制执行允许列表和关闭：Linux 上的 bubblewrap，其中包括 WSL2。在做不到的地方，设为允许列表或关闭的工作区会拒绝运行命令并说明原因，而不是用你的网络去运行它们。把它设回开放，命令就会再次运行。

<details>
<summary>边界情况</summary>

- 如果你的沙箱只有 Landlock（没有 bubblewrap 的 Linux 系统）或是 Linux 以外的任何平台，那么设为允许列表或关闭的工作区会拒绝运行命令：请把它设为开放以运行命令。
- 如果某条命令需要系统 D-Bus（例如 `systemctl`、`timedatectl` 或 `nmcli`）或要打印，那么它在设为允许列表或关闭的工作区中会失败：请对该工作区使用开放，或在你自己的终端中运行该命令。
- 如果某个工具忽略代理设置，那么它在允许列表下没有网络：请使用遵循 `HTTPS_PROXY` 的工具，或在开放下列出这些主机。
- 如果某条命令需要下载依赖项而工作区是关闭状态，那么它会失败：请先安装它们，或使用列有你的注册表的允许列表。
- 如果某个终端或后台任务在你收紧设置之前就已启动，那么它保留启动时拥有的网络：请重启该工作区的终端和任务。

</details>

<a id="what-each-setting-closes"></a>

## 每种设置关闭了什么

- **开放**什么也不关闭。命令可以把任何东西发送到任何地方。这是 stock DeepSeek Harness 的行为，也是 Delorun 的默认值。
- **允许列表**关闭命令和 `web_fetch` 自己打开的每一个连接，只有你列出的主机除外。仍然开放的，是这些主机所接受的东西。能访问 `github.com` 的命令，可以推送到你的 Git 凭据所允许的任何仓库，或在那里创建 issue。能访问某个软件包注册表的命令，可以用它找到的凭据向其发布。请只列出工作所需的最少主机。
- **关闭**关闭命令和 `web_fetch` 自己打开的每一个网络连接。需要下载依赖项的命令会失败。

这两种限制性设置都能挡住自己打开网络的命令。对于请求沙箱之外的另一个程序去打开网络的命令，它们只在沙箱隐藏了那个程序的范围内有效。在所有设置下，沙箱都会隐藏你的登录会话的服务；在允许列表和关闭下，还会隐藏域名解析、打印和系统服务。有些程序在你的主目录中监听，并为任何提出请求的人建立连接：你用 `ControlMaster` 打开的 ssh 连接，命令可以通过它访问那台服务器；或是在没有运行时目录的系统上，gpg 的 `dirmngr`，它会从密钥服务器获取密钥。请把允许列表和关闭理解为关闭了命令自己打开的途径，而不是所有途径。

<a id="what-no-setting-closes"></a>

## 任何设置都关不上的途径

该设置管辖沙箱中的命令和 `web_fetch`。下列途径在所有设置下都保持开放：

- **完全访问。**被批准在沙箱之外运行的命令，或处于完全访问的工作区，使用的是你的网络。
- **插件和 MCP 服务器。**它们在沙箱之外、用你的网络运行。如果模型可以带着你的数据调用某个获取网址或发布消息的 MCP 服务器，它就是一条出路。
- **模型编写的插件。**在 Web `cordis` 预设下，模型会编写插件并通过插件管理安装它们。它们在 harness 自己的进程中、沙箱之外、用你的网络运行。
- **Delorun 启动的 agent 和语言服务器。**Claude Code 和 ACP subagent 工具在沙箱之外启动它们的 agent 程序，语言服务器工具在沙箱之外启动语言服务器。在[外部 agent](../../reference/glossary.zh.md#external-agent) 运行之前，Delorun 会先询问你。
- **`web_search`。**在所有设置下，查询都会发往你的 profile 所配置的搜索提供方。它只到达该提供方，不会到达其他任何人。
- **模型的回复。**模型可以把数据放进它的回答。在你电脑上的 studio 中，回复所链接的图片会从其主机加载，所以图片的地址，以及写在其中的任何内容，都会到达那个主机。在通过远程访问使用的手机上，则显示为占位符。你点击的链接也以同样的方式发送它的地址。
- **你之后分享的文件。**模型可以把数据写入工作区中的文件、提交信息或 pull request 描述。当你推送、发布或发送它们时，数据就离开了。
- **模型提供方。**chat 中的一切都会发送给运行该模型的[提供方](../../reference/glossary.zh.md#provider)。模型就是这样工作的，任何设置都改变不了。

<a id="practical-advice"></a>

## 实用建议

- 不要把密钥放在工作区里。使用工作区之外的环境文件，以及模型永远不需要的密钥。
- 对于存放着密钥的工作区，或处理不是你写的代码、issue 或网页的工作区，请选择只列出工作所需主机的允许列表，或选择关闭。
- 在推送、发布或分享之前，先检查 chat 改动了什么。打开回复中的链接和图片之前先看清楚。
- 不要在会读取不受信任内容的工作区授予完全访问。
- 选择 MCP 服务器和插件时，要像选择任何一个以你自己的权限运行的程序那样谨慎。

下面是常见软件包注册表和 Git 主机的起始列表。在你把其中的主机添加到某个工作区的列表之前，列表中的任何一项都不被允许，而你添加的每个主机，都是命令可以向其发送数据的主机。

| 用途 | 主机 |
| --- | --- |
| npm | `registry.npmjs.org` |
| PyPI | `pypi.org`, `files.pythonhosted.org` |
| crates.io | `crates.io`, `index.crates.io`, `static.crates.io` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |
| GitHub | `github.com`, `codeload.github.com`, `objects.githubusercontent.com` |

<a id="changing-the-setting"></a>

## 更改设置

在运行 Delorun 的那台电脑上的 studio 中，打开“设置”→“安全”→“网络”，为每个工作区选择设置。成功后，工作区会显示你选择的设置。收紧会立即生效。让命令能访问更多内容的更改，例如从关闭改为开放，或在列表中加入新的主机或端口，会先要求你确认。

只有那台电脑能读取和更改该设置。通过远程访问使用的手机打不开它，模型也没有能更改它的工具。唯一的例外是模型在 `cordis` 预设下编写的插件，它以 harness 自己的权限运行。

<details>
<summary>边界情况</summary>

- 如果保存该设置的文件已损坏或其他用户可以读取它，那么每个工作区都视为关闭：请修复或删除“设置”→“安全”→“网络”所指出的那个文件。
- 如果你在 setup 中选择了 [**Ask less (like DeepSeek Harness)**](../../reference/glossary.zh.md#ask-less)，那么该页面会说明此设置不可用：请运行 `delorun setup prompts` 并选择 [Ask me first](../../reference/glossary.zh.md#ask-me-first)。
- 如果你在手机上，那么你打不开该页面：请使用运行 Delorun 的那台电脑。
- 如果你在命令运行时收紧设置，那么它们保留启动时拥有的网络：请重启该工作区的终端和任务。列表被移除的命令会失去它的代理，并且不再有网络。

</details>

<details>
<summary>进一步了解</summary>

- 允许列表编辑器中的**添加常用主机**会加入上面为 npm、PyPI、GitHub、crates.io 或 Go 列出的起始主机。检查列表后再保存。
- 在你的 profile 的 `cordis.yml` 中 `delorun-permission-defaults` 行里，为你没有选择过的工作区设置默认值（见[给想深入了解的人](#for-the-technically-curious)）。
- 阅读 [Delorun 保护什么](safety.zh.md)，了解与此并行的其他保护。

</details>

**接下来。**要一并查看所有保护，请阅读 [Delorun 保护什么](safety.zh.md)。如果某条命令被拒绝，请在[故障排查](../help/troubleshooting.zh.md#protections-and-plugins)中查找它的消息。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

对你没有选择过的工作区，默认值是你的 profile 的 `cordis.yml` 中 `delorun-permission-defaults` 行的 `network` 和 `allowedHosts` 设置，chat 中的插件管理无法更改它。代理会对每个列表限制它所持有的连接数，并关闭空闲连接；这两项限制都在该行中设置。

在允许列表下，代理会在做任何其他事情之前先检查主机名和端口，所以未列出的名称永远不会被查询，命令也无法通过 DNS 查询把数据送出去。它只连接它检查过的地址，并用它检查过的主机名发送纯 HTTP 请求。代理不会读取 HTTPS 连接的内部：它检查的是命令请求连接的名称，而不是加密连接内部的名称，所以在同一地址上托管许多站点的主机，例如内容分发网络，可能被请求一个不在你列表上的站点。通配符让命令可以请求代理查询该域名之下的任何名称，这会访问到该域名的 DNS 服务器。

命令的 `HTTP_PROXY`、`HTTPS_PROXY` 和 `ALL_PROXY` 变量指向代理。在允许列表和关闭下，沙箱会隐藏那些为程序查询名称或发送流量的服务的套接字：systemd-resolved、nscd、avahi、snapd、打印服务 CUPS、系统 D-Bus 和 Tailscale 的守护进程。如果保存该设置的文件已损坏或其他用户可以读取，每个工作区都视为关闭，受限的命令也无法读取或写入它。

[威胁模型](../../security/threat-model.zh.md)完整给出了各项防御及其局限，[执行途径](../../security/execution-vectors.zh.md)列出了在沙箱之外运行的途径。
