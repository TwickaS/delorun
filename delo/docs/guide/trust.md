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
- Commands that the model runs in a native workspace run with your own access. Delo's contract requires that these commands cannot write under Delo's home, and cannot read Delo's secrets and tokens or connect to its control sockets and the Docker socket, wherever your system can enforce those rules; nothing reports yet which of them your computer enforces ([What Delorun protects](safety.md#the-sandbox) lists them by sandbox). Other Unix sockets and the network stay open to commands.
- Docker workspaces, which would run a workspace's commands in a container, are not available yet; every workspace is native.
- Plugins run with the harness's access. Delo checks a plugin's declared DeepSeek Harness and Delo version ranges when you install it and at each start; it does not check a plugin's files again after install, so a plugin installed from npm, git or a tarball whose files change on disk loads as it now is at the next start.

## What Delo Run can and cannot do

Delo Run publishes Delo's releases, the documentation website and the waitlist. A plugin catalogue and a plugin revocation list are not available yet.

Delo Run can:

- publish a release that you may install. No client installs it until you confirm an update, and no client downgrades on its own;
- sign each release and enter it in a public log.

Under Delo's contract, Delo Run cannot:

- reach your studio on its own. Tailscale reach and a self-hosted relay use no Delo infrastructure, and Delo holds no studio TLS key and no device key;
- approve a device for you, command your machine, or change the plugin version pinned on your computer;
- disable or revoke a plugin you installed;
- audit plugins.

You still trust:

- Delo Run's releases and the `delorun.com` names that serve them;
- each plugin you install, and the place you installed it from;
- upstream's DeepSeek Harness code, which Delo runs at a named release;
- your identity provider, if you sign in through one. A party that controls your account there can pass the identity check, but device approval still applies.

## What each reach option shows its provider

Reach uses no Delo infrastructure, and it is off until you turn it on. The one reach option available is Tailscale private ([Reach the studio from your phone](reach.md)); `delorun reach on tailscale` refuses while Tailscale Funnel is on for the address. Funnel, a self-hosted relay on your own domain, and a passkey or your own sign-in provider are not available yet. The rows below state what each provider sees; the Funnel and relay rows describe options that are not available yet.

| Reach option | What the provider can see or do |
| --- | --- |
| Tailscale private | Only devices on your tailnet can open the address. Tailscale's coordination service sees your home's name, the IP addresses of your home and of each device, connection times and traffic volume. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains the address's certificate, so no app can pin its TLS key. |
| Tailscale Funnel | Anyone on the internet can open the address. Tailscale's Funnel servers and coordination service see your home's name, the IP addresses of your home and of each connecting device, connection times and traffic volume. Funnel passes encrypted traffic to your home, where Tailscale's software ends TLS. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the address's certificate. |
| Self-hosted relay on your domain | Your relay sees the address's name, the IP addresses of your home and of each connecting device, connection times and traffic volume. It can refuse or drop connections and force a rebind of a name. It passes encrypted traffic it cannot read, and TLS ends on your home. Traffic stays end-to-end encrypted only while your domain's CAA record lets only your home's Let's Encrypt account obtain certificates and your home answers its own certificate challenges. Let's Encrypt and your DNS provider can still affect certificates for your domain. Your home checks public certificate logs, which see your home's IP address and domain. |

Every device, whatever the option, needs your approval at your computer before it opens your chats.

## What leaves your machine

### By default

These checks run by default. They carry no personal data, but each request reveals your IP address, the request time and the Delo version to the host it reaches.

- The release-log check at each start, against Sigstore's public release log and its checkpoint distributor. No setting turns it off; when the log cannot be reached, the start goes on with a warning.
- The update check, once a day, which fetches Delo's signed release metadata from releases.delorun.com and GitHub. Turn it off in Settings → Privacy or with `delorun setup privacy` ([Updates](updates.md#the-update-notice)).

Each file these checks fetch is verified by its signature, so a host that serves a changed file fails the check. The first release publishes no plugin revocation list and fetches none.

Docker workspaces, which would pull images, and own-domain reach, which would query public certificate logs, are not available yet.

### Only when you opt in

Delo's contract requires that setup's `--yes` and `--config` forms never turn on reach or either upstream opt-in.

- **Upstream's desktop analytics** belongs to DeepSeek Harness's desktop app; the profile `delorun` runs collects none, and Settings → Privacy says so.
- **DeepSeek's session-log upload** is off by default in the first release. When you turn it on, each request to the official DeepSeek API carries an incremental part of your session log, in a `dsh_session_log` field.
- **Feedback** leaves your machine only when you send it. The feedback dialog shows the payload, including a session-log prefix, and its destination before you send.
- **Model requests** go to the model provider you configure, and carry what the model receives for each turn.
- **Reach** sends traffic to the provider you choose, as the table above states.

## Checking it yourself

- `delorun verify` checks the installed release's signature, with its entry in the public release log, and the installed files against their signed list. Its other checks, of isolation, exposure, sign-in, plugins and data sharing, are not available yet: the report lists each as `not run` and ends with `this is not a full verification of this Delo`. The checks run as you, so a program running as you can change them.
- `delorun logs` shows each operational log, its location and its records. Delo's own records hold no secret, chat text, prompt, model output, tool argument or file content. Captured command output can still hold chat and file text until retention deletes it. A log file is deleted at the next `delorun` command once its oldest record is 14 days old.
- The [threat model](../security/threat-model.md) lists each boundary, its defence and what Delo does not protect against.

## Reporting a problem

Report a suspected vulnerability privately, as [SECURITY.md](../../../SECURITY.md) describes, and not in a public issue. Report other problems to support@delorun.com.
