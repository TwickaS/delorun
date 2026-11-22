---
description: "用 npx delorun 安装 Delorun，并从零开始进行第一次 chat：你需要什么，启动器在安装之前检查什么，按使用方式进行的 setup，studio 及其新手引导，默认工作区，以及在没有浏览器的机器上打开 studio。"
---

# 安装与首次运行

[English](install.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页带你从零开始，直到你的第一次 chat。你只需运行一条命令：`npx delorun`。它会下载 Delorun，检查下载内容是否真实可信，问你几个问题，并完成 Delorun 的设置。之后你用 `delorun` 启动它，它会在浏览器中打开。此后一切都运行在你自己的电脑上。你需要一台 Delorun 支持的电脑、安装和启动它所需的 Node.js，以及你想与之对话的 AI 模型的密钥。chat 需要密钥；不过没有密钥 studio 也能打开，所以你可以先四处看看。

Delorun 是一个可以按你自己的工作来塑造的 agent harness。它构建在 [DeepSeek Harness](../../reference/glossary.zh.md#stock) 之上，后者是一个开源程序，让 AI 模型能够处理文件并在你的电脑上运行命令。

## 目录

- [开始之前](#before-you-start)
- [安装](#install)
- [通过 WSL2 使用 Windows](#windows-through-wsl2)
- [启动器验证什么](#what-the-launcher-verifies)
- [Setup：你将如何使用 Delorun](#setup-how-you-will-use-delorun)
- [studio 与你的第一次 chat](#the-studio-and-your-first-chat)
- [默认工作区](#the-default-workspace)
- [没有浏览器的电脑](#a-computer-without-a-browser)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="before-you-start"></a>

## 开始之前

- **一台受支持的电脑。**x64 上的 Linux，或通过 WSL2 使用的 Windows（见[通过 WSL2 使用 Windows](#windows-through-wsl2)）。Delorun 不能在 ARM（arm64）上的 Linux、原生 Windows 或 macOS 上运行（见[路线图](../roadmap.zh.md)）。
- **[Node.js](https://nodejs.org) 24.9 或更新版本。**`delorun` 命令是一个 Node 程序，所以每次启动都需要 Node，而不只是安装时。用 `node --version` 检查。如果你没有 Node，或版本较旧，请使用 [nodejs.org](https://nodejs.org/en/download) 上的官方安装方式。Ubuntu 自带的 Node 软件包要旧得多（Ubuntu 24.04 提供的是 Node 18），所以 `apt` 给不了你可用的 Node。
- **bubblewrap（在 Linux 和 WSL2 中）。**它是限制 chat 所运行命令的程序。请用系统的包管理器安装 `bubblewrap` 软件包。没有它时，在有登录会话或正在运行 tmux 这类程序的电脑上，Delorun 会拒绝每一条命令，`delorun doctor` 会显示 `fail sandbox`（见 [Delorun 保护什么](../safety-and-updates/safety.zh.md#the-sandbox)）。
- **模型密钥。**密钥是让 Delorun 在你的账户下使用 AI 模型的秘密文本。运行模型的公司或服务器就是[模型提供方](../../reference/glossary.zh.md#provider)。默认是 DeepSeek API 密钥。其他提供方也可以使用（见[模型提供方](providers.zh.md)）。你可以在 setup 时跳过密钥，之后再添加。
- **git**，`delorun update` 在更新之前用它保存你的设置（见[更新](../safety-and-updates/updates.zh.md)）。首次运行的 setup 不需要它。

<a id="install"></a>

## 安装

在终端中运行：

```sh
npx delorun
```

更喜欢用别的包管理器？下面这些使用 Node 运行同一个启动器：

```sh
pnpm dlx delorun
bunx delorun
```

`npx` 在安装 `delorun` 包之前可能会先问 `Ok to proceed? (y)`。请按 **y** 和回车。第一次运行会下载并安装 Delorun（这是一个很大的下载），然后开始 setup。Delorun 会打印下面描述的各项检查，然后问出 setup 的第一个问题。此后每一次 `npx delorun` 都会启动已安装的 Delorun，不再下载任何东西。

在结束时，setup 会打印后续步骤。第一步是一行需要你自己运行的命令，`npm install -g delorun@<version>`，它会安装 `delorun` 命令。之后你就可以输入 `delorun` 而不是 `npx delorun`。

Delorun 把一切都保存在一个文件夹 `~/.delorun` 中，只有你能打开它（见[你的 Delorun home](../customising/home.zh.md)）。

<details>
<summary>边界情况</summary>

- 如果你运行的是 macOS，那么启动器会在下载任何东西之前停止，并说明 Delorun 不能在 macOS 上运行。请使用 Linux，或通过 WSL2 使用 Windows。
- 如果你运行的是原生 Windows，那么启动器会在下载任何东西之前停止，并说明 Delorun 在 WSL2 中运行。请按照[通过 WSL2 使用 Windows](#windows-through-wsl2) 操作。
- 如果你的电脑运行的是发布版本未列出的其他系统或处理器，那么启动器会以 `PLATFORM_NOT_RELEASED` 停止，且不安装任何东西。
- 如果你的 Node 低于 24.9，那么启动器会以 `Delorun needs Node 24.9 or newer to start` 停止，并指出你的版本。请从 [nodejs.org](https://nodejs.org/en/download) 安装较新的 Node，然后再次运行 `npx delorun`。
- 如果某项检查失败，那么不会安装任何东西（见[启动器验证什么](#what-the-launcher-verifies)）。请再次运行 `npx delorun`；如果仍然失败，请见[安装与发布检查](../help/troubleshooting.zh.md#installs-and-release-checks)。
- 如果 `npm install -g` 以 `EACCES`（权限被拒绝）停止，那么你的 Node 是为整个系统安装的，npm 没有 root 权限就无法写入那里。请改为安装到你自己的文件夹：`npm install -g --prefix ~/.local delorun@<version>`，并把 `~/.local/bin` 加入你的 `PATH`。
- 如果你没有网络，那么首次安装无法下载发布版本。一旦安装了某个发布版本，启动它就不需要网络。
- 如果你设置了 `DELORUN_HOME`，那么 home 会创建在那里，而不是 `~/.delorun`（见[你的 Delorun home](../customising/home.zh.md#where-the-home-is)）。

</details>

<details>
<summary>进一步了解</summary>

启动器在任何 `delorun` 参数之前接受它自己的选项：

| 选项 | 作用 |
| --- | --- |
| `--profile <name>` | 使用 `default` 以外的另一个 [profile](../../reference/glossary.zh.md#profile)（见[你的 Delorun home](../customising/home.zh.md#profiles)）。 |
| `--release <version>` | 在尚未安装任何发布版本时，安装这个发布版本，而不是渠道当前的发布版本。 |
| `--` | 结束启动器的选项。它之后的所有内容都交给 `delorun`。 |

</details>

<a id="windows-through-wsl2"></a>

## 通过 WSL2 使用 Windows

Delorun 在 Windows 中通过 WSL2 运行，WSL2 是 Windows 的一项功能，可在 Windows 旁边运行 Linux。它不能在 PowerShell 这类原生 Windows 终端中运行。

1. 安装带有默认 Ubuntu 的 WSL2：打开 PowerShell 并运行 `wsl --install`，如果它要求，则重启 Windows。
2. 从“开始”菜单打开 Ubuntu 应用。此后的一切都在那个终端中进行。
3. 在 Ubuntu 内部而不是 Windows 中安装 Node.js 24.9 或更新版本（见[开始之前](#before-you-start)）。
4. 在 Ubuntu 内部安装 bubblewrap，即 `bubblewrap` 软件包（见[开始之前](#before-you-start)）。
5. 在那里运行 `npx delorun`，并按照[安装](#install)操作。

请把你的项目放在 Ubuntu 的主目录里，例如 `~/projects`，因为 Windows 驱动器（`/mnt/c`）上的文件对 Linux 程序来说很慢。请在你的 Windows 浏览器中，用 Delorun 打印的地址打开 studio。

<a id="what-the-launcher-verifies"></a>

## 启动器验证什么

在安装任何东西之前，启动器会证明下载的内容就是维护者发布的那个发布版本。它会打印每项检查：

```text
Resolving the release: the stable channel names 0.1.0-preview.2.1.
Checking the signature: 0.1.0-preview.2.1 is signed under release root 1.
Checking the release log: verified.
Downloading delorun-0.1.0-preview.2.1-linux-x64.tar.gz (…).
Installing release 0.1.0-preview.2.1.
```

- **渠道。**预览版发布在名为 `stable` 的渠道上，所以第一行这样写。
- **签名。**Delorun 的发布密钥为发布版本签名。启动器检查这些签名以及下载的文件是否与之吻合。如果有任何不吻合，就不会安装任何东西。
- **在一台机器上构建。**在 `1.0.0` 之前，维护者在维护者的电脑上构建并签署每个发布版本，没有第二个构建者重建它。当这样的 0.x 版本在预览根下验证通过时，启动器会安装它。若这样构建的版本是 `1.0.0` 版本，或是在更晚的根下签名的，启动器会拒绝它（[你信任什么](../safety-and-updates/trust.zh.md#how-releases-are-signed-in-the-preview)）。
- **公开发布日志。**每个发布版本还会被记入一份公开的、仅追加的[发布日志](../../reference/glossary.zh.md#release-log)。启动器会检查这个条目。如果无法访问日志，启动器只凭签名安装该发布版本，打印一条警告，并在下次能够访问日志的启动时再次检查日志。
- **每次启动。**启动器会把已安装的文件与已签名的列表比较。已安装发布版本的启动不需要网络。

你可以随时用 `delorun verify` 再次运行这些检查（见[日常使用](../everyday-use/daily-use.zh.md#check-the-release-and-your-setup)）。[你使用 Delorun 时信任什么](../safety-and-updates/trust.zh.md)说明了你仍然依赖什么。启动器从 releases.delorun.com 安装，以 GitHub Releases 和 Delorun 的一个备用主机作为后备，不使用其他任何主机。它不检查发布版本的 SBOM，npm 包也不带构建证明。

<details>
<summary>边界情况</summary>

- 如果日志与发布版本相矛盾，那么安装会停止。不要绕过它；请见[安装与发布检查](../help/troubleshooting.zh.md#installs-and-release-checks)。
- 如果你想在每次启动时进行更严格的完整文件检查，请把 `DELORUN_RUNTIME_FULL_CHECK_DAYS` 设为 `0`。默认至少每 7 天对每个文件计算一次哈希；最大值是 30。

</details>

<a id="setup-how-you-will-use-delorun"></a>

## Setup：你将如何使用 Delorun

在新的 home 上第一次运行 `delorun` 会执行 setup。它每次问一个问题，第一个问题之后的每个问题都提供 **← Back**。在你于最后一个界面选择 **Save and set up** 之前不会写入任何东西；在那里选择 **Cancel** 也不会写入任何东西。

第一个问题询问你将如何使用 Delorun。它的答案设定默认值，并决定接下来问哪些问题。每个选项都会显示它做什么、适合谁，以及之后如何更改，推荐的选项会有标记：

```text
How will you use Delorun?
● Just me, on this computer (recommended)
○ Also from my phone or another device
○ For scripts and automation
```

如果你不确定，请选第一个。大多数人接下来回答三个问题：模型提供方、它的密钥，以及 Delorun 询问的频繁程度。

| 你的选择 | Delorun 的运行方式 | setup 还会询问 |
| --- | --- | --- |
| **Just me, on this computer** | 在后台运行，并在这台电脑的浏览器中打开。这台电脑之外的任何东西都无法访问它。 | 没有更多问题。 |
| **Also from my phone or another device** | 同上，另外在你自己的 [Tailscale 网络](../../reference/glossary.zh.md#tailnet)上有一个私有地址。你在这里用代码批准的设备可以阅读和回复 chat。 | 是否通过 Tailscale 从你的手机打开 Delorun（见[用手机访问 studio](../everyday-use/reach.zh.md)）。 |
| **For scripts and automation** | 没有 studio。你在脚本或 CI 中运行 `delorun headless "task"`，把密钥放在 `DEEPSEEK_API_KEY` 之类的环境变量中。 | 既不询问导入问题，也不询问后台问题。 |

然后每个选项都会按以下顺序询问这些问题：

1. **隐私。**这是一条说明，不是问题。它说明 Delorun 自己没有[遥测](../../reference/glossary.zh.md#telemetry)，除非你开启，否则 DeepSeek Harness 的桌面分析和 DeepSeek 的会话日志上传都是关闭的，并且 Delorun 每天检查一次是否有更新的发布版本，不发送任何关于你的安装的信息。这条说明以此结尾：`Delorun checks for new releases once a day. To turn that off before Delorun first starts, choose More settings on the last screen, or run delorun setup privacy later.`
2. **导入。**仅当你以前用过 DeepSeek Harness 且这个 Delorun home 没有 chat 时：`Copy your DeepSeek Harness chats, attachments and workspace list? Your DeepSeek Harness folder is only read. You can also do this later with delorun import-home.` 答案默认为 No（见[从 DeepSeek Harness 切换](switching.zh.md)）。自动化选项从不询问它。
3. **模型提供方。**`Which model provider should Delorun use?` 列出 **DeepSeek (recommended)**、**More providers**（Anthropic、OpenAI、Google Gemini 等，或任何支持 OpenAI API 的服务器）和 **Choose later**。
4. **模型密钥。**这个问题会指出提供方创建 [API 密钥](../../reference/glossary.zh.md#api-key)的页面，然后询问 `How should Delorun get the DeepSeek API key?` 你可以**立即粘贴**（标为推荐），Delorun 会把它存放在你的 Delorun 文件夹中，只有你能读取；也可以**使用 `DEEPSEEK_API_KEY`**，Delorun 每次启动时都会读取它。环境变量是你的终端传递给它所启动程序的有名字的设置。如果你选择了变量而它在这个终端中没有设置，setup 会立即说明，并告诉你如何设置。setup 用一次发往提供方的请求来检查手工输入的密钥（见[模型提供方](providers.zh.md)）。
5. **提示。**`How much should Delorun ask before it changes things?` 这就是[提示回答](../../reference/glossary.zh.md#prompts-answer)。它有三个选项：

   ```text
   ● Ask me first (recommended)
   ○ Ask less (like DeepSeek Harness)
   ○ Never ask (dangerous)
   ```

   **Ask me first** 会在 chat 获得对某个文件夹的完全访问、添加工具服务器、编辑自己的指令或安排工作之前询问，你可以逐一允许一次。**Ask less (like DeepSeek Harness)** 的行为与 DeepSeek Harness 相同：问题很少，命令仍在[沙箱](../../reference/glossary.zh.md#sandbox)中运行（见 [Delorun 保护什么](../safety-and-updates/safety.zh.md#consents)）。**Never ask (dangerous)** 让任何 chat 无需询问就能切换为完全访问；它会打印一条警告，要求你确认两次并输入 `full access everywhere`（见[同意](../safety-and-updates/safety.zh.md#consents)）。它始终列在最后。

然后一个审阅界面会列出每个答案，例如对第一个选项：

```text
How you use Delorun: just me, on this computer
Release check: on, once a day
Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start.
Prompts: Ask me first
Keep running in the background: yes
Remote access: off
Changes protection: unchanged
Setup name: default, studio port 3080

Nothing is saved until you choose Save and set up.
```

你应该会看到 `Save these answers and set up Delorun?`，以及 **Save and set up**、**More settings**、**Cancel** 和 **← Back**。请选择 **Save and set up**。

然后 setup 会写入你的答案，打印后续步骤，并且不启动任何东西：

```text
Delorun is set up. Nothing is running yet.

Next:
  1. Install the delorun command, which npx does not keep:
     npm install -g delorun@0.1.0-preview.2.1
  2. Set DEEPSEEK_API_KEY in your terminal, then run delorun stop and delorun start if Delorun is running. It is the DeepSeek key you chose.
  3. Start Delorun and open the studio: delorun
     Send a first message in a new chat. The install guide's section on your first chat walks through it: https://docs.delorun.com/guide/get-started/install#the-studio-and-your-first-chat

Change an answer later: delorun setup <section> (delorun setup --list shows the sections).
If something looks wrong: delorun doctor.
```

安装步骤只在由启动器启动 setup 时出现，密钥步骤只在你选择的密钥变量尚未设置时出现。各步骤因选项而异。手机选项会加上 `Add your phone or another device: delorun devices approve, then type the code it shows.`，或者在远程访问关闭时加上 `Remote access is off. To turn it on later, install Tailscale and sign in, then run delorun reach on tailscale.` 自动化选项把第 2 步替换为 `Run a task from a script or CI: delorun headless "your task"`，并加上 `To use the studio as well, start it any time with delorun.`

<details>
<summary>边界情况</summary>

- 如果你选择 **Choose later**，那么不会设置任何提供方，chat 暂时无法回答。setup 会这样说明。新 chat 从 DeepSeek 的 `deepseek-flash` 开始，它从 `DEEPSEEK_API_KEY` 读取密钥。之后可以用 `delorun setup key` 或在 studio 的“设置”、“Agent”、“模型”中添加提供方。
- 如果提供方拒绝你的密钥，那么除非你选择 **Continue without a successful check**，否则 setup 不会存储它。审阅界面随后会说明密钥未经验证。
- 如果启动器是为另一个发布渠道（例如本地渠道）构建的，那么它不在 npm 注册表中，所以安装步骤会说明改为安装它所来自的包文件，即 `npm install -g ./delorun-<version>.tgz`；并且更新检查的声明会指出该渠道的主机，而不是 releases.delorun.com 和 GitHub。
- 如果你在任何问题上按 Ctrl-C，那么 setup 会打印 `Setup cancelled. Nothing was saved. Run delorun to start again.` 并以退出码 130 退出。在保存之前关闭终端同样不会写入任何东西。
- 如果你在危险模式确认处选择 **← Back**，那么你会回到提示问题。
- 如果你没有选择“更多设置”，而 3080 端口已被另一个程序占用，那么 setup 不会询问端口，启动会失败。`delorun start` 会打印 `Delorun did not start. Delorun stopped with exit code 1 before it was running.`，然后是 `Run delorun logs to see why, then delorun doctor to check your setup.` `delorun doctor` 会显示 `fail port` 和修复办法。请运行 `delorun setup profile` 选择另一个端口，然后运行 `delorun start`。
- 如果 `~/.dsh` 不存在，或你的 Delorun home 已经有 chat，那么导入问题会被跳过。
- 如果 setup 在没有终端的情况下运行，那么它无法提问；请使用 `delorun setup --yes` 或 `--config`（见下面的“进一步了解”）。
- 如果你运行 setup 时带有 `--yes` 而没有 `--provider`，那么它不设置任何模型提供方，并打印如何添加。运行 `delorun headless` 的脚本需要在自己的环境中设置密钥变量，因为 setup 从不存储它没有询问过的密钥。
- 如果你以 root 用户运行 setup，那么 **Never ask (dangerous)** 会被拒绝，问题、`--prompts dangerous` 和答案文档都是如此。
- 如果你选择在终端中运行（在“更多设置”下后台选 No），那么关闭终端会停止 Delorun。

</details>

<details>
<summary>进一步了解</summary>

- 审阅界面上的 **More settings** 会询问其余的问题：是否检查新的发布版本（默认为 Yes）、Delorun 是否在后台持续运行、远程访问，以及 [profile](../../reference/glossary.zh.md#profile) 名称和 studio 的端口（默认 3080）。端口被占用时 setup 会说明并再次询问。用另一个 profile 名称运行 setup，可以并排拥有多套设置（见[你的 Delorun home](../customising/home.zh.md#profiles)）。
- 想改变主意，请再次运行 `delorun setup`。在终端中对已完成的 setup，它会说明它将做什么，然后用你当前的选择作为选中项，再次询问每个问题。你保存的密钥会保留：密钥问题首先提供 **Keep the saved key**，并且从不显示它。审阅界面会标出你改变的答案，只有这些答案会被写入；其余的会被报告为保持不变。开启危险模式会再次要求两次确认。保持原样则不再询问任何东西。带有 `--yes` 或 `--config` 时，已完成的 setup 保持不变。
- 之后可以用 `delorun setup <section>` 更改单个答案。`delorun setup --list` 列出各个部分：`privacy`、`import`、`key`、`prompts`、`background`、`reach` 和 `profile`。
- 对于脚本，`delorun setup --yes --provider deepseek-official` 从 `DEEPSEEK_API_KEY` 读取密钥。没有 `--provider` 时，`--yes` 接受其他默认值且不设置任何模型提供方；之后可以用 `delorun setup key` 添加一家。`delorun setup --config <file>` 从一个包含完整答案文档的 JSON 文件读取每个答案。只含 `useCase` 的文件会被拒绝。两种形式都不会开启远程访问或导入 `~/.dsh`，也都不会启动 Delorun：之后请运行 `delorun`。`--check-key` 检查来自环境的密钥（见[模型提供方](providers.zh.md#set-up-without-questions)）。
- 一个从 `DEEPSEEK_API_KEY` 读取密钥的完整答案文档如下所示。[答案 schema](../../contracts/c11-setup-answers.zh.md#answer-schema)解释了每个字段。

  ```json setup-answers-example
  {
    "schemaVersion": 5,
    "useCase": "local",
    "modelProvider": { "id": "deepseek-official", "credential": { "source": "environment", "name": "DEEPSEEK_API_KEY" }, "baseURL": null, "model": null },
    "prompts": "safer",
    "background": true,
    "profile": { "name": null, "port": null },
    "reach": { "option": "none", "identityFactor": null },
    "importStockHome": false,
    "protectChanges": false,
    "updateCheck": true,
    "sections": []
  }
  ```

</details>

<a id="the-studio-and-your-first-chat"></a>

## studio 与你的第一次 chat

setup 之后运行 `delorun`。它会启动 Delorun 并在浏览器中打开 studio。[studio](../../reference/glossary.zh.md#studio) 是 Delorun 用来与模型聊天的网页。它会打印 studio 的位置，以及查看和停止它的命令：

```text
Delorun is running in the background for the profile default at http://127.0.0.1:3080/; it keeps running after this terminal closes.
See it with delorun status, follow its log with delorun logs --follow, and stop it with delorun stop.
Run delorun open to open the studio in your browser.
Opened the studio in your browser.
```

studio 监听 `127.0.0.1`，只有你自己的电脑才能访问，除非你开启了[远程访问](../everyday-use/reach.zh.md)。浏览器通过一个只能用一次、一分钟后过期的链接登录。`delorun open` 会用新的链接再次打开 studio。

第一次使用时，studio 会逐步显示一个简短的新手引导，以一次 chat 结束：

![新 home 上 studio 的首次运行向导：欢迎步骤，列出语言选项和预发布说明，背后是空的 chat 列表。](../pictures/first-run-guide.webp)

1. **Welcome。**选择语言。一条预览版通知会说明 Delorun 是 DeepSeek Harness 的社区分支，仍处于预览阶段；选择 Continue 表示你已知晓。
2. **Models。**勾选你使用的模型提供方。对每一家，粘贴它的密钥并选择 **Connect**，或选择 **Skip**。Delorun 已经拥有的密钥会显示为 “Key found”，并注明它的来源（例如“From DEEPSEEK_API_KEY in the environment Delorun started with”）和一条 “How does Delorun know?” 说明。这时没有密钥输入框：选择 **Next** 使用它，或选择 **Replace key** 输入另一个。随后一份摘要会列出已设置的内容。
3. **Look。**选择颜色和主题。选项下方的一个链接会打开一个界面，说明原版 DeepSeek Harness 外观会关闭什么、保留什么；如果你确认，切换会在你完成引导时发生。
4. **Agents。**可选地添加 Claude Code 或 Codex，作为 chat 可以把工作交给的助手。
5. **Recommended plugins。**可选地添加[插件](../../reference/glossary.zh.md#plugin)，这些小型附加组件让 Delorun 拥有更多工具。
6. **Phone access。**在远程访问尚未设置时显示。它列出 Tailscale 还需要什么，并提供 **Not now** 或 **I've done this**。
7. **PIN。**只在运行 Delorun 的那台电脑上的 studio 中显示，并且要在手机访问已开启之后。选择一个 PIN 或口令，输入两次，然后选择 **Set PIN**；或选择 **Skip**，让 PIN 模式保持关闭。如果 PIN 模式已经开启，这一步会这样说明，并链接到“设置”。
8. **Workspace。**为你的第一次 chat 选择[工作区](../../reference/glossary.zh.md#workspace)：默认的那个、你电脑上的一个文件夹，或要克隆的 git 地址。
9. **Ready。**选择 **Start a chat**。

大多数步骤都有 Back、Continue 和 **Skip**，Skip 只会跳过那一步；Models 步骤在你逐个处理提供方时有 **Connect** 和 **Next**，Phone access 步骤有它自己的两个按钮。步骤名称旁边的 **Finish later** 会关闭引导并保留你的位置，下次引导会再次显示。要重新走一遍这些步骤，请选择“设置”、“通用”、“Getting started”、**Run setup again**。每一步都从你当前的选择开始，例如“设置”中保存的模式和主题，只有当你更改时选择才会改变。在手机上，Phone access 步骤会说明 Tailscale 是在运行 Delorun 的那台电脑上设置的。

新 chat 以某个 agent [预设](../../reference/glossary.zh.md#preset)开始，studio 把它们称为模式：Standard、PTC、Minimal 和 Creator。PTC 具备 Standard 的全部能力，适合批量调用工具、再对结果进行筛选、去重或汇总的任务。在 Creator 模式中，agent 与你一起编写插件和预设。输入一条消息即可聊天。如果你没有设置提供方或密钥，模型就无法回答；请在“设置”、“Agent”、“模型”中添加。

<details>
<summary>边界情况</summary>

- 如果浏览器没有打开，那么请运行 `delorun open`，或运行 `delorun open --print` 并自己打开打印出的链接。
- 如果链接显示已过期，那么请再次运行 `delorun open`。每个链接只能在一分钟内使用一次。
- 如果浏览器在 studio 地址显示 “unauthorized”（HTTP 401），那么你是在没有登录链接的情况下打开的地址。请运行 `delorun open`。 <!-- us-spelling: quoted output -->
- 如果 `delorun status` 显示 `state: not running`，那么请用 `delorun start` 启动它；如果启动失败，请阅读 `delorun logs` 和[启动与停止](../help/troubleshooting.zh.md#starting-and-stopping)。
- 如果你的密钥没有设置，那么 `delorun doctor` 会显示一行以 `!` 开头的 `key`，chat 会报告模型无法回答。请用 `delorun setup key` 修复。

</details>

<details>
<summary>进一步了解</summary>

- 用手机打开 studio：[用手机访问 studio](../everyday-use/reach.zh.md)。
- 查看一次 chat 的花费：[查看一次 chat 的花费](../everyday-use/cost-meter.zh.md)。
- 用插件、预设和 skill 重塑 Delorun：[什么该在哪里定制](../customising/customise.zh.md)。

</details>

<a id="the-default-workspace"></a>

## 默认工作区

chat 在工作区中工作：这是你电脑上的一个文件夹，模型可以读取和更改其中的文件。Delorun 的默认工作区是你“文档”文件夹中的 `Delorun/default-workspace`，如果你的系统没有“文档”文件夹，则在你的用户主目录中。studio 在第一次使用时创建它。请在 studio 中添加你自己的项目文件夹。

<details>
<summary>边界情况</summary>

- 如果所有候选文件夹都不能使用，例如因为其中一个位于你的 Delorun home 之内，那么启动会以 `delorun: Delorun found no folder for the default workspace.` 停止，并列出每个文件夹及其原因。请像消息所示那样，在你的 profile 的 `cordis.patch.yml` 中指定一个文件夹（见[启动与停止](../help/troubleshooting.zh.md#starting-and-stopping)）。
- 如果你不想使用默认工作区，那么请在新手引导的 Workspace 步骤中选择另一个文件夹。

</details>

<a id="a-computer-without-a-browser"></a>

## 没有浏览器的电脑

在服务器上或通过 SSH 时，Delorun 无法打开浏览器。请从你自己的电脑转发 studio 的端口，然后向 Delorun 索取一个链接：

```sh
# on your own computer
ssh -L 3080:127.0.0.1:3080 you@server
# on the server, in that SSH session
delorun open --print
```

`delorun open --print` 会打印一个链接，然后是 `This link signs in to the studio once, within one minute; run delorun open --print again for another.` 请在你自己电脑上的浏览器中打开该链接。你应该会看到 studio。

<details>
<summary>边界情况</summary>

- 如果你的转发使用另一个本地端口，那么链接必须指明它：`delorun open --print --port <that port>`。链接只在它所指明的主机和端口上登录。
- 如果 studio 使用的端口不是 3080，那么请转发那个端口；`delorun status` 会打印地址。

</details>

<a id="next"></a>

## 接下来

- 每天使用 Delorun：[日常使用](../everyday-use/daily-use.zh.md)。
- 选择或更换模型提供方：[模型提供方](providers.zh.md)。
- 从 DeepSeek Harness 迁移而来：[从 DeepSeek Harness 切换](switching.zh.md)。
- 了解哪些东西受到保护：[Delorun 保护什么](../safety-and-updates/safety.zh.md)。
- 如果出了问题：[故障排查](../help/troubleshooting.zh.md)。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[发布 manifest 约定](../../contracts/c02-release-manifest.zh.md)和[发布日志约定](../../contracts/c18-release-log.zh.md)定义了启动器所做的每项签名和日志检查。[setup 答案约定](../../contracts/c11-setup-answers.zh.md)定义了每个 setup 问题及其写入的内容。[首次运行设计](../../design/first-run.zh.md)解释了 setup 为什么这样提问。
