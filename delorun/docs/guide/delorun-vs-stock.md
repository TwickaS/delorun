---
description: "How Delorun differs from stock DeepSeek Harness: why Delorun exists, what stays the same, every difference you notice, the defaults it changes, what it removes, what it does not include, and how to move between the two."
---

# Delorun and stock DeepSeek Harness

English | [中文](delorun-vs-stock.zh.md)

## Summary

This page helps you decide whether Delorun suits you, and what changes if you come from stock DeepSeek Harness. You need nothing first. Stock DeepSeek Harness (DSH) is the harness as its own maintainers release it ([stock DSH](../reference/glossary.md#stock)).

Delorun is a community fork of DSH. It runs DSH's own code, keeps DSH plugins and chats working, and installs and works like stock DSH: on your computer, with no account, and one command that opens the [studio](../reference/glossary.md#studio). On top of that it adds its own studio look, updates that show what they would change and can go back, protections around the commands the model runs, and remote access from your phone over your own [tailnet](../reference/glossary.md#tailnet). You can switch back to stock behaviour for each addition that changes what the model sees. This page lists what stays the same, every difference you notice, and what Delorun does not include. The [roadmap](roadmap.md) says what is planned.

## Contents

- [Why Delorun exists](#why-delorun-exists)
- [What stays the same](#what-stays-the-same)
- [What is different](#what-is-different)
- [Defaults that differ](#defaults-that-differ)
- [What Delorun removes](#what-delorun-removes)
- [What Delorun does not include](#what-delorun-does-not-include)
- [Moving between DSH and Delorun](#moving-between-dsh-and-delorun)
- [Roadmap and vision](#roadmap-and-vision)
- [For the technically curious](#for-the-technically-curious)

## Why Delorun exists

DSH is an excellent harness, and its maintainers do not accept outside contributions. Delorun is where the community can change any part of it: the studio, the harness, its [plugins](../reference/glossary.md#plugin) and its defaults. Its aim is that anyone using it can have many capable agents working with them, on their own work and their own machines, under their control.

Delorun holds itself to these rules:

- **Stock first.** A fresh install follows the stock DSH workflow. Delorun sends nothing about you. Its default network requests are a check of the public release log at each start and a daily check for a newer release, which Settings, General, Updates turns off ([What you trust when you use Delorun](trust.md#what-leaves-your-machine)).
- **Yours to change.** Configuration, plugins, presets, skills, themes and the studio are yours, and no hidden layer overrides them.
- **Updates never take your work away.** Before an update you see what it would change, your [profile](../reference/glossary.md#profile) is saved first, and one command goes back ([Updates](updates.md)).
- **Delorun cannot get in on its own.** Your studio runs on your computer, and every new device needs your approval at that computer ([Reach the studio from your phone](reach.md)).
- **Honest claims.** A protection is called enforced only where a test proves it, and this guide states what Delorun does not include.

## What stays the same

- **The harness.** Delorun runs DSH's own code at a named DSH release; `delorun --version` prints both versions.
- **Compatibility.** Plugins, presets, skills, profiles and chats work as in DSH. Before a change is accepted, DSH's own recorded scenarios are replayed with every Delorun change that the model can see switched off, and they must give the same results.
- **Modes.** DSH's four agent presets, Standard, PTC, Minimal and Creator, are offered in every new chat, and Standard is the default.
- **Model providers.** The [providers](../reference/glossary.md#provider) DSH supports, set up the same way.
- **The licence.** MIT.

## What is different

| Area | Stock DSH | Delorun |
| --- | --- | --- |
| Install | npm package and desktop app | `npx delorun`, which checks each release's signatures and its entry in a public release log before it installs it. It runs on Linux x64 and arm64, and on Windows through WSL2 ([Install and first run](install.md)) |
| Home | `~/.dsh` | `~/.delorun`, readable only by you. Delorun never changes `~/.dsh`, and `delorun import-home` copies what you choose from it ([Your Delorun home](home.md)) |
| Running | A command in a terminal, or the desktop app | `delorun` runs in the background and opens the studio; `delorun start`, `stop`, `status`, `open`, `doctor` and `logs` manage it ([Daily use](daily-use.md)) |
| Setup | First-run dialogs | [Setup](../reference/glossary.md#setup) in the terminal: privacy, copying from `~/.dsh`, the model key, and how careful prompts are, and in the longer form also background running, remote access, the profile name and the port. `delorun setup --yes` is for scripts |
| Studio | DSH's look | Delorun's theme, sidebar, chat states, settings layout and first-run guide, or the stock look in one switch |
| Updates | Incompatible plugins may be disabled at startup | A report of what would change before you confirm, a profile snapshot and an optional copy of your chat data first, a health check after, automatic rollback when it fails, and `delorun recover` to go back ([Updates](updates.md)) |
| Your own changes | Profile layers | Profile layers, a history of your profile that `delorun recover restore` brings back, [safe mode](../reference/glossary.md#safe-mode), and update checks that refuse to drop a plugin, setting or local plugin you added |
| What commands can reach | The [sandbox](../reference/glossary.md#sandbox) confines file writes | The same sandbox also keeps commands from writing to or reading Delorun's home and its secrets, and from reaching its control socket and Docker, where your system can enforce it ([What Delorun protects](safety.md#the-sandbox)) |
| Permissions | One default for every workspace | Every new workspace starts on Workspace Write. With [Ask me first](../reference/glossary.md#ask-me-first), [full access](../reference/glossary.md#full-access) needs your consent once per workspace, given at your computer ([Full access](safety.md#full-access)) |
| Consents | — | With Ask me first, the model's file-tool writes to `AGENTS.md`, skills and presets ask first, a scheduled task asks with its schedule and target, and a new [MCP server](../reference/glossary.md#mcp-server) that runs a command waits until you allow it at your computer ([Consents](safety.md#consents)) |
| Network | Commands reach any host | Each workspace can be Open, Allowlist or Off in Settings, Safety, Network; the default is Open ([The network setting](safety.md#the-network-setting)) |
| Cost | — | An optional meter under the message box shows what a chat has cost ([See what a chat costs](cost-meter.md)) |
| Thinking | — | An optional tab in the right sidebar shows the model's reasoning and reply word by word ([Read the model's thinking word by word](thinking-tab.md)) |
| Web fetch | Reaches loopback and private-network hosts in every mode | `web_fetch` refuses loopback, link-local and private-network addresses, cloud metadata addresses included. Commands are outside this guard |
| Reach from other devices | Your own certificate on a LAN address, or experimental Liveshare | Tailscale on your own tailnet, with each device approved at your computer by the code it shows ([Reach the studio from your phone](reach.md)) |
| Verification | — | `delorun verify` checks the installed release's signature, its release-log entry and its files |
| Logs | Process output in the terminal | A log file per process, rotated, with secrets removed, and `delorun logs` to find them ([Where Delorun keeps its logs](logs.md)) |
| Data sharing | Desktop analytics and DeepSeek session-log upload on | No telemetry of Delorun's own. DeepSeek session-log upload is off until you turn it on in Settings, Safety, Privacy, and the profile `delorun` runs has no desktop analytics |
| Workspaces | Local folders | Local folders, with a trash for deleted chats and workspaces and signed export files that move them between homes |
| Documentation | DSH's docs | This guide, at [docs.delorun.com](https://docs.delorun.com) |
| Contributions | Not accepted | Welcome to every part, under MIT with DCO sign-off; a pseudonym is fine |

<details>
<summary>Edge cases</summary>

- If you run on Windows, then commands can read Delorun's home, its secrets and its token, though they cannot write there — treat the model's commands as able to read them ([What Delorun protects](safety.md#the-sandbox)).
- If you run on Linux without bubblewrap on a desktop, then Delorun refuses to run sandboxed commands at all — install bubblewrap.
- If you chose [**Ask less (like DeepSeek Harness)**](../reference/glossary.md#ask-less) in setup, then the full-access, instruction-file, MCP server and scheduled-task consents are off, and the network setting is not available — run `delorun setup prompts` to choose Ask me first again.
- If you want the stock look, then choose Stock in Settings, General, Look — **Delorun look** in the same place switches back.

</details>

## Defaults that differ

The [parity checklist](../reference/parity.md) lists each changed default with its evidence:

- Delorun's studio additions are on; the stock look is one switch away in Settings, General, Look.
- A new workspace starts on Workspace Write whatever the deployment default is, and with Ask me first full access needs your consent once per workspace.
- DeepSeek's session-log upload is off until you turn it on.
- `web_fetch` refuses loopback, link-local and private-network addresses.
- Commands the model runs cannot write to or read Delorun's home, or reach its control socket, where your system enforces it.
- With Ask me first, the instruction-file, MCP server and scheduled-task consents apply. Setup's **Ask less (like DeepSeek Harness)** answer turns them and the full-access refusal off ([Ask less (like DeepSeek Harness)](switching.md#ask-less-like-deepseek-harness)).
- The default workspace is `Delorun/default-workspace` in your Documents folder, or in your home folder when your system names no Documents folder.

Other differences exist in the code but are off in the profile `delorun` runs, so DSH's behaviour stands for each. The [parity checklist](../reference/parity.md) names them.

## What Delorun removes

- DeepSeek's account and Platform integration: no Platform sign-in, Usage or Top-up page. Delorun works with any model provider DSH supports, DeepSeek's API with your own key included.

## What Delorun does not include

Delorun does not include these, and this guide describes each only where it affects a choice:

- a Delorun desktop app, and macOS and native Windows releases;
- Docker workspaces, where a workspace's commands run in a container;
- reach through Tailscale Funnel or your own relay on your own domain, and sign-in with a passkey or your own sign-in provider;
- `delorun verify` checks of isolation, exposure, sign-in, plugins and data sharing, which the report lists as `not run`;
- a community plugin catalogue with "tested with Delorun X" badges, and a revocation list for known-bad plugin versions;
- ejecting a plugin while keeping its settings in your profile;
- the main chat, importing a workspace with `git clone` and editing its `AGENTS.md` from the studio, which exist as plugins that no profile loads;
- PTC as the default mode in the first-run guide.

The [roadmap](roadmap.md) says which of these are planned.

## Moving between DSH and Delorun

- **From DSH:** setup offers to copy your chats and workspaces from `~/.dsh`, and `delorun import-home` does it any time and asks about your profiles, settings, instructions, skills and key one by one. `~/.dsh` is never changed ([Switching from DeepSeek Harness](switching.md)).
- **Back to DSH:** your DSH home stays untouched, so stock DSH keeps working beside Delorun. `delorun export` writes chats and workspaces as files that another home imports.
- **Stock behaviour inside Delorun:** turn off Delorun's studio additions for the stock look, and answer **Ask less (like DeepSeek Harness)** in `delorun setup prompts` for DSH's prompts.

<details>
<summary>Edge cases</summary>

- If `~/.dsh` is a link and not a folder, or your Delorun home already has chats, then setup does not offer the copy — run `delorun import-home` yourself.
- If you use both after importing, then chats you start in Delorun stay in your Delorun home — use `delorun export` to take them elsewhere.

</details>

<details>
<summary>Go further</summary>

- `delorun import-home --dry-run` shows what would be copied and writes nothing.
- `delorun export` and `delorun import` move chats and workspaces between Delorun homes.

</details>

## Roadmap and vision

What Delorun is for, what is planned and in what order, and what is not planned are on [Roadmap and vision](roadmap.md).

**Next.** To install Delorun, read [Install and first run](install.md). To keep your DeepSeek Harness work, read [Switching from DeepSeek Harness](switching.md). If something went wrong, find its message in [Troubleshooting](troubleshooting.md).

## For the technically curious

The [parity checklist](../reference/parity.md) lists every difference from stock with its evidence, including switches such as `preset_inspect`, profile-history actions for the model and the container denial marker that are off in the profile `delorun` runs. The [parity composition contract](../contracts/c16-parity-composition.md) defines how Delorun proves it still behaves like stock with its changes switched off. Plugins, presets, skills, profiles, bundles, client slots and chats keep DSH's ids and wire formats, which that contract checks.
