---
description: "Updating Delorun when you run many third-party plugins: what Delorun saves before an update, how to read the update report's disabled lines and try a plugin anyway with a version exemption, what the health check verifies, and how to go back or repair afterwards."
---

# Update Delorun with many plugins

English | [中文](updating-with-plugins.zh.md)

## Summary

This page is for people who run many plugins that other people wrote. A release can exclude a plugin whose declared version range does not admit it, and the update turns that plugin off. You can see which ones before you decide, try one anyway, and go back if the new release does not work for you. You need Delorun installed with its launcher and git ([Updates](../safety-and-updates/updates.md) lists the prerequisites). The steps run in order: before, check, update, after.

## Contents

- [Before: what is saved](#before-what-is-saved)
- [Check: read the report](#check-read-the-report)
- [Update: the health check](#update-the-health-check)
- [After: verify and go back](#after-verify-and-go-back)
- [Next](#next)

## Before: what is saved

Delorun saves your setup itself, so you do not copy it by hand. Before the switch it records a [profile history](../../reference/glossary.md#profile-history) version named `Before update to Delorun <version>` (a [snapshot](../../reference/glossary.md#snapshot)). The version holds your plugin list and the versions you pinned, your bundle list, your patches and your plugin version exemptions. It does not hold the plugins' installed code; `delorun recover` and the studio's Setup versions screen bring the list back, and the profile installs from it.

Your chats are not part of that snapshot. Most releases store them as the release before did, and then nothing needs copying. When a release changes the chat-data format, Delorun offers a copy first. To take a copy for any update, add `--data-copy`:

```text
delorun update --data-copy
```

To keep your chats safe, also write them out with `delorun export <chat-or-workspace> --out <file>`, which saves a chat, or a workspace's record with its chats and attachments, as a file another home imports ([Daily use](../everyday-use/daily-use.md#trash-export-and-import)). Export does not hold the files in a workspace's folder or your plugins, so it is not a backup of a project.

## Check: read the report

Run the report while Delorun runs. It installs the release beside yours and changes nothing:

```text
delorun update --report
```

Read the lines under `Changes`. Each starts with what happens to the plugin:

- `kept`: the plugin carries over. Delorun lists it only when you should see it, for example a plugin that runs under an exemption.
- `disabled`: the update turns the plugin off. A line such as `acme-tools requires DSH ^0.1.0; Delorun 0.2.0 runs DSH 0.2.2.` says which range excludes the new release.
- `removed`: the plugin or bundle leaves your lists.
- An item that ends `Delorun cannot predict this item.` is one the report could not decide, for example because its `package.json` cannot be read.

Read each `disabled` line with the plugin's author in mind. A plugin that declares no range is `kept`, with a line saying its compatibility is not stated.

Check a plugin before the release exists, or one you are writing, with `delorun plugin check <directory>`. It reads the folder's `package.json`, runs none of its files, and says what each of the plugin's version ranges admits against the release you run. It applies no exemption.

When a `disabled` line is a DeepSeek Harness range and you want the plugin anyway, the report prints the way to try it. A version exemption accepts the risk for one exact plugin version on one exact DeepSeek Harness version:

```text
delorun plugin allow-version acme-tools@1.2.0 --dsh-version 0.2.2 --accept-risk
```

Delorun prints the risk before it saves the exemption. Use the plugin version the report names and the DeepSeek Harness version it says the new release runs. An exemption does not carry to the next plugin version or the next Delorun release, so repeat it when either changes. `delorun plugin version-exemptions` lists the ones you have, and `delorun plugin revoke-version` removes one. A Delorun range (`engines.delorun`) has no exemption: ask the author for a release that admits the new version, or keep the plugin disabled.

Run `delorun update --report` again to see the line change, then decide.

<details>
<summary>Edge cases</summary>

- If the report says a plugin `runs today under your exemption` that `does not cover` the new version, then the exemption names the old DeepSeek Harness version. Grant it again for the new one.
- If you decline the update, then no plugin changes, and the exemption stays saved.

</details>

## Update: the health check

Run `delorun update`. It prints the report again and asks `Apply the update to Delorun <version>?`. `delorun update --yes` confirms only a report that turns nothing off, removes nothing, merges none of your changes to Delorun's own files and holds nothing Delorun cannot predict, and only when the release-log check passed, so with many plugins you will usually answer the question yourself. A report is valid for ten minutes.

After the switch, the new release has two minutes to pass its health check. The check verifies that:

- the new release's own files match their signed list;
- the studio answers;
- every plugin, bundle and profile entry the update turned off was one the report named;
- every entry the report did not name loads without an error, except one that already failed to load before;
- your bundle list is the one the report predicted.

An exempted plugin that fails to load is an entry the report did not turn off, so the check fails. If any check fails, or the new release stops, Delorun goes back on its own to the release and profile you had and prints which check failed: `Delorun <version> failed its health check (<check>); Delorun <previous> runs again with the profile from before. See delorun logs.` On success it prints `Delorun <version> runs now.`

## After: verify and go back

Check that your plugins are on: open the studio's Settings, Plugins page, or run `delorun doctor`, which reports a plugin the installer or the start refuses and prints the command that accepts the risk.

If the new release works but a plugin does not, the setup is in the history, so you can go back one step at a time:

| You want | Run |
| --- | --- |
| The previous release and your profile from before the update | `delorun recover rollback` |
| Your profile from before the update, on the new release | `delorun recover rollback --profile-only` |
| Any saved version of your setup | `delorun recover restore <version>`, or Settings, Setup versions in the studio |
| To see where you stand | `delorun recover status` |
| Delorun without your own plugins | `delorun recover safe-mode` |

The versions screen in the studio (Settings, Setup versions) lists every saved version newest first. **What changes** on a version shows which plugins would come back, change version or be removed, and which exemptions change; it writes nothing. **Switch to this version** saves your current setup first, so switching back is the same step. The rollback is described in [Going back](../safety-and-updates/updates.md#going-back).

A rollback to the previous release needs the chat-data copy when the chat format changed; without one it refuses with `ROLLBACK_NEEDS_DATA_COPY`, and `--profile-only` still works.

<details>
<summary>Edge cases</summary>

- If Delorun will not start after an update, then replace the program and keep your data: `npx delorun@latest repair` ([Repair](../help/troubleshooting.md#repair)). A plugin that stops the start is a different case: `delorun recover safe-mode`.
- If the release channel cannot be reached, then download the release's files and run `delorun update --from <folder>` ([Update from files you downloaded](../safety-and-updates/updates.md#update-from-files-you-downloaded)). The report, the health check and the rollback are the same.
- If a plugin you rely on has no compatible release, then do not update yet: keep running the release you have, which still checks the channel once a day and tells you when a newer one exists.

</details>

<details>
<summary>Go further</summary>

- Look for plugins a release would turn off before you update: `delorun update --check` names how many, and `delorun update --report` names which.
- Take the chat-data copy every time: `delorun update --data-copy`.
- Check a plugin's declared ranges against the release you run: `delorun plugin check <directory>`.

</details>

## Next

- The full update flow: [Updates](../safety-and-updates/updates.md).
- Write or maintain a plugin: [Write a plugin for Delorun](plugins.md), including [Check its versions](plugins.md#check-its-versions).
- If something failed: [Updates and rollback](../help/troubleshooting.md#updates-and-rollback).
