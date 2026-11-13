---
description: "What Delorun is for and where it is going: the vision, the ordered roadmap of work that is not in Delorun yet, and what is not planned."
---

# Roadmap and vision

English

## Summary

This page is the one place in the guide that describes work Delorun does not do today. It helps you decide whether something you need is on the way, and shows the direction Delorun is taking. You need nothing first. Every other page describes Delorun as it is. The roadmap is ordered, not dated: a stage starts when the one before it is ready, and the items inside a stage have no promised order. Plans change, so treat an item as an intention and not as a promise.

## Contents

- [What Delorun is for](#what-delorun-is-for)
- [The roadmap](#the-roadmap)
- [Not planned](#not-planned)
- [Follow along](#follow-along)
- [Next](#next)

## What Delorun is for

Delorun is the community fork of [DeepSeek Harness](../reference/glossary.md#stock), made for daily use. Its aim is that anyone can have many capable agents working with them, on their own work and their own machines, under their own control.

Four ideas steer what gets built:

- **Yours to run and change.** Delorun runs on your computer with no account. Its settings, plugins, presets, skills and look are yours to change, and a change you make survives an update.
- **Stock-compatible.** Your DeepSeek Harness plugins, profiles and chats keep working, and a fresh install follows the stock workflow ([Delorun and stock DeepSeek Harness](delo-vs-stock.md)).
- **Safe by default, and honest about it.** A protection is called enforced only where a test proves it, and a feature Delorun lacks is stated as missing.
- **Reachable, without giving up control.** You can open your studio from your phone, and every new device needs your approval at your computer.

## The roadmap

The stages below are in order. Everything in them is absent from Delorun today; [Delorun and stock DeepSeek Harness](delo-vs-stock.md#what-delorun-does-not-include) states each absence as it applies now.

1. **The Delo relay.** Studio addresses on `your-name.delo.run`, a Delo Run account and device approvals through Delo, first in beta releases. The [Delo relay](../reference/glossary.md#delo-relay) passes encrypted traffic it cannot read, and the page that announces it states exactly what Delo can see. Until then, [reach](../reference/glossary.md#reach) is Tailscale on your own tailnet ([Reach the studio from your phone](reach.md)).
2. **Studio follow-ups.** Delorun's own phone sidebar.
3. **Extra machines.** Run chats on a laptop, a server or a homelab machine from one studio: a small agent per machine, pairing, workspace copies, and continuing a chat on another machine.
4. **In no fixed order.**
   - **Apps and platforms.** A Delorun desktop app that manages WSL2, a Linux AppImage, and one profile shared by the desktop app and the command line. Releases for macOS.
   - **Isolation.** Docker workspaces, where a workspace's commands run in a container, and a Docker mode for hosted homes that runs the harness and the workspaces in containers.
   - **Reach and sign-in.** Reach through Tailscale Funnel or through a relay you host on your own domain, and sign-in with a passkey or your own sign-in provider ([What each reach option shows its provider](trust.md#what-each-reach-option-shows-its-provider) compares them).
   - **Verification and plugins.** `delorun verify` checks of isolation, exposure, sign-in, plugins and data sharing; a community plugin [catalogue](../reference/glossary.md#catalogue) with "tested with Delorun X" badges; a revocation list for known-bad plugin versions; an optional plugin security review, an agent preset you can run on a plugin before installing it, which can share its findings with the community; and ejecting a plugin while keeping its settings in your profile.
   - **Studio.** The main chat, importing a workspace with `git clone` and editing its `AGENTS.md` from the studio, which exist as plugins that no profile loads; PTC as the default mode in the first-run guide; an [activity history](../reference/glossary.md#activity-history) over your chats and a live system-stats panel.
   - **Your data.** Workspace checkpoints, scheduled local and off-site encrypted backups, and Delo Run Backup. Opt-in [telemetry](../reference/glossary.md#telemetry), off unless you say yes, with its exact payload shown.
   - **Teams and hosting.** An agent team, workspaces on other machines over SSH, hosted homes and machines, and teams. The [waitlist](../reference/glossary.md#waitlist) at delorun.com collects sign-ups for hosted homes, hosted machines and backup.

## Not planned

Delorun does not plan to manage other harnesses as products, to split one chat across machines, or to sell model access.

## Follow along

Each release's notes say what changed, and the waitlist at delorun.com announces the hosted services. To suggest or discuss a direction, write in the project's GitHub Discussions or to support@delorun.com ([CONTRIBUTING.md](../../../CONTRIBUTING.md) explains how to propose a feature).

## Next

To see what Delorun does today, read [Delorun and stock DeepSeek Harness](delo-vs-stock.md). To install it, read [Install and first run](install.md).
