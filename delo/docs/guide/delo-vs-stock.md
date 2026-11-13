---
description: "How Delorun differs from stock DeepSeek Harness: why Delorun exists, what stays the same, every difference you will notice, the defaults it changes, what it removes, what is not available yet, how to move between the two, and the roadmap."
---

# Delorun and stock DeepSeek Harness

English | [中文](delo-vs-stock.zh.md)

Delorun has no release yet; this page describes the code that the first release is built from.

## Summary

Delorun is a community fork of DeepSeek Harness (DSH). It runs DSH's own code, keeps DSH plugins and sessions compatible, and installs and works like stock DSH: local, no account, one command that opens the studio. On top of that it adds its own studio look, updates that show what they would change and can go back, protections around the commands the model runs, and remote access from your phone over your own tailnet, and each of these that changes what the model sees can be switched back to stock. This page lists what stays the same, every difference you will notice, what is not available yet, and what comes next.

## Contents

- [Why Delorun exists](#why-delorun-exists)
- [What stays the same](#what-stays-the-same)
- [What is different](#what-is-different)
- [Defaults that differ](#defaults-that-differ)
- [What Delorun removes](#what-delorun-removes)
- [Not available yet](#not-available-yet)
- [Moving between DSH and Delorun](#moving-between-dsh-and-delorun)
- [Roadmap](#roadmap)
- [For the technically curious](#for-the-technically-curious)

## Why Delorun exists

DSH is an excellent harness, and its maintainers do not accept outside contributions. Delorun is where the community can change any part of it: the studio, the harness, its plugins and its defaults. Its aim is that anyone using it can have many capable agents working with them, on their own work and their own machines, under their control.

Delorun holds itself to these rules:

- **Stock first.** A fresh install follows the stock DSH workflow. Delorun sends nothing about you; its default network requests are the release-log check at each start and a daily check for a newer release, which Settings → General → Updates turns off ([What you trust when you use Delorun](trust.md#what-leaves-your-machine)).
- **Yours to change.** Configuration, plugins, presets, skills, themes and the studio are yours, and no hidden layer overrides them.
- **Updates never take your work away.** Before an update you see what it would change; your profile is saved first; one command goes back ([Updates](updates.md)).
- **Delorun cannot get in on its own.** Your studio runs on your computer, and every new device needs your approval at that computer ([Reach the studio from your phone](reach.md)).
- **Honest claims.** A protection is called enforced only where a test proves it, and this guide marks what is not available yet.

## What stays the same

- **The harness.** Delorun runs DSH's own code at a named DSH release; `delorun --version` prints both versions.
- **Compatibility.** Plugins, presets, skills, profiles, bundles, client slots and sessions work as in DSH, with the same ids and wire formats. Before a change reaches Delorun's trunk, a check replays DSH's own recorded scenarios through Delorun with every model-visible Delorun change switched off, and they must match.
- **Modes.** DSH's four agent presets, Standard, PTC, Minimal and Creator, are offered in every new chat, and Standard is the default.
- **Model providers.** The providers DSH supports, configured the same way.
- **The licence.** MIT.

## What is different

| Area | Stock DSH | Delorun |
| --- | --- | --- |
| Install | npm package and desktop app | `npx delorun`, which verifies each release's signatures and its entry in a public release log before it installs it, on Linux x64 and arm64 and on Windows x64, WSL2 included ([Install and first run](install.md)) |
| Home | `~/.dsh` | `~/.delo`, readable only by you; `~/.dsh` is never changed, and `delorun import-home` copies what you choose from it ([Your Delorun home](home.md)) |
| Running | A command in a terminal, or the desktop app | `delorun` runs in the background and opens the studio; `delorun start`, `stop`, `status`, `open`, `doctor` and `logs` manage it ([Daily use](daily-use.md)) |
| Setup | First-run dialogs | Quick or Full setup in the terminal: privacy, the import from `~/.dsh`, the model key, how careful prompts are, and in Full also background running, remote access, the profile and the port; `delorun setup --yes` for scripts |
| Studio | DSH's look | Delorun's theme, sidebar, chat states, settings layout and onboarding, or the stock look in one switch |
| Updates | Incompatible plugins may be disabled at startup | A report of what would change before you confirm, a profile snapshot and an optional copy of your chat data first, a health check after, automatic rollback when it fails, and `delorun recover` to go back ([Updates](updates.md)) |
| Your own changes | Profile layers | Profile layers, profile history that `delorun recover restore` brings back, safe mode, and update checks that refuse to drop a plugin, setting or local plugin you added |
| What commands can reach | The sandbox confines file writes | The same sandbox also keeps commands from writing or reading Delorun's home and its secrets, and from connecting to its control socket and Docker's socket, where your system can enforce it ([What Delorun protects](safety.md#the-sandbox)) |
| Permissions | One default for every workspace | Every new workspace starts on Workspace Write; with Safer prompts, a switch of a workspace to full access is refused ([Full access](safety.md#full-access)) |
| Consents | — | With Safer prompts, the model's file-tool writes to `AGENTS.md`, skills and presets ask first, a scheduled task asks with its schedule and target, and a new MCP server that runs a command waits until you allow it at your computer ([Consents](safety.md#consents)) |
| Web fetch | Reaches loopback and private-network hosts in every mode | `web_fetch` refuses loopback, link-local and private-network targets, cloud metadata addresses included; commands are outside the guard |
| Reach from other devices | Your own certificate on a LAN address, or experimental Liveshare | Tailscale on your own tailnet, with each device approved at your computer by the code it shows ([Reach the studio from your phone](reach.md)) |
| Verification | — | `delorun verify` checks the installed release's signature, its release-log entry and its files |
| Logs | Process output in the terminal | Operational logs per process, rotated, with secrets redacted, and `delorun logs` to find them ([Where Delorun keeps its logs](logs.md)) |
| Data sharing | Desktop analytics and DeepSeek session-log upload on | No telemetry of Delorun's own; DeepSeek session-log upload off until you turn it on in Settings → Privacy, and no desktop analytics in the profile `delorun` runs |
| Workspaces | Local folders | Local folders, with a trash for deleted chats and workspaces and signed export files that move them between homes |
| Documentation | DSH's docs | This guide, at [docs.delorun.com](https://docs.delorun.com) |
| Contributions | Not accepted | Welcome to every part, under MIT with DCO sign-off; a pseudonym is fine |

## Defaults that differ

The [parity checklist](../reference/parity.md) lists each changed default with its evidence:

- Delorun's studio additions are on; the stock look is one switch away in Settings → General → Look.
- A new workspace starts on Workspace Write whatever the deployment default is, and with Safer prompts a switch to full access is refused.
- DeepSeek's session-log upload is off until you turn it on.
- `web_fetch` refuses loopback, link-local and private-network targets.
- Commands the model runs cannot write or read Delorun's home, or reach its control socket, where your system enforces it.
- With Safer prompts, the instruction-file, MCP server and scheduled-task consents apply. Setup's **Same as stock** answer turns them and the full-access refusal off ([Same as stock](switching.md#same-as-stock)).
- The default workspace is `Delo/default-workspace` in your Documents folder, or in your home folder when your system names no Documents folder.

The other differences the parity registry declares, such as `preset_inspect`, profile history actions for the model and a container denial marker, are off in the profile `delorun` runs, so DSH's behaviour stands for each.

## What Delorun removes

- DeepSeek's account and Platform integration: no Platform sign-in, Usage or Top-up page. Delorun works with any model provider DSH supports, DeepSeek's API with your own key included.

## Not available yet

These are part of Delorun's plans and are not in the code yet:

- a Delorun desktop app, and macOS releases;
- Docker workspaces, where a workspace's commands run in a container;
- a full-access consent screen that grants full access for one workspace, and a way to accept a new MCP server;
- reach through Tailscale Funnel or your own relay on your own domain, and sign-in with a passkey or your own sign-in provider;
- `delorun verify` checks of isolation, exposure, sign-in, plugins and data sharing, which the report lists as `not run`;
- a community plugin catalogue with "tested with Delorun X" badges, and a revocation list for known-bad plugin versions;
- ejecting a plugin while keeping its settings in your profile;
- the main chat, importing a workspace with `git clone` and editing its `AGENTS.md` from the studio, which exist as plugins that no profile loads;
- PTC as the default mode in onboarding.

## Moving between DSH and Delorun

- **From DSH:** setup offers to copy your chats and workspaces from `~/.dsh`, and `delorun import-home` does it any time and asks about your profiles, settings, instructions, skills and key one by one; `~/.dsh` is never changed ([Switching from DeepSeek Harness](switching.md)).
- **Back to DSH:** your DSH home stays untouched, so stock DSH keeps working beside Delorun. `delorun export` writes chats and workspaces as files that another home imports.
- **Stock behaviour inside Delorun:** turn off Delorun's studio additions for the stock look, and answer **Same as stock** in `delorun setup prompts` for DSH's prompts.

## Roadmap

The roadmap is ordered, not dated: each stage starts when the one before it is ready.

1. **First release.** What [What is different](#what-is-different) lists: the studio, safe updates, customisation, native workspaces with Delorun's protections, reach through your tailnet, verification of the release, operational logs and this guide.
2. **The Delo relay.** Studio addresses on `your-name.delo.run`, a Delo Run account and device approvals through Delo, first in beta releases. Delo Run passes encrypted traffic it cannot read, and the page that announces it states exactly what Delo can see.
3. **Studio follow-ups.** Delorun's own phone sidebar.
4. **Extra machines.** Run chats on a laptop, a server or a homelab machine from one studio: a small agent per machine, pairing, workspace copies, and continuing a chat on another machine.
5. **Stage 5, in no fixed order.**
   - The items under [Not available yet](#not-available-yet).
   - Opt-in telemetry, off unless you say yes, with its exact payload shown.
   - An optional plugin security review: an agent preset you can run on a plugin before installing it, which can share its findings with the community.
   - An activity history over your chats and a live system-stats panel.
   - The desktop app managing WSL2, a Linux AppImage, and one profile shared by the desktop app and the command line.
   - A harness-and-workspaces Docker mode for hosted homes.
   - Workspace checkpoints, scheduled local and off-site encrypted backups, and Delo Run Backup.
   - An agent team, workspaces on other machines over SSH, hosted homes and machines, and teams.

Not planned: managing other harnesses as products, splitting one chat across machines, and Delorun selling model access.

## For the technically curious

The [parity checklist](../reference/parity.md) lists every difference from stock with its evidence, and the [parity composition contract](../contracts/c16-parity-composition.md) defines how Delorun proves it still behaves like stock with its changes switched off.
