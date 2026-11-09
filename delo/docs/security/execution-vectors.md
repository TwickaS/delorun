---
description: "Platform trust across every way Delo runs: the native sandbox, a Docker workspace, a reach listener, a self-hosted home and a self-tailnet — what each guarantees, what it cannot, and how each compares with stock DSH."
---

# Trust across every execution vector

English | [中文](execution-vectors.zh.md)

Delo has no release yet; this page describes the first release. It states what each way of running Delo enforces, what it cannot, and how it compares with stock DSH at the same version. Where a vector is not in the first release it says so.

The [threat model](threat-model.md) gives the parties, the assets and each defence with its contract; this page is the execution-side view. The [trust guide](../guide/trust.md) says what each party can see or do.

## The vectors

Two things decide the posture: **where the model's commands run** (the execution vector) and **who can reach the studio** (the reach vector). They combine freely.

| Execution vector | What runs there | Enforced by | In 1.0 |
| --- | --- | --- | --- |
| Native workspace | commands run directly in your account, confined by the OS | bwrap or Landlock on Linux, Seatbelt on macOS, the Windows ACL runner — the kernel denies, not the tool | yes |
| Docker workspace (S2) | commands run in a container per workspace | the container's namespaces, capabilities, cgroups, mounts and network, plus an in-container probe gate after start | yes, on an engine that offers the required limits |
| Reach listener, Delo-hosted | the same routes on a public address | the C4 admission step: identity, Host, Origin, SNI, a launch token and a server-side session | not in 1.0 |
| Reach listener, your own tailnet | the same routes on your Tailscale address | Tailscale's device identity plus the same C4 admission step | not in 1.0 |

A **self-hosted home** is not a separate vector: it is the same home directory on a machine you own, and it composes with each of the four.

## Guarantees, by vector

The rows are the guarantees a person reasonably expects. "Stock" is stock DSH at the same version.

| Guarantee | Stock | Native | Docker (S2) | Reach (planned) |
| --- | --- | --- | --- | --- |
| A confined command cannot write outside the workspace | yes | yes | yes | n/a |
| A confined command cannot read Delo's home (keys, tokens, session log) | no | yes | yes — the home is not mounted | n/a |
| A confined command cannot read the rest of your account (`~/.ssh`, `~/.aws`, `/etc`) | no | no — parity with stock | yes — the container sees only the workspace and its own root | n/a |
| A confined command cannot reach the network | no | no — parity with stock | yes by default; the workspace network has no route off the engine | n/a |
| A command cannot reach the Docker socket or the engine host | no | n/a | yes — the socket is never mounted and the bridge gateway is blocked | n/a |
| A model-authored write to instructions needs an approval that names the effect | no | yes | yes | yes |
| Adding an MCP server needs an approval that names the command | no | yes | yes | yes |
| A scheduled task cannot deliver into a chat that changed its permission preset | no | yes | yes | yes |
| A model cannot change the sandbox mode without the guard | no | yes | yes | yes |
| Every route answers 401 before sign-in | stock dispatches with no admission step | n/a | n/a | yes |
| Sessions are server-side, hashed and revocable | no — stateless 30-day cookies from a same-user-readable secret | n/a | n/a | yes |
| The release is signature-verified before it runs | no | yes | yes | yes |
| An update reports, snapshots and rolls back | no — silently disables incompatible plugins | yes | yes | yes |
| Archives are a closed data schema and never evaluate code | no — `!!js` is evaluated with `new Function` | yes | yes | yes |
| A default install sends nothing about you | no — session-log upload and product analytics on by default | yes | yes | yes |
| Plugins are pinned, integrity-checked and revocable | no | not in 1.0 | not in 1.0 | not in 1.0 |

The Docker column assumes an engine that offers every limit the gate requires. `delorun verify` and the workspace's own start report say when it does not, and a workspace that cannot show a required property is stopped rather than started.

## Combinations

