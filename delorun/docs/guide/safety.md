---
description: "What Delorun protects and what it does not, in plain language: where its protections apply, the sandbox on each platform, full access, the consents and the prompts setting, the network setting, the web_fetch guard, release checks, and the stated limits, with links to the threat model."
---

# What Delorun protects

English | [中文](safety.zh.md)

## Summary

This page helps you understand what keeps the model from doing damage on your computer, and how to loosen or tighten each protection. You need Delorun installed and running ([Install and first run](install.md)). You do not need to change anything to be protected.

Delorun runs on your computer with your own access. An agent that runs commands for you can do real damage when it makes a mistake, or when text it reads tells it to. Delorun keeps DeepSeek Harness's approvals and sandbox and adds more: commands the model runs cannot touch Delorun's own [home](../reference/glossary.md#home), risky changes ask for your [consent](../reference/glossary.md#consent) first, each workspace can limit its [network setting](../reference/glossary.md#network-setting), `web_fetch` does not reach your local network, and releases are checked before they run.

Four words recur. A [workspace](../reference/glossary.md#workspace) is a folder you let the model work in. A [chat](../reference/glossary.md#chat) is one conversation with the model, and it belongs to one workspace. A command is a program the model runs for you in a chat, such as `git` or `npm`. The [sandbox](../reference/glossary.md#sandbox) is a set of operating-system rules that limits what those commands can touch.

## Contents

- [Where the protections apply](#where-the-protections-apply)
- [The sandbox](#the-sandbox)
- [Full access](#full-access)
- [Consents](#consents)
- [The network setting](#the-network-setting)
- [The web_fetch guard](#the-web_fetch-guard)
- [Release checks](#release-checks)
- [What Delorun does not protect against](#what-delorun-does-not-protect-against)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Where the protections apply

- **The [studio](../reference/glossary.md#studio) that `delorun` starts** has every protection on this page.
- **`delorun headless`**, which answers one task and exits, has the sandbox protection, the guards and the consents. A consent that would ask you refuses instead, because no one is there to answer.
- **`delorun plugin`** has none of them. It runs DeepSeek Harness's plugin installer as you.
- **DeepSeek Harness's desktop app** is upstream's, unchanged. None of Delorun's protections apply to it.

Delorun does not start a [profile](../reference/glossary.md#profile) whose settings turn one of its protections off. It names the setting and the file, and you can fix it with [Troubleshooting](troubleshooting.md#protections-and-plugins).

## The sandbox

The sandbox limits the commands the model runs. A chat works under one of three permission levels, which you choose in the chat's permission control: **Read Only**, where commands can look but not change anything; **Workspace Write**, where every new workspace starts; and **Full access**, which runs commands outside the sandbox ([Full access](#full-access)). In a workspace on Workspace Write, commands can write only inside the workspace and in the permitted temporary folders. Delorun adds rules that keep its own home folder, `~/.delorun`, out of reach:

- Commands cannot write anywhere in your Delorun home.
- Commands cannot read your keys, Delorun's secrets or the token that controls the running Delorun. They can read only the installed releases, skills and runtimes they need, and the approved copies of your profile's plugins, so a plugin can hand the agent a tool of its own. They cannot write to those copies, and they cannot read a plugin change that is waiting for your review. Anything a plugin writes into its own approved folder, such as a cached token, is readable by sandboxed commands, so a plugin keeps its secrets in the credentials store.
- Commands cannot connect to the socket that controls the running Delorun, or to Docker's socket.

The file tools, such as `read`, `grep` and `apply_patch`, refuse your Delorun home themselves.

On Linux, run `delorun doctor` to see which sandbox your computer runs. Its `sandbox` line names the sandbox in use, or why none can run. For a failure, see [Troubleshooting](troubleshooting.md#protections-and-plugins).

| Where you run Delorun | What the sandbox enforces |
| --- | --- |
| Linux with bubblewrap installed, WSL2 included | Every rule above. It also hides your login session's sockets, so commands cannot start programs through `systemd-run --user`, D-Bus, tmux or screen, or use your ssh-agent, gpg-agent or keyring. Under WSL2 it also stops commands from starting Windows programs. Abstract sockets, such as the X server's and the session bus's on a Linux desktop, are tied to the network, so with the network setting on Open a command is refused while any of them is listening ([The network setting](#the-network-setting)). |
| Linux without bubblewrap | The write and read rules only. It cannot hide your session's sockets, so on a computer with a desktop or login session Delorun refuses to run commands at all until you install bubblewrap. |

Commands can still reach everything else your user can: other local sockets, files such as `~/.ssh` and `~/.aws`, and the network unless you limit it ([The network setting](#the-network-setting)). The sandbox limits writes and protects Delorun's home. It does not hide the rest of your account.

<details>
<summary>Edge cases</summary>

- If a command needs your ssh-agent, such as `git push` over ssh, then it fails in the sandbox. Give that workspace [full access](../reference/glossary.md#full-access), or push from your own terminal.
- If you run Linux without bubblewrap on a computer with no login session or program such as tmux holding a socket, then commands run under Landlock and `delorun doctor` shows `warn sandbox`.
- If you run Linux without bubblewrap on a desktop, then every sandboxed command is refused. Install the `bubblewrap` package and start Delorun again. If it is installed but cannot create a sandbox, see [Troubleshooting](troubleshooting.md#protections-and-plugins).
- If you run under WSL2, then the Linux rules apply and commands cannot start Windows programs.
- If a program you start yourself, outside the sandbox, reads your Delorun home, then nothing stops it. The sandbox covers the model's commands only.

</details>

<details>
<summary>Go further</summary>

- Run `delorun doctor` after installing bubblewrap or changing your system to check the `sandbox` line.
- Limit the network per workspace with the [network setting](#the-network-setting).
- Read the [threat model](../security/threat-model.md) for the sockets each sandbox hides.

</details>

## Full access

Full access is a permission a chat can have: its commands run outside the sandbox, with everything your user can do, Delorun's home and secrets included. Every new workspace starts on Workspace Write instead. You grant full access to a workspace once, at the computer that runs Delorun, and chats in that workspace can then use it.

With setup's [**Ask me first**](../reference/glossary.md#ask-me-first), the default, you can grant it in four places:

- **On an [approval card](../reference/glossary.md#approval-card).** When a command asks to run outside the sandbox, the studio shows a card with **Allow once**, which lets that one command run, and **Allow for this chat**, which switches the chat to the permission the command asked for. The chat stays there until you lower it in the composer. When the command asks for full access and the workspace has none yet, **Allow for this chat** opens the full-access dialog. **Allow full access** in the dialog records the grant for the workspace and switches the chat. When it worked, the card is answered and the command runs.
- **In a chat.** Pick Full access in the chat's permission control. The same dialog opens, with a box to tick that you understand the risks. When it worked, the control shows Full access.
- **In Settings.** Open Settings, Safety, Permissions and choose **Allow full access** beside the workspace. When it worked, the workspace shows "Allowed" with the time.
- **In a terminal.** Run `delorun workspace full-access <folder> on` and answer yes. When it worked, `delorun workspace full-access` with no folder lists the workspace.

The dialog's **Details** list what full access can reach: your files outside the workspace, Delorun's home with its keys and tokens, and Delorun's update channel.

To take full access away, choose **Revoke** in Settings, Safety, Permissions, pick Workspace Write in a chat of that workspace, or run `delorun workspace full-access <folder> off`. The workspace's open chats go back to Workspace Write within a second.

<details>
<summary>Edge cases</summary>

- If the workspace already has a grant, then the dialog is only "Switch this chat to full access?" — confirm it.
- If you cancel the dialog on an approval card, then the card keeps waiting — choose Allow once, Allow for this chat again, or deny.
- If the chat is already at or above the permission the card asks for, then **Allow for this chat** is not offered — use **Allow once**.
- If you are on a phone signed in over [remote access](reach.md), then the card says "Approve this at your computer" and nothing you tap there grants it — answer at the computer that runs Delorun.
- If the chat has no workspace folder, then the model is told to ask you to run `delorun workspace full-access <folder> on` — give the chat a folder first.
- If the folder is a filesystem root, your home folder, your Delorun home or your DeepSeek Harness home, or contains one, then `delorun workspace full-access` refuses it — choose a project folder.
- If the list of full-access grants cannot be read, then no grant counts and Settings, Safety, Permissions says so — repair or remove the file it names, then grant again.
- If you run `delorun headless` in a folder without a grant, then it refuses with "which you have not granted full access" and does not start — run `delorun workspace full-access <folder> on`, or run without full access. A running headless task sees a revoke only when it next checks a permission.
- If you choose the safer preset in a chat, then the workspace's grant is withdrawn and its other open chats on full access drop back too — grant it again to return.
- If a single command asks to run outside the sandbox with no grant, then DeepSeek Harness asks you directly, and its question does not say the command can read Delorun's home — read it as if it did.
- If you chose [**Ask less (like DeepSeek Harness)**](../reference/glossary.md#ask-less) with `delorun setup prompts`, then a workspace switches to full access after the studio's own confirmation, as in DeepSeek Harness, with no per-workspace grant.

</details>

<details>
<summary>Go further</summary>

- `delorun setup prompts` switches between Ask me first and Ask less (like DeepSeek Harness).
- Settings, Safety, Permissions, under New chats, sets the permission new chats start in.
- `delorun workspace full-access` with no folder lists every workspace and its permission.

</details>

## Consents

Setup's prompts question decides how Delorun asks before risky changes. `delorun setup prompts` changes the answer.

| | Ask me first (default) | Ask less (like DeepSeek Harness) |
| --- | --- | --- |
| A workspace switched to full access | Asks once per workspace, as [Full access](#full-access) explains | Switches after the studio's confirmation |
| The model writes `AGENTS.md`, a skill or a preset with its file tools | Asks first, says the text will load as instructions in every future chat it reaches, and shows the difference. Nothing is written until you allow it | Written like any file |
| A new [MCP server](../reference/glossary.md#mcp-server) that runs a command | Held until you allow it at your computer, as [MCP servers](#mcp-servers) explains | Runs, as in DeepSeek Harness |
| The model creates or edits a scheduled task | Asks, showing the task's prompt, its schedule, the chat it runs in and that chat's [permission preset](../reference/glossary.md#permission-preset) | Created as in DeepSeek Harness |

**Never ask (dangerous)** is a third answer. It turns the three consents off as Ask less does, and lets any chat switch to full access with no question, from the studio, a phone, a scheduled task or a script. Setup prints a warning, asks you to confirm twice and to type `full access everywhere`; it refuses the answer for the root user, and `--yes` never selects it. Choosing another answer with `delorun setup prompts` turns it off again. Settings → General → How Delorun runs offers the same three answers. Dangerous mode can be turned on there only in the studio on the computer Delorun runs on, with the same warning, a first question that starts on No, the typed phrase and the same refusal for the root user. A phone can choose Ask me first, or Ask less after confirming with Face ID or its PIN, and never dangerous mode.

With Never ask, a phone you hold unlocked has nearly the computer's authority, so treat it as the computer.

### What an unlocked phone can do with Never ask

A phone or browser signed in over remote access can then do these too, each time it confirms that action with [Face ID](reach.md#confirm-with-face-id) or your PIN, or while a Face ID pass is open (Ask again after, in Settings, Face ID):

- It changes settings and plugin rows the computer alone changes with the other answers.
- It runs any slash command.
- It loosens the permission new chats start in.
- It saves or removes provider keys (it never reads a saved key back).
- It reads files outside the chat's workspace (never inside the Delorun home). This is the same reach that full access gives the chat in this mode.

Answering the questions for MCP servers, external agents and a workspace's network, giving the approvals that reserve full access and opening a terminal ask for Face ID or your PIN every time, whatever the answer; no switch or full-access workspace waives them. Opening a chat's folder in an application stays at the computer.

A preset or consent a phone loosened this way (the permission new chats start in, or the external-agent consent turned off) is set back when the mode ends, unless you changed it at your computer since. Nothing a device does while the mode is on outlives it: a terminal switch or a workspace's full access that a device turned on is turned off when the mode ends, and chats in those workspaces go back to Workspace Write, while what you set at the computer stays.

Remote access never extends itself: only the computer, through `delorun setup`, turns the mode on, approves a new device or removes a device, changes the remote-access settings and resets the home, and a device signs in as before.

A phone that has a terminal, or that prompts a chat in a full-access workspace, has the computer's authority: a shell on the computer can run `delorun devices approve`, `elevate` and `code`, so treat a phone you hold unlocked as the computer. Without its confirmation, a phone keeps every refusal it has with the other answers, and it opens no terminal. [`@delorun/home-auth`](../../packages/home-auth/README.md#dangerous-mode) lists each refusal the mode lifts.

The `web_fetch` [guard](../reference/glossary.md#fetch-guard), the update protections and the [external-agent](#external-agents) consent stay as they are with either answer. Plugin management cannot turn off, remove or change Delorun's consent and guard plugins or the sandbox, in any mode.

<details>
<summary>Edge cases</summary>

- If a shell command or code the model runs writes `AGENTS.md` or a skill inside a writable workspace, then no consent asks — a consent covers only the tool it names, so review what a chat changed.
- If a scheduled task's chat changes its permission preset after you allowed the task, then its delivery is refused — ask the model to set the task up again so it asks you.
- If you run `delorun headless`, then a consent that would ask refuses instead — allow it first in the studio, or run without it.
- If you are on a phone, then you cannot answer a consent — answer at the computer that runs Delorun.

</details>

### MCP servers

An MCP server is a helper program that gives the model extra tools. One that runs a command runs it on your computer with your access, outside the sandbox. With Ask me first, Delorun holds a new one stopped until you allow it in Settings, Safety, Permissions or with `delorun mcp accept <server>`. When it worked, the server shows as Allowed and running.

Before you answer you see its command, arguments, folder and the names of its environment variables, and the exact file that will run. Delorun asks again when any of these changes, including when the same command now finds a different file. A server can take a secret from your stored credentials as `${credential:NAME}` in an argument or in an ordinary environment variable. The review shows that text, never the secret, and notes that it is filled in when the server starts. To stop a server you allowed, choose Revoke in Settings, Safety, Permissions or run `delorun mcp revoke <server>`.

<details>
<summary>Edge cases</summary>

- If the file changes between your look and your answer, then your answer is refused as stale — look at the new review and answer again.
- If a server's command, folder or a variable that changes what runs, such as `PATH` or `NODE_OPTIONS`, holds a `${credential:NAME}`, then the server does not load — write the value directly or use another variable name.
- If an argument that is only a `${credential:NAME}` would start with `-` once filled in, then the server does not start, because a program would read it as an option — put the option in the argument itself, as in `--token=${credential:NAME}`.
- If you decline or revoke a server, then it stays stopped until its start changes or you allow it again.
- If you run `delorun mcp accept` without a terminal, then nothing is accepted — run it in a terminal on the computer that runs Delorun.
- If Delorun is not running, then `delorun mcp` commands cannot reach it — start it with `delorun start`.
- If you are on Windows and the server is a `.cmd` or `.bat` file, then the review also shows the command shell that runs it.
- If a package runner such as `npx` starts the server, then the code it downloads each time is not checked — pin a version or install the program yourself.
- If a chat can write to the folder the server runs from, then a chat can change what the server runs — keep servers in folders chats cannot write.

</details>

<details>
<summary>Go further</summary>

- `delorun mcp list` shows servers waiting and allowed, and what changed.
- `delorun mcp decline <server>` sets a review aside without allowing it.

</details>

### External agents

Claude Code and Codex are optional plugins that let the model hand a task to another agent program, an [external agent](../reference/glossary.md#external-agent). That program runs outside Delorun's sandbox and approval prompts. It can read and change files in the workspace and anywhere else its own settings allow, your Delorun home included. It uses your own Claude Code or Codex sign-in, so any cost goes to that account.

Each agent runs at a level you choose in Settings, Safety, External agents: Careful, Standard, Your own settings or Unrestricted. Standard is the default. An approved device can tighten a level, but loosening one, and Unrestricted in particular, needs you at the computer that runs Delorun, and dangerous mode does not lift that.

Delorun asks before each run, at the computer that runs Delorun, whichever prompts answer you chose. **Allow once** starts that run only. **Allow for this workspace** lets that agent start there without asking until you revoke it in Settings, Safety, External agents, or with `delorun workspace external-agents <folder> <agent> off`. Each run stops after 30 minutes.

<details>
<summary>Edge cases</summary>

- If the chat is on Read Only, then an external agent never starts — switch the chat's permission first.
- If the chat is on Full access, then the agent starts without asking, because you already chose to run without prompts, and the chat shows "Started without asking · Full access". To make a Full access chat ask again, turn off **Full access chats start agents without asking** in Settings, Safety, External agents — then an agent starts only in a workspace where you allowed it. Only the computer that runs Delorun turns the switch on.
- If you run `delorun headless`, then no one can be asked, so an agent starts only where you allowed it, or when the run has full access, through a workspace's full-access grant or setup's **Never ask (dangerous)** answer. A run with full access starts agents without asking and without a grant, as a Full access chat does.
- If the chat has no workspace folder, then an agent never starts — give the chat a folder.
- If you are on a phone, then you cannot answer the question — answer at the computer that runs Delorun.
- If the model tries to install or turn on these plugins through plugin management, then it is refused — add them yourself from the Plugins page or the first-run setup.
- If a run needs longer than 30 minutes, then it stops — raise the limit in Settings, Safety, External agents.

</details>

<details>
<summary>Go further</summary>

- Settings, Safety, External agents sets the run time limit from 1 to 1440 minutes, which applies from the next run.
- The same page can turn the question off, so agents start without asking, as in DeepSeek Harness. Only the computer that runs Delorun can turn it off.
- `delorun workspace external-agents` lists what you allowed.

</details>

## The network setting

Each workspace has a network setting, **Open**, **Allowlist** or **Off**, that limits which hosts its sandboxed commands and `web_fetch` can reach. It starts on Open, as in DeepSeek Harness, so a fresh install changes nothing until you choose. Choose it in Settings, Safety, Network, at the computer that runs Delorun. Tightening applies at once. Letting a workspace reach more asks you to confirm.

On Linux, Open also shares your computer's network, where programs such as the display server and the session bus listen on sockets the sandbox cannot hide. A command could use them to act outside the sandbox. So when you run Delorun on a Linux desktop with the workspace on Open, Delorun checks when each command starts and refuses it while any such socket is listening, naming the socket. The first time this happens in a workspace, the chat asks you, at the computer that runs Delorun, whether to let commands run anyway in that workspace. The model cannot answer it. Allowing records the same choice as the switch **Run commands even when desktop sockets are reachable** beside Open in Settings, Safety, Network, and the command then runs; declining keeps the refusal, and the chat does not ask again in that workspace until Delorun restarts. Only the `bash` and `pwsh` tools ask, and only where the sandbox is the one on this computer; terminals you open and `delorun headless`, where no one can answer, keep the refusal and point to Settings. You can also choose Allowlist or Off for the workspace, or switch on the setting yourself. With it on, commands run, the sandbox reports itself as partly confining, and Delorun logs the sockets. The check happens when a command starts, so a socket that starts listening later is not caught. [Prompt injection and data exfiltration](prompt-injection.md#the-network-setting) explains what each choice closes and leaves open.

<details>
<summary>Edge cases</summary>

- If your sandbox cannot enforce Allowlist or Off (anything but bubblewrap on Linux, WSL2 included), then the workspace's commands are refused rather than run with your network — set it back to Open to run them.
- If you are on a Linux desktop with Open and a command is refused with a message about abstract Unix sockets, then answer the chat's question, or choose Allowlist or Off for the workspace, or accept the risk with **Run commands even when desktop sockets are reachable**.
- If the command has full access, then the setting does not apply — it runs outside the sandbox.
- If the setting's file cannot be read, then every workspace counts as Off and changes are refused — repair or remove the file Settings names.
- If you are on a phone, then the page cannot be opened — use the computer that runs Delorun.
- If you chose **Ask less (like DeepSeek Harness)** with `delorun setup prompts`, then the page says the setting is not available — run `delorun setup prompts` and choose Ask me first.
- If a command is already running, then it keeps the network it started with — restart the workspace's terminals and jobs after tightening.

</details>

<details>
<summary>Go further</summary>

- **Add common hosts** in the Allowlist editor adds the hosts for npm, PyPI, GitHub, crates.io or Go. Review the list, then save.
- **Use default** returns a workspace to the default.

</details>

## The web_fetch guard

`web_fetch` is the tool the model uses to read a web page. It refuses addresses on your own computer and network: loopback, link-local and private-network addresses, cloud metadata addresses included. It checks every redirect and tells the model why it refused, for example `web fetch refused: the host "localhost" is a loopback address, which web_fetch does not fetch`. No setting turns the guard off.

<details>
<summary>Edge cases</summary>

- If the model runs `curl` or another command, then the guard does not apply — use the network setting for commands.
- If you configure a proxy or a remote fetch provider, then it resolves its target outside the guard.

</details>

## Release checks

- **Before install.** The launcher checks the release's signatures and its entry in the public release log, and installs nothing when either check fails ([What the launcher verifies](install.md#what-the-launcher-verifies)).
- **At every start.** The installed files are checked against their signed list, and the release is checked against the release log again.
- **Before an update.** The new release passes the same checks before it is installed beside the running one ([Updates](updates.md)).

They prove that you run the release Delorun's keys signed and logged publicly. They do not prove that the release has no defects.

<details>
<summary>Edge cases</summary>

- If the release log contradicts the release at start, then the start stops — run `delorun verify` to see every check.
- If the release log cannot be reached, then you get a warning and the start goes on — check your connection.
- If you are offline and want to check anyway, then `delorun verify --offline` runs the checks that need no network.
- No setting turns the release-log check off.

</details>

<details>
<summary>Go further</summary>

- `delorun verify --release <version>` checks a named release, and `--json` prints the result for scripts.

</details>

## What Delorun does not protect against

- **Programs running as you outside the sandbox.** Any program you run, and any command you let run with full access, can read and change everything in your Delorun home, use its token to approve a device or open the studio, and change the checks.
- **Linux without bubblewrap.** Where Delorun runs commands there at all, they can connect to Docker's socket, which gives root on a rootful Docker.
- **The network and other sockets.** Commands reach any network host unless you limit it, and local sockets outside the places the sandbox hides, such as one in your home folder. On a Linux desktop an X server also listens on a socket no file names, and a session bus that `dbus-launch` started can too. With the network setting on Open, Delorun refuses a command while any such socket listens, unless the workspace accepts that risk ([The network setting](#the-network-setting)); a socket that starts listening after the command starts is not caught. With the risk accepted, commands can reach those sockets, and through such a bus start programs outside the sandbox.
- **Plugins.** A plugin runs with the harness's own access. Delorun does not sandbox, audit or revoke plugins. It checks a plugin's declared version ranges at install and at each start, but not its files again after install. A plugin from npm, git or a tarball whose files change on disk loads as it now is at the next start.
- **Instructions in text the model reads.** Web pages, files, repositories and tool output can carry instructions. The consents and the sandbox limit what follows from them. They do not detect them ([Prompt injection](prompt-injection.md)).
- **The studio's sign-in.** A browser that signed in stays signed in for 30 days, across restarts, and the sign-in cannot be revoked.
- **Your logs.** A secret in a form Delorun does not recognise can reach an operational log ([Where Delorun keeps its logs](logs.md)).

With [Changes protection](changing-your-harness.md) off, the default, anything that can write a plugin folder you linked can change what Delorun runs before you see the change. The change is recorded and can be undone. [What you trust when you use Delorun](trust.md) states what each party, the maintainer included, can and cannot do.

## Next

- To limit what a workspace can send out, read [Prompt injection and data exfiltration](prompt-injection.md).
- To reach the studio from your phone, read [Reach the studio from your phone](reach.md).
- To see what each party can see and do, read [What you trust when you use Delorun](trust.md).
- If something went wrong, find the message in [Troubleshooting](troubleshooting.md).

## For the technically curious

The [threat model](../security/threat-model.md) states every protection with the rules that define it, and every limit, including the sandbox rules per platform and the sockets each one hides. The [home layout contract](../contracts/c01-home-layout.md) defines the sandbox rules for Delorun's home. The [parity checklist](../reference/parity.md) lists each consent and default with the switch that turns it back to stock.
