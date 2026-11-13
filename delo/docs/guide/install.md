---
description: "Install Delorun with npx delorun and run it for the first time: supported platforms, what the launcher verifies before it installs (signatures and the public release log), Quick and Full setup, the studio, the default workspace, and opening the studio from a machine without a browser."
---

# Install and first run

English

Delorun has no release yet; this page describes the first release.

## Summary

One command installs Delorun and sets it up: `npx delorun`. The launcher downloads the release for your computer, checks its signature and its entry in a public release log, and installs nothing when a check fails. Setup then asks for your model key and a few choices, starts Delorun and opens the studio in your browser. After that, everything runs on your computer, and you can reshape it to suit how you work: plugins, presets, skills and the harness itself, with updates that carry your changes.

## Contents

- [Before you start](#before-you-start)
- [Install](#install)
- [What the launcher verifies](#what-the-launcher-verifies)
- [Setup: Quick or Full](#setup-quick-or-full)
- [The studio](#the-studio)
- [The default workspace](#the-default-workspace)
- [A computer without a browser](#a-computer-without-a-browser)
- [Next steps](#next-steps)
- [For the technically curious](#for-the-technically-curious)

## Before you start

- **A supported computer.** Releases run on Linux on x64 or arm64, and on Windows on x64, inside WSL2 included. macOS is not supported yet: the launcher refuses with `PLATFORM_NOT_RELEASED`, and installs nothing.
- **Node.js 24.9 or newer**, for the launcher only; the release brings its own Node. With an older Node, the launcher stops with "Delo needs Node 24.9 or newer to start".
- **A model key.** Setup asks for a DeepSeek API key, or reads it from `DEEPSEEK_API_KEY` at each start.
- **git**, which Delorun uses to save your profile's history before an update ([Updates](updates.md)).
- **Coming from stock DeepSeek Harness?** Setup offers to copy your chats from `~/.dsh`, and never changes it ([Switching from DeepSeek Harness](switching.md)).

## Install

```sh
npx delorun
```

The first run downloads and installs the release your channel publishes, then runs setup. Every later `npx delorun` starts the installed release and downloads no release again. At the end of setup, Delorun offers to install the command for good: `Install the delorun command? (runs npm install -g delorun)`. Say yes, and run `delorun` from then on.

The launcher's own options come before any `delorun` arguments:

| Option | What it does |
| --- | --- |
| `--profile <name>` | Uses another CLI profile than `default` ([Your Delorun home](home.md#profiles)). |
| `--release <version>` | Installs this release instead of the channel's current one, when no release is installed yet. |
| `--` | Ends the launcher's options; everything after it goes to `delorun`. |

Delorun keeps everything in one folder, `~/.delo`, which only you can open ([Your Delorun home](home.md)). Releases are installed under `runtimes/` in it.

## What the launcher verifies

Before it installs a release, the launcher prints each check it makes:

```text
Resolving the release: the stable channel names 0.1.0.
Checking the signature: 0.1.0 is signed under release root 1.
Checking the release log: verified.
Downloading delorun-0.1.0-linux-x64.tar.gz (…).
Installing release 0.1.0.
```

- **Signatures.** Delorun's release keys sign a chain of files: the root of trust, which the launcher carries, a timestamp file that expires after three days, the channel's manifest and each platform's file list. The launcher checks each signature and then checks that the downloaded archive matches its signed length and hash. A file that does not match stops the install, and nothing is installed.
- **The public release log.** Every release is entered in a public, append-only log (Sigstore's), and an independent witness countersigns the log's state. The launcher checks the release's entry and the log's consistency. A log that answers with a contradiction stops the install. A log that cannot be reached leaves the release "not checked": the launcher installs it on its signature alone, prints a warning, and checks the log again at the next start that can reach it.
- **At every start.** The launcher checks the installed files against their signed list, and hashes every file at least every 7 days; `DELO_RUNTIME_FULL_CHECK_DAYS` sets that interval from 0, every start, to 30 days. A start with a release installed needs no network.

`delorun verify` runs these checks on demand and reports each one ([Daily use](daily-use.md#check-the-release-and-your-setup)). The launcher installs from releases.delorun.com, with GitHub Releases and a spare host of Delorun's as fallbacks, and from no other host. It does not check the release's SBOM, and the npm package carries no build attestation. [What you trust when you use Delorun](trust.md) states what you still trust: Delorun's release keys and the hosts that serve releases.

## Setup: Quick or Full

The first `delorun` on a new home runs setup. It asks one question at a time, and every question after the first offers **← Back**. Setup writes nothing until you choose **Save and set up** at the end.

```text
How do you want to set up Delorun?
  Quick   the model key and how careful prompts are
  Full    also the release check, background running, the profile name and the port
```

Both forms ask, in this order:

1. **Privacy.** A note of what leaves your computer: Delorun has no telemetry of its own; DeepSeek Harness's desktop analytics and DeepSeek's session-log upload are off unless you turn them on; and once a day Delorun checks for a newer release, sending nothing about your installation. Full asks **Check for new releases?**; Quick keeps the check on.
2. **Import.** When `~/.dsh` exists and your Delorun home has no chats: `Copy your DeepSeek Harness chats, attachments and workspace list?`, after a preview of what would be copied. The answer starts on No.
3. **Model key.** Enter the DeepSeek API key now, or read `DEEPSEEK_API_KEY` from the environment at each start. Setup checks a typed key with one request to the provider.
4. **Prompts.** `How should Delorun ask before it changes things?` **Safer prompts**, the default, asks before instruction edits, new MCP servers, scheduled work and full access. **Same as stock** behaves as DeepSeek Harness does ([What Delorun protects](safety.md#consents)).

Full also asks:

5. **Background.** `Keep Delorun running in the background after the terminal closes?` Yes by default; No runs Delorun in the terminal, and closing the terminal stops it.
6. **Remote access.** Whether to reach this studio from your phone over your own tailnet. No by default ([Reach the studio from your phone](reach.md)).
7. **Profile name and port.** The CLI profile, `default`, and the studio's port, 3080.

Change an answer later with `delorun setup <section>`; `delorun setup --list` lists the sections: `privacy`, `import`, `key`, `prompts`, `background`, `reach` and `profile`.

For scripts, `delorun setup --yes` takes every default and reads the key from `DEEPSEEK_API_KEY`, and `delorun setup --config <file>` reads the answers from a JSON file. Neither form turns on remote access or imports `~/.dsh`, and neither starts Delorun: run `delorun` afterwards.

## The studio

When setup ends, Delorun starts and opens the studio in your browser, and prints its address and three commands:

```text
Delorun is running in the background and keeps running after you close this terminal.
Studio: http://127.0.0.1:3080/ (opened in your browser)
  delorun status
  delorun logs --follow
  delorun stop
```

The studio listens on `127.0.0.1` only, so other computers cannot reach it unless you turn on [remote access](reach.md). The browser signs in with a link that works once and expires after one minute; `delorun open` opens the studio again with a fresh link. Each new chat starts in one of DeepSeek Harness's agent presets, which the studio calls modes: Standard, PTC, Minimal and Creator, in which the agent writes plugins and presets with you.

## The default workspace

A chat works in a workspace: a folder on your computer whose files the model may read and change ([Daily use](daily-use.md#workspaces-and-what-the-model-may-change)). Delorun's default workspace is `Delo/default-workspace` in your Documents folder, or in your home folder when your system names no Documents folder. The studio creates it the first time it is used. Add your own project folders as workspaces in the studio.

When none of these folders can be used, for example because it would lie inside your Delorun home, the start stops with "Delo found no folder for the default workspace" and shows how to name one in your profile.

## A computer without a browser

On a server or over SSH, Delorun cannot open a browser. Forward the studio's port from your own computer, then ask Delorun for a link:

```sh
# on your own computer
ssh -L 3080:127.0.0.1:3080 you@server
# on the server, in that SSH session
delorun open --print
```

`delorun open --print` prints a link and `This link signs in to the studio once, within one minute; run delorun open --print again for another.` Open it in the browser on your own computer. A link signs in only at the host and port it names: when the local end of your forward uses another port, run `delorun open --print --port <that port>`.

## Next steps

- [Daily use](daily-use.md): start, stop, status, logs, workspaces, safe mode.
- [Updates](updates.md): the update notice and going back.
- [Changing your harness](https://docs.delorun.com/guide/changing-your-harness): what Delorun records when plugins or Delorun's own files change, turning protection on, and undo.
- [Where to customise what](https://docs.delorun.com/guide/customise) and [Write a plugin for Delo](https://docs.delorun.com/guide/plugins): reshaping Delorun to suit how you work.
- [What Delorun protects](safety.md) and [What you trust when you use Delorun](trust.md).
- [Troubleshooting](troubleshooting.md): refusals and their fixes.

## For the technically curious

The [release manifest contract](../contracts/c02-release-manifest.md) and the [release log contract](../contracts/c18-release-log.md) define every signature and log check the launcher makes, the [setup answers contract](../contracts/c11-setup-answers.md) defines each setup question and what it writes, and the [first run design](../design/first-run.md) explains why setup asks what it asks.
