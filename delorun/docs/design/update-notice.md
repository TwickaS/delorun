---
description: "Design of the update notice: the check that verifies the channel's newest release and sends nothing about the person, when it runs, how the terminal and the studio show it, the one switch that turns it off, the patch rule that keeps a security fix a patch, and how a plugin targets Delorun's own version."
---

# The update notice

English | [中文](update-notice.zh.md)

## Summary

An update is the person's choice: `delorun update` and the studio's Update now show the same report, ask, copy the chat data and roll back on a failed health check ([update and rollback](update-and-rollback.md#the-studios-update)). The update notice tells the person that a newer release exists. A running installation checks the release channel at start and on a schedule, verifies what it fetches as an update verifies it, and shows one line in the terminal and a quiet notice in the studio's sidebar. The notice names the kind of update, whether it is a security fix, how many installed plugins it would turn off, and the command to run; it applies nothing itself; the studio's Update now button on the notice opens the report. Delorun has one release stream, so a security fix is a release with a mark, and the release tool keeps such a fix a patch that leaves every plugin compatible. Delorun's version and upstream's are two axes ([C17](../contracts/c17-plugin-versions.md)); [C22](../contracts/c22-delorun-plugin-interface.md) states what a Delorun version promises a plugin, and `delorun plugin check` shows an author what their declared ranges admit.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Implementation status](#implementation-status)

## What exists today

- `delorun update` asks the home process to resolve the channel's newest release through `@delorun/install`'s `LauncherChannel`, which verifies the root chain, the timestamp, the manifest, the release-log bundle and the online log check ([C2](../contracts/c02-release-manifest.md), [C18](../contracts/c18-release-log.md)), installs it into the store and prints [C3](../contracts/c03-update-report.md)'s report. Nothing tells a person that a release exists until they run it.
- The timestamp names each channel's current release and its manifest. The manifest states the release's Delorun version and its upstream version, `dsh`. No signed file marks a security fix or carries a summary.
- `@delorun/update` decides each installed plugin's two axes against a target release, for the report.
- Upstream's `evaluatePluginCompatibility` decides both axes at install and at start. Nothing shows a plugin author what their ranges admit before they install.
- The release tool signs any version the draft names. Nothing compares a release with the earlier releases of its minor.

## The rules

### The check

1. The check is `checkForUpdate` in `delorun/apps/cli/src/update/notice.ts`. It opens the home's channel as `delorun update` does: from the release roots of the launcher that started Delorun, named in `DELORUN_LAUNCHER_ROOTS`, at the origins the installation recorded in `trust/channel.json`, through the same `LauncherChannel`. A Delorun the launcher did not start has no anchored root, and its check fails without a request, and calls `LauncherChannel.newest`, which fetches `timestamp.json`, any newer root files, the channel's manifest and its release-log bundle, and verifies them with the functions an update uses: the root chain, the timestamp's signature, expiry and version against the stored timestamp, the manifest's digest against the timestamp and its targets signature, and the bundle's inclusion proof and witness cosignature. It runs no online log check, downloads no archive and writes nothing under `trust/`.
2. A request carries no query, cookie, body or identifier. Nothing about the installed plugins leaves the machine.
3. The result is the channel's newest release: its Delorun version, its upstream version, whether its manifest marks it as a security fix, and its summary. A manifest without the mark is not a security fix; one without a summary has none.
4. The plugin count is computed on the machine: each installed plugin of the profile is evaluated on both axes against the newest release's two versions with the report's evaluation, which is upstream's installer and preflight evaluation with the newest release's versions, and the notice counts the plugins it would disable.
5. The check has one deadline for all its requests, the row's `timeoutSeconds`. A failed or unverifiable check adds nothing to the notice and says nothing in it: the notice keeps showing the last verified release, if any, and `delorun doctor` names the failure. A timestamp older than the last one the record holds, or a lower release on the same channel, is a failure, `regressed`, so a host cannot take a notice back by serving older files.
6. The result is written to `run/<profile>/update-check.json` ([C3](../contracts/c03-update-report.md#update-check)) with the time of the check: the newest verified release, when it was verified, the timestamp's version, and the last failure as a code. The failure's own text can come from the host, through a field read before its signature is checked, so it goes only to the home log, escaped; the record, the terminal and `delorun doctor` show Delorun's sentence for the code.

### The signed fields

7. The release manifest gains two optional fields, `security` and `summary`, signed with the rest by the offline targets key. The timestamp, whose online key signs only freshness, carries neither. A reader treats a manifest without them as no security fix and no summary.
8. A summary is one line of at most 200 characters with no control or format character, because terminals and the studio show it. Signing requires both fields in every new draft.

### When it runs

9. The check is the `delorun-update-check` row of `@delorun/bundle-local`. Its Config holds `enabled`, the C16 switch `update_check`; `intervalHours`, at least 1 and 24 by default; and `timeoutSeconds`. The row provides the `delorunUpdateCheck` service, and `delorun` attaches the check to it once the profile boots, only when the runtime runs from the store.
10. The row looks at start and then each hour, by the wall clock, so a machine that slept checks at its first wake. It checks when the last check is at least the interval old; after a failure it tries again after one hour, then two, four and so on, never later than the interval. A start never waits for it.
11. The Delorun project keeps no connection to an installation and pushes nothing; every check starts on the machine.

### Where it shows

12. The terminal shows one line, such as `Delorun 0.1.3 is available (security fix; all your plugins stay compatible). Run: delorun update`. `delorun start` and a bare `delorun` print that line alone from the last check once the home process runs; a foreground start prints it when its first check completes. `delorun update --check` also prints the release's summary beneath it, labelled `Release note:`, so the release's text is never read as Delorun's instruction.
13. The studio's sidebar shows a quiet notice with the version, the kind of update, the plugin count, the summary labelled as the release note, and the command. It reads `/api/delorunUpdateCheck.notice` over the studio's connection and refreshes on reconnect, focus and an interval. It can be dismissed for that version and comes back for a newer one. A device signed in through remote access is refused the route, which names the running release and the plugin count, so a phone shows no notice; a remote page that can read the route shows the text with no control.
14. `delorun update --check` runs the check on demand, whatever the switch says, and prints the same line, the summary and any failure. `delorun update --report` prepares the update through the home process and prints its full report, which plugins it disables and why, and applies nothing. `delorun doctor` reports the last check.

### Consent and control

15. One switch, the row's `enabled`, turns the check off: Settings → General → Updates → Check for new releases writes it, and so does setup's `updateCheck` answer in the same form ([C11](../contracts/c11-setup-answers.md#profile-writes)). Turning it off stops every scheduled check, and `delorun` removes the record on the next start.
16. Setup's main flow shows one privacy line with a link to the privacy page and asks no question about the check. `delorun setup privacy` states what is requested, from where, that those hosts see the machine's address, and how to turn the check off, then asks whether to check; Settings → General → Updates asks it in the studio. `--no-update-check` turns the check off for a whole setup run, interactive, `--yes` or `--config`; `delorun setup <section>` refuses it, so `delorun setup privacy` asks the question instead. Setup writes the answer before Delorun first starts, so a check turned off there makes no request.
17. The parity composition restates the row disabled, because stock makes no such request ([C16](../contracts/c16-parity-composition.md)).

### The patch rule

18. Signing refuses a release whose version is a patch of an earlier release of the same major and minor, a non-pre-release tag `v<major>.<minor>.<patch>` below it, when its upstream version differs from that release's, when upstream's persistence schema or Delorun's record versions differ, or when the plugin-facing interface inventory differs or names an interface the release no longer declares ([C22](../contracts/c22-delorun-plugin-interface.md)). A release that moves the upstream base is therefore at least a minor, and a security fix ships as a patch that disables no plugin.

### Targeting Delorun

19. The two axes stay independent: `engines.delorun` never overrides the upstream axis.
20. `delorun plugin check <directory>` reads the plugin's `package.json` without importing its code, evaluates both axes against the running release with upstream's `evaluatePluginCompatibility`, the installer's evaluation, and prints what each declared range admits, what is undeclared, and the `engines.delorun` range that targets the running Delorun minor.

## What this does not protect against

- The hosts see the machine's address and the time of each check, as for every other integrity request ([threat model](../security/threat-model.md#the-network)).
- The check reads no runtime archive, so a release whose archive does not match its signed file list is still noticed; `delorun update` and `delorun update --report` download the archive and refuse it before anything is installed.
- The notice does not run the online log check. A release whose signed bundle verifies but which the log does not hold is noticed, and `delorun update` refuses it.
- A host that withholds a newer release is noticed only when the timestamp expires; until then the notice shows the release the timestamp names. The online timestamp key alone, which the channel's cron Worker holds as a secret, can keep a stale release current beyond 3 days and freeze freshness the same way, and can name only a manifest the offline targets key signed, at a version not below the last one recorded.
- A process running with the person's own access can write the record under `run/<profile>/` and so choose what the notice says; the record's reader refuses a summary with a control character, so it cannot rewrite the terminal.
- The plugin count covers the version axes only. A revocation, a retired bundle or a profile row the update would change shows only in `delorun update`'s report.
- The patch rule checks the inventory's names, not the interfaces' types. A change of an interface's behaviour within a patch is caught only by review.

## Denial tests

| Test | Proves |
| --- | --- |
| `update-notice-sends-no-identifier` | Every request of a check is a bare `GET` of a channel file, with no query, cookie, body or plugin name. |
| `update-notice-unverified-index-silent` | A timestamp or manifest that does not verify adds nothing to the notice, keeps the last verified release and records the failure. |
| `update-notice-replayed-timestamp-refused` | A timestamp older than the stored one is refused. |
| `update-notice-writes-no-trust-state` | A check leaves `trust/` byte for byte as it was. |
| `update-notice-deadline` | A host that never answers ends the check at its deadline without a notice. |
| `update-notice-regressed` | An older timestamp or a lower release on the same channel is refused and the last verified release stays. |
| `update-notice-hostile-text` | Text the host chose reaches neither the record nor the terminal. |
| `update-notice-manifest-length-capped` | A timestamp that states an oversized manifest is refused before the manifest is fetched. |
| `update-notice-retries-after-failure`, `update-notice-wall-clock` | A failure is retried after one, two and four hours, and a machine that slept checks at its first hourly wake. |
| `update-notice-off-makes-no-request` | With the switch off the row registers nothing and no request is made. |
| `update-notice-remote-session-offers-no-action` | A remote session's notice offers no control. |
| `c02-summary-control-characters-refused` | A summary with an escape, a line break or a direction override is refused by the reader and by signing. |
| `patch-rule-refuses-base-move` | A patch whose upstream version differs from the earlier release's refuses to sign. |
| `patch-rule-refuses-persistence-change`, `patch-rule-refuses-delorun-record-change` | A patch whose data formats differ refuses to sign. |
| `patch-rule-refuses-interface-removal`, `patch-rule-refuses-interface-addition` | A patch whose interface inventory differs refuses to sign. |
| `plugin-check-imports-no-code` | `delorun plugin check` reads the manifest and runs none of the plugin's files. |
| `plugin-check-refuses-special-files` | A manifest that is a FIFO or a symbolic link is refused without waiting or following it. |
| `plugin-check-escapes-manifest-text` | The manifest's name and ranges print with terminal control characters escaped. |

## Implementation status

The rules above are built. The contract pages state them as built facts: the check, its record and the notice in [C3](../contracts/c03-update-report.md#update-check), the signed fields in [C2](../contracts/c02-release-manifest.md), the switch in [C16](../contracts/c16-parity-composition.md), the record's path in [C1](../contracts/c01-home-layout.md), and the promise, the patch rule and `delorun plugin check` in [C22](../contracts/c22-delorun-plugin-interface.md) and [C17](../contracts/c17-plugin-versions.md). This page keeps the reasons the rules are as they are.
