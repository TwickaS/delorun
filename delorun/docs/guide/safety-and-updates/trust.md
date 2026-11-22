---
description: "What you trust when you use Delorun: what runs on your computer, what Delo Run can and cannot do, what each reach option shows its provider, what leaves your machine by default and what leaves only when you opt in, and how to check it yourself."
---

# What you trust when you use Delorun

English | [中文](trust.zh.md)

## Summary

This page helps you decide what you are comfortable with. It says, party by party, what each one can see and do when you use Delorun, and how to check it yourself. You need nothing first, but it reads best after [Install and first run](../get-started/install.md).

Delorun is a preview. Its releases are signed with preview keys, and no outside security review has happened; the sections on [signing](#how-releases-are-signed-in-the-preview) and [review](#outside-security-review) say what that means. Delorun runs on your computer, as you. Nobody else runs it for you, and Delo Run, the project that publishes it, has no way into your [studio](../../reference/glossary.md#studio). Delorun has no telemetry: it sends nothing about you. Two small checks that keep your installation honest talk to the internet by default. Everything else leaves your computer only when you turn it on.

## Contents

- [What runs on your computer](#what-runs-on-your-computer)
- [What Delo Run can and cannot do](#what-delo-run-can-and-cannot-do)
- [How releases are signed in the preview](#how-releases-are-signed-in-the-preview)
- [Outside security review](#outside-security-review)
- [What each reach option shows its provider](#what-each-reach-option-shows-its-provider)
- [What leaves your machine](#what-leaves-your-machine)
- [Checking it yourself](#checking-it-yourself)
- [Reporting a problem](#reporting-a-problem)
- [For the technically curious](#for-the-technically-curious)

## What runs on your computer

- **Delorun itself.** The studio and its [plugins](../../reference/glossary.md#plugin) run as your user, with your user's access. Any other program you run as yourself can read everything in your [home](../../reference/glossary.md#home), the folder `~/.delorun`, and Delorun cannot stop that.
- **Commands the model runs.** They run with your access too, inside the [sandbox](../../reference/glossary.md#sandbox): a set of operating-system rules that limits what a command can touch. The sandbox keeps commands from writing into Delorun's home. Where your system supports it, it also keeps them from reading Delorun's secrets or reaching Docker. The one part of Delorun's home they can read besides installed releases, skills and runtimes is the approved copies of your profile's plugins; they cannot change those. Commands can still use other local services and the network, unless you set the workspace's [network setting](../../reference/glossary.md#network-setting) to Allowlist or Off ([Prompt injection and data exfiltration](prompt-injection.md)). [What Delorun protects](safety.md#the-sandbox) lists the rules on each system, and on Linux `delorun doctor` shows whether the sandbox can run.
- **Every workspace** runs on your computer directly. Delorun has no Docker workspaces, which would run a workspace's commands in a container ([Roadmap](../roadmap.md)).
- **Plugins** run with the same full access as Delorun. When you install a plugin and each time Delorun starts, it checks that the plugin says it works with your versions. It does not check the plugin's files again after the install: if a plugin you installed from npm, git or a tarball changes on disk, the changed version loads at the next start.

## What Delo Run can and cannot do

Delo Run publishes Delorun's releases and this documentation. It publishes no plugin catalogue and no list of revoked plugins ([Roadmap](../roadmap.md)).

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

## How releases are signed in the preview

Every release is signed, and `delorun update` and `delorun verify` check the signature before anything runs. The signing keys are preview keys: they were made on the computer where the maintainer works with agents, not on a machine kept offline for the purpose, and nobody else has witnessed or backed them up. That computer is also where agents run. So anyone, or any agent, who gains access to it could sign a release that your installation accepts. The public release log still records every release, so a release signed that way would be visible to everyone who checks it, but nothing stops it from being signed.

Until `1.0.0`, the maintainer also builds each release on that same computer. No second builder rebuilds it to check that the published files match the source, so the release is built and signed on one machine and no independent rebuild backs it. Your installation accepts such a release while it is a 0.x release signed under the preview root in the table below. Your installation refuses a release built this way when it is a `1.0.0` release or is signed under a later root.

This is the main limit of the preview, and it is why the README calls Delorun a preview. A signature tells you a release came from whoever holds the preview keys, and the release log tells you that everyone got the same release. Neither is the protection that offline keys give. The maintainer publishes every release by hand with a second factor, so that no long-lived publishing credential sits where agents can use it.

The release root that these releases are signed under:

| | Value |
| --- | --- |
| Release root 1, SHA-256 of `1.root.json` | `e78c076567b1a2e104756409ad6f4a77c9b8caab95a3f38e857a94f82523b746` |
| Root key id | `d8cb882168a05fe18b7139ad904de8634bcac2e8b3bebad3776b7efb008be734` |
| Targets key id | `cd269895db6714d341b1fe23e6d290e42e141da44789d754f3729543fdc9d769` |
| Timestamp key id | `df07a99c3eab87eb0428a3f17ac561cafc7f3bf13444a10a66885d342662a971` |
| Catalogue key id | `cee603433150c5d96ac52e886af0e3d502a9910de3d4efb994d078ab2de5d446` |

## Outside security review

No outside security review of Delorun has happened. The maintainer's own reviews, the denial tests that fail when a protection is removed, and the checks that replay recorded sessions are real, and they are the work of the maintainer and the agents the maintainer works with. An outside review is a person or firm that does not work on Delorun reading its security-critical code and reporting what they find. Treat Delorun as a preview: do not rely on it to confine an agent you would not otherwise trust ([What Delorun protects](safety.md)).

## What each reach option shows its provider

[Reach](../../reference/glossary.md#reach) means opening your studio from another device, such as your phone. It is off until you turn it on, and it uses nothing of Delo Run's. Delorun offers one option: Tailscale on your own [tailnet](../../reference/glossary.md#tailnet) ([Reach the studio from your phone](../everyday-use/reach.md)). `delorun reach on tailscale` refuses while Tailscale Funnel, which would publish your address on the internet, is on.

The table also describes two options that Delorun does not offer, so you can compare. The [roadmap](../roadmap.md) names a relay that Delo Run would run; Delorun does not offer it, so no row describes it.

| Reach option | What the provider can see or do |
| --- | --- |
| Tailscale on your tailnet (available) | Only devices on your tailnet can open the address. Tailscale's coordination service sees your computer's name, the IP addresses of your computer and of each device, connection times and how much traffic flows. Tailscale can add a device to your tailnet unless Tailnet Lock is on. Tailscale controls `ts.net` and obtains your address's certificate. |
| Tailscale Funnel (not offered) | Anyone on the internet can open the address. Tailscale's Funnel servers and coordination service see your computer's name, the IP addresses of your computer and of each device that connects, connection times and traffic volume. Funnel passes encrypted traffic to your computer, where Tailscale's software decrypts it. Tailscale can add a device to your tailnet unless Tailnet Lock is on, and it obtains the address's certificate. |
| A relay you host on your own domain (not offered) | Your relay sees the address, the IP addresses of your computer and of each device, connection times and traffic volume. It can refuse or drop connections. It passes encrypted traffic it cannot read, which only your computer decrypts, as long as your domain's DNS lets only your computer obtain certificates for it and your computer answers its own certificate challenges. Let's Encrypt and your DNS provider can still affect certificates for your domain. |

Whatever the option, a device opens your chats only after you approve it at your computer. Delorun offers no sign-in with a passkey or your own sign-in provider either. A phone can still confirm a strong action with a passkey (Face ID), which confirms one action and does not sign the phone in ([Confirm with Face ID](../everyday-use/reach.md#confirm-with-face-id)).

<details>
<summary>Edge cases</summary>

- If Tailscale Funnel is on, then `delorun reach on tailscale` refuses — turn Funnel off with the command it prints, then run it again.
- If Funnel is turned on while reach is running, then Delorun notices within a minute and stops serving the address — turn Funnel off with the command that `delorun reach on tailscale` prints when it refuses.

</details>

## What leaves your machine

### By default

Two checks run by default. They carry nothing about you, but each server they reach sees your IP address and the time of the request.

- **The release-log check**, at each start. It asks Sigstore's public release log, and the service that publishes its state, whether the release you run is the one Delo Run recorded publicly. No setting turns it off. When the log cannot be reached, Delorun starts anyway and warns you.
- **The update check**, once a day. It fetches Delorun's signed release files from releases.delorun.com, or from a fallback host, to see whether a newer release exists ([Updates](updates.md#the-update-notice)). Turn it off in Settings, General, Updates, or with `delorun setup privacy`.

Each file these checks download is checked against its signature, so a server that hands out a changed file fails the check. Delorun downloads no list of revoked plugins, because Delo Run publishes none.

### Only when you opt in

`delorun setup --yes` and `--config` never turn on reach or DeepSeek's session-log upload.

- **DeepSeek's session-log upload** is off until you turn it on in Settings, Safety, Privacy. When it is on, each request to DeepSeek's official API also carries the part of your chat's log not sent yet: your messages, the replies, tool calls with their results, workspace paths and feedback.
- **Analytics.** DeepSeek Harness's own analytics are switched off in the preview. The [profile](../../reference/glossary.md#profile) `delorun` runs collects none, and Settings, Privacy says so. Delorun's own opt-in telemetry is not part of the preview.
- **Feedback.** The profile `delorun` runs has no feedback dialog, so it sends no feedback.
- **Model requests** go to the [model provider](../../reference/glossary.md#provider) you set up, and carry what the model receives for each turn.
- **Reach** sends traffic through the provider you choose, as the table above says.

<details>
<summary>Edge cases</summary>

- If the release log cannot be reached, then Delorun starts and shows a warning — nothing to fix; it checks again at the next start.
- If you turned the update check off, then you hear of new releases only when you run `delorun update` — run it now and then.

</details>

## Checking it yourself

- **`delorun verify`** checks that the installed release is signed, that it is in the public release log, and that its files are the signed ones. It does not check isolation, exposure, sign-in, plugins or data sharing: the report lists each as `not run` and ends with `this is not a full verification of this Delorun`. The checks run as you, so a program running as you could tamper with them.
- **`delorun logs`** shows each log, where it is and what it holds ([Where Delorun keeps its logs](../help/logs.md)).

<details>
<summary>Go further</summary>

- **Check the launcher.** npm serves the `delorun` [launcher](../../reference/glossary.md#launcher) before any Delorun check runs, so check it separately. `delorun verify` prints a `Launcher` line with the integrity that the installed release's signed manifest gives the launcher you ran. Compare it with the output of `npm view delorun@<version> dist.integrity`.
- **Compare the release roots.** Delo Run publishes the SHA-256 of each release root file and its key ids on this page and in each release's notes. Compare them with the root files under the launcher package's `roots/` directory.
- Setup installs the `delorun` command at the version you ran, never the newest version npm serves.

</details>

## Reporting a problem

Report a suspected vulnerability privately, as [SECURITY.md](../../../../SECURITY.md) describes, and not in a public issue. For other problems, follow [CONTRIBUTING.md](../../../../CONTRIBUTING.md), or write to support@delorun.com.

**Next.** To see the protections themselves, read [What Delorun protects](safety.md). To reach your studio from your phone, read [Reach the studio from your phone](../everyday-use/reach.md). If something went wrong, find its message in [Troubleshooting](../help/troubleshooting.md).

## For the technically curious

The [threat model](../../security/threat-model.md) lists every boundary, its defence and what Delorun does not protect against. The [verification checks contract](../../contracts/c15-verification-checks.md) defines each `delorun verify` check, and the [reach providers contract](../../contracts/c07-reach-providers.md) defines what each reach option may use.
