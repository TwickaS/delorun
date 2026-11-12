---
description: "What Delorun protects and what it does not, in plain language: where its protections apply, the sandbox and the protected home on each platform, full access, the consents and the prompts setting, the web_fetch guard, release checks, and the stated limits, with links to the threat model."
---

# What Delorun protects

English

## Summary

Delorun runs on your computer with your own access, and an agent that runs commands for you can do real damage when it is wrong or when text it reads tells it to. Delorun keeps DeepSeek Harness's approvals and sandbox and adds protections around them: commands the model runs cannot touch Delorun's own home, risky changes ask you first, `web_fetch` does not reach your local network, and releases are checked before they run. This page says what each protection does, where it applies and what it leaves open. For the exact rules, see [For the technically curious](#for-the-technically-curious).

## Contents

- [Where the protections apply](#where-the-protections-apply)
- [The sandbox](#the-sandbox)
- [Full access](#full-access)
- [Consents](#consents)
- [The web_fetch guard](#the-web_fetch-guard)
- [Release checks](#release-checks)
- [What Delorun does not protect against](#what-delorun-does-not-protect-against)
- [For the technically curious](#for-the-technically-curious)

## Where the protections apply

- **The studio that `delorun` starts** carries every protection on this page.
- **`delorun headless`** carries the sandbox protection, the guards and the consents; a consent that would ask you refuses instead, because no one is there to answer.
- **`delorun plugin`** carries none of them: it runs DeepSeek Harness's plugin installer as you.
- **DeepSeek Harness's desktop app** is upstream's, unchanged, and none of Delorun's protections apply to it.

Delorun refuses to start a profile whose settings turn one of its protections off, and names the setting and the file ([Troubleshooting](troubleshooting.md#protections-and-plugins)).

## The sandbox

DeepSeek Harness's sandbox confines the commands the model runs: in a Workspace Write workspace, they write only inside the workspace and the permitted temporary folders. Delorun adds rules that keep its own home, `~/.delo`, out of reach of those commands:

- they cannot write anywhere under your Delorun home;
- they cannot read it, except the installed releases, skills and runtimes they need, so they cannot read your keys, Delorun's secrets or the token that controls the running Delorun;
- they cannot connect to the socket that controls the running Delorun or to Docker's socket.

The file tools, such as `read`, `grep` and `apply_patch`, refuse your Delorun home themselves. How much of this your computer enforces depends on the sandbox it can run:

| Sandbox | Where | What it enforces |
| --- | --- | --- |
| bwrap (bubblewrap, a Linux sandbox tool) | Linux, WSL2 included | Every rule above. Under WSL2 it also hides `/run/WSL`, so commands cannot start Windows programs. |
| Landlock (a Linux kernel feature) | Linux without bwrap | The write and read rules; commands can still connect to Delorun's control socket, which refuses them because they cannot read its token, and to Docker's socket. |
| Windows access lists | Windows | Writes only: commands can read your Delorun home, its secrets and the token included. |

Commands can still reach the network, other local sockets such as your ssh-agent and D-Bus, and everything else your user can read, such as `~/.ssh` and `~/.aws`. The sandbox limits writes and protects Delorun's home; it does not hide the rest of your account.

## Full access

A workspace on full access runs the model's commands outside the sandbox, with everything your user can do, Delorun's home and secrets included. Every new workspace starts on Workspace Write instead.

With setup's **Safer prompts**, the default, Delorun asks for full access once per workspace before it applies: pick Full access in a chat, choose "Allow full access for this workspace" on an approval card, use Settings, Permissions, or run `delorun workspace full-access <folder> on`, and you answer on the home's own computer. A single command can still ask to run outside the sandbox: DeepSeek Harness asks you, and its question does not say that such a command can read Delorun's home. With **Same as stock**, a workspace switches to full access after the studio's own confirmation, as in DeepSeek Harness.

## Consents

Setup's prompts question decides how Delorun asks before risky changes, and `delorun setup prompts` changes the answer:

| | Safer prompts (default) | Same as stock |
| --- | --- | --- |
| A workspace switched to full access | Asks once per workspace, as [Full access](#full-access) explains | Switches after the studio's confirmation |
| The model writes `AGENTS.md`, a skill or a preset with its file tools | Asks first, says the text will load as instructions in every future chat it reaches, and shows the diff; nothing is written until you allow it | Written as any file |
| A new MCP server that runs a command | Held until you allow it at your computer, as [MCP servers](#mcp-servers) explains | Runs, as in DeepSeek Harness |
| The model creates or edits a scheduled task | Asks with the task's prompt, its schedule, the chat it runs in and that chat's permission preset; a delivery is refused when that chat's preset has changed | Created as in DeepSeek Harness |

The `web_fetch` guard and the update protections stay on with either answer. Plugin management cannot turn off, remove or reconfigure Delorun's consent and guard plugins or the sandbox, in any mode.

A consent covers the tool it names. A shell command or code the model runs can still write `AGENTS.md` or a skill inside a writable workspace without asking.

### MCP servers

An MCP server that runs a command runs it on your computer with your access, outside the sandbox. With Safer prompts, Delorun holds a new one stopped until you allow it in Settings, Permissions or with `delorun mcp accept <server>`. Before you answer you see its command, arguments, folder and environment variable names, and the exact file that will run and the folder it runs in, found the way the server would start. On Windows you also see the command shell that runs a `.cmd` or `.bat` file. Delorun asks again when any of these changes, including when the same command now finds a different file, for example after a folder earlier in `PATH` gains a program with that name. If the file changes between your look and your answer, your answer is refused and the review shows the new file. `delorun mcp revoke <server>` or Revoke in Settings, Permissions stops a server you allowed.

## The web_fetch guard

`web_fetch` refuses addresses on your own computer and network: loopback, link-local and private-network addresses, cloud metadata addresses included. It checks every redirect, connects only to the address it checked, and tells the model why it refused, for example `web fetch refused: the host "localhost" is a loopback address, which web_fetch does not fetch`. No setting turns the guard off.

The guard covers the `web_fetch` tool only. Commands the model runs can reach any address, and a proxy or a remote fetch provider you configure resolves its target outside the guard.

## Release checks

- **Before install.** The launcher checks the release's signatures and its entry in the public release log, and installs nothing when either check fails ([What the launcher verifies](install.md#what-the-launcher-verifies)).
- **At every start.** The installed files are checked against their signed list, and the release is checked against the release log again. A log that contradicts the release stops the start; a log that cannot be reached gives a warning, and the start goes on. No setting turns the release-log check off.
- **Before an update.** The new release passes the same checks before it is installed beside the running one ([Updates](updates.md)).

The release checks prove that you run the release Delorun's keys signed and logged publicly. They do not prove that the release has no defects.

## What Delorun does not protect against

- **Programs running as you outside the sandbox.** Any program you run, and any command you let run with full access, can read and change everything in your Delorun home, use its token to approve a device or open the studio, and change the checks.
- **Windows reads.** On Windows, the model's commands can read Delorun's secrets and token.
- **Landlock sockets.** On a Linux system with Landlock but no bwrap, commands can connect to Docker's socket, which gives root on a rootful Docker.
- **The network and other sockets.** Commands reach any network host, your ssh-agent, D-Bus and the display server.
- **Plugins.** A plugin runs with the harness's own access. Delorun does not sandbox, audit or revoke plugins. It checks a plugin's declared version ranges at install and at each start, but does not check a plugin's files again after install: a plugin from npm, git or a tarball whose files change on disk loads as it now is at the next start.
- **Instructions in text the model reads.** Web pages, files, repositories and tool output can carry instructions; the consents and the sandbox limit what follows from them, and do not detect them.
- **The studio's sign-in.** A browser that signed in stays signed in for 30 days, across restarts, and the sign-in cannot be revoked.
- **Your logs.** A secret in a form Delorun does not recognise can reach an operational log ([Where Delorun keeps its logs](logs.md)).

With [Changes protection](https://docs.delorun.com/guide/changing-your-harness) off, the default, anything that can write a plugin folder you linked can change what Delorun runs before you see the change; the change is recorded and can be undone. [What you trust when you use Delorun](trust.md) states what each party, Delorun's maintainers included, can and cannot do, and the [threat model](../security/threat-model.md) lists every limit.

## For the technically curious

The [threat model](../security/threat-model.md) states every protection with the rules that define it and every limit, the [home layout contract](../contracts/c01-home-layout.md) defines the sandbox rules for Delorun's home, and the [parity checklist](../reference/parity.md) lists each consent and default with the switch that turns it back to stock.
