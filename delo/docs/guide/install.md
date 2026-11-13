---
description: "Install Delorun with npx delorun and take it from nothing to a first chat: what you need, what the launcher checks before it installs, setup by how you will use Delorun, the studio and its first-run guide, the default workspace, and opening the studio from a machine without a browser."
---

# Install and first run

English

## Summary

This page takes you from nothing to your first chat. You run one command, `npx delorun`. It downloads Delorun, checks that the download is genuine, asks a few questions and sets Delorun up. You then start it with `delorun`, and it opens in your browser. Everything then runs on your own computer. You need a computer that Delorun supports, Node.js to run the command, and a key for the AI model you want to talk to. A chat needs the key; the studio opens without one, so you can look around first.

Delorun is a community fork of [DeepSeek Harness](../reference/glossary.md#stock), the open-source program that lets an AI model work on files and run commands on your computer.

## Contents

- [Before you start](#before-you-start)
- [Install](#install)
- [What the launcher verifies](#what-the-launcher-verifies)
- [Setup: how you will use Delorun](#setup-how-you-will-use-delorun)
- [The studio and your first chat](#the-studio-and-your-first-chat)
- [The default workspace](#the-default-workspace)
- [A computer without a browser](#a-computer-without-a-browser)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Before you start

- **A supported computer.** Linux on x64 or arm64, and Windows on x64, which includes WSL2. macOS is not supported ([Roadmap and vision](roadmap.md)).
- **[Node.js](https://nodejs.org) 24.9 or newer.** Only the install command needs it. Check with `node --version`.
- **A model key.** A key is a secret text that lets Delorun use an AI model on your account. The company or server that runs the model is the [model provider](../reference/glossary.md#provider). The default is a DeepSeek API key. Other providers work too ([Model providers](providers.md)). You can skip the key during setup and add it later.
- **git**, which Delorun uses to save your settings before an update ([Updates](updates.md)).

## Install

Run this in a terminal:

```sh
npx delorun
```

The first run downloads and installs Delorun, then starts setup. Delorun prints the checks described below, then asks the first setup question. Every later `npx delorun` starts the installed Delorun and downloads nothing.

At the end of setup, Delorun offers `Install the delorun command? (runs npm install -g delorun)`. Say yes, and you can type `delorun` instead of `npx delorun` from then on.

Delorun keeps everything in one folder, `~/.delo`, which only you can open ([Your Delorun home](home.md)).

<details>
<summary>Edge cases</summary>

- If you run macOS, then the launcher stops with `PLATFORM_NOT_RELEASED` and installs nothing. Use Linux, WSL2 or Windows.
- If your Node is older than 24.9, then the launcher stops with `Delo needs Node 24.9 or newer to start`, and names your version. Install a newer Node from nodejs.org and run `npx delorun` again.
- If a check fails, then nothing is installed ([What the launcher verifies](#what-the-launcher-verifies)). Run `npx delorun` again; if it keeps failing, see [Installs and release checks](troubleshooting.md#installs-and-release-checks).
- If you have no network, then the first install cannot download a release. Once a release is installed, starting needs no network.
- If you set `DELO_HOME`, then the home is created there instead of `~/.delo` ([Your Delorun home](home.md#where-the-home-is)).

</details>

<details>
<summary>Go further</summary>

The launcher takes its own options before any `delorun` arguments:

| Option | What it does |
| --- | --- |
| `--profile <name>` | Uses another [profile](../reference/glossary.md#profile) than `default` ([Your Delorun home](home.md#profiles)). |
| `--release <version>` | Installs this release instead of the channel's current one, when no release is installed yet. |
| `--` | Ends the launcher's options. Everything after it goes to `delorun`. |

</details>

## What the launcher verifies

Before it installs anything, the launcher proves the download is the release Delorun's maintainers published. It prints each check:

```text
Resolving the release: the stable channel names 0.1.0.
Checking the signature: 0.1.0 is signed under release root 1.
Checking the release log: verified.
Downloading delorun-0.1.0-linux-x64.tar.gz (…).
Installing release 0.1.0.
```

- **Signature.** Delorun's release keys sign the release. The launcher checks the signatures and that the downloaded file matches. If anything does not match, nothing is installed.
- **Public release log.** Every release is also entered in a public, append-only [release log](../reference/glossary.md#release-log). The launcher checks the entry. If the log cannot be reached, the launcher installs the release on its signature alone, prints a warning, and checks the log again at the next start that can reach it.
- **Every start.** The launcher compares the installed files with the signed list. A start with a release installed needs no network.

You can run these checks again at any time with `delorun verify` ([Daily use](daily-use.md#check-the-release-and-your-setup)). [What you trust when you use Delorun](trust.md) says what you still rely on.

<details>
<summary>Edge cases</summary>

- If the log contradicts the release, then the install stops. Do not work around it; see [Installs and release checks](troubleshooting.md#installs-and-release-checks).
- If you want a stricter full file check at every start, then set `DELO_RUNTIME_FULL_CHECK_DAYS` to `0`. The default hashes every file at least every 7 days; the largest value is 30.

</details>

## Setup: how you will use Delorun

The first `delorun` on a new home runs setup. It asks one question at a time, and every question after the first offers **← Back**. Nothing is written until you choose **Save and set up** on the last screen; **Cancel** there writes nothing.

The first question asks how you will use Delorun. Its answer sets the defaults and decides which questions come next. Each choice shows what it does, who it suits and how to change it later, and the recommended choice is marked:

```text
How will you use Delorun?
● Just me, on this computer (recommended)
○ Also from my phone or another device
○ For scripts and automation
```

If you are unsure, choose the first. Most people then answer three questions: the model provider, its key, and how much Delorun asks.

| You choose | Delorun runs | Setup also asks |
| --- | --- | --- |
| **Just me, on this computer** | In the background, and opens in your browser on this computer. Nothing outside this computer can reach it. | Nothing more. |
| **Also from my phone or another device** | As above, plus a private address on your own [Tailscale network](../reference/glossary.md#tailnet). A device you approve here with a code can read and reply to chats. | Whether to open Delorun from your phone over Tailscale ([Reach the studio from your phone](reach.md)). |
| **For scripts and automation** | With no studio. You run `delorun headless "task"` from scripts or CI, with your key in an environment variable such as `DEEPSEEK_API_KEY`. | Neither the import question nor the background question. |

Every choice then asks these questions, in this order:

1. **Privacy.** A note, no question. It says that Delorun has no [telemetry](../reference/glossary.md#telemetry) of its own, that DeepSeek Harness's desktop analytics and DeepSeek's session-log upload are off unless you turn them on, and that once a day Delorun checks whether a newer release exists and sends nothing about your installation. The note ends: `Delorun checks for new releases once a day. To turn that off before Delorun first starts, choose More settings on the last screen, or run delorun setup privacy later.`
2. **Import.** Only if you used DeepSeek Harness before and this Delorun home has no chats: `Copy your DeepSeek Harness chats, attachments and workspace list? They are only read, and nothing in them changes.` The answer starts on No ([Switching from DeepSeek Harness](switching.md)). The automation choice never asks it.
3. **Model provider.** `Which model provider should Delorun use?` lists **DeepSeek (recommended)**, **More providers** (Anthropic, OpenAI, Google Gemini and others, or any server that speaks the OpenAI API) and **Choose later**.
4. **Model key.** The question names the provider's page for creating an [API key](../reference/glossary.md#api-key), then asks `How should Delorun get the DeepSeek API key?` You can **paste it now**, and Delorun stores it in your Delorun folder where only you can read it, or **use `DEEPSEEK_API_KEY`**, which Delorun reads each time it starts. An environment variable is a named setting that your terminal passes to the programs it starts. If you choose the variable and it is not set in this terminal, setup says so at once and tells you how to set it. Setup checks a typed key with one request to the provider ([Model providers](providers.md)).
5. **Prompts.** `How much should Delorun ask before it changes things?` This is the [prompts answer](../reference/glossary.md#prompts-answer). It has three choices:

   ```text
   ● Ask me first (recommended)
   ○ Ask less (like DeepSeek Harness)
   ○ Never ask (dangerous)
   ```

   **Ask me first** asks before a chat gets full access to a folder, adds a tool server, edits its own instructions or schedules work, and you can allow each once. **Ask less (like DeepSeek Harness)** behaves as DeepSeek Harness does: few questions, and commands still run in a [sandbox](../reference/glossary.md#sandbox) ([What Delorun protects](safety.md#consents)). **Never ask (dangerous)** lets any chat switch to full access with no question; it prints a warning, asks you to confirm twice and to type `full access everywhere` ([Consents](safety.md#consents)). It is always listed last.

A review screen then lists every answer, for example for the first choice:

```text
How you use Delorun: just me, on this computer
Release check: on, once a day
Model: DeepSeek, default model. Key: read from DEEPSEEK_API_KEY at each start.
Prompts: Ask me first
Keep running in the background: yes
Remote access: off
Setup name: default, studio port 3080

Nothing is saved until you choose Save and set up.
```

You should see `Save these answers and set up Delorun?` with **Save and set up**, **More settings**, **Cancel** and **← Back**. Choose **Save and set up**.

Setup then writes your answers, prints the next steps and starts nothing:

```text
Delorun is set up. Nothing is running yet.

Next:
  1. Set DEEPSEEK_API_KEY in your terminal, then run delorun stop and delorun start if Delorun is running. It is the DeepSeek key you chose.
  2. Start Delorun and open the studio: delorun
     Send a first message in a new chat. The install guide's section on your first chat walks through it: https://docs.delorun.com/guide/install#the-studio-and-your-first-chat

Change an answer later: delorun setup <section> (delorun setup --list shows the sections).
If something looks wrong: delorun doctor.
```

Step 1 appears only while the key variable you chose is not set. The steps differ by choice. The phone choice adds `Add your phone or another device: delorun devices approve, then type the code it shows.`, or, when Tailscale was not ready, `Remote access is off. Fix what the Tailscale note said, then run delorun reach on tailscale.` The automation choice replaces step 2 with `Run a task from a script or CI: delorun headless "your task"` and adds `To use the studio as well, start it any time with delorun.` When the launcher started setup, the first step installs the `delorun` command at the same version, with `npm install -g delorun@<version>`.

<details>
<summary>Edge cases</summary>

- If you choose **Choose later**, then no provider is set up and chats cannot answer yet. Setup says so. New chats start on `deepseek-flash` from DeepSeek, which reads its key from `DEEPSEEK_API_KEY`. Add a provider later with `delorun setup key` or in the studio's Settings → Agent → Models.
- If the provider refuses your key, then setup does not store it unless you choose **Continue without a successful check**. The review screen then says the key is not verified.
- If you press Ctrl-C at any question, then setup prints `Setup cancelled. Nothing was saved. Run delorun to start again.` and exits with code 130. Closing the terminal before you save also writes nothing.
- If you choose **← Back** at the dangerous-mode confirmation, then you return to the prompts question.
- If you did not choose More settings and port 3080 is already used by another program, then setup does not ask about the port, and the start fails. `delorun start` prints `the home process exited with code 1 before it was running; see its log` and the log's path. `delorun doctor` shows `fail port` and the fix. Run `delorun setup profile` to choose another port, then `delorun start`.
- If `~/.dsh` does not exist, or your Delorun home already has chats, then the import question is skipped.
- If setup runs without a terminal, then it cannot ask; use `delorun setup --yes` or `--config` (see Go further below).
- If you run setup with `--yes` and no `--provider`, then it sets up no model provider and prints how to add one. A script that runs `delorun headless` needs the key variable set in its own environment, because setup never stores a key it did not ask for.
- If you run setup as the root user, then **Never ask (dangerous)** is refused, by the question, by `--prompts dangerous` and by an answers document.
- If you chose to run in the terminal (background: No, under More settings), then closing the terminal stops Delorun.

</details>

<details>
<summary>Go further</summary>

- **More settings** on the review screen asks the rest: whether to check for new releases (Yes by default), whether Delorun keeps running in the background, remote access, and the [profile](../reference/glossary.md#profile) name and the studio's port (3080 by default). Setup says when the port is in use, and asks again. Run setup with another profile name for several setups side by side ([Your Delorun home](home.md#profiles)).
- Change one answer later with `delorun setup <section>`. `delorun setup --list` lists the sections: `privacy`, `import`, `key`, `prompts`, `background`, `reach` and `profile`.
- For scripts, `delorun setup --yes` takes every default and reads the key from `DEEPSEEK_API_KEY`. `delorun setup --config <file>` reads the answers from a JSON file, which may name `"useCase": "local" | "remote" | "automation"`. Neither turns on remote access or imports `~/.dsh`, and neither starts Delorun: run `delorun` afterwards. `--check-key` checks a key that comes from the environment ([Model providers](providers.md#set-up-without-questions)).

</details>

## The studio and your first chat

Run `delorun` after setup. It starts Delorun and opens the studio in your browser. The [studio](../reference/glossary.md#studio) is Delorun's web page for chatting with the model. It prints the studio address and three commands:

```text
Delorun is running in the background and keeps running after you close this terminal.
Studio: http://127.0.0.1:3080/ (opened in your browser)
  delorun status
  delorun logs --follow
  delorun stop
```

The studio listens on `127.0.0.1`, which only your own computer can reach, unless you turn on [remote access](reach.md). The browser signs in with a link that works once and expires after one minute. `delorun open` opens the studio again with a fresh link.

The first time, the studio shows a short first-run guide, one step at a time, ending in a chat:

1. **Welcome.** Choose the language. Each model provider shows whether its key works. Add or change a provider here.
2. **Look.** Choose colours and theme, or the stock look.
3. **Agents.** Optionally add Claude Code or Codex as helpers a chat can hand work to.
4. **Recommended plugins.** Optionally add [plugins](../reference/glossary.md#plugin), small add-ons that give Delorun more tools.
5. **Phone access.** Shown while remote access is not set up. It lists what Tailscale still needs.
6. **Workspace.** Choose the [workspace](../reference/glossary.md#workspace) for your first chat: the default one, a folder on your computer, or a git address to clone.
7. **Ready.** Choose **Start a chat**.

Every step has Back, Continue and **Skip for now**. Skip opens no chat. You can reopen the guide in Settings → General → Getting started → Show again.

A new chat starts in one of the agent [presets](../reference/glossary.md#preset), which the studio calls modes: Standard, PTC, Minimal and Creator. In Creator mode, the agent writes plugins and presets with you. Type a message to chat. If you set up no provider or key, the model cannot answer; add one in Settings → Agent → Models.

<details>
<summary>Edge cases</summary>

- If the browser does not open, then run `delorun open`, or `delorun open --print` and open the printed link yourself.
- If the link says it has expired, then run `delorun open` again. Each link works once, within one minute.
- If the browser shows "unauthorized" (HTTP 401) at the studio address, then you opened the address without a sign-in link. Run `delorun open`. <!-- us-spelling: quoted output -->
- If `delorun status` says `state: not running`, then start it with `delorun start`; if the start fails, read `delorun logs` and [Starting and stopping](troubleshooting.md#starting-and-stopping).
- If your key is not set, then `delorun doctor` shows `warn key`, and a chat reports that the model cannot answer. Fix it with `delorun setup key`.

</details>

<details>
<summary>Go further</summary>

- Open the studio from your phone: [Reach the studio from your phone](reach.md).
- See what a chat costs: [See what a chat costs](cost-meter.md).
- Reshape Delorun with plugins, presets and skills: [Where to customise what](https://docs.delorun.com/guide/customise).

</details>

## The default workspace

A chat works in a workspace: a folder on your computer whose files the model may read and change. Delorun's default workspace is `Delo/default-workspace` in your Documents folder, or in your home folder when your system has no Documents folder. The studio creates it the first time it is used. Add your own project folders in the studio.

<details>
<summary>Edge cases</summary>

- If none of the candidate folders can be used, for example because one would lie inside your Delorun home, then the start stops with `delorun: Delo found no folder for the default workspace.` and lists each folder with the reason. Name a folder in your profile's `cordis.patch.yml`, as the message shows ([Starting and stopping](troubleshooting.md#starting-and-stopping)).
- If you would rather not use the default, then choose another folder in the first-run guide's Workspace step.

</details>

## A computer without a browser

On a server or over SSH, Delorun cannot open a browser. Forward the studio's port from your own computer, then ask Delorun for a link:

```sh
# on your own computer
ssh -L 3080:127.0.0.1:3080 you@server
# on the server, in that SSH session
delorun open --print
```

`delorun open --print` prints a link, then `This link signs in to the studio once, within one minute; run delorun open --print again for another.` Open the link in the browser on your own computer. You should see the studio.

<details>
<summary>Edge cases</summary>

- If your forward uses another local port, then the link must name it: `delorun open --print --port <that port>`. A link signs in only at the host and port it names.
- If the studio uses another port than 3080, then forward that port instead; `delorun status` prints the address.

</details>

## Next

- Use Delorun every day: [Daily use](daily-use.md).
- Choose or change the model provider: [Model providers](providers.md).
- Coming from DeepSeek Harness: [Switching from DeepSeek Harness](switching.md).
- Know what is protected: [What Delorun protects](safety.md).
- If something went wrong: [Troubleshooting](troubleshooting.md).

## For the technically curious

The [release manifest contract](../contracts/c02-release-manifest.md) and the [release log contract](../contracts/c18-release-log.md) define every signature and log check the launcher makes. The [setup answers contract](../contracts/c11-setup-answers.md) defines each setup question and what it writes. The [first run design](../design/first-run.md) explains why setup asks what it asks.
