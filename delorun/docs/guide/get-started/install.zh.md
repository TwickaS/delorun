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
- [Setup：你将如何使用 Delorun](#setup-a-few-questions)
- [studio 与你的第一次 chat](#the-studio-and-your-first-chat)
- [默认工作区](#the-default-workspace)
- [没有浏览器的电脑](#a-computer-without-a-browser)
- [接下来](#next)
- [给想深入了解的人](#for-the-technically-curious)

<a id="before-you-start"></a>

## 开始之前

- **一台受支持的电脑。**x64 上的 Linux，或通过 WSL2 使用的 Windows（见[通过 WSL2 使用 Windows](#windows-through-wsl2)）。Delorun 不能在 ARM（arm64）上的 Linux、原生 Windows 或 macOS 上运行（见[已知问题](../help/known-issues.zh.md#where-delorun-runs)）。
- **[Node.js](https://nodejs.org) 24.9 或更新版本。**`delorun` 命令是一个 Node 程序，所以每次启动都需要 Node，而不只是安装时。用 `node --version` 检查。如果你没有 Node，或版本较旧，请使用 [nodejs.org](https://nodejs.org/en/download) 上的官方安装方式。Ubuntu 自带的 Node 软件包要旧得多（Ubuntu 24.04 提供的是 Node 18），所以 `apt` 给不了你可用的 Node。
- **bubblewrap（在 Linux 和 WSL2 中）。**它是限制 chat 所运行命令的程序。请用系统的包管理器安装 `bubblewrap` 软件包。没有它时，在有登录会话或正在运行 tmux 这类程序的电脑上，Delorun 会拒绝每一条命令，`delorun doctor` 会显示 `fail sandbox`（见 [Delorun 保护什么](../safety-and-updates/safety.zh.md#the-sandbox)）。
- **模型密钥。**密钥是让 Delorun 在你的账户下使用 AI 模型的秘密文本。运行模型的公司或服务器就是[模型提供方](../../reference/glossary.zh.md#provider)。默认是 DeepSeek API 密钥。其他提供方也可以使用（见[模型提供方](providers.zh.md)）。Setup does not ask for it: the studio does, the first time it opens, and you can add it later.
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
✔ Found release <version> on the stable channel                            0.4s
✔ Signature checked (release root 1)                                       0.1s
✔ Release log checked                                                      0.6s
⠹ Downloading delorun-<version>-linux-x64.tar.gz
  ██████████████░░░░░░░░░░   58%  126.4 / 218.0 MB  6.7 MB/s  ~14s left
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
- If a copy on 0.1.0-preview.2.7 or earlier cannot update, then run `npx delorun@latest repair` once: your home, chats and settings stay. Releases from 0.1.0-preview.3 are verified under release root 2, which such a copy cannot read.
- 如果你想在每次启动时进行更严格的完整文件检查，请把 `DELORUN_RUNTIME_FULL_CHECK_DAYS` 设为 `0`。默认至少每 7 天对每个文件计算一次哈希；最大值是 30。

</details>

## Setup: a few questions

The first `delorun` on a new home runs setup in the terminal. It asks few questions, and the studio takes the rest. A run without a terminal, or with `--yes`, asks nothing.

It opens with one line about privacy, which is a note and not a question:

```text
Delorun sends nothing about you. Details: https://delorun.com/privacy
```

The details are on the [privacy page](https://delorun.com/privacy); what Delorun asks of the network is in [What you trust](../safety-and-updates/trust.zh.md#what-leaves-your-machine), and the release check has its own switch in Settings → General → Updates. Setup asks these questions in this order:

1. **Phone.** `Use Delorun from your phone too?` offers **No, just this computer** (the default) and **Yes, over Tailscale**. Yes first checks Tailscale on this computer: that it is installed, signed in, and that your user may run `tailscale serve`. A check that fails leaves phone access off and says what to fix; the rest of setup goes on ([Reach the studio from your phone](../everyday-use/reach.zh.md)). A phone you approve reads and replies to chats, and each sensitive action asks for its PIN.
2. **DeepSeek Harness chats.** Only if you used DeepSeek Harness before and this Delorun home has no chats: `Copy your N DeepSeek Harness chats?`, over a summary of what will be copied and what stays behind. Your DeepSeek Harness folder is only read. The choices are **Yes**, **Later (delorun import-home)** and **Show what stays behind** ([Switching from DeepSeek Harness](switching.zh.md)).
3. **The studio port.** Delorun takes port 3080 and, when another program uses it, the next free port, and says so. In a terminal it asks first: `Port 3080 is in use. Use 3081?` with **Yes** and **Enter another port**.
4. **The PIN and the command.** (Two questions, asked after the start.) Setup then starts Delorun in this terminal and opens the studio in your browser. If you chose phone access, it asks `Set a PIN for your phone now?` once Delorun runs, because the PIN is stored by the running home. It ends with `Keep the delorun command?`, which runs `npm install -g delorun@<version>` for you on **Yes**, or leaves you with `npx delorun` on **No, keep using npx**.

Setup does not ask for your model key. The studio's welcome screen does ([The studio and your first chat](#the-studio-and-your-first-chat)). Setup also does not ask how much Delorun asks, whether to run in the background, or what to call the profile: it takes safe defaults. **Ask me first** is the default for [prompts](../../reference/glossary.zh.md#prompts-answer), so Delorun asks before a chat gets full access to a folder, adds a tool server, edits its own instructions or schedules work ([What Delorun protects](../safety-and-updates/safety.zh.md#consents)). Change any of them in the studio's Settings → General → How Delorun runs, which shows the command for each, or with `delorun setup <section>`.

Delorun then runs in this terminal. The last lines say so:

```text
Finish setup here, or on any device signed in to your Tailscale:
https://my-pc.example.ts.net
A new device asks to pair: approve it here at this computer, or unlock it with
the PIN.

Delorun runs in this terminal. Ctrl+C stops it.
To keep it running after you close the terminal: delorun start --background
(or Settings → General → How Delorun runs).
Change an answer later: delorun setup <section> (delorun setup --list)
If something looks wrong: delorun doctor
```

Press Ctrl+C to stop Delorun. The next `delorun` starts it again, in the background unless you turned that off in Settings → General → How Delorun runs.

**Setup without questions.** With no terminal, or with `--yes`, setup asks nothing. It takes the safe defaults: no phone access, no import, **Ask me first**, port 3080 or the next free port. It writes the profile, starts nothing and prints where the studio will be and how to start it:

```text
Delorun is set up. Nothing is running yet.
Studio: http://127.0.0.1:3080

Next:
  1. Install the delorun command, which npx does not keep:
     npm install -g delorun@<version>
  2. Add your model key in the studio (the welcome screen asks for it), or run delorun setup key.
  3. Start Delorun and open the studio: delorun
     Send a first message in a new chat. The install guide's section on your first chat walks through it: https://docs.delorun.com/guide/get-started/install#the-studio-and-your-first-chat

Change an answer later: delorun setup <section> (delorun setup --list shows the sections).
If something looks wrong: delorun doctor.
```

The install step appears only when the launcher started setup. The key step names the variable instead while you chose a key variable that is not set in your terminal. These flags answer the questions without asking them:

| Flag | What it answers |
| --- | --- |
| `--yes` | Takes every default and asks nothing. |
| `--phone` | Turns on phone access over Tailscale, and fails with the reason when Tailscale is not ready. In a terminal it pre-selects Yes. |
| `--import-dsh` | Copies your DeepSeek Harness chats after it prints what is copied and what stays behind. |
| `--port <n>` | Uses this studio port, from 1024 to 65535, instead of 3080 or the next free port. |

<details>
<summary>Edge cases</summary>

- If you answer **No** to the phone question, then nothing about phone access changes; turn it on later with `delorun reach on tailscale` or `delorun setup reach`.
- If you choose **Later** for the DeepSeek Harness chats, then nothing is copied; run `delorun import-home` any time.
- If port 3080 is busy and you run with `--yes`, then setup takes the next free port, prints `! Port 3080 is in use, so the studio will use 3081. Change it later with: delorun setup profile`, and goes on. A `--port` that is busy fails with the port named.
- If `npm install -g` is refused for lack of permission, then setup prints the same command with `--prefix ~/.local` and says to add `~/.local/bin` to your `PATH`.
- If the launcher is built for another release channel, such as a local channel, then it is not on the npm registry, so the command installs the package file it came from, `npm install -g ./delorun-<version>.tgz`, and the update-check statement names that channel's host, not releases.delorun.com and GitHub.
- If you press Ctrl-C at a question, then setup prints `Setup cancelled. Nothing was saved. Run delorun to start again.` and exits with code 130. Closing the terminal before the questions end also writes nothing.
- If `~/.dsh` does not exist, or your Delorun home already has chats, then the DeepSeek Harness question is skipped.
- If you run setup as the root user, then **Never ask (dangerous)** is refused, by `delorun setup prompts`, by `--prompts dangerous` and by an answers document.
- If you run setup with `--yes` and no `--provider`, then it sets up no model provider and says how to add one. A script that runs `delorun headless` needs the key variable set in its own environment, because setup never stores a key it did not ask for.

</details>

<details>
<summary>Go further</summary>

- To change your mind, run `delorun setup` again. On a finished setup in a terminal it says what the run does, then asks its questions again with your current choices selected. With `--yes` or `--config`, a finished setup is left unchanged.
- Change one answer with `delorun setup <section>`. `delorun setup --list` lists the sections: `privacy`, `import`, `key`, `prompts`, `background`, `reach`, `changes-protection` and `profile`. `delorun setup key` sets the model provider and key from the terminal ([Model providers](providers.zh.md)), `delorun setup privacy` the release check, and `delorun setup changes-protection` whether changes to your plugins and to Delorun wait for your review.
- Run setup with another profile name for several setups side by side ([Your Delorun home](../customising/home.zh.md#profiles)).
- For scripts, `delorun setup --yes --provider deepseek-official` reads the key from `DEEPSEEK_API_KEY`. `delorun setup --config <file>` reads every answer from a JSON file that holds a complete answers document. A file with only `useCase` is refused. Neither form turns on remote access or imports `~/.dsh` by itself, and neither starts Delorun: run `delorun` afterwards. `--check-key` checks a key that comes from the environment ([Model providers](providers.zh.md#set-up-without-questions)).
- A complete answers document that reads the key from `DEEPSEEK_API_KEY` looks like this. [Answer schema](../../contracts/c11-setup-answers.zh.md#answer-schema) explains each field.

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

## The studio and your first chat

Setup starts Delorun and opens the studio in your browser. The [studio](../../reference/glossary.zh.md#studio) is Delorun's web page for chatting with the model. It listens on `127.0.0.1`, which only your own computer can reach, unless you turn on [remote access](../everyday-use/reach.zh.md). The browser signs in with a link that works once and expires after one minute. `delorun open` opens the studio again with a fresh link, and a run of `delorun` on a home that is already set up starts Delorun and opens the studio the same way:

```text
Delorun is running in the background for the profile default at http://127.0.0.1:3080/; it keeps running after this terminal closes.
See it with delorun status, follow its log with delorun logs --follow, and stop it with delorun stop.
Run delorun open to open the studio in your browser.
Opened the studio in your browser.
```

The first time, the studio shows a short first-run guide of three steps, ending in a chat:

![The studio's first-run guide on a new home: the Welcome step, with the language choices and the pre-release notice, over an empty chat list.](../pictures/first-run-guide.webp)

1. **Welcome.** Choose the language. A pre-release notice says that Delorun is a community fork of DeepSeek Harness that is still in preview; choose Continue to acknowledge it.
2. **Models.** This is where you give Delorun its model key. A key that Delorun already has shows as "Key found", with where it came from (for example "From DEEPSEEK_API_KEY in the environment Delorun started with") and a "How does Delorun know?" note. Otherwise paste your DeepSeek key; Delorun tests it with a free request for the provider's model list, and shows `Key works` when the provider accepts it. Other providers are under **Add another provider**, and later in Settings, Agent, Models ([Model providers](providers.zh.md)). You can skip the step and add a key later.
3. **Ready.** Delorun lists the model and the workspace it will use, and says that the look, agents, plugins and phone access are in Settings. It offers three ideas to try, each with a **Copy** button. **Start a chat** opens a new chat; Delorun never sends a first message for you.

Two steps join the guide only when they are needed. A Workspace step appears only when no default workspace exists yet. A PIN step appears at your computer when phone access is on and no PIN is set: choose a PIN or passcode, typed twice, and **Set PIN**, or **Skip**. **Finish later**, beside the step name, closes the guide and keeps your place, and the guide shows again next time.

The rest of what the guide used to ask is in Settings. Settings → General → Getting started, **Run setup again**, opens the full guide: Welcome, Models, Look (colours and theme), Agents (Claude Code or Codex as helpers a chat can hand work to), Recommended [plugins](../../reference/glossary.zh.md#plugin), Browser, Phone access, PIN, Workspace and Ready. Settings → General → How Delorun runs shows how much Delorun asks, whether it runs in the background, the profile name and studio port, and phone access, each with the `delorun setup` command that changes it.

A new chat starts in one of the agent [presets](../../reference/glossary.zh.md#preset), which the studio calls modes: Standard, PTC, Minimal and Creator. PTC does everything Standard does and suits tasks that call tools in batches and then filter, deduplicate or summarise the results. In Creator mode, the agent writes plugins and presets with you. Type a message to chat. If you set up no provider or key, the model cannot answer; add one in the Models step or in Settings, Agent, Models.

<details>
<summary>Edge cases</summary>

- If the browser does not open, then run `delorun open`, or `delorun open --print` and open the printed link yourself.
- If the link says it has expired, then run `delorun open` again. Each link works once, within one minute.
- If the browser shows "unauthorized" (HTTP 401) at the studio address, then you opened the address without a sign-in link. Run `delorun open`. <!-- us-spelling: quoted output -->
- If `delorun status` says `state: not running`, then start it with `delorun start`; if the start fails, read `delorun logs` and [Starting and stopping](../help/troubleshooting.zh.md#starting-and-stopping).
- If your key is not set, then `delorun doctor` shows a `!` line for `key`, and a chat reports that the model cannot answer. Add it in the studio's Models step or Settings → Agent → Models, or run `delorun setup key`.

</details>

<details>
<summary>Go further</summary>

- Open the studio from your phone: [Reach the studio from your phone](../everyday-use/reach.zh.md).
- See what a chat costs: [See what a chat costs](../everyday-use/cost-meter.zh.md).
- Reshape Delorun with plugins, presets and skills: [Where to customise what](../customising/customise.zh.md).

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
