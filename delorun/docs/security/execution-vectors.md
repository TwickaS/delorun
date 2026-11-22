---
description: "Platform trust across every way Delorun runs: which commands carry Delorun's protections, what the native sandbox enforces on each platform, the Docker workspace and reach, which are not built, a self-hosted home, and how each compares with stock DSH."
---

# Trust across every execution vector

English | [中文](execution-vectors.zh.md)

Delorun has no release; this page describes the code in this repository. It states what each way of running Delorun enforces, what it cannot, and how it compares with stock DSH at the same version.

The [threat model](threat-model.md) gives the parties, the assets and each defence with its contract; this page is the execution-side view. The [trust guide](../guide/safety-and-updates/trust.md) says what each party can see or do.

## The vectors

Three things decide the posture: **which command boots the Host**, **where the model's commands run** (the execution vector) and **who can reach the studio** (the reach vector).

Delorun's protections are in the CLI profile, which `delorun setup` creates and `delorun` or `delorun start` boots: upstream's web template with `@delorun/bundle-local` and `@delorun/bundle-studio`. `delorun headless` boots the home's `headless` profile, upstream's `headless` template with `@delorun/bundle-headless`: the sandbox overlay, the fetch guard, the instruction write, MCP and schedule consents, the full-access consent and the turn gate, protected from plugin management, with session-log upload off. A guard that asks a person refuses there, and full access is refused for a working directory without a grant recorded at the home's computer, in the studio or with `delorun workspace full-access`. `delorun plugin` runs upstream's own pnpm operation with none of Delorun's rows. The desktop app is upstream's, unchanged.

| Execution vector | What runs there | Enforced by | Built |
| --- | --- | --- | --- |
| Native workspace | commands run directly in your account, confined by the OS | bwrap or Landlock on Linux, Seatbelt on macOS: the kernel denies, not the tool. On Windows the ACL runner confines writes only | yes |
| Docker workspace (S2) | commands run in a container per workspace | the supervisor of [C9](../contracts/c09-runtime-supervisor.md) | no: the supervisor is built and no command launches it |
| Reach listener, your own tailnet | the routes a device session is allowed on your Tailscale address | an approved device's key plus the admission of [C4](../contracts/c04-admission.md) and the [reach design](../design/reach.md) | yes, off until you turn it on |
| Reach listener, a self-hosted relay | the same routes on your own domain | the relay of [C6](../contracts/c06-relay-protocol.md) and the admission of C4 | no: the relay's server is built and no home connects to it |

A **self-hosted home** is not a separate vector: it is the same home directory on a machine you own.

## Guarantees, by command

The rows are the guarantees a person reasonably expects of a native workspace. "Stock" is stock DSH at the same version; the CLI profile column applies to `delorun` and `delorun start`.

| Guarantee | Stock | Delorun, CLI profile | `delorun headless` |
| --- | --- | --- | --- |
| A confined command cannot write outside its writable roots | yes | yes | yes |
| A confined command cannot write under Delorun's home | no | yes | yes |
| A confined command cannot read Delorun's home (keys, tokens, credentials) | no | yes on Linux and macOS; no on Windows | as the CLI profile |
| A confined command cannot read the rest of your account (`~/.ssh`, `~/.aws`, `/etc`) | no | no, as stock | no |
| A confined command cannot reach the network | no | no, as stock | no |
| A confined command cannot connect to the Docker socket | no | yes on bwrap and Seatbelt for the active context's socket and, under WSL and on Linux, Docker Desktop's control sockets; no on Landlock and Windows | as the CLI profile |
| A confined command cannot start a Windows program through WSL's interop sockets | no | yes under WSL on bwrap; on Landlock every confined command is refused while interop exists | as the CLI profile |
| A confined command cannot start a program outside the sandbox through your session's services (`systemd-run --user`, the session or system bus, a tmux or screen server, the X server) | no | yes on bwrap and Seatbelt for their default sockets; on Landlock every confined command is refused while one of their directories exists; an X server's abstract socket and a session bus on an abstract address stay reachable | as the CLI profile |
| A confined command cannot use your ssh-agent | no | yes on bwrap and Seatbelt for the agent `SSH_AUTH_SOCK` names at start and for agents under `/tmp` and the runtime directory; no on Landlock | as the CLI profile |
| A program a confined command names in a repository's git settings, attributes or hooks never runs outside the sandbox when the harness summarises the turn's changed files | no | yes | not applicable: the change summary is not mounted |
| `web_fetch` refuses loopback, link-local and private-network targets | no | yes | yes |
| A model-authored write to instructions needs an approval that names the effect | no | through the file tools only; a shell command or PTC code writes without it | through the file tools only, and the write is refused because no one can answer |
| A chat cannot switch off, reconfigure or remove Delorun's guards through `plugin_manager` | no | yes, judged on the profile's composed rows; a full-access command can still edit the profile's files | no |
| A new stdio MCP server needs the person's consent | no | a new stdio server is held with its command named until the person accepts it at the home's computer, in the studio's Settings, Permissions or with `delorun mcp accept`, after which it starts without a restart; revoking the acceptance there or with `delorun mcp revoke` stops it again | no |
| A scheduled delivery is refused when the target chat's permission preset changed | no | yes | no |
| A switch of a workspace to full access needs the person's consent | no | the switch is refused until the person grants the workspace at the home's computer, in the studio's consent or with `delorun workspace full-access`; a per-call escalation still goes through upstream's approval | full access by option or variable is refused before boot for a working directory without a recorded grant |
| The release is signature-checked before it runs | no | yes, when the npm launcher starts it: every installed file is checked at each start | yes, as for the CLI profile |
| An update reports, snapshots and rolls back | no: incompatible plugins are disabled silently | yes, for the CLI home through `delorun update` | not applicable |
| Archives are a closed data schema and never evaluate code | no: `!!js` is evaluated with `new Function` | yes | yes: `delorun import` is the same command |
| A default install sends nothing about you | no: session-log upload and product analytics on by default | yes | yes: session-log upload is off |
| Plugins are pinned, integrity-checked and revocable by Delorun | no | no: the catalogue and revocation list are not built | no |

