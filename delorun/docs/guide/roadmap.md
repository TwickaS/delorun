---
description: "What Delorun is for and where it is going: fit as the aim, what is being built now, what comes next, the directions after that, how Delorun earns and what is not planned."
---

# Roadmap

English | [中文](roadmap.zh.md)

## Summary

This page is the one place in the guide that describes work Delorun does not do today. It helps you decide whether something you need is on the way. You need nothing first. Every other page describes Delorun as it is. The roadmap has three parts: Now is what is being built, Next is what follows it, and Later is a list of directions without an order. It carries no dates and no version numbers except the `1.0.0` milestone, and plans change, so treat an item as an intention and not as a promise.

## Contents

- [What Delorun is for](#what-delorun-is-for)
- [Now](#now)
- [Next](#next)
- [Later](#later)
- [How Delorun earns](#how-delorun-earns)
- [Not planned](#not-planned)
- [Follow along](#follow-along)
- [What to read next](#what-to-read-next)

## What Delorun is for

Delorun is a harness that you shape to your own work. Its value is fit: a harness that suits how you work, through plugins, modes and the studio, and that you can change without fear because every change can be undone. It is built on [DeepSeek Harness](../reference/glossary.md#stock) and runs its plugins and imports your chats.

Four ideas steer what gets built:

- **Yours to change.** Delorun runs on your computer with no account. Its settings, plugins, presets, skills and look are yours to change, and a change you make survives an update.
- **Safe to change.** An update saves your setup first, a failed update goes back on its own, and one command returns you to the previous version ([Updates](updates.md#going-back)).
- **Honest about safety.** A protection is called enforced only where a test proves it, and a feature Delorun lacks is stated as missing.
- **Reachable, without giving up control.** You can open your studio from your phone, and every new device needs your approval at your computer.

DeepSeek Harness plugins and chats stay compatible. Everything a person sees, which is the studio, the defaults and the first run, is Delorun's own ([Delorun and stock DeepSeek Harness](delorun-vs-stock.md)).

## Now

What is being built is the first public version, for individuals: people switching from stock and people new to it.

- **The preview.** Delorun on Linux and on Windows through WSL2, with the Web studio and your phone over Tailscale.
- **The words.** The README, the trust page, the known issues and the answers to the hard questions, so a first-time reader is never lost.
- **A safe release process.** Signed releases, a written plan for a bad release, and a security review of remote access and the update chain by the maintainer.
- **Opt-in telemetry.** Delorun's own, off unless you say yes, asked at setup with its exact payload shown, built in the open. The preview ships with upstream's analytics switched off and none of Delorun's own.

## Next

What follows, in order. A stage starts when the one before it is ready.

1. **The desktop app.** macOS and Windows reach most developers. It manages WSL2 on Windows, shares one profile with the command line, and adds releases for macOS.
2. **The free relay with accounts.** Reach without Tailscale: studio addresses on `your-name.delo.run`, a Delo Run account and device approvals through Delorun. The [Delorun relay](../reference/glossary.md#delorun-relay) passes encrypted traffic it cannot read, and the page that announces it states exactly what Delorun can see. It is free, with a fair-use limit per account on devices and traffic. Until then, [reach](../reference/glossary.md#reach) is Tailscale on your own tailnet ([Reach the studio from your phone](reach.md)).
3. **Extra machines.** Run chats on a laptop, a server or a homelab machine from one studio. Where an existing DeepSeek Harness plugin does the job, Delorun adopts it.
4. **`1.0.0`, ready for a business.** The desktop app, the relay and extra machines work, the signing keys are made in a key ceremony on an offline machine, and an outside security review has happened and its report is published.

## Later

Directions, in no fixed order. None of them is promised.

- **Teams.** After `1.0.0`, the maintainer works with a first company to shape Delorun to its work ([How Delorun earns](#how-delorun-earns)).
- **Income that does not depend on the maintainer's hours.** Support subscriptions, hosted instances for individuals or managed private deployments; which one is chosen after the first company's work. Nothing is built for any of them now.
- **Isolation.** Docker workspaces, where a workspace's commands run in a container.
- **Reach and sign-in.** Reach through Tailscale Funnel or through a relay you host on your own domain, and sign-in with a passkey or your own sign-in provider ([What each reach option shows its provider](trust.md#what-each-reach-option-shows-its-provider) compares them).
- **Verification and plugins.** `delorun verify` checks of isolation, exposure, sign-in, plugins and data sharing; a community plugin [catalogue](../reference/glossary.md#catalogue) with "tested with Delorun X" badges; an optional plugin security review that you can run before installing a plugin; and ejecting a plugin while keeping its settings in your profile.
- **Studio.** Delorun's own phone sidebar, an [activity history](../reference/glossary.md#activity-history) over your chats and a live system-stats panel.
- **Your data.** Workspace checkpoints, which would let undo cover the files an agent changed, and scheduled local and off-site encrypted backups.
- **Shareable setups.** A setup is plain files; sharing one with a link or a gallery is a direction.

## How Delorun earns

Delorun and everything it needs stay MIT and free. You can set it up for yourself, and anyone may host it for others. Nothing in the product is held back for payment, and no plugin works only for people who pay.

From `1.0.0`, the maintainer offers teams custom plugins, modes and integrations as paid work: a company pays for the work, not for a licence. The code is the same for everyone. Sponsors can support the project on GitHub.

Delorun has no hosted waitlist, because hosting is not decided. Delorun does not sell model access or resell inference.

## Not planned

Delorun does not plan to manage other harnesses as products, to split one chat across machines, or to sell model access.

## Follow along

Each release's notes say what changed. The sign-up list on delorun.com sends a note for each major article and release, and nothing more frequent. To suggest or discuss a direction, use the Ideas category in the project's GitHub Discussions, or write to support@delorun.com ([CONTRIBUTING.md](../../../CONTRIBUTING.md) explains how to propose a feature).

<details>
<summary>Go further</summary>

- Read [Delorun and stock DeepSeek Harness](delorun-vs-stock.md#what-delorun-does-not-include) for each absence as it applies today.
- Read [Questions and answers](questions.md) for why Delorun is built the way it is.

</details>

## What to read next

To see what Delorun does today, read [Delorun and stock DeepSeek Harness](delorun-vs-stock.md). To install it, read [Install and first run](install.md).
