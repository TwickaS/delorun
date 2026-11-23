---
description: "用平实的语言说明 Delorun 保护什么、不保护什么：保护措施适用于哪里，各平台上的沙箱，完全访问，同意与提示设置，网络设置，web_fetch 防护，发布检查，以及已声明的局限，并附威胁模型的链接。"
---

# Delorun 保护什么

[English](safety.md) | 中文

> 英文页面是当前版本；本页可能落后于它。

## 摘要

本页帮助你理解是什么在阻止模型对你的电脑造成损害，以及如何放宽或收紧每一项保护。你需要先安装并运行 Delorun（见[安装与首次运行](../get-started/install.zh.md)）。你不需要改动任何东西就能受到保护。

Delorun 在你的电脑上、以你自己的权限运行。替你运行命令的 agent 在出错时，或在它读到的文字指示它这样做时，可能造成真正的损害。Delorun 保留了 DeepSeek Harness 的批准和沙箱，并在此基础上增加了更多保护：模型运行的命令无法触及 Delorun 自己的 [home](../../reference/glossary.zh.md#home)，有风险的更改会先征求你的[同意](../../reference/glossary.zh.md#consent)，每个工作区都可以限制自己的[网络设置](../../reference/glossary.zh.md#network-setting)，`web_fetch` 不会访问你的本地网络，发布版本在运行之前会先经过检查。

有四个词会反复出现。[工作区](../../reference/glossary.zh.md#workspace)是你允许模型在其中工作的文件夹。[chat](../../reference/glossary.zh.md#chat) 是与模型的一次对话，它属于一个工作区。命令是模型在 chat 中替你运行的程序，例如 `git` 或 `npm`。[沙箱](../../reference/glossary.zh.md#sandbox)是一组操作系统规则，用来限制这些命令可以触及什么。

## 目录

- [保护措施适用于哪里](#where-the-protections-apply)
- [沙箱](#the-sandbox)
- [完全访问](#full-access)
- [同意](#consents)
- [网络设置](#the-network-setting)
- [web_fetch 防护](#the-web_fetch-guard)
- [发布检查](#release-checks)
- [Delorun 不防护什么](#what-delorun-does-not-protect-against)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="where-the-protections-apply"></a>

## 保护措施适用于哪里

- **`delorun` 启动的 [studio](../../reference/glossary.zh.md#studio)** 具备本页的每一项保护。
- **`delorun headless`** 回答一个任务然后退出，它具备沙箱保护、防护措施和同意。本该询问你的同意会改为拒绝，因为没有人在场回答。
- **`delorun plugin`** 一项都不具备。它以你的身份运行 DeepSeek Harness 的插件安装器。
- **DeepSeek Harness 的桌面应用**是上游的，保持不变。Delorun 的任何保护都不适用于它。

Delorun 不会启动其设置关闭了某项保护的 [profile](../../reference/glossary.zh.md#profile)。它会指出该设置和文件，你可以按[故障排查](../help/troubleshooting.zh.md#protections-and-plugins)来修复。

<a id="the-sandbox"></a>

## 沙箱

沙箱限制模型运行的命令。chat 在三个权限级别之一下工作，你在 chat 的权限控件中选择：**Read Only**，命令只能查看、不能更改任何东西；**Workspace Write**，每个新工作区都从这里开始；以及 **Full access**，在沙箱之外运行命令（见[完全访问](#full-access)）。在处于 Workspace Write 的工作区中，命令只能写入工作区和获许的临时文件夹。Delorun 增加了一些规则，使它自己的 home 文件夹 `~/.delorun` 不被触及：

- 命令不能在你的 Delorun home 的任何位置写入。
- 命令不能读取你的密钥、Delorun 的秘密或控制正在运行的 Delorun 的令牌。它们只能读取它们所需的已安装发布版本、skill 和运行时，以及你的 profile 插件的已批准副本，这样插件才能给 agent 一个自己的工具。它们不能写入这些副本，也不能读取正等待你审阅的插件更改。插件写入其自身已批准文件夹的任何内容（例如缓存的令牌）都能被沙箱中的命令读取，所以插件应当把它的密钥放在凭据存储中。
- 命令不能连接控制正在运行的 Delorun 的套接字，也不能连接 Docker 的套接字。

`read`、`grep` 和 `apply_patch` 等文件工具自己就会拒绝你的 Delorun home。

在 Linux 上，运行 `delorun doctor` 可以看到你的电脑运行的是哪种沙箱。它的 `sandbox` 行会指出正在使用的沙箱，或为何没有沙箱能运行。出现故障时，请见[故障排查](../help/troubleshooting.zh.md#protections-and-plugins)。

| 你在哪里运行 Delorun | 沙箱强制执行什么 |
| --- | --- |
| 安装了 bubblewrap 的 Linux，包括 WSL2 | 上述每条规则。它还会隐藏你的登录会话的套接字，所以命令无法通过 `systemd-run --user`、D-Bus、tmux 或 screen 启动程序，也无法使用你的 ssh-agent、gpg-agent 或密钥环。在 WSL2 下，它还会阻止命令启动 Windows 程序。抽象套接字（例如 Linux 桌面上 X 服务器和会话总线的套接字）与网络绑定在一起，所以在网络设置为 Open 时，只要其中任何一个在监听，命令就会被拒绝（见[网络设置](#the-network-setting)）。 |
| 没有 bubblewrap 的 Linux | 只有写入和读取规则。它无法隐藏你的会话的套接字，所以在有桌面或登录会话的电脑上，在你安装 bubblewrap 之前，Delorun 会拒绝运行任何命令。 |

命令仍然可以触及你的用户能触及的其他一切：其他本地套接字、`~/.ssh` 和 `~/.aws` 之类的文件，以及网络（除非你加以限制，见[网络设置](#the-network-setting)）。沙箱限制写入并保护 Delorun 的 home。它不会隐藏你账户中的其余部分。

<details>
<summary>边界情况</summary>

- 如果某条命令需要你的 ssh-agent，例如通过 ssh 的 `git push`，那么它在沙箱中会失败。请给那个工作区[完全访问](../../reference/glossary.zh.md#full-access)，或在你自己的终端中推送。
- 如果你在没有 bubblewrap 的 Linux 上运行，且电脑上没有登录会话或 tmux 这类程序持有套接字，那么命令在 Landlock 下运行，`delorun doctor` 会显示 `warn sandbox`。
- 如果你在桌面上运行没有 bubblewrap 的 Linux，那么每条沙箱中的命令都会被拒绝。请安装 `bubblewrap` 包并再次启动 Delorun。如果它已安装但无法创建沙箱，请见[故障排查](../help/troubleshooting.zh.md#protections-and-plugins)。
- 如果你在 WSL2 下运行，那么适用 Linux 的规则，命令无法启动 Windows 程序。
- 如果你自己在沙箱之外启动的程序读取你的 Delorun home，那么没有任何东西能阻止它。沙箱只涵盖模型的命令。

</details>

<details>
<summary>进一步了解</summary>

- 安装 bubblewrap 或更改你的系统之后，运行 `delorun doctor` 检查 `sandbox` 行。
- 用[网络设置](#the-network-setting)按工作区限制网络。
- 阅读[威胁模型](../../security/threat-model.zh.md)，了解每种沙箱隐藏的套接字。

</details>

<a id="full-access"></a>

## 完全访问

完全访问是 chat 可以拥有的一种权限：它的命令在沙箱之外运行，拥有你的用户所能做的一切，包括 Delorun 的 home 和密钥。每个新工作区开始时用的都是 Workspace Write。你在运行 Delorun 的那台电脑上为某个工作区授予一次完全访问，该工作区中的 chat 之后就可以使用它。

在默认的 setup 选项 [**Ask me first**](../../reference/glossary.zh.md#ask-me-first) 下，你可以在四个地方授予它：

- **在[批准卡片](../../reference/glossary.zh.md#approval-card)上。**当某条命令请求在沙箱之外运行时，studio 会显示一张卡片，上面有 **Allow once**（让那一条命令运行）和 **Allow for this chat**（把 chat 切换为命令所请求的权限）。chat 会一直保持这一权限，直到你在输入框中把它调低。当命令请求完全访问而工作区还没有时，**Allow for this chat** 会打开完全访问对话框。对话框中的 **Allow full access** 会为该工作区记录这项授权凭证（grant）并切换 chat。成功后，卡片得到回答，命令开始运行。
- **在 chat 中。**在 chat 的权限控件中选择 Full access。同一个对话框会打开，其中有一个要勾选的框，表示你了解风险。成功后，该控件显示 Full access。
- **在设置中。**打开“设置”→“安全”→“权限”，选择工作区旁边的 **Allow full access**。成功后，工作区显示 “Allowed” 和时间。
- **在终端中。**运行 `delorun workspace full-access <folder> on` 并回答“是”。成功后，不带文件夹的 `delorun workspace full-access` 会列出该工作区。

对话框的 **Details** 列出完全访问可以触及的内容：你工作区之外的文件、带有密钥和令牌的 Delorun home，以及 Delorun 的更新渠道。

要收回完全访问，请在“设置”→“安全”→“权限”中选择 **Revoke**，在该工作区的 chat 中选择 Workspace Write，或运行 `delorun workspace full-access <folder> off`。该工作区已打开的 chat 会在一秒之内回到 Workspace Write。

<details>
<summary>边界情况</summary>

- 如果工作区已经有授权，那么对话框只是 “Switch this chat to full access?”：确认即可。
- 如果你取消批准卡片上的对话框，那么卡片会继续等待：请再次选择 Allow once、Allow for this chat，或拒绝。
- 如果 chat 已经处于或高于卡片所请求的权限，那么不会提供 **Allow for this chat**：请使用 **Allow once**。
- 如果你在通过[远程访问](../everyday-use/reach.zh.md)登录的手机上，那么卡片会显示 “Approve this at your computer”，你在那里点按的任何东西都不会授予它：请在运行 Delorun 的那台电脑上回答。
- 如果 chat 没有工作区文件夹，那么模型会被告知要求你运行 `delorun workspace full-access <folder> on`：请先给 chat 一个文件夹。
- 如果该文件夹是文件系统根目录、你的用户主目录、你的 Delorun home 或你的 DeepSeek Harness home，或者包含其中之一，那么 `delorun workspace full-access` 会拒绝它：请选择一个项目文件夹。
- 如果无法读取完全访问授权列表，那么没有任何授权有效，“设置”→“安全”→“权限”会这样说明：请修复或删除它所指出的文件，然后重新授权。
- 如果你在没有授权的文件夹中运行 `delorun headless`，那么它会以 “which you have not granted full access” 拒绝且不会启动：请运行 `delorun workspace full-access <folder> on`，或不带完全访问运行。正在运行的 headless 任务只在它下次检查权限时才会看到撤销。
- 如果你在 chat 中选择更安全的预设，那么工作区的授权会被撤回，该工作区中其他处于完全访问的已打开 chat 也会降级：要回到原状，请重新授权。
- 如果单条命令在没有授权的情况下请求在沙箱之外运行，那么 Delorun 会用原有的批准问题直接询问你，该问题不会说明该命令可以读取 Delorun 的 home：请把它当作可以读取来看待。
- 如果你在 setup 中选择了 [**Ask less (like DeepSeek Harness)**](../../reference/glossary.zh.md#ask-less)，那么工作区会像在 DeepSeek Harness 中那样，在 studio 自己的确认之后切换为完全访问，没有按工作区的授权。

</details>

<details>
<summary>进一步了解</summary>

- `delorun setup prompts` 在 Ask me first 与 Ask less (like DeepSeek Harness) 之间切换。
- “设置”→“安全”→“权限”中“新 chat”下的选项设置新 chat 开始时的权限。
- 不带文件夹的 `delorun workspace full-access` 列出每个工作区及其权限。

</details>

<a id="consents"></a>

## 同意

setup 的提示问题决定 Delorun 在有风险的更改之前如何询问。`delorun setup prompts` 可以更改答案。

| | Ask me first（默认） | Ask less (like DeepSeek Harness) |
| --- | --- | --- |
| 工作区切换为完全访问 | 每个工作区询问一次，如[完全访问](#full-access)所述 | 在 studio 确认之后切换 |
| 模型用它的文件工具写入 `AGENTS.md`、skill 或预设 | 先询问，说明该文字将作为指令加载到它之后触及的每个 chat 中，并显示差异。在你允许之前不会写入任何东西 | 像任何文件一样写入 |
| An [MCP server](../../reference/glossary.zh.md#mcp-server) that runs a command and comes from a plugin, your editor or an unknown place | Held until you allow it at your computer, as [MCP servers](#mcp-servers) explains | Runs, as in DeepSeek Harness |
| 模型创建或编辑计划任务 | 询问，并显示任务的提示、它的计划、它运行所在的 chat 以及该 chat 的[权限预设](../../reference/glossary.zh.md#permission-preset) | 与 DeepSeek Harness 一样创建 |

**Never ask (dangerous)** 是第三个答案。它像 Ask less 一样关闭这三项同意，并让任何 chat 无需询问就能切换为完全访问，无论是来自 studio、手机、计划任务还是脚本。setup 会打印一条警告，要求你确认两次并输入 `full access everywhere`；对 root 用户它会拒绝这个答案，`--yes` 也从不选择它。用 `delorun setup prompts` 选择另一个答案即可再次关闭它。

使用 Never ask 时，你解锁着拿在手里的手机拥有近乎这台电脑的权限，所以请把它当作这台电脑。

### Never ask 下已解锁的手机能做什么

通过远程访问登录的手机或浏览器，每次用 [Face ID](../everyday-use/reach.zh.md#confirm-with-face-id) 或你的 PIN 确认该操作时，或在 Face ID 通行期（pass）开启期间（“设置”的 Face ID 中的 Ask again after），还可以做这些事：

- 它更改在其他答案下只有电脑才能更改的设置和插件行。
- 它运行任何斜杠命令。
- 它放宽新 chat 开始时的权限。
- 它保存或移除提供方密钥（但从不读回已保存的密钥）。
- 它读取 chat 工作区之外的文件（但从不读取 Delorun home 之内的）。这与该模式下完全访问给予 chat 的权限范围相同。

回答关于 MCP 服务器、外部 agent 和工作区网络的问题、给出预留完全访问的批准，以及打开终端，无论答案是什么，每次都要 Face ID 或你的 PIN；没有任何开关或完全访问的工作区可以免除它们。在应用程序中打开 chat 的文件夹仍然只能在电脑上进行。

手机以这种方式放宽的预设或同意（新 chat 开始时的权限，或被关闭的外部 agent 同意），在该模式结束时会被设回，除非你在那之后已在电脑上更改过。设备在该模式开启期间所做的任何事都不会比它活得更久：设备开启的终端开关或工作区完全访问会在该模式结束时关闭，这些工作区中的 chat 回到 Workspace Write，而你在电脑上设置的则保持不变。

远程访问从不自行扩大：只有电脑才能通过 `delorun setup` 开启该模式、批准新设备或移除设备、更改远程访问设置以及重置 home，设备则照常登录。

拥有终端的手机，或在完全访问的工作区中向 chat 发出提示的手机，拥有这台电脑的权限：电脑上的 shell 可以运行 `delorun devices approve`、`elevate` 和 `code`，所以请把你解锁着拿在手里的手机当作这台电脑。没有它的确认，手机保留它在其他答案下的每一项拒绝，并且不会打开终端。[`@delorun/home-auth`](../../../packages/home-auth/README.zh.md#dangerous-mode) 列出了该模式解除的每一项拒绝。

`web_fetch` [防护](../../reference/glossary.zh.md#fetch-guard)、更新保护以及[外部 agent](#external-agents) 同意，在两种答案下都保持原样。在任何模式下，插件管理都不能关闭、移除或更改 Delorun 的同意和防护插件或沙箱。

<details>
<summary>边界情况</summary>

- 如果模型运行的 shell 命令或代码在可写的工作区内写入 `AGENTS.md` 或 skill，那么没有任何同意会询问：同意只涵盖它所指明的工具，所以请检查 chat 改动了什么。
- 如果计划任务的 chat 在你允许该任务之后更改了它的权限预设，那么它的投递会被拒绝：请让模型重新设置该任务，这样它才会询问你。
- 如果你运行 `delorun headless`，那么本该询问的同意会改为拒绝：请先在 studio 中允许它，或不带它运行。
- 如果你在手机上，那么你无法回答同意：请在运行 Delorun 的那台电脑上回答。

</details>

<a id="mcp-servers"></a>

### MCP 服务器

An MCP server is a helper program that gives the model extra tools. One that runs a command runs it on your computer with your access, outside the sandbox. With Ask me first, Delorun judges a server by where its definition lives, not by its name or command. Servers you set up yourself (your own configuration or Settings) and servers Delorun's packs install start without asking. A server that comes from another plugin, from your editor or from a place Delorun could not identify is held stopped, and a card above the message box says "<server> wants to start" and where it comes from. Choose **Allow**, or **Details** for the full review, or **Not now** to hide the card for this studio session; the server stays waiting in Settings, Safety, Permissions, where you can also allow it, and `delorun mcp accept <server>` allows it too. A studio on a phone shows no Allow. When it worked, the server shows as Allowed and running.

在你回答之前，你会看到它的命令、参数、文件夹、环境变量的名称，以及将要运行的确切文件。这其中任何一项发生变化时，包括同一条命令现在找到了不同的文件，Delorun 都会再次询问。服务器可以在参数或普通环境变量中用 `${credential:NAME}` 从你存储的凭据中取用密钥。审阅界面显示的是这段文字，而不是密钥本身，并注明它在服务器启动时才填入。要停止你已允许的服务器，请在“设置”→“安全”→“权限”中选择 Revoke，或运行 `delorun mcp revoke <server>`。

An allowed server starts at once, and the chat you have open gets its tools with your next message; nothing restarts. Your allowance covers the server's name from the place it came from, so a server of the same name from another place asks again. Settings, Safety, Permissions also chooses which servers ask: **Ask for project servers**, the default, as above; **Always ask**, which also asks for your own and your packs' servers; or **Never ask**. Changing the choice needs you at your computer, and a server the new choice no longer asks for starts at once, while one it still asks for stays listed. [How each place is judged](../../../packages/plugin-mcp-consent/README.zh.md#origins-and-the-ask-mode) is in the package's README.

<details>
<summary>边界情况</summary>

- 如果文件在你查看和你回答之间发生了变化，那么你的回答会因过时而被拒绝：请查看新的审阅内容并再次回答。
- 如果服务器的命令、文件夹或某个会改变运行内容的变量（例如 `PATH` 或 `NODE_OPTIONS`）含有 `${credential:NAME}`，那么该服务器不会加载：请直接写出值，或使用另一个变量名。
- 如果一个只含 `${credential:NAME}` 的参数在填入之后会以 `-` 开头，那么服务器不会启动，因为程序会把它读作选项：请把选项写在参数本身里，例如 `--token=${credential:NAME}`。
- 如果你拒绝或撤销某个服务器，那么它会保持停止，直到它的启动方式改变或你再次允许它。
- 如果你在没有终端的情况下运行 `delorun mcp accept`，那么不会接受任何东西：请在运行 Delorun 的那台电脑上的终端中运行它。
- 如果 Delorun 没有在运行，那么 `delorun mcp` 命令无法访问它：请用 `delorun start` 启动它。
- 如果你在 Windows 上，且服务器是 `.cmd` 或 `.bat` 文件，那么审阅界面还会显示运行它的命令 shell。
- 如果由 `npx` 之类的包运行器启动服务器，那么它每次下载的代码不会被检查：请固定版本，或自己安装该程序。
- 如果 chat 可以写入服务器运行所在的文件夹，那么 chat 可以改变服务器所运行的内容：请把服务器放在 chat 无法写入的文件夹中。

</details>

<details>
<summary>进一步了解</summary>

- `delorun mcp list` 显示等待中的和已允许的服务器，以及什么发生了变化。
- `delorun mcp decline <server>` 搁置一次审阅而不允许它。

</details>

<a id="external-agents"></a>

### 外部 agent

Claude Code 和 Codex 是可选插件，让模型可以把任务交给另一个 agent 程序，即[外部 agent](../../reference/glossary.zh.md#external-agent)。该程序在 Delorun 的沙箱和批准提示之外运行。它可以读取和更改工作区中的文件，以及它自己的设置所允许的任何其他位置，包括你的 Delorun home。它使用你自己的 Claude Code 或 Codex 登录，所以任何费用都记在那个账户上。

每个 agent 以你在“设置”→“安全”→“外部 agent”中选择的级别运行：Careful、Standard、Your own settings 或 Unrestricted。Standard 是默认级别。已批准的设备可以收紧级别，但放宽级别（尤其是 Unrestricted）需要你在运行 Delorun 的那台电脑前，危险模式也不会解除这一点。

无论你在 setup 中给出了哪种提示答案，Delorun 都会在每次运行之前，在运行 Delorun 的那台电脑上询问。**Allow once** 只启动这一次运行。**Allow for this workspace** 让该 agent 在那里无需询问就能启动，直到你在“设置”→“安全”→“外部 agent”中，或用 `delorun workspace external-agents <folder> <agent> off` 撤销。每次运行在 30 分钟后停止。

<details>
<summary>边界情况</summary>

- 如果 chat 处于 Read Only，那么外部 agent 永远不会启动：请先切换 chat 的权限。
- 如果 chat 处于 Full access，那么 agent 会不经询问就启动，因为你已选择在没有提示的情况下运行，chat 会显示 “Started without asking · Full access”。要让 Full access 的 chat 重新询问，请在“设置”→“安全”→“外部 agent”中关闭 **Full access chats start agents without asking**：此后 agent 只会在你已允许它的工作区中启动。只有运行 Delorun 的那台电脑才能把该开关打开。
- 如果你运行 `delorun headless`，那么没有人可以被询问，所以 agent 只会在你已允许的地方启动，或在该次运行具有完全访问权限时启动，即通过工作区的完全访问授权，或 setup 的 **Never ask (dangerous)** 答案。具有完全访问权限的运行与 Full access 的 chat 一样，不经询问也无需授权就会启动 agent。
- 如果 chat 没有工作区文件夹，那么 agent 永远不会启动：请给 chat 一个文件夹。
- 如果你在手机上，那么你无法回答这个问题：请在运行 Delorun 的那台电脑上回答。
- 如果模型试图通过插件管理安装或开启这些插件，那么会被拒绝：请自己从“插件”页面或新手引导的 setup 中添加它们。
- 如果某次运行需要超过 30 分钟，那么它会停止：请在“设置”→“安全”→“外部 agent”中提高上限。

</details>

<details>
<summary>进一步了解</summary>

- “设置”→“安全”→“外部 agent”将运行时间上限设为 1 到 1440 分钟，从下一次运行开始生效。
- 同一个页面可以关闭这个询问，这样 agent 无需询问就会启动，与 DeepSeek Harness 相同。只有运行 Delorun 的那台电脑能够关闭它。
- `delorun workspace external-agents` 列出你已允许的内容。

</details>

<a id="the-network-setting"></a>

## 网络设置

每个工作区都有一个网络设置，即 **Open**、**Allowlist** 或 **Off**，用来限制它沙箱中的命令和 `web_fetch` 可以访问哪些主机。它从 Open 开始，与 DeepSeek Harness 相同，所以全新安装在你选择之前不会改变任何东西。请在运行 Delorun 的那台电脑上，在“设置”→“安全”→“网络”中选择。收紧会立即生效。让工作区能访问更多内容则会要求你确认。

在 Linux 上，Open 还会共享你电脑的网络，其中显示服务器和会话总线等程序监听的套接字是沙箱无法隐藏的。命令可能利用它们在沙箱之外行事。所以当你在 Linux 桌面上运行 Delorun 且工作区处于 Open 时，Delorun 会在每条命令启动时检查，只要有任何这类套接字在监听就拒绝它，并指出该套接字。在某个工作区第一次遇到这种情况时，对话会在运行 Delorun 的电脑上询问你，是否让该工作区中的命令照常运行。模型无法回答这个询问。允许会记录与“设置”→“安全”→“网络”中 Open 旁边的开关 **Run commands even when desktop sockets are reachable** 相同的选择，随后命令运行；拒绝则保持拒绝，在 Delorun 重启之前，对话不会在该工作区再次询问。只有 `bash` 和 `pwsh` 工具会询问，并且只在沙箱是本机沙箱时询问；你打开的终端和无人可答的 `delorun headless` 保持拒绝并指向设置。你也可以为工作区选择 Allowlist 或 Off，或自己打开该设置。开启它之后，命令会运行，沙箱会报告自己只是部分限制，Delorun 会记录这些套接字。检查发生在命令启动时，所以之后才开始监听的套接字不会被发现。[提示词注入与数据外泄](prompt-injection.zh.md#the-network-setting)说明了每种选择关闭了什么、又留下了什么。

<details>
<summary>边界情况</summary>

- 如果你的沙箱无法强制执行 Allowlist 或 Off（除了 Linux 上的 bubblewrap（包括 WSL2）之外的任何情况），那么工作区的命令会被拒绝，而不是带着你的网络运行：把它设回 Open 即可运行。
- 如果你在 Linux 桌面上使用 Open，而某条命令被一条关于抽象 Unix 套接字的消息拒绝，那么请回答对话的询问，或为工作区选择 Allowlist 或 Off，或用 **Run commands even when desktop sockets are reachable** 接受风险。
- 如果命令拥有完全访问，那么该设置不适用：它在沙箱之外运行。
- 如果无法读取该设置的文件，那么每个工作区都视为 Off，更改会被拒绝：请修复或删除“设置”所指出的文件。
- 如果你在手机上，那么无法打开该页面：请使用运行 Delorun 的那台电脑。
- 如果你在 setup 中选择了 **Ask less (like DeepSeek Harness)**，那么该页面会说明此设置不可用：请运行 `delorun setup prompts` 并选择 Ask me first。
- 如果某条命令已经在运行，那么它保留启动时拥有的网络：收紧之后请重启该工作区的终端和任务。

</details>

<details>
<summary>进一步了解</summary>

- Allowlist 编辑器中的 **Add common hosts** 会添加 npm、PyPI、GitHub、crates.io 或 Go 的主机。检查列表后再保存。
- **Use default** 让工作区回到默认值。

</details>

<a id="the-web_fetch-guard"></a>

## web_fetch 防护

`web_fetch` 是模型用来读取网页的工具。它会拒绝你自己电脑和网络上的地址：回环、链路本地和私有网络地址，包括云元数据地址。它会检查每一次重定向，并告诉模型为何拒绝，例如 `web fetch refused: the host "localhost" is a loopback address, which web_fetch does not fetch`。没有任何设置可以关闭这项防护。

<details>
<summary>边界情况</summary>

- 如果模型运行 `curl` 或其他命令，那么这项防护不适用：对命令请使用网络设置。
- 如果你配置了代理或远程获取提供方，那么它在这项防护之外解析自己的目标。

</details>

<a id="release-checks"></a>

## 发布检查

- **安装之前。**启动器检查发布版本的签名及其在公开发布日志中的条目，其中任何一项检查失败时都不安装任何东西（见[启动器验证什么](../get-started/install.zh.md#what-the-launcher-verifies)）。
- **每次启动时。**已安装的文件会对照其已签名的列表进行检查，发布版本也会再次对照发布日志进行检查。
- **更新之前。**新的发布版本在被安装到正在运行的版本旁边之前，要通过同样的检查（见[更新](updates.zh.md)）。

它们证明的是：你运行的是 Delorun 的密钥签名并公开记录过的发布版本。它们并不证明该发布版本没有缺陷。

<details>
<summary>边界情况</summary>

- 如果发布日志在启动时与发布版本相矛盾，那么启动会停止：请运行 `delorun verify` 查看每一项检查。
- 如果无法访问发布日志，那么你会收到一条警告，启动继续进行：请检查你的连接。
- 如果你离线但仍想检查，那么 `delorun verify --offline` 会运行不需要网络的检查。
- 没有任何设置可以关闭发布日志检查。

</details>

<details>
<summary>进一步了解</summary>

- `delorun verify --release <version>` 检查指定的发布版本，`--json` 为脚本打印结果。

</details>

<a id="what-delorun-does-not-protect-against"></a>

## Delorun 不防护什么

- **在沙箱之外以你的身份运行的程序。**你运行的任何程序，以及你让它以完全访问运行的任何命令，都可以读取和更改你的 Delorun home 中的一切、用它的令牌批准设备或打开 studio，并改动各项检查。
- **没有 bubblewrap 的 Linux。**在那里 Delorun 只要运行命令，这些命令就能连接 Docker 的套接字，而这在 rootful Docker 上等于获得 root。
- **网络和其他套接字。**命令可以访问任何网络主机（除非你加以限制），以及沙箱所隐藏的位置之外的本地套接字，例如位于你主目录中的套接字。在 Linux 桌面上，X 服务器还会监听一个没有任何文件命名的套接字，由 `dbus-launch` 启动的会话总线也可能如此。当网络设置为 Open 时，只要有这样的套接字在监听，Delorun 就会拒绝命令，除非该工作区接受这一风险（见[网络设置](#the-network-setting)）；命令启动之后才开始监听的套接字不会被发现。接受风险后，命令可以访问这些套接字，并通过这样的总线在沙箱之外启动程序。
- **插件。**插件以 harness 自己的权限运行。Delorun 不对插件做沙箱、审计或撤销。它在安装时和每次启动时检查插件声明的版本范围，但安装之后不再次检查它的文件。来自 npm、git 或 tarball 的插件，如果其文件在磁盘上发生变化，会在下次启动时按其现在的样子加载。
- **模型所读文字中的指令。**网页、文件、仓库和工具输出都可能携带指令。同意和沙箱限制由此产生的后果，但并不检测这些指令（见[提示词注入](prompt-injection.zh.md)）。
- **studio 的登录。**已登录的浏览器会在 30 天内保持登录，重启后仍然如此，且登录无法被撤销。
- **你的日志。**Delorun 不认识的形式的密钥，可能进入运行日志（见 [Delorun 的日志存放在哪里](../help/logs.zh.md)）。

关闭[变更保护](../customising/changing-your-harness.zh.md)（默认就是关闭）时，任何能够写入你所链接的插件文件夹的东西，都可以在你看到更改之前改变 Delorun 所运行的内容。该更改会被记录，并且可以撤销。[你使用 Delorun 时信任什么](trust.zh.md)说明了各方（包括 Delorun 的维护者）能做什么、不能做什么。

<a id="next"></a>

## 接下来

- 要限制工作区能向外发送什么，请阅读[提示词注入与数据外泄](prompt-injection.zh.md)。
- 要用手机访问 studio，请阅读[用手机访问 studio](../everyday-use/reach.zh.md)。
- 要了解各方能看到什么、能做什么，请阅读[你使用 Delorun 时信任什么](trust.zh.md)。
- 如果出了问题，请在[故障排查](../help/troubleshooting.zh.md)中找到那条消息。

<a id="for-the-technically-curious"></a>

## 给想深入了解的人

[威胁模型](../../security/threat-model.zh.md)陈述了每一项保护及定义它的规则，以及每一项局限，包括各平台的沙箱规则以及每种沙箱所隐藏的套接字。[home 布局约定](../../contracts/c01-home-layout.zh.md)定义了 Delorun home 的沙箱规则。[对等清单](../../reference/parity-with-deepseek-harness/parity.zh.md)列出了每项同意和默认值，以及把它改回 stock 的开关。