## Combinations

- **Native, CLI profile.** The OS sandbox is the boundary. On Linux and macOS your home is hidden from commands; the rest of your account and the network are not, exactly as in stock. On Windows commands can read the home.
- **Native, `delorun headless`.** The CLI profile's sandbox overlay, the fetch guard, the instruction write consent, the full-access consent and the privacy defaults apply; the MCP and schedule consents have nothing to guard, because the profile mounts no MCP client and no schedule runtime.
- **Docker workspaces and reach.** Docker workspaces are not built, and reach is built for the Tailscale private route only. Their rules are in [C9](../contracts/c09-runtime-supervisor.md), the [reach design](../design/reach.md) and the contracts it names, each with a status of what exists.
- **Self-hosted home, local only.** No listener opens beyond the loopback studio, and nothing leaves the machine except what you ask for: model requests, the tools you enable and the release checks.

## Self-hosting

A self-hosted home is a home directory (`~/.delorun`) on a machine you own and operate. What that means for trust:

- **You hold the keys.** Model credentials live on your machine; Delo Run has no route to them. The release and release-log hosts learn your IP address and the version you ask for, nothing else.
- **You own the operating system.** File permissions, full-disk encryption, backups and who can log in are yours. Delorun's protection is the home's 0700 and 0600 layout on Linux and macOS plus the sandbox's protected-home rules in the CLI profile; it is not disk encryption, and it does not defend against a program you run as the same user.
- **You own the update decision.** `delorun update` reports what an update will change and applies nothing until you confirm; it snapshots the profile and rolls back when the new release fails its health check. The signature check does not depend on the host that serves the files.
- **You can check it.** `delorun verify` reports the installed release's signature, its release-log state and its files. It reports its other checks, the confinement rules among them, as not run.

## Comparing with stock DSH

Delorun is stock DSH with a Delorun layer. On confinement the two are the same mechanism, Delorun's sandbox being upstream's, so the differences are the ones the Delorun layer adds:

| | Stock | Delorun | Where |
| --- | --- | --- | --- |
| Home protection | nothing hides the home from a confined command | in the CLI profile the home is a protected read for the in-process tools, and for confined commands on Linux and macOS | [C1](../contracts/c01-home-layout.md) |
| Reach | none | Tailscale private only, off until the person turns it on; no Funnel, relay or passkey | [reach design](../design/reach.md) |
| Permission consent | none | in the CLI profile: the full-access consent per workspace, the instruction-layer consent for file-tool writes, the consent for new stdio MCP servers, the schedule consent and the fetch guard; off in the parity composition | [C16](../contracts/c16-parity-composition.md) |
| Releases | no verification | signature, freshness, release-log check and file list before running | [C2](../contracts/c02-release-manifest.md), [C18](../contracts/c18-release-log.md) |
| Updates | silent disable and rewrite | report, snapshot, restore and rollback for the CLI home | [C3](../contracts/c03-update-report.md) |
| Archives | `!!js` evaluated during load | a closed data schema, no evaluation | [C8](../contracts/c08-archive-and-trash.md) |
| Privacy default | session-log upload and product analytics on | both off in the CLI profile; session-log upload off under `delorun headless` | [C11](../contracts/c11-setup-answers.md) |
| Plugins | unpinned, unsandboxed | the same: Delorun pins nothing beyond upstream's lockfile, and the revocation list is not built | [C13](../contracts/c13-catalogue-revocation.md) |

## What no vector protects against

These limits hold in every vector and are stated here rather than left implied:

- **A program running as your user.** It reads `~/.delorun`, the credentials file, the session log and everything else. That is what an operating-system account is.
- **A compromised operating system, or a live attacker with your account.** Same class.
- **Nothing is encrypted at rest.** Delorun's stores are plaintext under 0700 and 0600; full-disk encryption is your control.
- **A model with an approved action.** An approval names what will happen; once granted, the action happens. The consents bound what can be asked, not whether an approved action is wise.
- **A plugin.** A plugin runs as trusted code with your access. Installing one grants it that.
- **Network egress through a command.** The fetch guard governs `web_fetch`; a shell command reaches the network.
- **What a remote host learns.** Model providers see your requests; the release and release-log hosts see your IP address and version.
