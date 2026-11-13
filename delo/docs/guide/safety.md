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
- [Dangerous mode](#dangerous-mode)
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
| bwrap (bubblewrap, a Linux sandbox tool) | Linux, WSL2 included | Every rule above. It hides the sockets your session keeps as files, so commands cannot start programs through `systemd-run --user`, D-Bus, tmux, screen or the X server's socket file, or use your ssh-agent, gpg-agent or keyring, and it gives read-only commands an empty `/tmp`. It also hides Docker Desktop's control sockets and Tailscale's. Under WSL2 it also hides `/run/WSL` and WSLg, so commands cannot start Windows programs. Sockets that no file names stay reachable: on a Linux desktop the X server's, and a session bus started by `dbus-launch`. |
| Landlock (a Linux kernel feature) | Linux without bwrap | The write and read rules. It cannot hide sockets, so on a machine with a desktop or login session, D-Bus, tmux or WSL it refuses to run commands at all. Elsewhere, such as in a container, commands can still connect to Delorun's control socket, which refuses them because they cannot read its token, to Docker's socket and to an ssh-agent. |
| Windows access lists | Windows | Writes only: commands can read your Delorun home, its secrets and the token included. |

Commands can still reach the network, local sockets outside the places the sandbox hides, such as one in your home folder, and everything else your user can read, such as `~/.ssh` and `~/.aws`. A command that needs your ssh-agent, such as `git push` over ssh, needs full access. The sandbox limits writes and protects Delorun's home; it does not hide the rest of your account.

## Full access

A workspace on full access runs the model's commands outside the sandbox, with everything your user can do, Delorun's home and secrets included. Every new workspace starts on Workspace Write instead.

With setup's **Safer prompts**, the default, Delorun asks for full access once per workspace before it applies: pick Full access in a chat, choose "Allow for this chat" on an approval card that asks for full access, use Settings, Permissions, or run `delorun workspace full-access <folder> on`, and you answer on the home's own computer. A single command can still ask to run outside the sandbox: DeepSeek Harness asks you, and its question does not say that such a command can read Delorun's home. With **Same as stock**, a workspace switches to full access after the studio's own confirmation, as in DeepSeek Harness, and that confirmation can come from a phone signed in over remote access too.

To take full access away, use Revoke in Settings, Permissions, pick Workspace Write in a chat of that workspace, or run `delorun workspace full-access <folder> off`. The workspace's open chats go back to Workspace Write within a second in every running profile, because each one watches the list of full-access grants. If a profile cannot watch it, its log says so, and its chats pick up the change the next time they check a permission. A running `delorun headless` task picks up the change only when it next checks a permission.

## Consents

Setup's prompts question decides how Delorun asks before risky changes, and `delorun setup prompts` changes the answer:

| | Safer prompts (default) | Same as stock |
| --- | --- | --- |
| A workspace switched to full access | Asks once per workspace, as [Full access](#full-access) explains | Switches after the studio's confirmation |
| The model writes `AGENTS.md`, a skill or a preset with its file tools | Asks first, says the text will load as instructions in every future chat it reaches, and shows the diff; nothing is written until you allow it | Written as any file |
| A new MCP server that runs a command | Held until you allow it at your computer, as [MCP servers](#mcp-servers) explains | Runs, as in DeepSeek Harness |
| The model creates or edits a scheduled task | Asks with the task's prompt, its schedule, the chat it runs in and that chat's permission preset; a delivery is refused when that chat's preset has changed | Created as in DeepSeek Harness |

The `web_fetch` guard, the update protections and the [external-agent](#external-agents) consent stay as they are with either answer. Plugin management cannot turn off, remove or reconfigure Delorun's consent and guard plugins or the sandbox, in any mode.

A consent covers the tool it names. A shell command or code the model runs can still write `AGENTS.md` or a skill inside a writable workspace without asking.

### MCP servers

An MCP server that runs a command runs it on your computer with your access, outside the sandbox. With Safer prompts, Delorun holds a new one stopped until you allow it in Settings, Permissions or with `delorun mcp accept <server>`. Before you answer you see its command, arguments, folder and environment variable names, and the exact file that will run and the folder it runs in, found the way the server would start. On Windows you also see the command shell that runs a `.cmd` or `.bat` file. Delorun asks again when any of these changes, including when the same command now finds a different file, for example after a folder earlier in `PATH` gains a program with that name. If the file changes between your look and your answer, your answer is refused and the review shows the new file. `delorun mcp revoke <server>` or Revoke in Settings, Permissions stops a server you allowed.

### External agents

Claude Code and Codex are optional delegation plugins: the model can hand a task to one of them. An external agent runs as its own program, outside Delorun's sandbox and approval prompts. It can read and change files in the workspace and anywhere else its own settings allow, your Delorun home with its keys and tokens included, and it uses your own Claude Code or Codex sign-in and account, so any cost goes to that account.

Delorun asks before each run on the home's own computer, whichever prompts answer you gave in setup; a phone signed in over remote access cannot answer. "Allow once" starts that run only. "Allow for this workspace" lets that agent start there without asking until you revoke it in Settings, External agents, or with `delorun workspace external-agents <folder> <agent> off`; `delorun workspace external-agents` lists what you allowed. A chat on Read Only never starts an external agent, a run cannot start outside the chat's workspace, and each run stops after 30 minutes. A chat on Full access refuses every approval without asking you, so there an agent starts only in a workspace where you allowed it; a chat on Auto asks you, as on Workspace Write. `delorun headless` cannot ask anyone either, so it starts an agent only where you allowed it. A chat without a workspace folder never starts one, and the approval names the folder the agent will run in. The model cannot install or turn on these plugins, or another external-agent plugin such as the ACP one, which can run any program, through plugin management; you add them from the Plugins page or the first-run setup. A full-access chat can run any command anyway. Settings, External agents turns this question off, so agents start without asking as in DeepSeek Harness, or changes the 30-minute limit, from 1 to 1440 minutes; a change applies from the next run. Only the home's own computer can turn the question off.

## Dangerous mode

Setup's third prompts answer, **Dangerous: full access without asking**, works like Claude Code's bypass mode. It does not put every chat on full access. It makes full access available to every chat without asking: any chat can switch to full access with no consent for its workspace and no dialog, whether it runs at this computer, on a phone signed in over remote access, in a scheduled task, in a bot or in `delorun headless`. A new chat still starts on Workspace Write unless the workspace's default is full access.

A phone or browser signed in over remote access, with its unlock running, can then do everything the computer can: it changes settings and plugin rows the computer alone changes with the other answers, runs any slash command, loosens the permission new chats start in, answers the questions for MCP servers, external agents and a workspace's network, gives the approvals that reserve full access, uses terminals without a separate switch, saves or removes provider keys (it never reads a saved key back), opens a chat's folder in an application on the computer, and reads files outside the chat's workspace (never inside the Delorun home). Remote access never extends itself: only the computer, through `delorun setup`, turns the mode on, approves a new device, approves an unlock or removes a device, changes the remote-access settings and resets the home, and a device signs in as before. A device whose unlock has ended keeps every refusal it has with the other answers. [`@delo/home-auth`](../../packages/home-auth/README.md#dangerous-mode) lists each refusal the mode lifts.

What you give up: commands then run outside the sandbox with everything your user can do, including reading and changing Delorun's home, its keys and the token that controls it. The questions before writing `AGENTS.md` or skills, adding MCP servers and creating scheduled tasks are off, as in DeepSeek Harness. Text the model reads (web pages, files, repositories) can tell it to do harmful things, and in this mode nothing asks you first.

Two steps turn it on. Setup prints the warning and asks `Allow any chat to switch to full access without asking?`, which starts on No. Then you type `full access everywhere` exactly; anything else cancels and keeps your previous answer. A scripted setup needs `--yes --prompts dangerous --accept-dangerous-mode`; `--yes` alone never selects it, and a document given to `--config` needs `"acceptDangerousMode": true` beside `"prompts": "dangerous"`. Delorun refuses Dangerous when it runs as root, as Claude Code does, because full access would then reach the whole computer.

Setup writes the answer into the profile and a grant file in the home's protected `secrets/` directory. Both must be present: the profile alone grants nothing. While it is on, `delorun` prints `Dangerous mode is on: any chat can switch to full access without asking. Turn it off with `delorun setup prompts`.` at start, and `delorun status` and `delorun doctor` show it. Choose **Safer prompts** or **Same as stock** with `delorun setup prompts` to turn it off; setup removes the grant file.

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
- **The network and other sockets.** Commands reach any network host and local sockets outside the places the sandbox hides, such as one in your home folder. On a Linux desktop an X server also listens on a socket no file path names, and a session bus that `dbus-launch` started can listen on one too; commands can still reach both, and through such a bus start programs outside the sandbox.
- **Plugins.** A plugin runs with the harness's own access. Delorun does not sandbox, audit or revoke plugins. It checks a plugin's declared version ranges at install and at each start, but does not check a plugin's files again after install: a plugin from npm, git or a tarball whose files change on disk loads as it now is at the next start.
- **Instructions in text the model reads.** Web pages, files, repositories and tool output can carry instructions; the consents and the sandbox limit what follows from them, and do not detect them.
- **The studio's sign-in.** A browser that signed in stays signed in for 30 days, across restarts, and the sign-in cannot be revoked.
- **Your logs.** A secret in a form Delorun does not recognise can reach an operational log ([Where Delorun keeps its logs](logs.md)).

With [Changes protection](https://docs.delorun.com/guide/changing-your-harness) off, the default, anything that can write a plugin folder you linked can change what Delorun runs before you see the change; the change is recorded and can be undone. [What you trust when you use Delorun](trust.md) states what each party, Delorun's maintainers included, can and cannot do, and the [threat model](../security/threat-model.md) lists every limit.

## For the technically curious

The [threat model](../security/threat-model.md) states every protection with the rules that define it and every limit, the [home layout contract](../contracts/c01-home-layout.md) defines the sandbox rules for Delorun's home, and the [parity checklist](../reference/parity.md) lists each consent and default with the switch that turns it back to stock.
