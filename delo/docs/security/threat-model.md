---
description: "Delo's threat model: the goal of never being less safe than stock DSH, the defaults Delo changes, which commands carry Delo's protections, the assets, what each party can see and do, the defence at each trust boundary as built today with the contract that specifies it, what Delo does not protect against, and how changes keep the model true."
---

# Delo threat model

English | [中文](threat-model.zh.md)

Delo has no release; this page describes the code in this repository.

## Summary

This page states what Delo protects, against whom, how, and where it cannot. It extends upstream's [safety statement](../../../SAFETY.md) and [process sandbox reference](../../../docs/subsystems/sandbox.md), which apply to Delo unchanged, with Delo's assets, parties, trust boundaries and limits. Each boundary states the defence that is built and links the contract that specifies it; a defence that is not built is named as not built, with the design or contract that holds its rules. Report a suspected vulnerability through [SECURITY.md](../../../SECURITY.md).

## Contents

- [Goal](#goal)
- [Where Delo's protections apply](#where-delos-protections-apply)
- [Assets](#assets)
- [Parties and trust](#parties-and-trust)
- [Boundaries and their defences](#boundaries-and-their-defences)
- [What Delo does not protect against](#what-delo-does-not-protect-against)
- [How changes keep this true](#how-changes-keep-this-true)

## Goal

Delo's goal is to be never less safe than stock DSH on any path, and safer where it changes a default. Delo runs upstream's code at a named DSH release and keeps upstream's approval, permission and sandbox decisions, including the rule that an approval request with no answerer is denied ([approval](../../../docs/subsystems/approval.md)). Delo adds protections around them, and each Delo change that moves an approval, a refusal or an escalation follows [the rules below](#how-changes-keep-this-true). The [parity composition](../contracts/c16-parity-composition.md) switches every model-visible Delo change off and replays upstream's recorded scenarios, so stock behaviour stays reachable and checked.

Upstream's safety statement holds for Delo as written: sandboxing, approvals and permission controls reduce risk and do not guarantee isolation. In a native workspace, commands run with the person's own access.

The CLI profile changes these defaults. The [parity checklist](../reference/parity.md) lists each one with its evidence.

| Default | Stock DSH | Delo's CLI profile | Effect on safety |
| --- | --- | --- | --- |
| Confinement of native commands | The sandbox confines file writes; reads, Unix sockets and the network stay open | The sandbox also denies confined commands writes under Delo's home and reads under it except three exemptions on bwrap, Landlock and Seatbelt, and connections to the update channel's socket and the Docker context's socket on bwrap and Seatbelt ([C1](../contracts/c01-home-layout.md)); on Windows only writes are confined | Safer on Linux and macOS; nothing reports per machine which rules hold |
| Full access | A new workspace starts on `workspace-write`, and full access needs no consent | Stock's `workspace-write` default; a switch of a workspace's preset to full access is refused until the person grants that workspace at the home's computer, in the studio's consent, which names Delo's home, its keys and tokens and its channels, or with `delorun workspace full-access`; a per-call escalation goes through upstream's approval prompt, which does not name Delo's home | Safer for preset switches; per-call escalation as in stock; "same as stock" turns the refusal off |
| `web_fetch` targets | Loopback, link-local and private-network hosts are fetched in every mode without confirmation ([web-fetch-http](../../../packages/web/web-fetch-http/README.md)) | The fetch guard refuses those targets, cloud metadata addresses included, before any connection, with a typed reason the model reads | Safer; setup's prompts answer leaves it on |
| Scheduled tasks | One approved call creates turns that recur unattended | Creating or editing a task asks with the recurrence, the target session and its permission preset, and a delivery is refused when the target chat's preset differs from the approved one | Safer under setup's default prompts answer; "same as stock" turns it off |
| Instruction-layer files | A model-authored write to a skill, a preset or an `AGENTS.md` is approved, if at all, as a file write | A write through the file tools asks with the effect, that the text loads as instructions in every future chat of its scope, and the diff; a shell command or PTC code writes without asking. The review matches the target against the roots the skill providers and the profile launcher read by device and inode of its existing directories, so a link or another letter case reaches the same answer, and folds case for the missing part where the volume is case-insensitive; a hard link asks only when it names the instruction file itself, not a file elsewhere linked to it. It is a prompt for file-tool writes, not a boundary against a model with a shell | Safer for the file tools only; "same as stock" turns it off |
| MCP servers | Each server command runs as trusted code outside the agent sandbox | A new stdio server is refused, naming its command, arguments, working directory and the names of its configured environment variables, and the absolute executable and canonical directory they resolve to, which are the paths it is started with; the review shows a value only for a variable that changes what runs (`PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PYTHONPATH`, `DYLD_*`). An acceptance belongs to one server name and covers its whole start: a change to any part, a change of the Host's working directory or `PATH` included, such as `PATH`, `NODE_OPTIONS` or `LD_PRELOAD`, is asked again naming the changed variables or paths, another server name never shares it, an acceptance recorded before the resolved paths were reviewed or before acceptances were kept per server name is not honoured (on Windows the lookup uses `PATH` and `PATHEXT` without searching the working directory first, and a `.cmd` shim is reviewed with the canonical `COMSPEC` that runs it, so a changed `COMSPEC` is asked again), and a server row waits for the consent row whatever their order. The person accepts a held server at the home's computer, in the studio's Settings, Permissions or with `delorun mcp accept`, which show the same start with the executable, directory and command shell it resolves to, and an answer to a review whose start now resolves elsewhere is refused as stale, and declines it or revokes its acceptance there or with `delorun mcp revoke`, which keeps that server stopped until its start changes; a remote device reads only the waiting servers' names and what changed, and every answer from it is refused. The review compares paths, not file contents: a server whose accepted executable or script argument sits where chats can write (a workspace, `node_modules/.bin`) runs whatever is written there later, at the next start or reconnect, and that is only warned about, not refused | Safer; a new stdio server starts after one acceptance; "same as stock" turns the refusal off |
| Guard plugins under `plugin_manager` | In full access the tool runs without a prompt and can disable, reconfigure or remove every plugin except plugin management's own components | Plugin management also protects Delo's consent and guard plugins, the update gate, the update check, `dsh-sandbox-local` and `dsh-sandbox-policy`. In every mode the tool refuses a change that, judged on the profile's composed rows before and after it, would drop, replace, reconfigure, disable or duplicate a protected row, give another row its id or add a row of a protected module, through `set_plugin`, `configure`, a bundle's install, selection, deselection or removal, `undo` or `restore`, and refuses packages that provide a protected module. A full-access command can still edit the profile's files directly and a shadowing package nested in another bundle's dependencies is not checked; a version exemption of a guard's package cannot be revoked or restored away | Safer |
| Data sharing | Desktop analytics and DeepSeek session-log upload on | Session-log upload off; Delo has no telemetry of its own. Desktop analytics belongs to the desktop app, which is upstream's and keeps it on | Safer in the CLI profile |
| Studio additions | Stock look | Delo's theme, settings layout, chat states, sidebar and onboarding; the main chat is not mounted | No change to approvals or confinement |
| Home directory | `~/.dsh` | `~/.delo`, at mode 0700 on Linux and macOS; `delorun` never reads or writes `~/.dsh` | Separates the two homes |

The parity registry also declares switches for a container denial marker, `plugin_manager` read actions without escalation, `preset_inspect` and profile history; the CLI profile turns none of them on, so stock behaviour stands for each.

## Where Delo's protections apply

- **The CLI profile.** The profile `delorun setup` creates and `delorun` or `delorun start` boots: upstream's web template with `@delo/bundle-local` and `@delo/bundle-studio`. Every protection this page names as built applies here.
- **`delorun headless`.** It boots the home's `headless` profile: upstream's `headless` template with `@delo/bundle-headless`, under C1's sandbox overlay. The fetch guard, the instruction write, MCP and schedule consents, the full-access consent and the turn gate apply, plugin management cannot turn them off, and DeepSeek's session-log upload is off, as in the CLI profile. A guard that asks a person refuses, because the profile composes no approval answerer. The full-access consent refuses full access for a working directory without a full-access grant recorded at the home's computer; a request for it in the arguments or `DSH_PERMISSION_MODE` is also refused early, before boot. The composition refuses a `headless` profile without the bundle, and the task starts only after Delo checked the bundle's rows and services. The template mounts no MCP client and no schedule runtime; the MCP and schedule consents guard one that the person's own patch adds.
- **`delorun plugin`.** It runs upstream's pnpm operation with none of Delo's rows: no protected home, no denied sockets, no consents, no fetch guard and no privacy defaults. Making every command that boots a Host apply Delo's layer is in the [native confinement design](../design/native-confinement.md#every-way-a-host-boots).
- **The desktop app.** It is upstream's, unchanged, and none of Delo's rows apply to it.
- **Windows.** The sandbox confines writes only. Confined commands can read the whole home, Delo's secrets, upstream's credential files and the start token included, and no mode or access-list check of the home runs.

## Assets

- **The person's files and workspaces**: workspace roots on the machine.
- **Model-provider keys and other secrets**: upstream's `.credentials.yaml`, which also holds the browser session secret, and `.env` under the home; Delo's files under `~/.delo/secrets/`, which hold the home key `delorun export` creates and the consent records of Delo's consent plugins.
- **Sessions**: chat history, which often holds secrets, with attachments, the full-text index, spill files and drafts in the browser.
- **Delo's home**: `~/.delo` with its secrets, the per-start token, the update channel's socket, the verified release root and checkpoint, and the runtime store.
- **Release integrity**: signed release manifests, runtime files and the npm launcher, and the offline root and targets keys that sign them.
- **The plugin supply**: installed plugins, whose versions and tarball integrity upstream's plugin manager records in the profile's `pnpm-lock.yaml`.

## Parties and trust

### The person

The person owns the home and the machine. They can see and do everything their operating-system user can: every file under the home, every chat and secret, and `delorun` and Docker where their account can run them. `delorun verify` reports and changes nothing. The person approves escalations, consents and updates; Delo's own prompts state their effect before the person answers, and the per-call escalation prompt is upstream's.

### The model and its tool calls

The model sees the system prompt, the chat's history, tool descriptions and tool results. Any of that text can carry instructions injected through web pages, files, repositories, issues, other chats or tool output. An imported chat reaches no model request, because nothing opens imported chats ([C8](../contracts/c08-archive-and-trash.md#untrusted-imported-chats)). The model can call the tools its preset gives it, each through upstream's approval and the workspace's sandbox mode, and request an escalation that only the person can approve; it does not see the escalation prompt. Its commands run with the person's own access. In the CLI profile they are confined as [C1](../contracts/c01-home-layout.md) states, and its `web_fetch` calls reach only targets the fetch guard allows. A shell command or PTC code it runs can write an instruction file in a writable root without the instruction consent.

### Plugins

Plugins are code the person installs, trusted to the extent of their install. A Host plugin runs in the harness process with the harness's authority: it can read what the Host reads, including the credentials the Host loads and the start token the home process holds in memory, and can send the update channel any request in its fixed request set. A client plugin runs in the studio's page with the browser's access. Delo does not sandbox plugins and does not audit them. Delo checks each plugin's DSH and Delo version requirements at install and at start ([C17](../contracts/c17-plugin-versions.md)); it pins nothing beyond upstream's lockfile, and the catalogue and revocation list are not built ([C13](../contracts/c13-catalogue-revocation.md)). Each MCP server command runs as trusted code outside the agent sandbox, as upstream states; in the CLI profile a new stdio server, or one whose command, arguments, working directory or environment changed, is refused.

### Other local processes under the same user

A process of the person's user that runs outside the sandbox can read and change everything under the home, read the start token, and run `delorun` and `docker` whenever the person can. With the start token it can use every operation of the update channel ([C19](../contracts/c19-home-process.md#the-update-channel)), including `devices.approve`, `devices.remove` and `studio.open-token`: it can open the approval window and approve a pending device request with its match code, cancel a request, remove a device, and obtain a fresh studio sign-in link. When it also controls a device that asks to be approved, it can approve that device with nobody present, and that device then signs in over reach. The Host's own channel token is refused for these operations, and a confined command cannot read the token file or reach the socket ([C1](../contracts/c01-home-layout.md#sockets-and-the-start-token)); that confinement is all that keeps the agent from the same actions, and a command that runs outside the sandbox, such as one approved under `danger-full-access`, has them. Delo claims no protection against such a process. The home's modes protect against other users, not against it, and no root-owned helper exists. The launcher's start check detects a changed runtime file only when the tampering does not also alter the launcher, the stored root or the runtime's identity record under `trust/runtime-files/`.

### Other users on the machine

On Linux and macOS, other non-administrator users cannot read the home, whose directories have mode 0700 and protected files 0600, and cannot connect to the update channel's socket, which has mode 0600 inside a 0700 directory. On Windows Delo checks no access list, and the home has the access the operating system gives a new directory in the person's profile. Other users can open a TCP connection to the studio's loopback listener, which admits a launch token and upstream's signed cookies ([C4](../contracts/c04-admission.md#sessions)). In the CLI profile the launch token is one-time: `delorun` obtains each from the home process with the person's start token, it expires after 60 seconds, and its first presentation consumes it ([C4](../contracts/c04-admission.md#launch-tokens)). It still travels in the URL handed to the browser launcher, whose command line other users can read on Linux without `hidepid`, so another user can race the browser to it in the seconds before the browser's first request. A cookie obtained that way, or copied from the browser, admits for 30 days. `delorun headless` and the desktop app run upstream's profiles, where the launch token stays reusable for the life of the Host process. An administrator or root can do everything the person can. On a rootful Docker engine, membership of the `docker` group is equivalent to root.

### The network

A party on the network sees the machine's connections. Installing and updating fetch the release's public signed files, and every start through the npm launcher checks the release log when the network is reachable. These requests carry no personal data, and they reveal the machine's IP address, the request times and the Delo version to their hosts. The files are verified by signature, so their hosts are not trusted: a changed file fails verification, and a withheld one is noticed at install or update when its timestamp expires. No setting turns the release-log check off. The studio listens on loopback; it listens on the person's tailnet as well only after the person turns on Tailscale private reach, which is off until then.

### Tailscale, a self-hosted relay and an OIDC provider

With reach off, no Tailscale node, relay or identity provider is in any path to the studio. With Tailscale private reach on, Tailscale carries the traffic: its coordination service sees the machine's name, the IP addresses of the machine and of each device, connection times and traffic volume, can add a device to the tailnet unless Tailnet Lock is on, and obtains the `ts.net` certificate. An added device can open the sign-in page and ask for approval, and opens no chat until the person approves it at the computer. The self-hosted relay and the OpenID Connect provider are not built, so neither is in any path. The [reach design](../design/reach.md) and contracts [C5](../contracts/c05-device-approval.md), [C6](../contracts/c06-relay-protocol.md), [C7](../contracts/c07-reach-providers.md) and [C14](../contracts/c14-oidc-passkeys.md) state what each sees and does, each with a status of what exists.

### Delo Run, the project

Delo Run holds the offline root and targets keys and the online timestamp key. It can publish a release, signed and entered in a public log. No client installs it until the person confirms: the npm launcher installs only into an empty runtime store, and `delorun update` applies only after the person confirms. No client compares versions, so a channel that a timestamp signer moved to a lower release would be offered as an update; the timestamp command refuses such a move, and clients refuse a timestamp older than the one they stored ([C2](../contracts/c02-release-manifest.md#freshness-and-rollback-protection)). Delo Run cannot reach a home: no Delo infrastructure is in any path to the studio, and it holds no key of the home. The person's residual trust in Delo Run covers its releases and the `delorun.com` names that serve their metadata.

### Upstream and dependency authors

Upstream's code is the harness, so its authors are trusted as the harness is. Delo merges each upstream release, records a verdict for every changed file, and reruns the parity replay and the plugin corpus. Dependencies are pinned by the lockfile, and the signing command checks the lockfile against an advisory feed before it signs. A malicious change in the tagged source or a pinned dependency is reproduced by the rebuild and signed; the signature and the log entry show where a release came from, not that it is free of defects.

### A party holding a stolen device

A device the person approved gives its holder the chats and the actions the allowlist permits for as long as the device is unlocked and its session lives: 12 hours without a request, 14 days at most. The allowlist is wide on purpose: an approved device can already prompt the agent, so every action no riskier than a prompt is allowed, and a holder reads and drives the chats, chooses their preset and model, organizes chats and workspaces, sets goals and scheduled follow-ups and reads the files of their workspaces. It grants no access on its own: a preset grants nothing, a workspace's full access stays the computer's answer, and every approval prompt still applies. Settings writes, slash commands, plugin changes, terminals, the folder picker, new folders and dynamic plugin code need an unlock the person approves at the computer by typing the code the device shows; an unlock lasts 15 minutes by default and 60 at most, admits nothing on another listener or in another profile, and closes the device's connections when it ends. Credentials, the account, full-access grants and device approval stay the computer's, unlocked or not ([C14](../contracts/c14-oidc-passkeys.md#elevation)). The person removes a lost device at the computer, which ends its sessions at once. A browser profile on the home's computer that holds a loopback cookie admits as the person for up to 30 days from minting, across restarts, and no command revokes it. A stolen computer that runs the home gives its holder everything the person's user holds; Delo relies on the operating system's login and disk encryption there.

## Boundaries and their defences

Each section names the boundary, the defence that is built and the contract that specifies it.

- [Confinement of native commands](#confinement-of-native-commands)
- [The home's control channels](#the-homes-control-channels)
- [Container isolation](#container-isolation)
- [Admission and listeners](#admission-and-listeners)
- [Device approval](#device-approval)
- [Reach providers](#reach-providers)
- [Sign-in](#sign-in)
- [Releases, the log and the rebuild](#releases-the-log-and-the-rebuild)
- [The catalogue and revocation](#the-catalogue-and-revocation)
- [Updates and rollback](#updates-and-rollback)
- [Archives and untrusted chats](#archives-and-untrusted-chats)
- [Logs and redaction](#logs-and-redaction)
- [Verification](#verification)
- [Parity](#parity)
- [The web_fetch guard](#the-web_fetch-guard)
- [Data sharing](#data-sharing)

### Confinement of native commands

[C1](../contracts/c01-home-layout.md) defines six rules that the CLI profile adds to upstream's sandbox for every command that runs under `read-only` or `workspace-write`; the sixth, `wsl-interop`, is stated below. The first five are: no writes under the home (`home-write`), no reads under it except `runtimes/`, `skills/` and `dsh-runtimes/` (`home-read`), no read of the start token (`token-read`), and no connection to the home's channels (`home-connect`) or to the Docker socket at its real path (`docker-connect`).

- bwrap enforces all five. Landlock enforces `home-write`, `home-read` and `token-read`, and cannot express the two socket rules. Seatbelt enforces all five. windows-acl enforces `home-write` only.
- Delo's secrets live in files under `secrets/`, mode 0600 inside 0700 directories on Linux and macOS, and never under a read exemption, in a profile, a command line, a command's environment or a log. Upstream's credential files lie under the home and fall under `home-read`. Delo does not use the OS key store, because confined commands can reach the Linux Secret Service over D-Bus and run the `node` executable a macOS keychain item trusts.
- `workspace-write` is refused when a writable root equals, lies inside or contains the home.
- Other Unix sockets, such as the ssh-agent socket, D-Bus and the display server, and the network stay reachable for confined commands. Docker Desktop's control sockets other than the context's socket are not denied.
- The approval prompt for `danger-full-access` is upstream's; it does not state that full access reaches Delo's home.
- Nothing reports per machine which rules hold: no probe runs at start, and `delorun verify` reports the `confinement-rule` check as not run.
- Under WSL, interop would let a confined command start a Windows program, which runs outside every Linux namespace, mount rule and protected home with the person's Windows account and can read Windows processes' command lines. `delorun start` names WSL's interop directory `/run/WSL` as an escape socket directory (`wsl-interop`); where it exists, bwrap hides it, so no Windows program starts through the interop sockets, whether by path, by bare name, as a copy, through `/init` or with `WSL_INTEROP` set, and Landlock, which cannot hide it, refuses every confined command instead. Under bwrap a seccomp filter also refuses vsock sockets, the transport between WSL and Windows under the interop sockets, and io_uring, whose requests create sockets the filter does not see (`vsock`); it applies on any virtual machine whose kernel offers vsock, where a program that requires io_uring fails and a 32-bit program that creates sockets through `socketcall` gets none. Abstract Unix sockets stay reachable on every dialect; WSL listens on none, and a program the person runs that listens on one is reachable ([C1](../contracts/c01-home-layout.md#what-this-does-not-prove)).
- The harness itself runs git over a workspace's repository to record each turn's changed files. Each of those commands runs in the Session's sandbox with the Session's writable roots plus the plugin's snapshot directory, or with only that directory writable when the Session is `read-only`; it runs unconfined only when the Session's commands do, and a command the sandbox cannot confine, or a confined Session with no sandbox mounted, records nothing. The snapshot directory lies in the per-user cache directory, outside Delo's home; no dialect grants it to confined commands unless a Session's writable root contains it. Each snapshot and copy first checks it against the writable roots of every live Session and records nothing on an overlap, the harness checks the device and inode of every directory in it before each use, and its file operations there refuse a final-component link, named pipes and entries it did not create. A command run through an approved full-access escalation is not covered. Every command runs with every inherited `GIT_*` variable removed and with command-scope configuration that switches off the file-system monitor, hooks, every filter and diff driver the repository's configuration defines, the pager, editors, credential helpers and transports, so a `.git/config`, `.gitattributes`, hook or `.git` file that a confined command writes starts no program ([workspace-changes](../../../packages/deliverables/workspace-changes/README.md#git-hardening)). Stock runs these commands unconfined with the repository's configuration in effect.
- The person's own git and editors are not hardened. Under `workspace-write` a confined command can write a repository's `.git/config`, its hooks and its attributes, and the next time the person runs git or an editor's git integration in that repository outside the sandbox, a program such a setting names runs with the person's full access. A [design option](../design/workspace-git-state.md) for keeping those files read-only to confined commands is open for decision.
- The file tools apply `home-read` and `home-write` themselves. `read`, `read_image`, `apply_patch` and `str_replace_editor` refuse a path under the home or another path that reaches it, outside the read exemptions, and the local filesystem confirms that the file or directory it opens is the one it checked, so a workspace directory replaced by a link to the home between the check and the open fails the read: on Linux by the descriptor's own path, elsewhere by its device and inode, where a link swapped in and restored between those lookups is not detected. The write fence refuses the home and every other mount of it the provider finds, and the local filesystem holds the target's directory open and confirms it for every edit, write, create, move and delete, creating missing directories one at a time, so a directory swapped for a link to the home after the fence's check fails the change instead of reading, creating or removing a file there; outside Linux it confirms by path, and a link swapped in and restored between those checks is not detected. `glob` and `grep` resolve their root before ripgrep starts and run ripgrep confined under `read-only`, so the dialect's `home-read` holds for a search at every depth, as for a command; where no runner can confine, the search fails, and on Windows, which confines no reads, a link swapped in and restored during a search is not detected. The tools may also read their own chat's directory under `spill/`, where tool output too long for that chat is saved and which the spill notice tells the model to read, and no other chat's, which also leaves a forked chat unable to read the spill files it inherited; confined commands cannot read `spill/` at all. Spill files are written only under `spill/` (mode 0700, tightened if looser): when the home cannot hold it, the output stays in the chat instead of going to a temporary directory that confined commands could read.
- Commands and the other processes the harness starts through its subprocess service inherit its environment without the entries upstream's filter drops: names that hold credentials, such as `*_TOKEN`, `*_CREDENTIALS`, `*PASSPHRASE*`, `MYSQL_PWD`, `KUBECONFIG` and `KRB5CCNAME`, and values holding a URL with user information, a token alone such as `https://<token>@host` or a Sentry DSN included. A search list such as `PATH` loses only its elements that name a credential file or an agent socket. A credential under a name and in a form the filter does not know is inherited.
- Some tools start programs outside the sandbox in the workspace: the Claude Code and ACP subagent tools start their agent processes, and the stdio language-server tool starts language servers, unconfined. Those programs read the workspace's files and configuration with the person's full access, so a file a confined command wrote there can change what they do.

The probes, the check, the prompt's statement, Docker Desktop's control-socket directories, Windows and the same rules under `delorun headless` are in the [native confinement design](../design/native-confinement.md).

### The home's control channels

The update channel ([C19](../contracts/c19-home-process.md)) listens on the socket `run/<profile>/update.sock`. It accepts a request only with the token of the current home-process start: 256 bits from the operating system's random source, compared in constant time, and never in a command line, an environment variable, a response or a log. It does not pass a request through: an update request carries no path, archive, URL or command, so a caller holding the token can only choose a version: one the home process fetches and verifies from the channel, or one already installed in the runtime store. The protection rests on confining the agent's commands, as C1 states, and holds only where the dialect denies reads of the token. The Docker supervisor's channel of [C9](../contracts/c09-runtime-supervisor.md) does not listen, because no command launches the supervisor, and no named pipe exists on Windows.

### Container isolation

Docker workspaces are not built. [C9](../contracts/c09-runtime-supervisor.md) specifies them and the supervisor that would create them; the supervisor package exists, and `delorun start` never launches it.

### Admission and listeners

[C4](../contracts/c04-admission.md) defines admission. The loopback listener, `127.0.0.1:3080` in the CLI profile, runs upstream's admission with one-time launch tokens turned on: a launch token that works once within 60 seconds, `/connect`, and stateless signed cookies that expire 30 days after they are minted, with no idle limit, no server-side record and no revocation. A reader of the home's `.credentials.yaml` can sign such a cookie without any launch token. Every browser holding a cookie acts as the one owner, and the loopback studio sends no Content Security Policy. Setup's `--yes` and `--config` forms never turn reach on ([C11](../contracts/c11-setup-answers.md)); `delorun reach on tailscale` and the yes answer in setup's Full mode do. With reach on, the reach listener's dispatcher authenticates every request before any route, upgrade or the fallback. Loopback credentials are upstream's launch cookie and API credential, admitted by upstream's built-in admission; no per-credential record exists, so nothing refuses a valid credential for lacking one. Recording each loopback credential with a 7-day idle limit is in the [reach design](../design/reach.md#loopback-credentials) and is not built.

### Device approval

[C5](../contracts/c05-device-approval.md) specifies device approval and `@delo/home-auth`, which every CLI profile loads, builds it for the Tailscale private route. A new device is approved only at the home's computer: the person opens a 5-minute approval window there, and the device is approved by typing the 8-digit match code its screen shows, either in the studio on loopback, which needs the studio's own credential, or with `delorun devices approve` over the update channel, which needs the start token. The home cannot verify where a request comes from, because every request on the route has the source `127.0.0.1`; the match code is what binds an approval to the device whose screen the person read, and it does not prove who holds that device. A reach session cannot approve or remove a device, open a window or claim the home ([fundamentals](fundamentals.md) F12 and F13). Passkeys, the recovery kit, reset and alerts are not built.

### Reach providers

The Tailscale private provider is built ([C7](../contracts/c07-reach-providers.md)): it serves a fixed local port through `tailscale serve`, refuses Funnel, removes serve rules on its port that it does not own, and rechecks Tailscale every minute. The Funnel and own-domain providers are not built, and the self-hosted relay's server is built and no home connects to it ([C6](../contracts/c06-relay-protocol.md)). The specs fake `tailscale`; the [reach design](../design/reach.md#never-run-on-a-real-tailnet-or-phone) lists what no real tailnet or phone has exercised.

### Sign-in

The loopback studio signs in with a launch token from `delorun open`. A reach session signs in with an approved device's key alone, the identity factor `tailnet-membership` ([C14](../contracts/c14-oidc-passkeys.md#tailnet-membership)). C14 also specifies the passkey and OpenID Connect identity factors, which are not built.

### Releases, the log and the rebuild

[C2](../contracts/c02-release-manifest.md) and [C18](../contracts/c18-release-log.md) define release integrity.

- The offline targets key signs each release manifest, and the offline root key signs every role's keys and each rotation. The online timestamp key signs only freshness, and its file expires 3 days after issue; a client refuses an expired or older timestamp.
- Installing or updating needs a verified inclusion proof in the release log, cosigned by a witness the root lists. At each start, a verified release-log failure stops the start; an offline or unknown result never blocks one.
- The targets-key holder signs only after rebuilding the release from the tagged source with the published recipe on a machine they control, outside CI, and the signing command refuses without a matching rebuild record.
- The signing command checks the lockfile against the GitHub Advisory Database and refuses on an advisory without a valid acceptance.
- Nothing lands under `~/.delo/runtimes/` before the signature, digest and log checks pass. At every start the npm launcher checks every installed runtime file against the signed file list: it hashes each file, or compares the file's identity with the one recorded after its last hash, and hashes every file at least every 7 days by default. Storage corruption that leaves a file's change time alone is found by that full pass or `delorun verify`, not by the next start.
- The npm launcher is the pre-install trust anchor: `npx delorun` runs the launcher npm serves before any Delo check.

No release workflow exists: re-signing the timestamp every 24 hours, publishing to npm with a build attestation and without a token, and the install scripts are in the [release workflow design](../design/release-workflow.md). The desktop app's updater is upstream's and checks no Delo signature or log entry ([update and rollback design](../design/update-and-rollback.md#the-desktop-app)).

### The catalogue and revocation

The catalogue and the revocation list are not built ([C13](../contracts/c13-catalogue-revocation.md)): Delo pins no plugin version beyond upstream's lockfile and can disable no installed version. [C17](../contracts/c17-plugin-versions.md) refuses at install, and disables at start, a plugin whose DSH or Delo version requirement is unmet or unreadable, and never imports plugin code to decide. Delo does not audit plugins.

### Updates and rollback

[C3](../contracts/c03-update-report.md) and [C19](../contracts/c19-home-process.md) define how an update of the CLI home applies. Before an update, `delorun update` shows every plugin, bundle and profile row the target would disable, remove or change, and whether the chat data's format changes, marks what Delo cannot predict as unverified and never counts it as safe, and applies nothing until the person confirms. A snapshot is written first; the switch waits until no chat runs on the old runtime, and new turns are refused meanwhile; a health check within 120 seconds rolls back automatically when it fails, and the person can roll back later with `delorun recover`. `delorun recover restore` applies a profile history version at once, without an approval prompt or the install-time plugin checks. The desktop app updates through upstream's updater.

### Archives and untrusted chats

[C8](../contracts/c08-archive-and-trash.md) defines export files and trash. An import validates the whole archive in staging before it writes anything and never overwrites a workspace or chat. Customisation is data under a closed schema: no `!!js` expression is evaluated, no `insert` row is accepted, and no row can set a sandbox mode, a credential reference, a reach option or egress. An archive without a signature that the importing home vouches for imports only after the person accepts it as unverified. No customisation row is applied, and imported chats are kept where nothing reads them, so they reach no model request. Opening imported chats as untrusted chats and applying customisation are in the [imported chats design](../design/imported-chats.md). A purge removes an item from every store C8 lists, the request-image cache excepted; a purge in the studio removes the chat's drafts in that browser, and a purge from `delorun trash` or at the end of the retention reaches no draft.

### Logs and redaction

[C20](../contracts/c20-operational-logs.md) defines Delo's operational logs. Every record passes a redactor that replaces the registered secret values, which are the start token and the relay key, secret-named fields and listed credential forms before the record is written. A secret that matches no listed form and is not registered, such as a model key in an unrecognised form, can reach a log. Delo's own records hold no chat text, prompt, model output, tool argument or file content. Log files have mode 0600 under the home, where confined commands in the CLI profile cannot write them and, where `home-read` is enforced, cannot read them. Each `delorun` invocation deletes logs written more than 14 days before; a home process that runs for longer keeps them until the next invocation.

### Verification

[C15](../contracts/c15-verification-checks.md) defines `delorun verify`. It runs two checks: `release-signature`, which anchors the stored root on the roots the launcher ships and checks the manifest's signature, the timestamp's freshness and the release-log bundle, with the online log check unless `--offline`; and `runtime-files`, which hashes every installed file against the signed file list. Every other check of C15's list is reported as not run. The checks run with the person's access, and every report states that a program running with that access can change them. A result is `pass`, `fail`, `not-enforced` or `unknown`; `not-enforced` and `unknown` never count as a pass. Nothing reads a verification mode: `delorun verify` reports in `warn` and blocks nothing, and the launcher always stops on a verified signature, file or release-log failure. No detail holds a secret, a token, a cookie, a key or file content.

### Parity

[C16](../contracts/c16-parity-composition.md) defines the parity composition. Its overlay loads only when the replay lane sets `DSH_SNAPSHOT_PATCH`; no shipped profile, configuration or command-line option selects it. In the parity composition the fetch guard, the protected home of the sandbox and of the search, `read` and `present` tools, the scheduled-task, instruction-layer, MCP and full-access consents and the update gate are off, and their protections are absent there; the CLI profile keeps each on.

### The web_fetch guard

In the CLI profile the fetch guard makes `web_fetch` and the HTTP fetch provider refuse loopback, link-local and private-network targets, cloud metadata addresses included, before any connection, with a typed reason the model reads; the tool stays in the model's tool list ([decision](../../../.agents/notes/proposed/feature/2026-11-06-delo-web-fetch-private-targets.md)). It checks each redirect and connects only to the addresses it approved. It limits `web_fetch`'s targets, not what commands can reach.

### Data sharing

Delo has no telemetry of its own. In the CLI profile, DeepSeek's session-log upload is off until the person turns it on in the Privacy section of Settings, and DeepSeek's feedback send is removed; setup cannot turn upload on ([C11](../contracts/c11-setup-answers.md)). Under `delorun headless` session-log upload is off by default as well, and the desktop app keeps upstream's analytics. The release checks run whenever a release is installed, updated or started; their requests reveal the machine's IP address and version to their hosts, as [the network](#the-network) states. The update check fetches the release channel's signed files once a day, and at start when a day has passed, until it is turned off in the Privacy section of Settings; it sends no identifier. A new default-on request to a Delo host needs the lead's approval and an entry in the network test's allowlist, [`network-requests.json`](../../apps/tools/src/checks/network-requests.json), which names each request Delo makes without being asked with its hosts, purpose, switch and disclosure; its spec fails when a shipped source file that opens a network request is not listed, and does not catch a new request added to a file already listed. `delorun verify` reports the `data-sharing` check as not run.

## What Delo does not protect against

Each limit below is stated in the contract that owns it. `delorun verify` reports only the release's signature, log state and files, so no other limit is reported per machine.

| Limit | What remains possible |
| --- | --- |
| Commands outside the CLI profile | Under `delorun plugin`, a command can read the whole home, the start token and upstream's credential files included, and connect to the update channel; no consent, fetch guard or privacy default applies. Under `delorun headless`, a confined command gets the sandbox overlay's rules, and a command run with full access, which needs a grant recorded at the home's computer for the working directory, is unconfined |
| Windows does not confine reads | Confined commands can read the home's secrets, upstream's credential files and the start token, so the token does not keep them from the update channel; the home's modes and access lists are not checked; a link swapped into a search's path and restored before ripgrep finishes can reach the home |
| Filesystems that hide the home's other mounts | Where the home lies on btrfs, bcachefs or overlayfs, or the mount table does not list its device, the provider finds no other mount of it and commands run protected at the home's own paths only, so a second mount of the same filesystem stays reachable to confined commands and to the file tools; the provider reports its alias coverage as `unknown`, and nothing shows that yet ([C1](../contracts/c01-home-layout.md#what-this-does-not-prove)) |
| Landlock cannot deny a connect to a pathname socket | On a Landlock-only system a confined command can connect to the update channel, which refuses it because it cannot read the start token, and to a rootful Docker socket, which is equivalent to root |
| Docker over TCP or SSH | Any command with network access can reach the engine |
| Docker Desktop's control sockets | Sockets in Docker Desktop's control directories other than the context's socket stay reachable for confined commands |
| Other Unix sockets and the network | Confined commands reach the ssh-agent socket, D-Bus, the display server and any network host |
| Model-authored commands that write instruction files | A shell command or PTC code can change an `AGENTS.md`, a skill or a preset in a writable root without the instruction consent |
| Escalated commands | A command under `danger-full-access` runs unconfined: it can read every secret under the home and the start token and reach the update channel; upstream's prompt does not say so |
| Same-user processes outside the sandbox | They can read and change everything under the home, mint loopback credentials, run `delorun` and `docker`, use the update channel with the start token (approve a device, remove devices, obtain a studio sign-in link), and alter the launcher, the stored root and the checks |
| Process memory on macOS and Windows | Protection of the home process's memory rests on the operating system's rules, which no Delo test checks |
| The loopback studio's credentials | In the CLI profile a launch token works once within 60 seconds, yet travels on the browser launcher's command line, where another user or a confined command under Landlock or Seatbelt can race the browser to it within that minute; a cookie admits for 30 days, survives restarts and cannot be revoked; a reader of `.credentials.yaml` can sign one; every holder acts as the owner, and no Content Security Policy applies |
| Plugins | A plugin runs with the harness's authority; Delo pins nothing beyond upstream's lockfile and can revoke nothing |
| Clock trust | A clock set back accepts a release timestamp or log checkpoint past its real expiry; a clock set forward refuses fresh metadata, and the refusal names the expiry and the local time |
| A home that never connects | Its release stays `unchecked` against the log, and a different view of the log shown to it goes undetected |
| Witness independence | A listed witness's cosignature is checked; its independence from the log and from Delo rests on which witnesses the root lists |
| What a log entry or a rebuild shows | A logged, rebuilt release came from the tagged source; it can still carry a defect or a vulnerability, and the rebuild cannot show that the signer's machine and toolchain are uncompromised |
| Advisory coverage | The advisory check does not cover the Node binary, the native addon's toolchain or a vulnerability without a published advisory |
| No version comparison | `delorun update` offers a channel's release whenever it differs from the running one, lower included; the timestamp command's refusal to lower a channel is the protection |
| Redaction | A secret that is not registered and matches no listed form can pass into a log; captured output can hold chat and file text until retention or purge removes it |
| Log retention | Expired records stay until the next `delorun` invocation or `delorun logs --prune` |
| Purge residue | Fragments of a purged chat stay in process logs until their retention removes them, unless the person clears them at purge; resized images stay in the request-image cache; drafts in another browser profile, and every draft after a purge from `delorun trash`, stay |
| The fetch guard's reach | Commands reach any address; a request through a configured proxy or a remote fetch provider resolves its target outside the guard |
| Code on the studio's origin | A client plugin, or injected script, runs with the browser's full access to the studio; the loopback studio enforces no Trusted Types |
| The parity composition | The protections its switches turn off are absent there; no shipped profile selects it |

## How changes keep this true

- A change that moves an approval, a refusal or an escalation is a `security`-class entry in the [divergence ledger](../../upstream-patches.json), carries the lead's verdict, and includes a denial test that fails before the change and passes after it ([decision](../../../.agents/notes/implemented/process/2026-11-06-delo-never-less-safe-than-stock.md)). A Delo exemption from a stock check is narrow, names the check and the case it covers, and sits behind a switch that is off in the parity composition.
- A trust-boundary change, to sign-in, devices, the relay, runtimes, archives, updates or signing, is marked Lead in its brief and gets line-by-line review, and human code owners approve security paths ([rules](../../../AGENTS.md)).
- Denial tests run against local stand-ins and never contact real services.
- This page changes in the same change as a boundary, a party's access or a limit it states, and a defence that a change builds moves from not built to built here in that change.
- Security reports go through [SECURITY.md](../../../SECURITY.md), never a public issue.
