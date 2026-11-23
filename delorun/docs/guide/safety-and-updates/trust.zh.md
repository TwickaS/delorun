---
description: "你使用 Delorun 时信任什么：什么在你的电脑上运行，Delorun 项目能做什么、不能做什么，每个远程访问选项向其提供方展示什么，默认离开你机器的内容与仅在你选择时才离开的内容，以及如何自行核查。"
---

# 你使用 Delorun 时信任什么

[English](trust.md) | 中文

> 本页是英文页面的模型翻译。如有出入，以英文页面为准。

## 摘要

本页帮助你判断自己能接受什么。它逐方说明你使用 Delorun 时每一方能看到什么、能做什么，以及如何自行核查。你不需要任何前置知识，但在读过[安装与首次运行](../get-started/install.zh.md)之后读起来最顺。

Delorun 是预览版。它的发布版本使用预览密钥签名，尚未经过外部安全评审；[签名](#how-releases-are-signed-in-the-preview)和[评审](#outside-security-review)两节说明这意味着什么，以及何时会改变。Delorun 在你的电脑上、以你自己的身份运行。没有别人替你运行它，发布它的 Delorun 项目也无法进入你的 [studio](../../reference/glossary.zh.md#studio)。Delorun 没有遥测：它不发送任何关于你的信息。有两项让你的安装保持可信的小检查默认会访问互联网。其他一切只有在你开启时才会离开你的电脑。

## 目录

- [什么在你的电脑上运行](#what-runs-on-your-computer)
- [Delorun 项目能做什么、不能做什么](#what-the-delorun-project-can-and-cannot-do)
- [预览版中发布版本如何签名](#how-releases-are-signed-in-the-preview)
- [外部安全评审](#outside-security-review)
- [每个远程访问选项向其提供方展示什么](#what-each-reach-option-shows-its-provider)
- [什么会离开你的机器](#what-leaves-your-machine)
- [自行核查](#checking-it-yourself)
- [报告问题](#reporting-a-problem)
- [给想深入了解的人](#for-the-technically-curious)

<a id="what-runs-on-your-computer"></a>
## 什么在你的电脑上运行

- **Delorun 本身。** studio 及其[插件](../../reference/glossary.zh.md#plugin)以你的用户身份运行，拥有该用户的访问权限。你以自己身份运行的任何其他程序都能读取你的 [home](../../reference/glossary.zh.md#home)（即文件夹 `~/.delorun`）中的全部内容，Delorun 无法阻止这一点。
- **模型运行的命令。** 它们同样以你的访问权限运行，但处在[沙箱](../../reference/glossary.zh.md#sandbox)之内：沙箱是一组操作系统规则，限制命令能触及的范围。沙箱阻止命令写入 Delorun 的 home。在你的系统支持的情况下，它还阻止命令读取 Delorun 的密钥或访问 Docker。除已安装的版本、skill 和运行时之外，命令唯一能读取的 Delorun home 内容是你的 profile 中插件的已批准副本；它们无法修改这些副本。命令仍然可以使用其他本地服务和网络，除非你把工作区的[网络设置](../../reference/glossary.zh.md#network-setting)设为白名单或关闭（[提示词注入与数据外泄](prompt-injection.zh.md)）。[Delorun 保护什么](safety.zh.md#the-sandbox)列出了各系统上的规则；在 Linux 上，`delorun doctor` 会显示沙箱能否运行。
- **每个工作区**都直接在你的电脑上运行。Delorun 没有 Docker 工作区，也就是在容器中运行工作区命令的工作区（[路线图](../roadmap.zh.md)）。
- **插件**拥有与 Delorun 相同的完全访问权限。安装插件时，以及每次 Delorun 启动时，它都会检查该插件是否声明与你的版本兼容。安装之后，它不会再次检查插件的文件：如果你从 npm、git 或压缩包安装的插件在磁盘上发生变化，变化后的版本会在下次启动时加载。

<a id="what-the-delorun-project-can-and-cannot-do"></a>
## Delorun 项目能做什么、不能做什么

该项目发布 Delorun 的版本和本文档。它不发布插件索引，也不发布被撤销插件的列表（[路线图](../roadmap.zh.md)）。

该项目能够：

- 发布一个版本。你的安装只有在你确认更新后才会安装它，也绝不会自行回到更旧的版本；
- 对每个版本签名并将其记入公开日志，使任何人都能核查每个安装得到的是同一个版本。

该项目不能：

- 进入你的 studio。通过 Tailscale 的远程访问不使用该项目的任何东西，该项目不持有你 studio 的密钥，也不持有你设备的密钥；
- 替你批准设备、向你的电脑发送命令，或更改你已安装的插件；
- 停用或撤销你安装的插件；
- 为插件背书：它不审阅插件。

你仍然需要信任：

- 该项目的版本，以及提供这些版本的 `delorun.com` 地址；
- 你安装的每个插件，以及你安装它的来源；
- DeepSeek Harness 的代码，Delorun 在指定版本上运行它。

<a id="how-releases-are-signed-in-the-preview"></a>
## 预览版中发布版本如何签名

每个发布版本都有签名，`delorun update` 和 `delorun verify` 会在任何东西运行之前检查签名。在 `1.0.0` 之前，签名密钥是预览密钥：它们生成于维护者及其 agent 工作的那台电脑上，而不是专门为此保持离线的机器上，也没有其他人见证或备份过它们。那台电脑同时也是 agent 运行的地方。因此，任何人或任何 agent 一旦获得对它的访问权限，就能签出一个你的安装会接受的版本。公开发布日志仍会记录每个版本，所以这样签出的版本会让每个核查的人看到，但没有任何机制阻止它被签出。

在 `1.0.0` 之前，维护者也在同一台电脑上构建每个发布版本。没有第二个构建者重建它来核对发布的文件与源码是否一致，所以这个版本在一台机器上构建并签名，没有独立重建作保证。只要它是 0.x 版本，并且是在下表的预览根下签名的，你的安装就会接受这样的版本。若这样构建的版本是 `1.0.0` 版本，或是在更晚的根下签名的，你的安装会拒绝它。

这是预览版的主要限制，也是 README 称 Delorun 为预览版的原因。签名告诉你，一个版本来自持有预览密钥的人；发布日志告诉你，所有人拿到的是同一个版本。两者都不是离线密钥所提供的保护。到 `1.0.0`，密钥会在离线机器上的密钥仪式中生成；在那之前，维护者用第二因素手动发布每个版本，使 agent 能够使用的地方不存放任何长期有效的发布凭据。

这些版本所使用的发布根：

| | 值 |
| --- | --- |
| 发布根 1，`1.root.json` 的 SHA-256 | `e78c076567b1a2e104756409ad6f4a77c9b8caab95a3f38e857a94f82523b746` |
| 根密钥 id | `d8cb882168a05fe18b7139ad904de8634bcac2e8b3bebad3776b7efb008be734` |
| 目标密钥 id | `cd269895db6714d341b1fe23e6d290e42e141da44789d754f3729543fdc9d769` |
| 时间戳密钥 id | `df07a99c3eab87eb0428a3f17ac561cafc7f3bf13444a10a66885d342662a971` |
| 索引密钥 id | `cee603433150c5d96ac52e886af0e3d502a9910de3d4efb994d078ab2de5d446` |

<a id="outside-security-review"></a>
## 外部安全评审

Delorun 尚未经过外部安全评审。维护者自己的评审、移除保护就会失败的拒绝测试，以及回放录制会话的检查都是真实的，但它们是维护者及其 agent 自己的工作。外部评审是指不参与 Delorun 的人或机构阅读其对安全至关重要的代码，并报告发现。它随 `1.0.0` 一起到来，与密钥仪式同时进行，评审报告会公开发布。在那之前，请把 Delorun 当作预览版：不要依赖它去约束一个你原本就不信任的 agent（[Delorun 保护什么](safety.zh.md)）。

<a id="what-each-reach-option-shows-its-provider"></a>
## 每个远程访问选项向其提供方展示什么

[远程访问](../../reference/glossary.zh.md#reach)是指从另一台设备（例如你的手机）打开你的 studio。它在你开启前处于关闭状态，并且不使用 Delorun 项目的任何东西。Delorun 提供一个选项：你自己的 [tailnet](../../reference/glossary.zh.md#tailnet) 上的 Tailscale（[用手机访问 studio](../everyday-use/reach.zh.md)）。当 Tailscale Funnel（会把你的地址发布到互联网上）开启时，`delorun reach on tailscale` 会拒绝执行。

下表还描述了 Delorun 不提供的两个选项，方便你比较。[路线图](../roadmap.zh.md)提到一个由 Delorun 项目运行的中继；Delorun 不提供它，所以没有哪一行描述它。

| 远程访问选项 | 提供方能看到或做到什么 |
| --- | --- |
| 你的 tailnet 上的 Tailscale（可用） | 只有你 tailnet 中的设备能打开该地址。Tailscale 的协调服务能看到你电脑的名称、你的电脑与每台设备的 IP 地址、连接时间与流量大小。除非开启 Tailnet Lock，Tailscale 可以向你的 tailnet 添加设备。Tailscale 控制 `ts.net` 并为你的地址获取证书。 |
| Tailscale Funnel（不提供） | 互联网上任何人都能打开该地址。Tailscale 的 Funnel 服务器与协调服务能看到你电脑的名称、你的电脑与每台连接设备的 IP 地址、连接时间与流量大小。Funnel 把加密流量转交给你的电脑，由 Tailscale 的软件在那里解密。除非开启 Tailnet Lock，Tailscale 可以向你的 tailnet 添加设备，并为该地址获取证书。 |
| 你自己域名上的自托管中继（不提供） | 你的中继能看到该地址、你的电脑与每台设备的 IP 地址、连接时间与流量大小。它可以拒绝或断开连接。只要你域名的 DNS 仅允许你的电脑为其获取证书，且你的电脑自行应答证书挑战，它转交的就是它无法读取、只有你的电脑才能解密的加密流量。Let's Encrypt 与你的 DNS 提供方仍可能影响你域名的证书。 |

无论哪个选项，设备都只有在你于电脑上批准之后才能打开你的聊天。Delorun 也不提供通行密钥或自带登录提供方的登录方式。 A phone can still confirm a strong action with a passkey (Face ID), which confirms one action and does not sign the phone in ([Confirm with Face ID](../everyday-use/reach.zh.md#confirm-with-face-id)).

<details>
<summary>边界情况</summary>

- 如果 Tailscale Funnel 已开启，那么 `delorun reach on tailscale` 会拒绝执行——请用它打印的命令关闭 Funnel，然后再次运行。
- 如果在远程访问运行期间开启了 Funnel，那么 Delorun 会在一分钟内发现并停止提供该地址——请用 `delorun reach on tailscale` 拒绝时打印的命令关闭 Funnel。

</details>

<a id="what-leaves-your-machine"></a>
## 什么会离开你的机器

### 默认情况

默认会运行两项检查。它们不携带任何关于你的信息，但它们所访问的每个服务器都会看到你的 IP 地址和请求时间。

- **发布日志检查**，每次启动时进行。它向 Sigstore 的公开发布日志以及发布其状态的服务询问，你运行的版本是否就是该项目公开记录的那个版本。没有任何设置能关闭它。当无法访问日志时，Delorun 仍会启动，并向你发出警告。
- **更新检查**，每天一次。它从 releases.delorun.com 或备用主机获取 Delorun 已签名的发布文件，以查看是否有更新的版本（[更新](updates.zh.md#the-update-notice)）。可在设置 → 通用 → 更新中关闭，或使用 `delorun setup privacy`。

这些检查下载的每个文件都经签名验证，因此提供被篡改文件的服务器会导致检查失败。Delorun 不下载被撤销插件的列表，因为该项目不发布这样的列表。

### 仅在你选择时

`delorun setup --yes` 与 `--config` 从不开启远程访问或 DeepSeek 的会话日志上传。

- **DeepSeek 的会话日志上传**在你于设置 → 安全 → 隐私中开启之前保持关闭。开启后，每个发往 DeepSeek 官方 API 的请求还会携带你聊天日志中尚未发送的部分：你的消息、回复、带结果的工具调用、工作区路径和反馈。
- **分析。** DeepSeek Harness 自己的分析在预览版中已关闭。[profile](../../reference/glossary.zh.md#profile) `delorun` 运行时不收集任何数据，设置 → 隐私中也这样说明。Delorun 自己的可选遥测不属于预览版。
- **反馈。** `delorun` 所运行的 profile 没有反馈对话框，因此不会发送反馈。
- **模型请求**发往你设置的[模型提供方](../../reference/glossary.zh.md#provider)，携带每个回合中模型所接收的内容。
- **远程访问**按上表所述，向你选择的提供方发送流量。

<details>
<summary>边界情况</summary>

- 如果无法访问发布日志，那么 Delorun 会启动并显示警告——无需处理；它会在下次启动时再次检查。
- 如果你关闭了更新检查，那么你只有在运行 `delorun update` 时才会得知新版本——请时不时运行一下。

</details>

<a id="checking-it-yourself"></a>
## 自行核查

- **The Security panel.** The shield at the foot of the sidebar opens it. Five rows answer what the agent can do, whether you can undo a change, who can reach the studio, what you added and whether this copy of Delorun is genuine. Green means the protection is on and checked; amber marks something you chose or something that needs a look; red means a protection is off or failing, and the row says what to do. Advanced shows what each row checks and when. Shortly after Delorun starts, once no chat has been busy for a moment, it hashes every installed file through the launcher at low priority, and it stops if a chat starts working; until then this copy reads "Signature verified · checking files". It reads plugins and your changes again after you add, update, switch or remove a plugin.
- **`delorun verify`** 检查已安装的版本是否已签名、是否在公开发布日志中，以及其文件是否就是已签名的文件。它不检查隔离、暴露、登录、插件或数据共享：报告将其逐项列为 `not run`，并以 `this is not a full verification of this Delorun` 结尾。这些检查以你的身份运行，因此以你身份运行的程序可以篡改它们。
- **`delorun logs`** 显示每个日志、其位置与记录的内容（[Delorun 把日志放在哪里](../help/logs.zh.md)）。

<details>
<summary>进一步了解</summary>

- **核查启动器。** npm 在任何 Delorun 检查运行之前就提供 `delorun` [启动器](../../reference/glossary.zh.md#launcher)，因此请单独核查它。`delorun verify` 会打印一行 `Launcher`，给出已安装版本的签名清单为你所运行的启动器记录的完整性值。请将其与 `npm view delorun@<version> dist.integrity` 的输出比较。
- **比较发布根。** 该项目在本页和每个版本的说明中公布每个发布根文件的 SHA-256 及其密钥 id。请将它们与启动器包 `roots/` 目录下的根文件比较。
- Setup 按你所运行的版本安装 `delorun` 命令，从不安装 npm 提供的最新版本。

</details>

<a id="reporting-a-problem"></a>
## 报告问题

请按 [SECURITY.md](../../../../SECURITY.md) 所述私下报告疑似漏洞，不要公开提交 issue。其他问题请按 [CONTRIBUTING.zh.md](../../../../CONTRIBUTING.zh.md) 处理，或写信到 support@delorun.com。

**下一步。** 要了解保护措施本身，请阅读 [Delorun 保护什么](safety.zh.md)。要用手机访问你的 studio，请阅读[用手机访问 studio](../everyday-use/reach.zh.md)。如果出了问题，请在[故障排查](../help/troubleshooting.zh.md)中找到对应的信息。

<a id="for-the-technically-curious"></a>
## 给想深入了解的人

[威胁模型](../../security/threat-model.zh.md)列出每个边界、其防护，以及 Delorun 不防范的内容。[验证检查契约](../../contracts/c15-verification-checks.zh.md)定义了每项 `delorun verify` 检查，[远程访问提供方契约](../../contracts/c07-reach-providers.zh.md)定义了每个远程访问选项可以使用什么。
