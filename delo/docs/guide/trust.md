---
description: "What you trust when you use Delo: what runs on your computer, what Delo Run can and cannot do, what each reach option shows its provider, what leaves your machine by default and what leaves only when you opt in, and how to check it yourself."
---

# What you trust when you use Delo

English | [中文](trust.zh.md)

Delo has no release yet; this page describes the first release.

## Summary

Delo runs on your computer under your own user account. Delo's contract requires that Delo Run, the project behind it, cannot reach your studio on its own. Delo has no telemetry of its own. Delo's contract requires the integrity checks that run by default to send no personal data, and every other network feature to turn on only when you choose it. This page states what each party can see or do; the [threat model](../security/threat-model.md) gives each defence, its contract and its limits.

## Contents

- [What runs on your computer](#what-runs-on-your-computer)
- [What Delo Run can and cannot do](#what-delo-run-can-and-cannot-do)
- [What each reach option shows its provider](#what-each-reach-option-shows-its-provider)
- [What leaves your machine](#what-leaves-your-machine)
- [Checking it yourself](#checking-it-yourself)
- [Reporting a problem](#reporting-a-problem)

## What runs on your computer

- The studio, the harness and its plugins run under your operating-system user, with that user's access. A program that you run as the same user can read everything under `~/.delo`, and Delo does not protect against such a program.
- Commands that the model runs in a native workspace run with your own access. Delo's contract requires that these commands cannot write under Delo's home, and cannot read Delo's secrets and tokens or connect to its control sockets and the Docker socket, wherever your system can enforce those rules. `delorun verify` reports which rules your system enforces. Other Unix sockets and the network stay open to commands.
- A Docker workspace runs in a container. Delo's contract offers one container per workspace, which isolates each workspace from your computer and from the others, or one container for all workspaces, which isolates your computer from them but not the workspaces from each other.

## What Delo Run can and cannot do

Delo Run publishes Delo's releases, the plugin catalogue and its revocation list, the documentation website and the waitlist.

Delo Run can:

- publish a release that you may install. No client installs it until you confirm an update, and no client downgrades on its own;
- sign each release, enter it in a public log, and sign the plugin catalogue and its revocation list;
- disable a plugin version through the revocation list. Delo's contract requires that a revoked version be disabled at its next load, with its reason, and recorded in profile history. A plugin that is already running keeps running until Delo loads it again.

Under Delo's contract, Delo Run cannot:

- reach your studio on its own. Tailscale reach and a self-hosted relay use no Delo infrastructure, and Delo holds no studio TLS key and no device key;
- approve a device for you, command your machine, or change the plugin version pinned on your computer;
- audit plugins. A finding that a catalogue entry lists is its author's or a reviewer's claim, which Delo does not verify.

You still trust:

- Delo Run's releases, the catalogue and revocation list, and the `delorun.com` names that serve them;
- upstream's DeepSeek Harness code, which Delo runs at a named release;
- your identity provider, if you sign in through one. A party that controls your account there can pass the identity check, but device approval still applies.

## What each reach option shows its provider

Delo's contract requires that no reach option use Delo infrastructure. Reach is off until you turn it on, and Delo's contract requires each option to show its note before it turns on.

| Reach option | What the provider can see or do |
| --- | --- |
| Tailscale private | Only devices on your tailnet can open the address. Tailscale's coordination service sees your home's name, the IP addresses of your home and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains the address's certificate, so no app can pin its TLS key. |
| Tailscale Funnel | Anyone on the internet can open the address. Tailscale's Funnel servers and coordination service see your home's name, the IP addresses of your home and of each connecting device, connection times and traffic volume. Funnel passes encrypted traffic to your home, where Tailscale's software ends TLS. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the address's certificate. |
| Self-hosted relay on your domain | Your relay sees the address's name, the IP addresses of your home and of each connecting device, connection times and traffic volume. It can refuse or drop connections and force a rebind of a name. It passes encrypted traffic it cannot read, and TLS ends on your home. Traffic stays end-to-end encrypted only while your domain's CAA record lets only your home's Let's Encrypt account obtain certificates and your home answers its own certificate challenges. Let's Encrypt and your DNS provider can still affect certificates for your domain. Your home checks public certificate logs, which see your home's IP address and domain. |

Delo's contract requires each option to also need your passkey or sign-in provider, and approval of each new device from one you already trust.

## What leaves your machine

### By default

Delo's contract requires these integrity checks to run by default. They carry no personal data, but each request reveals your IP address, the request time and the Delo version to the host it reaches.

- The release-log check at each start, against Sigstore's public release log and its checkpoint distributor.
- The plugin revocation list from `catalogue.delorun.com`, at each start of the home and every 6 hours while it runs.
- Update checks, which fetch Delo's signed release metadata.

Each file these checks fetch is verified by its signature, so a host that serves a changed file fails the check.

Delo's contract requires `integrity.mode: off` to turn the release-log check and the revocation list off. The offline check of your installed release still runs at each start, and a failed check still stops it. With the revocation list off, the list goes stale after 24 hours: catalogue installs pause, and installed plugins keep loading.

Docker workspaces pull images, and own-domain reach queries public certificate logs. Delo's contract requires each to happen only when you choose that feature.

### Only when you opt in

Delo's contract requires that setup's `--yes` and `--config` forms never turn on reach or either upstream opt-in.

- **Upstream's desktop analytics** is off by default in the first release. When you turn it on, the desktop app sends product usage events to the collector that upstream's configuration names.
- **DeepSeek's session-log upload** is off by default in the first release. When you turn it on, each request to the official DeepSeek API carries an incremental part of your session log, in a `dsh_session_log` field.
- **Feedback** leaves your machine only when you send it. The feedback dialog shows the payload, including a session-log prefix, and its destination before you send.
- **Model requests** go to the model provider you configure, and carry what the model receives for each turn.
- **Reach** sends traffic to the provider you choose, as the table above states.

## Checking it yourself

- Delo's contract requires `delorun verify` to check the release, the files, isolation, exposure, sign-in, plugins and data sharing, and to report what your system cannot enforce. Every report states that a program running as you can change the checks.
- Delo's contract requires `delorun logs` to show each operational log, its location and its records. Delo's own records hold no secret, chat text, prompt, model output, tool argument or file content. Captured command output can still hold chat and file text until retention deletes it. While Delo runs, logs are deleted 14 days after they were written.
- The [threat model](../security/threat-model.md) lists each boundary, its defence and what Delo does not protect against.

## Reporting a problem

Report a suspected vulnerability privately, as [SECURITY.md](../../../SECURITY.md) describes, and not in a public issue. Report other problems to support@delorun.com.
