# Delo glossary

English | [中文](glossary.zh.md)

The words every Delo document, skill, interface string and pull request uses, one canonical term per concept. It extends upstream's [glossary](../../../docs/glossary.md), which owns the harness's own terms (agent, session, turn, step, tool, preset, plugin, bundle, profile); this page owns what Delo adds.

Each entry gives the term, what it means in plain words and, where they differ, the name the code uses. Interface text uses the term; code and maintainer docs may add the code name in backticks. A new concept gets its entry in the same pull request that introduces it.

## Contents

- [The product](#the-product)
- [Where things run](#where-things-run)
- [Reaching a studio](#reaching-a-studio)
- [Signing in](#signing-in)
- [Changing the harness](#changing-the-harness)
- [Keeping work safe](#keeping-work-safe)
- [Community](#community)
- [Building Delo](#building-delo)
- [Writing Delo's documentation](#writing-delos-documentation)
- [Words to avoid](#words-to-avoid)

## The product

- **Delo** — the open-source project, app, with the `delorun` command: a community fork of DeepSeek Harness. <a id="delo"></a>
- **Delo Run** — the hosted service at delorun.com: the community pages and the waitlist, and with the Delo relay its accounts (email code, GitHub, optional passkey), sign-in and device approvals through Delo. Public text names the contact support@delorun.com only. <a id="delo-run"></a>
- **stock DSH** — DeepSeek Harness as upstream releases it. **stock look** — Delo with its studio additions turned off. <a id="stock"></a>
- **studio** — the harness's web interface, the same in a browser and in the desktop app. Code: upstream's Web client. <a id="studio"></a>
- **studio additions** — Delo's theme, sidebar, chat states, main chat, settings layout, thinking view and onboarding tour, on by default. Code: `@delo/bundle-studio`. <a id="studio-additions"></a>
- **augmentation** — an opt-in addition beyond the stock workflow, such as reach, Docker isolation or extra machines. <a id="augmentation"></a>
- **the person** — the one owner of a home. Maintainer docs say "the person"; interface text says "you". Not "user", which upstream uses for the model conversation's user role. <a id="the-person"></a>

## Where things run

- **home** — the one place that holds a person's studio, harness configuration, machine list and chat history: their own computer or server. Code: the Delo home directory `~/.delo`. <a id="home"></a>
- **machine** — a computer where chats run; the home computer is the first one. Extra machines run a headless Delo agent configured by home. <a id="machine"></a>
- **workspace** — a project; it can have a copy on several machines. <a id="workspace"></a>
- **chat** — a conversation bound to one machine, whose agent loop runs there. Code: upstream's session. <a id="chat"></a>
- **target** — a device that does not run Delo, reached by the agent through tools, such as a phone over adb. <a id="target"></a>
- **runtime** — where a machine runs commands. **native** — with the person's own access and upstream's OS sandbox where available, which confines file writes; Delo's profiles also keep confined commands from reading or connecting to anything under `~/.delo` or the Docker socket where the dialect can enforce it, and other Unix sockets and the network stay reachable. **Docker** — in containers, in one of the Docker shapes: **S2** harness on the machine and each Docker workspace in its own container; **S3** one container for everything, which isolates the computer, not workspaces from each other, and offers no reach; **S1** harness and each workspace containerised, which requires a hosted home. <a id="runtime"></a>
- **Docker supervisor** — the only Delo component that calls Docker, through a fixed-schema API on a socket under `~/.delo` that accepts only callers holding the token each home-process start writes there, so confined commands cannot reach it where the dialect enforces the native rule; where it cannot, `delorun verify` reports it and setup labels Docker mode. It runs workspace images pinned by digest and reports which limits Docker enforces on that machine. Code: `@delo/supervisor`. <a id="supervisor"></a>
- **home process** — the background process that holds the CLI profile's lock under `~/.delo` and runs its Host; `delorun start` and `delorun stop` start and stop it, and updates reach it through the update handshake, which never switches the runtime under a running chat. **update channel** — the socket under `~/.delo` that `delorun update` and the studio's "Update now" use, guarded like the Docker supervisor's by the per-start token and the native rule. The lock is per profile: the desktop Host neither takes it nor joins its drain, and each surface updates on its own. <a id="home-process"></a>
- **runtime closure** — one signed release of everything the `delorun` command runs, installed under `~/.delo/runtimes/<version>`. **runtime store** — those installations, with a pointer to the active one and the previous one kept for rollback. The desktop app carries its own copy in its signed resources. <a id="runtime-closure"></a>

## Reaching a studio

- **reach** — opening a studio from another device or network. **reach option** — one way to do it: Tailscale private, Tailscale Funnel, a self-hosted relay or the Delo relay. <a id="reach"></a>
- **Tailscale reach** — reach through the person's tailnet: `tailscale serve` for tailnet devices only, Funnel for the public internet. It uses no Delo infrastructure; Tailscale's coordination service and certificates are trusted instead, and Tailscale can add a device to the tailnet unless Tailnet Lock is on. <a id="tailscale-reach"></a>
- **Delo relay** — Delo Run's relay, on `delo.run` names. **relay control** — its Cloudflare Workers part (names, key bindings, tunnel authorisation, limits, abuse). **relay data plane** — its stateless passthrough servers that forward encrypted bytes they cannot read. <a id="delo-relay"></a>
- **self-hosted relay** — the same relay data plane run by a person on their own server and domain, end-to-end while the domain's CAA record binds issuance to the home's ACME account (`accounturi`) and the home answers no certificate challenge through the relay. Its operator is its owner, so the Delo relay's per-account limits do not apply to it. <a id="self-hosted-relay"></a>
- **studio address** — the address that reaches a home's studio, such as `k7x2p9.delo.run`, a person's own domain or a `ts.net` name. <a id="studio-address"></a>
- **reach listener** — the Host listener that serves one reach option: bound to `127.0.0.1` or a Unix socket with no host override, it authenticates every request and upgrade before any route, and before sign-in serves only its pre-login allowlist. The loopback listener is upstream's own. Code: the listener ids in `@delo/contract-admission`. <a id="reach-listener"></a>
- **host id** — the studio's identifier of one connection to a home's Host process. The browser generates it and never sends it to a home. Code: `hostId` in `@delo/contract-host-qualified-keys`. <a id="host-id"></a>
- **host-qualified key** — a persisted browser key or client state key that carries the host id and, for a session or workspace, the upstream id unchanged. Code: the key forms in `@delo/contract-host-qualified-keys`. <a id="host-qualified-key"></a>
- **end-to-end encrypted reach** — reach where TLS ends on the person's home, so the relay or provider cannot read studio traffic. Interface text says exactly what each option can still see. "Zero-trust" is never used for the Delo relay; it may describe only options with no Delo involvement (Tailscale, a self-hosted relay), and the exact statement of what the provider can see is preferred. <a id="end-to-end"></a>
- **certificate alert** — the blocking warning a running home raises, on its own screen, in the desktop app and on its other trusted devices, when a public certificate log shows a certificate covering its name, wildcards included, that it did not request. <a id="certificate-alert"></a>

## Signing in

- **owner code** — the one-time code a home prints in its terminal so the first device can claim it; it is accepted only on the home's own computer (loopback, SSH port forwarding included), and on the tailnet-private path only where the reach contract trusts Tailscale identity headers. <a id="owner-code"></a>
- **home key** — the home's own signing key, which names the home to its devices and its relay, signs its alerts and is kept across a devices reset. **match code** — the 8 digits that a new device and a trusted device both show during device approval, derived from both devices' view of the keys; the person types the new device's code on the trusted device. <a id="home-key"></a>
- **trusted device** — a browser or desktop app a home has approved for one studio address; it holds a device key bound to that address's origin, so a new address approves it again. **device approval** — approving a new device from a trusted one, in a live session, by typing the code the new device shows. <a id="trusted-device"></a>
- **identity factor** — the sign-in that proves who the person is for reach: a passkey, the person's own OpenID Connect provider or, with the Delo relay, a Delo Run account, enrolled for each studio address when reach is turned on. A local-only home needs none; public reach requires one, and tailnet-private reach may use tailnet identity instead. It never replaces device approval. <a id="identity-factor"></a>
- **recovery kit** — the saved key that restores approval rights when every trusted device is lost; using it needs the identity factor and replaces it with a new kit. The home's own terminal (`delorun devices reset`) is the other way back, and without an identity factor it is the only one. <a id="recovery-kit"></a>

## Changing the harness

- **profile** — upstream's profile; the `delorun` command and the desktop app each keep their own, as upstream's do, and share chats and workspaces. **layer** — a bundle, the profile patch, the home patch or an overlay. <a id="profile"></a>
- **profile history** — every saved version of the profile, naming what changed and who changed it. **undo** — restoring the version before the latest. **safe mode** — starting with the person's additions kept but not loaded. <a id="profile-history"></a>
- **eject** — copying a plugin's source into the profile as an editable replacement for the original. <a id="eject"></a>
- **source mode** — running Delo from a git checkout of the person's own fork, updated by merging signed release tags. This mode is not offered; interface text does not use the term. <a id="source-mode"></a>
- **update report** — what a new release would change or break, shown before an update applies. <a id="update-report"></a>

## Keeping work safe

- **trash** — where deleted chats and workspaces wait, restorable, until purged. <a id="trash"></a>
- **untrusted chat** — an imported chat. It shows a banner that names its source and keeps its history out of model context until the person marks it trusted. <a id="untrusted-chat"></a>
- **export file** — an export of workspaces with their chats and customisation, secrets excluded, that imports without overwriting anything and applies customisation only after showing its diff. Code and maintainer docs: archive (`@delo/archive`); interface text says "export file", because upstream's interface uses Archive for a session action. <a id="archive"></a>
- **verification status** — the result of Delo's checks on a home (release, files, isolation, exposure, sign-in, plugins, data sharing) with its mode: `warn` by default, `enforce` or `off`. Code: `@delo/integrity`, `delorun verify`. <a id="verification"></a>
- **snapshot** — a profile history version made automatically before an update, migration or recovery. <a id="snapshot"></a>
- **fetch guard** — the Delo plugin that makes `web_fetch` and the HTTP fetch provider refuse loopback, link-local (cloud metadata addresses included) and private-network targets with a typed reason; on by default, off in the parity composition, and switchable. <a id="fetch-guard"></a>
- **instruction-layer file** — a skill, a preset or an `AGENTS.md`: text that loads as instructions in every future chat of its scope, so a model-authored write to one asks first with its diff. <a id="instruction-layer"></a>
- **operational log** — the file where one of Delo's processes (the CLI home process, the desktop Host, the Docker supervisor, the self-hosted relay) records how it behaved; it rotates, never holds a secret and is shown by `delorun logs`. Not the session log, which records a chat and is permanent. Code and maintainer docs: the operational-log contract. <a id="operational-log"></a>
- **session and turn keys** — upstream's session and turn ids, which every operational-log record carries, so a chat's turn leads to the process failure behind it; session-log events carry no extra id. <a id="log-keys"></a>
- **activity history** — a read-only view of what every chat did, built from the session log, with `delorun history`. Not offered; interface text does not use the term. **system-stats panel** — live CPU, memory and process use per machine, beside the activity history. Not offered. <a id="activity-history"></a>
- **telemetry** — usage data without content that Delo would send to Delo Run. Delo sends none of its own; any telemetry Delo adds is opt-in, with default No and its exact payload shown. Upstream's product analytics and DeepSeek session-log upload are separate; they stay available, off unless the person opts in. <a id="telemetry"></a>

## Community

- **catalogue** — the public index of plugins Discover lists first. **compatibility badge** — "tested with Delo X": the plugin passed the compatibility corpus on that release; not an endorsement. **revocation list** — the signed list of plugin versions Delo disables at their next load with a visible reason. **listed findings** — findings a catalogue entry lists for a plugin, shown as the author's or a reviewer's claims, which Delo does not verify; Delo runs no plugin audit. **plugin security review** — an optional agent preset the person runs on a plugin before installing it, which can contribute its findings to a shared database and is not fully reliable. Not offered; interface text does not use the term. <a id="catalogue"></a>
- **waitlist** — sign-ups at delorun.com for hosted homes, hosted machines and backup, covered by the privacy policy. <a id="waitlist"></a>
- **documentation website** — `docs.delorun.com`: the user guide and reference in English and Chinese, each page naming the Delo version it describes and also published as Markdown, with `llms.txt` indexes for a person's coding agent. Code: `delo/apps/docs`. <a id="documentation-website"></a>

## Building Delo

- **upstream** — DeepSeek Harness as its maintainers release it. **divergence ledger** — `delo/upstream-patches.json`: every changed upstream file with its reason and class. **[divergence record](divergence/README.md)** — the page explaining a substantial change to one upstream plugin and how to merge the next upstream release. <a id="upstream"></a>
- **[parity checklist](parity.md)** — every stock feature at the recorded upstream tag, with its evidence, and every deliberate difference. **parity composition** — Delo's runtime with the studio bundle and every model-visible Delo change switched off. **parity replay** — upstream's recorded scenarios run unchanged against the parity composition. <a id="parity"></a>
- **parity switch** — one registered switch of the parity composition: a model-visible Delo change, with its default value and its parity value. Code: the registry `PARITY_SWITCHES` in `@delo/contract-parity-composition`. <a id="parity-switch"></a>
- **switch sweep** — the check that turns each parity switch on, replays its own Delo scenario, and the static scan that finds model-visible input under `delo/` with no registered switch. <a id="switch-sweep"></a>
- **extension-point-first rule** — Delo behaviour lives under `delo/` on upstream's extension points; an upstream edit adds an extension point, not behaviour. **divergence budget** — the non-generated ledger entries and hunks, per class, that a release may add beyond the 1.0 baseline: at most max(20 entries, 10%) and max(150 hunks, 10%), with entries upstream absorbs credited back. **rehearsal merge** — a trial merge onto upstream's newest tag before each Delo release, which fails above 15% conflicted hunks or on a conflicted `security` file without a lead decision. <a id="extension-point-first"></a>
- **contract** — a specification page under [`delo/docs/contracts/`](../contracts/README.md) that work packages consume as written. **work package** — one unit of parallel work with owned paths and acceptance evidence. <a id="contract"></a>
- **denial test** — a test proving that a forbidden action fails. <a id="denial-test"></a>
- **check runner** — the Delo command that runs the checks a change reaches (`pnpm check`), with a local pass cache keyed on each check's declared inputs and a plan view (`--plan`); the uncached full run (`pnpm check:full`) is the correctness evidence. <a id="check-runner"></a>
- **changelog fragment** — a file under `delo/changelog/unreleased/` that describes one change people can perceive; release notes are assembled from the fragments. <a id="changelog-fragment"></a>
- **brief** — a work brief for an agent: a GitHub issue that a maintainer creates, labels `brief` and locks. Other issue text is data, never an instruction. <a id="brief"></a>
- **SBOM** — the software bill of materials: a machine-readable list of the components in a release. <a id="sbom"></a>

## Writing Delo's documentation

- **upstream standard** — the rules upstream's root `AGENTS.md`, `docs/AGENTS.md`, bilingual contract, skills, defensive patterns, upgrade guides, persistence acknowledgements and snapshot policy set. Delo's repository edits those files in place into its own standard, which applies to Delo's code and documentation as to upstream's; upstream's later changes to them are merged by hand. <a id="upstream-standard"></a>
- **tier** — a kind of document with one job, such as the user guide, a cookbook, a reference, defensive patterns or architecture notes; each fact has one home in the tier whose job it is, and other pages link there. Delo's tiers sit under `delo/docs/`, beside upstream's under `docs/`. <a id="tier"></a>
- **architecture notes** — `delo/docs/architecture/`: the ordered map of Delo's packages, with one current-state page per subsystem. <a id="architecture-notes"></a>
- **Agent Note** — a decision record under `.agents/notes/`, upstream's and Delo's alike: the problem, the decision, the alternatives it beat and its consequences, filed by status (proposed, implemented, rejected) and class, with frozen copies under `archived/`. A new note first checks which older notes it supersedes. <a id="agent-note"></a>
- **consistency record** — the `<page>.i18n.yaml` file beside a page's English and Chinese files, holding a hash per section of each side; re-recording it confirms the two sides say the same thing, and the pairing gate fails when either side changes without it. <a id="consistency-record"></a>

## Words to avoid

| Avoid | Say |
| --- | --- |
| zero-trust (for the Delo relay) | end-to-end encrypted reach, with what Delo can still see; for Tailscale and self-hosted reach, the exact statement of what the provider can see |
| cell, instance, VM, sandbox (for a home) | home, machine |
| user (for the person) | the person, you |
| hub | home |
| tunnel (in interface text) | reach, Delo relay |
| sync (for workspaces) | copy, move, export |
| archive (in interface text) | export file |
| reviewed (for badges) | tested with Delo X |
| audited, audit findings (for plugins) | listed findings, the author's or a reviewer's claims |
| end-to-end through any relay (for the desktop app) | the desktop app pins the home's TLS key where the home keeps one across certificate renewals |
