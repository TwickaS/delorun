---
description: "Delo's threat model: the goal of never being less safe than stock DSH and each changed default, the assets, what each party can see and do, the defence at each trust boundary with the contract that specifies it, what Delo does not protect against, and how changes keep the model true."
---

# Delo threat model

English | [中文](threat-model.zh.md)

## Summary

This page states what Delo protects, against whom, how, and where it cannot. It extends upstream's [safety statement](../../../SAFETY.md) and [process sandbox reference](../../../docs/subsystems/sandbox.md), which apply to Delo unchanged, with Delo's assets, parties, trust boundaries and limits. Each boundary links the contract that specifies its defence and its denial tests; where the package that implements a defence has not shipped, this page states the contract's requirement. `delorun verify` reports which defences hold on a given machine. Report a suspected vulnerability through [SECURITY.md](../../../SECURITY.md).

## Contents

- [Goal](#goal)
- [Assets](#assets)
- [Parties and trust](#parties-and-trust)
- [Boundaries and their defences](#boundaries-and-their-defences)
- [What Delo does not protect against](#what-delo-does-not-protect-against)
- [How changes keep this true](#how-changes-keep-this-true)

## Goal

Delo is never less safe than stock DSH on any path, and it is safer where it changes a default. Delo runs upstream's code at a named DSH release and keeps upstream's approval, permission and sandbox decisions, including the rule that an approval request with no answerer is denied ([approval](../../../docs/subsystems/approval.md)). Delo adds protections around them, and each Delo change that moves an approval, a refusal or an escalation follows [the rules below](#how-changes-keep-this-true). The [parity composition](../contracts/c16-parity-composition.md) switches every model-visible Delo change off and replays upstream's recorded scenarios, so stock behaviour stays reachable and checked.

Upstream's safety statement holds for Delo as written: sandboxing, approvals and permission controls reduce risk and do not guarantee isolation. In a native workspace, commands run with the person's own access.

Delo changes these defaults. The [parity checklist](../reference/parity.md) lists each one with its evidence.

| Default | Stock DSH | Delo | Effect on safety |
| --- | --- | --- | --- |
| Confinement of native commands | The sandbox confines file writes; reads, Unix sockets and the network stay open | The sandbox also denies confined commands writes under Delo's home, reads under it except three exemptions, and connections to the home's control channels and the Docker socket, wherever the dialect enforces each rule ([C1](../contracts/c01-home-layout.md)) | Safer; `delorun verify` reports each rule per machine |
| Full access | One permission default for every workspace | A new workspace starts on `workspace-write`, and full access needs one consent per workspace; the escalation prompt states that full access reaches Delo's home, its keys and tokens, the Docker supervisor and the update channel | Safer |
| `web_fetch` targets | Loopback, link-local and private-network hosts are fetched in every mode without confirmation ([web-fetch-http](../../../packages/web/web-fetch-http/README.md)) | The fetch guard refuses those targets, cloud metadata addresses included, with a typed reason the model reads | Safer; the person can switch it off |
| Scheduled tasks | One approved call creates turns that recur unattended | Creating or editing a task names the recurrence, the target session and its permission preset; delivery into a full-access workspace needs a per-workspace consent | Safer |
| Instruction-layer files | A model-authored write to a skill, a preset or an `AGENTS.md` is approved, if at all, as a file write | The approval names the effect, that the text loads as instructions in every future chat of its scope, and shows the diff | Safer |
| MCP servers | Each server command runs as trusted code outside the agent sandbox | Adding a server asks for consent on a screen that names the command and its arguments | Safer |
| Data sharing | Desktop analytics and DeepSeek session-log upload on | Both off until the person turns them on; Delo has no telemetry of its own | Safer |
| Container denials | No Docker workspaces | A file operation that a container's read-only root refuses carries a marker and no escalation hint | Applies only in Docker workspaces |
| Studio additions | Stock look, no main chat | On, including the main chat, whose tools that write another workspace's instructions, import a workspace or restore one ask every time | New tools, each standing effect asks |
| `plugin_manager` read actions | Every action needs a `danger-full-access` escalation | `list_plugins`, `list_bundles`, `list_version_exemptions`, `history` and `read_config` run without it; `read_config` redacts secret fields and withholds the values of a Config that is not a native schema; every write action still escalates | The one default that removes an escalation: narrow, switchable and off in the parity composition |
| Onboarding mode and model-visible tools | Standard mode; no `preset_inspect` or doctor | PTC preselected; `preset_inspect` and the doctor added, each switchable | No change to approvals or confinement |
| Home directory | `~/.dsh` | `~/.delo` at mode 0700; `~/.dsh` is never read or written | Separates the two homes |

## Assets

- **The person's files and workspaces**: workspace roots on the machine, and the roots a Docker workspace mounts.
- **Model-provider keys and other secrets**: upstream's `.credentials.yaml` and `.env` under the home; Delo's secrets under `~/.delo/secrets/`, which hold the home-auth, relay and TLS keys, session secrets, and the deploy keys and tokens a workspace forwards.
- **Sessions**: chat history, which often holds secrets, with attachments, the full-text index, spill files and drafts in the browser.
- **Delo's home**: `~/.delo` with its secrets, the per-start token, the sockets of the Docker supervisor and the update channel, the verified release root and checkpoint, the catalogue cache and the runtime store.
- **Release integrity**: signed release manifests, runtime files, workspace images, desktop installers and the npm launcher, and the offline root and targets keys that sign them.
- **The plugin supply**: installed plugins with their pinned versions and integrity hashes, the catalogue index, the revocation list and the catalogue key.
- **Studio access from other devices**: studio addresses, trusted device keys, the identity factor, the recovery kit, and the home's TLS certificate and key.

## Parties and trust

### The person

The person owns the home and the machine. They can see and do everything their operating-system user can: every file under the home, every chat and secret, and `delorun` and Docker where their account can run them. Delo's checks do not hold the person back: `delorun verify` reports, and in `enforce` mode a failed check blocks only the start or reach it names. The person approves escalations, consents, devices and updates, and each prompt states its effect before they answer.

### The model and its tool calls

The model sees the system prompt, the chat's history, tool descriptions and tool results. Any of that text can carry instructions injected through web pages, files, repositories, issues, other chats or tool output; an imported chat's history stays out of model context until the person marks it trusted. The model can call the tools its preset gives it, each through upstream's approval and the workspace's sandbox mode, and request an escalation that only the person can approve; it does not see the escalation prompt. Its commands run with the person's own access, confined as [C1](../contracts/c01-home-layout.md) states, and its `web_fetch` calls reach only targets the fetch guard allows. A Delo tool with a standing effect, such as writing another workspace's instructions, importing a workspace or restoring one, asks the person every time.

### Plugins

Plugins are code the person installs, trusted to the extent of their install. A Host plugin runs in the harness process with the harness's authority: it can read what the Host reads, including the credentials the Host loads and the start token the home process holds in memory, and can send the update channel and the Docker supervisor any request in their fixed request sets. A client plugin runs in the studio's page with the signed-in session's access. Delo does not sandbox plugins and does not audit them; it pins versions with integrity hashes, checks version requirements and disables revoked versions at their next load. Each MCP server command runs as trusted code outside the agent sandbox, as upstream states, and Delo asks for consent naming the command when a server is added.

### Other local processes under the same user

A process of the person's user that runs outside the sandbox can read and change everything under the home, read the start token, and run `delorun` and `docker` whenever the person can. Delo claims no protection against such a process. The home's modes protect against other users, not against it, and no root-owned helper exists. Verification detects tampering by such a process only when the tampering does not also alter the launcher, the stored root or the checks.

### Other users on the machine

Other non-administrator users cannot read the home, whose directories have mode 0700 and protected files 0600, or on Windows a DACL that allows only the person, `SYSTEM` and Administrators. They cannot connect to the home's sockets, which have mode 0600 inside a 0700 directory, or to its named pipes, whose DACL grants only the person and rejects remote clients. They can open a TCP connection to the studio's loopback listener, which admits only upstream's launch token or a session cookie. An administrator or root can do everything the person can. On a rootful Docker engine, membership of the `docker` group is equivalent to root.

### The network

A party on the network sees the machine's connections. By default Delo makes these requests to fetch public signed files: the release-log check at each start, the revocation list at each Host start and every 6 hours, update checks, and image pulls for Docker workspaces. They reveal the machine's IP address, the request times and the Delo version to their hosts. The files are verified by signature, so their hosts are not trusted: a changed file fails verification, and a withheld one is noticed when its signed metadata expires. The studio listens on loopback until the person turns reach on, and reach ends TLS on the home. A Docker workspace reaches the network only through its egress proxy and allowlist.

### Tailscale, the person's own relay and OIDC provider

- **Tailscale** carries Tailscale reach with no Delo infrastructure. Tailscale's coordination service and certificates are trusted instead: Tailscale can add a device to the tailnet unless Tailnet Lock is on, and it holds the TLS key of a `ts.net` name. Funnel's servers also see connecting IP addresses and traffic volume.
- **A self-hosted relay** is run by the person on their own server and domain. Its operator sees the studio's name, the IP addresses of the home and of each connecting device, connection times and traffic volume, and forwards encrypted bytes it cannot read while the own-domain conditions [below](#reach-providers) hold. Client addresses it asserts are marked unverified.
- **The person's OIDC provider** can state who signed in and can refuse a sign-in. A token it issues does not sign in on its own: the home also requires an approved device key.

### Delo Run, the project

Delo Run holds the offline root and targets keys, the online timestamp key and the online catalogue key. It publishes releases, release metadata, the catalogue index, the revocation list, the documentation website and the waitlist. It can publish a release that the person may install, signed and entered in a public log; no client installs it until the person confirms an update, and no client downgrades on its own. It can disable a plugin version at its next load through the revocation list, which the studio shows with its reason and records in profile history. It cannot reach a home on its own: no Delo infrastructure lies in the path of Tailscale reach or a self-hosted relay, Delo holds no studio TLS or device key, it cannot forge a device approval or command a machine, and it cannot change an installed plugin's pinned version. The person's residual trust in Delo Run covers its releases, the catalogue and revocation list, and the `delorun.com` names that serve them.

### Upstream and dependency authors

Upstream's code is the harness, so its authors are trusted as the harness is. Delo merges each upstream release, records a verdict for every changed file, and reruns the parity replay and the plugin corpus. Dependencies are pinned by the lockfile, and the release checks the lockfile against an advisory feed. A malicious change in the tagged source or a pinned dependency is reproduced by the rebuild and signed; the signature and the log entry show where a release came from, not that it is free of defects.

### A party holding a stolen device

A trusted device holds a non-extractable device key bound to one studio address. On reach, a new sign-in also needs the identity factor. A thief who holds the device with a live session, or who can also use the identity factor, such as a passkey on the unlocked device, can act as the person on that studio address until another trusted device or the home's terminal revokes the device. Approving a further device on a reach address needs a WebAuthn user-verified assertion and the code the new device shows. A stolen computer that runs the home gives its holder everything the person's user holds; Delo relies on the operating system's login and disk encryption there.

## Boundaries and their defences

Each section names the boundary, the defence its contract requires and the check that reports it.

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

[C1](../contracts/c01-home-layout.md) adds five rules to upstream's sandbox profiles for every command that runs under `read-only` or `workspace-write`: no writes under the home (`home-write`), no reads under it except `runtimes/`, `skills/` and `dsh-runtimes/` (`home-read`), no read of the start token (`token-read`), and no connection to the home's channels (`home-connect`) or to the Docker socket at its real path (`docker-connect`).

- Delo's secrets live in files under `secrets/`, mode 0600 inside 0700 directories, and never under a read exemption, in a profile, a command line, a command's environment or a log. Upstream's credential files lie under the home and fall under `home-read`. Delo does not use the OS key store, because confined commands can reach the Linux Secret Service over D-Bus and run the `node` executable a macOS keychain item trusts.
- `workspace-write` is refused when a writable root equals, lies inside or contains the home.
- The approval prompt for `danger-full-access` states, before the person approves, that full access lets the command read Delo's home, including its keys and tokens, and reach the Docker supervisor and the update channel.
- Other Unix sockets, such as the ssh-agent socket, D-Bus and the display server, and the network stay reachable for confined commands.
- The home process probes each rule at each start, and the `confinement-rule` check reports a rule as enforced only when the dialect expresses it and its probe was refused. C1's per-dialect table states what bwrap, Landlock, Seatbelt and windows-acl enforce.

### The home's control channels

The Docker supervisor ([C9](../contracts/c09-runtime-supervisor.md)) and the update channel ([C19](../contracts/c19-home-process.md)) listen on sockets under `run/<profile>/`, or on named pipes on Windows. Each accepts a request only with the token of the current home-process start: 256 bits from the operating system's random source, compared in constant time, and never in a command line, an environment variable, a response or a log. Neither channel passes a request through: the supervisor's API has a fixed schema in which no field names an image, flag, mount, environment variable, command, device, capability or network, and an update request carries no path, archive, URL or command, so a caller holding the token can only choose a version that the home process fetches and verifies. The protection rests on confining the agent's commands, as C1 states.

### Container isolation

[C9](../contracts/c09-runtime-supervisor.md) defines Docker workspaces in two Docker shapes. Under S2 the harness runs on the machine and each Docker workspace has its own container, which isolates it from the computer and from every other workspace. The limited S3 runs the harness and every workspace in one container, which isolates the computer from the workspaces but not the workspaces from each other; its harness runs as a separate user over a read-only tree, and reach refuses to turn on.

- Every container drops all capabilities, sets `no-new-privileges`, uses the release's seccomp profile and a read-only root filesystem, and receives no Docker socket, no device and none of the host's namespaces.
- Each workspace has its own internal network with no route to the machine, and leaves only through its egress proxy, which refuses loopback, link-local, private and the machine's own addresses and allows the default allowlist unless the person chooses otherwise for that workspace.
- The supervisor mounts only workspace roots under parents chosen at setup, and refuses `/`, `$HOME` and `~/.delo`.
- It runs only the S2 and S3 images whose digests the verified release manifest lists, pulled by digest.
- Credential forwarding is off by default and chosen per workspace: a deploy key for one repository, an ssh agent that confirms each use, or a repository-scoped token. The studio states that the workspace's code can act as the person within that scope.
- The capability report states each limit as enforced only when inspecting a probe container shows it; setup lists every limit before the person chooses a shape, and recommends Docker's rootless engine.

### Admission and listeners

The studio's loopback listener keeps upstream's sign-in. Reach is off until the person turns it on, and setup's `--yes` and `--config` forms never turn it on ([C11](../contracts/c11-setup-answers.md)). [C4](../contracts/c04-admission.md) requires that the reach listener authenticate each request in its dispatcher before any route, upgrade or fallback, serve only a pre-login allowlist before sign-in, refuse upstream's launch tokens, `/connect`, upstream session cookies and any `Host` other than a bound name, keep reach sessions server-side, hashed and revocable, and send a Content Security Policy that keeps images and media to the studio's own origin. The `reach-binding` check reports the listener's binding and the active reach option.

### Device approval

[C5](../contracts/c05-device-approval.md) requires that a home have no owner until the first device presents the owner code on loopback, or on the tailnet-private path where C7 trusts tailnet identity, and that reach stay off until then. A trusted device approves a new one only inside a live session, by typing the code the new device shows, and on a reach address with a WebAuthn user-verified assertion. A device key is bound to one studio address, so a new address approves each device again. An approval prompt marks a location derived from a relay-asserted client address as unverified. `delorun devices reset` needs the home stopped, turns reach off, rotates the loopback session secret and notifies every trusted device. The desktop app pins the home's TLS leaf key, on homes that keep one across certificate renewals, and is approved like any device when it opens another home. The `owner-and-devices` check reports the owner, the trusted devices and the identity factor of each address.

### Reach providers

[C7](../contracts/c07-reach-providers.md) defines the reach options and the statement each shows of what its provider can see; [C6](../contracts/c06-relay-protocol.md) defines the relay protocol.

| Reach option | Delo infrastructure in the path | What the provider can see or do | End-to-end condition |
| --- | --- | --- | --- |
| Tailscale private | None | Tailscale's coordination service and certificates are trusted; Tailscale can add a device to the tailnet unless Tailnet Lock is on, and holds the `ts.net` TLS key | Only tailnet devices connect; the desktop app cannot pin a `ts.net` key |
| Tailscale Funnel | None | As Tailscale private; Funnel's servers also see connecting IP addresses and traffic volume | Funnel forwards TLS to the home |
| Self-hosted relay on the person's domain | None | The relay operator sees the name, the IP addresses of the home and of each device, connection times and traffic volume; one live tunnel exists per name | End-to-end while the domain's CAA record binds issuance to the home's ACME account (`accounturi`) and the home answers no certificate challenge through a relay; only the RFC 8657 parameters the named CA enforces are claimed |

The `own-domain-caa` check reports the CAA record for the parameters the named CA enforces. A running home watches public certificate logs for certificates covering its name, wildcards included, and raises a certificate alert on its own screen, in the desktop app and on its other trusted devices for one it did not request. Detection follows a log's inclusion of the certificate, a delay each log's inclusion policy bounds; the desktop app's pin does not wait for the logs. The `certificates` check reports certificate state and alerts. The Delo relay is a roadmap stage and is not a reach option; the page that announces it states what Delo can see.

### Sign-in

[C14](../contracts/c14-oidc-passkeys.md) defines the identity factor: a passkey or the person's own OIDC provider, enrolled for each studio address when reach turns on. Public reach requires one; tailnet-private reach may use tailnet identity instead. The identity factor never replaces device approval: the home refuses a valid token without an approved device key. The home verifies issuer, audience, nonce and PKCE itself and refuses a token from an issuer other than the one that started the flow. Recovery, with an identity factor, uses the recovery kit and the home's terminal; without one, the terminal only. Using the recovery kit needs the identity factor and replaces the kit.

### Releases, the log and the rebuild

[C2](../contracts/c02-release-manifest.md) and [C18](../contracts/c18-release-log.md) define release integrity.

- The offline targets key signs each release manifest, and the offline root key signs every role's keys and each rotation. The online timestamp key signs only freshness, and its file expires 3 days after issue; a client refuses an expired or older timestamp and never moves to a lower version on its own.
- Every manifest has an entry in Sigstore's public Rekor log, cosigned by a witness the root lists. Installing or updating needs a verified inclusion proof, and a verifiable log failure stops the CLI start in every verification mode.
- The targets-key holder signs only after rebuilding the release from the tagged source with the published recipe on a machine they control, outside CI, and the signing command refuses without a matching rebuild record.
- The release checks its lockfile against the GitHub Advisory Database and fails on an advisory without a recorded acceptance.
- Nothing lands under `~/.delo/runtimes/` before the signature, digest and log checks pass. At every start, in every verification mode, the launcher checks every installed runtime file against the signed file list, outside the integrity package.
- The desktop app verifies the manifest, the downloaded file's digests and the log entry before every update applies, and refuses an automatic downgrade.
- The npm launcher is the pre-install trust anchor: `npx delorun` runs the launcher npm serves before any Delo check, so it is trusted through the build attestation npm publishes from Delo's release workflow, which holds no npm token. The install script is trusted through its published hash.

### The catalogue and revocation

[C13](../contracts/c13-catalogue-revocation.md) defines the catalogue index and the revocation list, both signed with the catalogue key and served from a host that is not trusted. An install pins the exact version and its integrity hash, and is refused for a revoked version or while the revocation list is stale. The list carries a sequence number against replay, expires 48 hours after issue and has a maximum cache age of 24 hours; past it, the studio says so, new catalogue installs pause, installed plugins keep loading and already revoked versions stay disabled. A revoked version is disabled at its next load with its reason and a profile history version. Badges read only "tested with Delo X", written by a publish job that runs no plugin code. Delo does not audit plugins: findings an entry lists are the author's or a reviewer's claims, which Delo does not verify, and the studio says so where it shows them. [C17](../contracts/c17-plugin-versions.md) refuses at install, and disables at start, a plugin whose DSH or Delo version requirement is unmet or unreadable, and never imports plugin code to decide. The `plugin-pins` check reports pins, badges and the revocation list's state.

### Updates and rollback

[C3](../contracts/c03-update-report.md) and [C19](../contracts/c19-home-process.md) define how an update applies. Before an update, the update report shows every plugin, bundle and profile row the target would disable, remove or change, marks what Delo cannot predict as unverified and never counts it as safe, and applies nothing until the person confirms. A report exists only for a target that passed signature, freshness and log checks. A snapshot is written first; the switch waits until no chat runs on the old runtime; a health check within 120 seconds rolls back automatically when it fails, and the person can roll back at any later time. Undo and restore of profile history run the install-time plugin checks and list the plugins, builds and exemptions they change before applying. The CLI home and the desktop app update independently, and updating one never switches the other.

### Archives and untrusted chats

[C8](../contracts/c08-archive-and-trash.md) defines export files and trash. An import validates the whole archive in staging before it writes anything and never overwrites a workspace or chat. Customisation is data under a closed schema: no `!!js` expression is evaluated, no `insert` row is accepted, and no row can set a sandbox mode, a credential reference, a reach option or egress. An archive without a signature that the importing home vouches for imports only in the unverified state, which the diff screen and the import report show. Imported plugin declarations are listed and never installed, imported presets cannot raise a permission above the person's own, imported skills start disabled, and imported chats start untrusted, with a banner naming their source and their history out of model context until the person marks them trusted. A purge removes an item from every store C8 lists; [C10](../contracts/c10-host-qualified-keys.md) keeps each connection's browser state apart, and a purge removes a chat's drafts under every host scope in the browser that performs it.

### Logs and redaction

[C20](../contracts/c20-operational-logs.md) defines Delo's operational logs. Every record passes a redactor that replaces registered secret values, secret-named fields and listed credential forms before the record is written, so no secret, token, key, owner code or cookie reaches a log. Delo's own records hold no chat text, prompt, model output, tool argument or file content. Log files have mode 0600 under the home, where confined commands cannot write them and, where `home-read` is enforced, cannot read them. While Delo runs, logs are deleted 14 days after they were written.

### Verification

[C15](../contracts/c15-verification-checks.md) defines `delorun verify` and the studio's Verification panel. The checks run in the home's process with the person's access, and every report states that a program running with that access can change the checks. A result is `pass`, `fail`, `not-enforced` or `unknown`; `not-enforced` and `unknown` never count as a pass. The mode is `warn` by default, `enforce` or `off`, and every interface that shows a result shows the mode. The badge is green only in `enforce` with every check passing. No detail holds a secret, a token, an owner code, a cookie, a key or file content.

### Parity

[C16](../contracts/c16-parity-composition.md) defines the parity composition. Its overlay loads only when the replay lane sets `DSH_SNAPSHOT_PATCH`; no shipped profile, configuration or command-line option selects it. In the parity composition the fetch guard, the scheduled-task, instruction-layer and MCP consents and the container denial marker are off, and their protections are absent there; Delo's default composition keeps each on.

### The web_fetch guard

The fetch guard makes `web_fetch` and the HTTP fetch provider refuse loopback, link-local and private-network targets, cloud metadata addresses included, with a typed reason the model reads; the tool stays in the model's tool list ([decision](../../../.agents/notes/proposed/feature/2026-11-06-delo-web-fetch-private-targets.md)). It checks the target before a request is sent. It limits `web_fetch`'s targets, not what commands can reach.

### Data sharing

Anything that leaves the machine about the person is opt-in ([C11](../contracts/c11-setup-answers.md)). Delo has no telemetry of its own. Upstream's desktop analytics and DeepSeek session-log upload stay available and off by default; setup and the consent screen turn each on or off, and `--yes` and `--config` cannot turn either on. A new default-on request to a Delo host needs the lead's approval and an entry in the network test's allowlist. The `data-sharing` check reports both opt-ins.

## What Delo does not protect against

Each limit below is stated in the contract that owns it. Where `delorun verify` can see the limit, the last column names what it reports.

| Limit | What remains possible | What `delorun verify` reports |
| --- | --- | --- |
| Landlock cannot deny a connect to a pathname socket | On a Landlock-only system a confined command can connect to the home's channels, which refuse it because it cannot read the start token, and to a rootful Docker socket, which is equivalent to root | `confinement-rule`: `home-connect` and `docker-connect` not enforced, with the socket's path; setup offers Docker's rootless engine |
| Windows does not confine reads | Where the no-read-up label's denial test does not pass, confined commands can read the home's secrets and the start token; the channels rest on the named pipes' write denial | `confinement-rule`: `home-read` and `token-read` not enforced on that machine |
| Docker over TCP or SSH | Any command with network access can reach the engine | `confinement-rule`: `docker-connect` not enforced; Docker shapes are not offered on that context |
| Other Unix sockets and the network | Confined commands reach the ssh-agent socket, D-Bus, the display server and any network host | Not reported; native mode says commands run with the person's own access |
| Escalated commands | A command under `danger-full-access` runs unconfined: it can read every secret under the home and the start token, reach both channels and change the supervisor's roots file | `confinement-rule`: unconfined for a workspace in that mode |
| Same-user processes outside the sandbox | They can read and change everything under the home, run `delorun` and `docker`, and alter the launcher, the stored root and the checks | Every report states that the checks run with the person's access and can be changed by a program with it |
| Process memory on macOS and Windows | Protection of the home process's memory rests on the operating system's rules, which no Delo test checks | Not reported |
| Plugins | A plugin runs with the harness's authority; a revocation takes effect only at its next load, up to 6 hours after the revocation plus the time until a restart; listed findings are unverified claims | `plugin-pins`: pins, badges and the revocation list's state |
| A compromised catalogue key or publish job | It could sign any index entry, badge or revocation; installed versions keep their pinned integrity | Not detectable by a client |
| Clock trust | A clock set back accepts a release timestamp, revocation list or log checkpoint past its real expiry; a clock set forward refuses fresh metadata | The refusal names the expiry and the local time |
| A home that never connects | Its release stays `unchecked` against the log, a different view of the log shown to it goes undetected, and its revocation list goes stale, which pauses catalogue installs | `release-signature`: the release's log state; `plugin-pins`: the stale state |
| Witness independence | A listed witness's cosignature is checked; its independence from the log and from Delo rests on which witnesses the root lists | Not reported |
| What a log entry or a rebuild shows | A logged, rebuilt release came from the tagged source; it can still carry a defect or a vulnerability, and the rebuild cannot show that the signer's machine and toolchain are uncompromised | `release-signature`: signature and log entry |
| Advisory coverage | The advisory check does not cover the Node binary, the native addon's toolchain, the images' system packages or the desktop app's Python and Office payloads, nor a vulnerability without a published advisory | Not reported |
| Container limits the engine does not enforce | Host gateway reachability depends on the engine; disk limits are advisory on most storage drivers, rootless engines and Docker Desktop; Docker Desktop's VM is not a user namespace for the container | `workspace-isolation`: each limit as the probe found it |
| S3 and the S2 helper | S3 does not isolate workspaces from each other; the S2 helper's key does not protect it from commands in its own container | `workspace-isolation` |
| Forwarded credentials | A workspace that forwards a credential lets its code act as the person within that credential's scope | `workspace-isolation` |
| Redaction | A secret Delo never loaded that matches no listed form can pass into a log; captured output can hold chat and file text until retention or purge removes it | Not reported |
| Log retention while Delo is stopped | Expired records stay until a Delo process starts or the person runs `delorun logs --prune` | Not reported |
| Purge residue | Fragments of a purged chat stay in process logs until their retention removes them, unless the person clears them at purge; drafts in another browser profile stay | Not reported; purge states it |
| The fetch guard's reach | Commands reach any address; a request through a configured proxy or a remote fetch provider resolves its target outside the guard | Not reported |
| Certificate detection delay | A certificate for the home's name can be used before any log includes it | `certificates`: alerts once a log includes the certificate |
| The parity composition | The protections its switches turn off are absent there | Not applicable; no shipped profile selects it |

## How changes keep this true

- A change that moves an approval, a refusal or an escalation is a `security`-class entry in the [divergence ledger](../../upstream-patches.json), carries the lead's verdict, and includes a denial test that fails before the change and passes after it ([decision](../../../.agents/notes/implemented/process/2026-11-06-delo-never-less-safe-than-stock.md)). A Delo exemption from a stock check is narrow, names the check and the case it covers, and sits behind a switch that is off in the parity composition.
- A trust-boundary change, to sign-in, devices, the relay, runtimes, archives, updates or signing, is marked Lead in its brief and gets line-by-line review, and human code owners approve security paths ([rules](../../../AGENTS.md)).
- Denial tests run against local stand-ins and never contact real services.
- This page changes in the same change as a boundary, a party's access or a limit it states.
- Security reports go through [SECURITY.md](../../../SECURITY.md), never a public issue.
