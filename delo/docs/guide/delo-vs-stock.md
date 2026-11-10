---
description: "How Delo differs from stock DeepSeek Harness: why Delo exists, what stays the same, every product difference and changed default, how to move between them, and the roadmap."
---

# Delo and stock DeepSeek Harness

English | [中文](delo-vs-stock.zh.md)

Delo has no release yet; this page describes the first release.

## Summary

Delo is a community fork of DeepSeek Harness (DSH). The first release installs and works like stock DSH and keeps DSH plugins compatible, then adds a better studio, updates that never take your work away, deep customisation, and opt-in isolation and reach, each one you can turn off. This page explains why Delo exists, what stays exactly the same, every difference you will notice, and what comes next.

## Contents

- [Why Delo exists](#why-delo-exists)
- [What stays the same](#what-stays-the-same)
- [What is different](#what-is-different)
- [Defaults that differ](#defaults-that-differ)
- [What Delo removes](#what-delo-removes)
- [Moving between DSH and Delo](#moving-between-dsh-and-delo)
- [Roadmap](#roadmap)

## Why Delo exists

DSH is an excellent harness, and its maintainers do not accept outside contributions. Delo is where the community can change any part of it: the studio, the harness, its plugins and its defaults. Delo's aim is that anyone using it can feel they have a nation of geniuses working with them: many capable agents, on their own work and their own machines, under their control.

Delo's contract requires these rules everywhere:

- **Stock first.** A fresh install follows the stock DSH workflow: local, no account, a command that opens the studio. Delo's own integrity checks run by default: the release-log check at start and the plugin revocation list. They send no personal data, and `integrity.mode: off` turns both network checks off. Every other network feature is opt-in and explained before it applies.
- **Yours to change.** Configuration, plugins, presets, skills, themes and the studio are yours. Delo never hides a layer that overrides them.
- **Updates never take your work away.** Before an update you see what it would break; your profile is snapshotted; one action goes back.
- **Delo cannot get in on its own.** Your studio runs on your computer and every new device needs approval from one you already trust. Releases and the plugin revocation list are signed, and a revocation disables a plugin at its next load, which you can override.
- **Honest claims.** A limit is called enforced only when it is enforced, and `delorun verify` shows what is.

## What stays the same

- The harness: Delo runs DSH's own code at a named DSH release, and every Delo release note names it in a "From upstream" section.
- Plugins, presets, skills, profiles, bundles, client slots and sessions work as in DSH, with the same ids and wire formats. A recorded test suite replays DSH's own scenarios through Delo with Delo's additions switched off, and must match.
- Upstream's four modes, Standard, PTC, Minimal and Creator, are offered in every new chat.
- The model providers DSH supports, configured the same way.
- The MIT licence.

## What is different

| Area | Stock DSH | Delo |
| --- | --- | --- |
| Install | npm package and desktop app | `npx delorun` (or `pnpx`, `bunx`, a global install), a signed install script and the signed desktop app for macOS and Windows, as Delo's contract requires; on Linux and inside WSL2, npm or the install script |
| Home | `~/.dsh` | Delo's contract requires `~/.delo`, with a copy of your DSH setup imported on request; `~/.dsh` is never changed |
| Setup | First-run dialogs | A setup screen for your model provider and key, native or Docker workspaces, Delo's studio additions, and reach; `delorun setup --yes` for scripts |
| Studio | DSH studio | Delo's theme, chat list with chat states (snooze and settle), main chat, settings layout and thinking view, or the stock look in one switch |
| Updates | Incompatible plugins may be disabled at startup | A report of what would break before updating, a snapshot before it applies, a health check after, and rollback on every channel |
| Your own changes | Profile layers | The first release offers profile layers plus profile history with undo, safe mode, plugin eject, and presets, skills, themes and Creator changes that survive updates |
| Isolation | Native, with the OS sandbox confining file writes | Native, with Delo's contract requiring the same sandbox to also keep commands from reading Delo's secrets or tokens, or connecting to its control sockets and the Docker socket, where your system can enforce it, which `delorun verify` reports; or Docker, with Delo's contract requiring either each workspace in its own container on Linux, or one shared container that isolates your computer but not projects from each other, with the limits that machine enforces listed in setup |
| Permissions | One default for every workspace | Delo's contract requires that a new workspace start on stock's `workspace-write`, that full access ask once per workspace, and that a scheduled task name the session and preset it will run under before you approve it |
| Web fetch | Reaches loopback and private-network hosts in every mode without asking | Delo's contract requires `web_fetch` to refuse loopback, link-local and private-network targets, cloud metadata addresses included, unless you turn the guard off. The guard covers the `web_fetch` tool; commands, and a proxy or remote fetch provider you configure, are outside it. |
| Reach from other devices | Your own certificate on a LAN address, or experimental Liveshare | Delo's contract requires reach through your tailnet (Tailscale private or Funnel) or your own relay on your own domain, with a passkey or your own sign-in provider and approval of each new device from a trusted one |
| Verification | None | Delo's contract requires `delorun verify` to check the release, files, isolation, exposure, sign-in, plugins and data sharing, and to say what your system cannot enforce |
| Logs | Process output in the terminal or the desktop console | Delo's contract requires operational logs per part of Delo, rotated, with secrets redacted, and `delorun logs` to find them |
| Data sharing | Desktop analytics on | Delo has no telemetry of its own; Delo's contract requires DSH's desktop analytics and DeepSeek session-log upload to stay available but off unless you turn them on |
| Plugins | Bring your own index | Delo's contract requires a community catalogue with "tested with Delo X" badges and revocation of known-bad versions; findings an author or reviewer lists are shown as their claims |
| Diagnostics | — | The first release's `delorun doctor` checks your setup; `preset_inspect` shows what a preset composes |
| Workspaces | Local folders | Local folders, import by `git clone`, `AGENTS.md` editing, trash and export files |
| Releases | DSH's signing | Delo's contract requires signed releases with an SBOM and a public log entry, matching a rebuild from the tagged source; npm releases carry a build attestation |
| Documentation | DSH's docs | [docs.delorun.com](https://docs.delorun.com) in English and Chinese, each page also as Markdown with an `llms.txt` index for coding agents |
| Contributions | Not accepted | Welcome to every part, under MIT with DCO sign-off; a pseudonym is fine |

## Defaults that differ

The first release changes a few of DSH's defaults on purpose, and the [parity checklist](../reference/parity.md) lists each one:

- The first release turns Delo's studio additions on; the stock look is one switch away.
- The first release preselects PTC when you choose a mode in onboarding.
- A new workspace starts on stock's `workspace-write`; the first release also asks once per workspace before full access.
- The first release keeps DSH's desktop analytics and DeepSeek session-log upload off until you turn them on.
- The first release's `web_fetch` refuses loopback, link-local and private-network targets.
- The first release's commands cannot read Delo's secrets or reach its control sockets, where your system enforces it; `delorun verify` reports which.
- The first release asks your consent before a scheduled task is created or edited, before a model-authored write to an instruction-layer file, and when an MCP server is added, naming the command it will run.
- The first release gives a container's denial of a file access an environment marker and offers no escalation for it.
- The first release's main chat write tools always ask before they run.
- The first release runs the plugin manager's read actions without escalation.
- The first release adds `preset_inspect` by default, which is switchable in configuration. The doctor is a command you run, and no model sees it.

## What Delo removes

- The first release removes DeepSeek's account and Platform integration. Delo works with any model provider DSH supports, including DeepSeek's API with your own key.

## Moving between DSH and Delo

- **From DSH:** setup offers to copy your chats and workspaces from `~/.dsh`, and `delorun import-home` does it any time and asks about your profiles, settings, instructions, skills and key one by one; `~/.dsh` is never changed ([Switching from DeepSeek Harness](switching.md)).
- **Back to DSH:** Delo's contract requires that your DSH home stay untouched, so stock DSH keeps working beside Delo. Delo's export files carry workspaces and chats between homes.
- **Delo's look without leaving Delo:** turn off Delo's studio additions for the stock look, or turn off any one of them.

## Roadmap

The roadmap is ordered, not dated: each stage starts when the one before it is ready.

1. **First release.** Everything in [What is different](#what-is-different): the studio, safe updates, customisation, native and Docker workspaces, reach through your tailnet or your own relay, verification, operational logs, the catalogue and the documentation site.
2. **The Delo relay.** Studio addresses on `your-name.delo.run`, a Delo Run account and device approvals through Delo, first in beta releases. Delo Run passes encrypted traffic it cannot read, and the page that announces it states exactly what Delo can see.
3. **Studio follow-ups.** Delo's own phone sidebar.
4. **Extra machines.** Run chats on a laptop, a server or a homelab machine from one studio: a small agent per machine, pairing, workspace copies, and continuing a chat on another machine.
5. **Stage 5, in no fixed order.**
   - Opt-in telemetry, off unless you say yes, with its exact payload shown.
   - An optional plugin security review: an agent preset you can run on a plugin before installing it, which can share its findings with the community.
   - An activity history over your chats and a live system-stats panel.
   - Editing the harness's own source with updates that keep your edits.
   - The desktop app managing WSL2, a Linux AppImage, and one profile shared by the desktop app and the command line.
   - A harness-and-workspaces Docker mode for hosted homes.
   - Workspace checkpoints, scheduled local and off-site encrypted backups, and Delo Run Backup.
   - An agent team, workspaces on other machines over SSH, hosted homes and machines, and teams.

Not planned: managing other harnesses as products, splitting one chat across machines, and Delo selling model access.
