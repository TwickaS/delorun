---
description: "Updating Delorun: the update notice and how to turn it off, delorun update --check and --report, what the update report shows, what happens during an update, the health check and automatic rollback, the chat-data copy for data-format changes, and going back with delorun recover."
---

# Updates

English

## Summary

Delorun tells you when a newer release exists, shows what it would change before it applies anything, and applies it only when you confirm. Before the switch it saves your profile's history, and when the new release changes how chats are stored, it copies your chat data first. After the switch it checks the new release and goes back on its own if a check fails. Your plugins, presets and profile changes carry over; when a release cannot carry one, the report names it before you decide.

## Contents

- [The update notice](#the-update-notice)
- [Check and read the report](#check-and-read-the-report)
- [Apply an update](#apply-an-update)
- [What happens during an update](#what-happens-during-an-update)
- [Chat data that changes format](#chat-data-that-changes-format)
- [Going back](#going-back)
- [Channels](#channels)
- [For the technically curious](#for-the-technically-curious)

## The update notice

Once a day, Delorun fetches the signed release files from releases.delorun.com and GitHub and checks whether a newer release exists on its channel. The check sends nothing about your installation, and those hosts see your computer's address. It verifies the files' signatures and downloads no release. When a newer release exists, Delorun says so in three places:

- in the terminal, when Delorun starts, as a line such as `Delorun 0.1.3 is available (security fix; all your plugins stay compatible). Run: delorun update`;
- in the studio, as a card at the bottom of the chat list, which names the kind of release, how many of your plugins it would turn off and the command to run; **Hide this notice until a newer release** hides it for that release only;
- in `delorun doctor`, which also reports a failed check with its reason.

A phone or other device you reach the studio from sees the notice without its controls, because an update is applied at your computer ([Reach the studio from your phone](reach.md)).

The check runs only for Delorun installed with its launcher, not for a source checkout. Turn it off in the studio's Settings → General → Updates with **Check for new releases**, or with `delorun setup privacy`. Setup leaves it on; More settings on the review screen asks. With the check off, Delorun makes no update request and shows no notice, and `delorun update` still works when you run it.

## Check and read the report

```text
delorun update --check     # is there a newer release? applies nothing
delorun update --report    # what would the newest release change? applies nothing
```

`delorun update --check` runs the check now and prints either `Delorun <version> is the newest release on the <channel> channel.` or the notice line and the release's summary. It needs no running Delorun.

`delorun update --report` needs Delorun running. It downloads the newest release, verifies it, installs it beside the running one without switching to it, and prints the update report, then `Nothing changed. Run delorun update to apply it.` The report shows:

- the versions you go from and to, of Delorun and of the DeepSeek Harness it runs on, and the channel;
- the release checks: the signature, the freshness of the release files and the public release log;
- every plugin, bundle and profile entry the update would change, with the reason (a bundle is a package of plugins and settings, and a profile entry, which the report calls a row, is one plugin in your profile's list): `kept`, `changed`, `disabled` or `removed`. A plugin whose declared version ranges exclude the new release is listed as `disabled`, with the range it declares. An item Delorun cannot predict, such as a plugin whose `package.json` it cannot read, says so;
- whether the chat data changes format, with the size of the copy and the free disk space ([Chat data that changes format](#chat-data-that-changes-format)).

When nothing changes, the report says `No plugin, bundle or profile row changes.` The report covers plugins, bundles and profile entries; it does not list setting values, which carry over unchanged.

## Apply an update

Run `delorun update`. It prints the same report and asks `Apply the update to Delo <version>?`, with No as the default. A report is valid for ten minutes: confirm an older one and Delorun asks you to read a fresh report.

- `delorun update --yes` confirms without asking, but only a report that turns nothing off, removes nothing and holds nothing Delorun cannot predict. Any other report needs you to run `delorun update` and decide.
- Without a terminal to ask in, `delorun update` answers no and changes nothing.
- An update needs git, which saves your profile's history; without git, Delorun refuses before it fetches anything. `--check` and `--report` do not need git.

Delorun never applies an update you have not confirmed, and the check applies nothing.

## What happens during an update

`delorun update` prints each step as it goes:

1. **Checking and installing.** Delorun downloads the release, verifies its signature, its signed file list and its entry in the public release log, and installs it beside the running release. A release that does not verify is refused, and nothing changes.
2. **Snapshot.** Delorun saves a profile history version named `Before update to Delo <version>`, holding your profile's patches, bundle list and plugin version exemptions.
3. **Waiting.** Running chats finish their turns; a new message gets "Delo started no new turn: an update is waiting for running chats" and you send it again once Delorun is back. Delorun waits up to 30 minutes, then stops the update with `DRAIN_TIMEOUT` and changes nothing.
4. **Switching.** The studio stops, the chat-data copy is written when one is taken, and the new release starts. The studio is unavailable for this step.
5. **Health check.** Within two minutes the new release must verify its own files, answer its health request, start every plugin that started before, keep the profile's bundle list, and turn off nothing the report did not name.

If the health check fails, or the new release stops, Delorun goes back on its own to the release and profile you had and prints which check failed: `Delo <version> failed its health check (<check>); Delo <previous> runs again with the profile from before. See delorun logs.` On success it prints `Delo <version> runs now.`

## Chat data that changes format

Most releases store chats as the release before did. When a release changes how chats or other stored data are written, the report says so, for example `Chat data: Delo 1.1.0 keeps chat data in a format Delo 1.0.0 may not read.`, and Delorun treats the change as one-way: once the new release has started, the older release may not read the data.

For such an update, Delorun offers to copy your chat data first, and the copy is the default: `The chat data changes format. Take a copy first?` The copy holds your chats and plugin stores (`sessions/` and `storages/`) as they were, in `data-copies/<version>/` in your Delorun home; attachments stay where they are, and secrets are never copied. The report shows the size of the copy and the free space, and Delorun refuses with `DATA_COPY_NO_SPACE` when it does not fit.

- `delorun update --data-copy` takes a copy even when the format does not change.
- `delorun update --no-data-copy` skips it. Without the copy, you cannot go back to the older release after the new one first starts; only your profile can go back.

Delorun keeps one copy. `delorun recover status` lists it with its size, and `delorun recover discard <path>` removes it once you no longer need to go back.

## Going back

`delorun recover` shows where your profile stands and takes you back:

| Command | What it does |
| --- | --- |
| `delorun recover` or `delorun recover status` | Shows the last update, its snapshot, how many profile versions exist, whether safe mode is on, and each data copy with its size. `--json` prints it as JSON. |
| `delorun recover rollback` | Goes back to the release before the last update, with the profile snapshot taken before it. When the chat data changed format, it sets the newer data aside and puts the copy back; without a copy it refuses with `ROLLBACK_NEEDS_DATA_COPY`. |
| `delorun recover rollback --profile-only` | Restores the profile snapshot and keeps the running release. |
| `delorun recover restore <version>` | Restores any saved profile version at once. |
| `delorun recover discard <path>` | Removes a data copy or a set-aside folder that `status` lists. |
| `delorun recover safe-mode` | Starts without your own plugins ([Daily use](daily-use.md#safe-mode-and-recovery)). |

`delorun recover rollback` works whether Delorun runs or not; a running Delorun first waits for running chats. The rollback completes when the older release starts and passes its check. Delorun keeps two releases installed, the running one and the one before, so it can go back one release.

A rollback does not merge. When the data format changed, the chat data as the newer release left it, with the chats you started after the update, is set aside in `data-set-aside/` in your Delorun home, not deleted, and the copy taken before the update comes back in its place; `delorun recover discard <path>` removes the folder once you no longer need it. Secrets are never rolled back.

## Channels

Each release belongs to a channel, `stable` or `beta`, and checks for updates on its own channel; no setting moves an installation to another channel. `delorun update` offers the channel's current release whenever it differs from the running one, a lower version included.

## For the technically curious

The [update report contract](../contracts/c03-update-report.md) defines the report, the health check and rollback, the [release manifest contract](../contracts/c02-release-manifest.md) defines channels and signatures, and the [update and rollback design](../design/update-and-rollback.md) and [update notice design](../design/update-notice.md) explain why updates work this way.
