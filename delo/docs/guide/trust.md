---
description: "What you trust when you use Delorun: what runs on your computer, what Delo Run can and cannot do, what each reach option shows its provider, what leaves your machine by default and what leaves only when you opt in, and how to check it yourself."
---

# What you trust when you use Delorun

English | [中文](trust.zh.md)

Delorun has no release yet; this page describes the first release.

## Summary

Delorun runs on your computer, as you. Nobody else runs it for you, and Delo Run, the project that publishes it, has no way into your studio. Delorun has no telemetry: it sends nothing about you. A few checks that keep your installation honest talk to the internet by default, and everything else that leaves your computer does so only when you turn it on. This page says, party by party, what each one can see and do, so you can decide what you are comfortable with.

## Contents

- [What runs on your computer](#what-runs-on-your-computer)
- [What Delo Run can and cannot do](#what-delo-run-can-and-cannot-do)
- [What each reach option shows its provider](#what-each-reach-option-shows-its-provider)
- [What leaves your machine](#what-leaves-your-machine)
- [Checking it yourself](#checking-it-yourself)
- [Reporting a problem](#reporting-a-problem)
- [For the technically curious](#for-the-technically-curious)

## What runs on your computer

- **Delorun itself.** The studio, the harness and its plugins run as your user, with your user's access. Any other program you run as yourself can read everything in `~/.delo`, and Delorun cannot stop that.
- **Commands the model runs.** They run with your access too, inside a sandbox: a set of operating-system rules that limits what a command can touch. The sandbox keeps them from writing into Delorun's home, and, where your system supports it, from reading Delorun's secrets and tokens or talking to its control socket and to Docker. Nothing tells you yet which of these rules your computer enforces; [What Delorun protects](safety.md#the-sandbox) lists them per sandbox. Commands can still use other local sockets, and the network unless you set the workspace's network to `allowlist` or `off` ([prompt injection and data exfiltration](prompt-injection.md)).
- **Docker workspaces**, which would run a workspace's commands in a container, are not available yet. Every workspace runs on your computer directly.
- **Plugins** run with the harness's full access. When you install a plugin and at each start, Delorun checks which DeepSeek Harness and Delorun versions it says it supports. It does not check the plugin's files again after install: if a plugin you installed from npm, git or a tarball changes on disk, the changed version loads at the next start.

## What Delo Run can and cannot do

Delo Run publishes Delorun's releases, this documentation and the waitlist. A plugin catalogue and a list of revoked plugins are not available yet.

Delo Run can:

- publish a release. Your installation installs it only when you confirm an update, and never goes back to an older release on its own;
- sign each release and record it in a public log, so anyone can check that every installation got the same release.

Delo Run cannot:

- reach your studio. Remote access over Tailscale uses nothing of Delo Run's, and Delo Run holds none of your studio's keys or your devices' keys;
- approve a device for you, send commands to your computer, or change the plugins you have installed;
- turn off or revoke a plugin you installed;
- vouch for plugins: it does not review them.

What you still trust:

- Delo Run's releases and the `delorun.com` addresses that serve them;
- each plugin you install, and the place you installed it from;
- DeepSeek Harness's code, which Delorun runs at a named release.

## What each reach option shows its provider

Remote access, which Delorun calls reach, is off until you turn it on, and uses nothing of Delo Run's. Today there is one option: Tailscale on your own tailnet ([Reach the studio from your phone](reach.md)). `delorun reach on tailscale` refuses while Tailscale Funnel, which would publish your address on the internet, is on. Funnel, a relay you host on your own domain, and sign-in with a passkey or your own sign-in provider are not available yet; the table also describes the two planned options, so you can compare.

| Reach option | What the provider can see or do |
| --- | --- |
| Tailscale on your tailnet (available) | Only devices on your tailnet can open the address. Tailscale's coordination service sees your computer's name, the IP addresses of your computer and of each device, connection times and how much traffic flows. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains your address's certificate. |
| Tailscale Funnel (not available yet) | Anyone on the internet can open the address. Tailscale's Funnel servers and coordination service see your computer's name, the IP addresses of your computer and of each device that connects, connection times and traffic volume. Funnel passes encrypted traffic to your computer, where Tailscale's software decrypts it. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the address's certificate. |
| A relay you host on your own domain (not available yet) | Your relay sees the address, the IP addresses of your computer and of each device, connection times and traffic volume. It can refuse or drop connections. It passes encrypted traffic it cannot read, which only your computer decrypts, as long as your domain's DNS lets only your computer obtain certificates for it and your computer answers its own certificate challenges. Let's Encrypt and your DNS provider can still affect certificates for your domain. |

Whatever the option, a device opens your chats only after you approve it at your computer.

## What leaves your machine

### By default

Two checks run by default. They carry nothing about you, but each request shows the server it reaches your IP address and the time of the request.

- **The release-log check**, at each start, against Sigstore's public release log and the service that publishes its state. It confirms that the release you run is the one Delo Run recorded publicly. No setting turns it off; when the log cannot be reached, Delorun starts anyway and warns you.
- **The update check**, once a day, which fetches Delorun's signed release files from releases.delorun.com, or from a fallback host. Turn it off in Settings → General → Updates or with `delorun setup privacy` ([Updates](updates.md#the-update-notice)).

Each file these checks download is checked against its signature, so a server that hands out a changed file fails the check. Delorun downloads no list of revoked plugins, because none is published yet. Docker images and certificate-log lookups would come with Docker workspaces and own-domain reach, which are not available yet.

### Only when you opt in

`delorun setup --yes` and `--config` never turn on reach or DeepSeek's session-log upload.

- **DeepSeek's session-log upload** is off until you turn it on in Settings → Privacy. When it is on, each request to DeepSeek's official API also carries the part of your chat's log not sent yet: your messages, the replies, tool calls with their results, workspace paths and feedback.
- **Desktop analytics** belong to DeepSeek Harness's desktop app. The profile `delorun` runs collects none, and Settings → Privacy says so.
- **Feedback.** The profile `delorun` runs has no feedback dialog, so it sends no feedback.
- **Model requests** go to the model provider you set up, and carry what the model receives for each turn.
- **Reach** sends traffic through the provider you choose, as the table above says.

## Checking it yourself

- **`delorun verify`** checks that the installed release is signed, that it is in the public release log, and that its files are the signed ones. Its other planned checks, of isolation, exposure, sign-in, plugins and data sharing, are not available yet: the report lists each as `not run` and ends with `this is not a full verification of this Delo`. The checks run as you, so a program running as you could tamper with them.
- **`delorun logs`** shows each log, where it is and what it holds ([Where Delorun keeps its logs](logs.md)).
- **The launcher.** npm serves the `delorun` launcher before any Delo check runs, so check it out of band. `delorun verify` prints a `Launcher` line with the integrity that the installed release's signed manifest gives the launcher you ran; compare it with the output of `npm view delorun@<version> dist.integrity`. Delo Run publishes the SHA-256 of each release root file and its key ids in the README, on this page, in each release's notes and in `delo/release/production-keys.json`; compare them with the root files under the launcher package's `roots/` directory. No release root is published yet. Setup installs the `delorun` command at the version you ran, never the newest version npm serves.

## Reporting a problem

Report a suspected vulnerability privately, as [SECURITY.md](../../../SECURITY.md) describes, and not in a public issue. Report other problems to support@delorun.com.

## For the technically curious

The [threat model](../security/threat-model.md) lists every boundary, its defence and what Delorun does not protect against, and the [verification checks contract](../contracts/c15-verification-checks.md) defines each `delorun verify` check.