- **Native only.** The OS sandbox is the boundary. Your home is hidden from commands; the rest of your account and the network are not, exactly as in stock. Choose it when the OS supports a sandbox and you want the smallest attack surface.
- **Docker only.** The container is the boundary. The workspace is the only writable host path; the home, the Docker socket and the rest of the machine are out of reach, and the workspace network has no route to your machine. Choose it when you run untrusted models or plugins, or when the OS sandbox is unavailable. It costs a Docker engine and a container per workspace.
- **Native plus Docker.** Different workspaces can use different vectors. Isolation is per workspace: a native workspace stays as open as your account.
- **Reach on top of either.** Reach changes who can talk to the studio, not where commands run. A reached studio still executes in the vector its workspace chose, and every route behind the listener answers 401 before sign-in. Not in 1.0.
- **Self-hosted home plus your own tailnet.** The combination to prefer for remote access: nothing of Delo Run is in the path, the tailnet carries the traffic, TLS terminates on your machine, and the C4 admission step still runs. Not in 1.0.
- **Self-hosted home, local only.** The simplest trust story: no listener opens, and nothing leaves the machine except what you ask for — model requests and the tools you enable.

## Self-hosting

A self-hosted home is a home directory (`~/.delo`) on a machine you own and operate. What that means for trust:

- **You hold the keys.** Model credentials live on your machine; Delo Run has no route to them. The release and catalogue hosts learn your IP address and the version you ask for — nothing else.
- **You own the operating system.** File permissions, full-disk encryption, backups and who can log in are yours. Delo's protection is the home's 0700/0600 layout plus the sandbox's protected-home rules; it is not disk encryption, and it does not defend against a program you run as the same user.
- **You own the update decision.** Every update reports what it will change, snapshots the profile and rolls back on failure. A self-hosted home can point the installer at a mirror; the signature check does not depend on the host.
- **You can check it.** `delorun verify` reports the release's verification and which confinement rules your system enforces.

## Your own tailnet

Tailscale is the reach vector Delo recommends for remote access, because the trust boundary stays with you:

- **No Delo Run service is in the path.** The tailnet carries the connection; TLS ends on your machine.
- **Device identity is Tailscale's.** Delo's C4 admission step still requires a Host, Origin and SNI match and a server-side session; the tailnet adds a layer rather than replacing it.
- **The tailnet is not the internet.** Only your devices see the studio, and tailnet ACLs decide which of them may connect at all.
- **What it does not change.** Commands still run in the vector the workspace chose, and the fetch guard governs `web_fetch`, not your shell.

## Comparing with stock DSH

Delo is stock DSH with a Delo layer. On confinement the two are the same mechanism — Delo's sandbox is upstream's — so the meaningful differences are the ones the Delo layer adds, each with the decision that argues it:

| | Stock | Delo | Why |
| --- | --- | --- | --- |
| Home protection | nothing hides the home from a confined command | the home is a protected read for the in-process tools and for confined commands | C1 |
| Reach | routes dispatch with no admission step | an admission step runs before every route, upgrade and fallback | C4 |
| Reach sessions | stateless 30-day cookies from a same-user-readable secret | server-side, hashed, revocable and authority-bound | C5 |
| Permission consent | none | a mode guard plus instruction-layer, MCP, schedule and fetch consents, off in the parity composition and on in Delo's | C16, A101 |
| Releases | no verification | signature, identity, transparency entry and log check before running | C2, C18 |
| Updates | silent disable and rewrite | report, snapshot, restore and rollback | C3 |
| Archives | `!!js` evaluated during load | a closed data schema, no evaluation | C8 |
| Privacy default | session-log upload and product analytics on | both off; nothing leaves until you turn it on | A49 |
| Plugins | unpinned, unsandboxed, stated | the same in 1.0, stated plainly; pinning and revocation land with the plugin index | A140 |

## What no vector protects against

These limits hold in every vector and are stated here rather than left implied:

- **A program running as your user.** It reads `~/.delo`, the credentials file, the session log and everything else. That is what an operating-system account is.
- **A compromised operating system, or a live attacker with your account.** Same class.
- **Nothing is encrypted at rest.** Delo's stores are plaintext under 0700/0600; full-disk encryption is your control.
- **A model with an approved action.** An approval names what will happen; once granted, the action happens. The consents bound what can be asked, not whether an approved action is wise.
- **A plugin.** A plugin runs as trusted code with your access. Installing one grants it that.
- **Network egress through a command.** The fetch guard governs `web_fetch`; a shell command reaches the network unless the vector is a Docker workspace.
- **What a remote host learns.** Model providers see your requests; the release and catalogue hosts see your IP address and version.
