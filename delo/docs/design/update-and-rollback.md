---
description: "Design of Delo's update and rollback: the update report's data item, the copy of chat data taken by default, the one rollback table, interrupted restores, the rule that a rollback deletes nothing, the refusal of a lower version, and verified updates and rollback for the desktop app."
---

# Update and rollback

English

## Summary

Before an update changes anything, Delo shows a report of what the new release would disable, remove or change, including whether it changes how chat data is stored. When it does, Delo copies the chat data first unless the person declines, so going back to the previous release keeps working. Every way back runs through one function and one table, and a rollback never deletes chat data: chats written after the update are set aside, not removed. The update report's types and rules are [contract C3](../contracts/c03-update-report.md), the home process's update handshake [contract C19](../contracts/c19-home-process.md), and the home's directories [contract C1](../contracts/c01-home-layout.md).

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- `delorun update` updates the CLI home through its home process. The home process fetches and verifies the channel's release, installs it into the runtime store and builds an update report in format `delo.update-report/3`, whose items include the `data` item of rules 1 to 3; the command prints the report, asks, and applies it with the person's choice about the session-data copy.
- The session-data copy, the update record `run/<profile>/update.json` with `targetStarted`, the one rollback table, the set-aside directories, the restore journal, the chat gate that counts running chats and refuses new turns while an update waits, and the health checks with the automatic rollback are built for the CLI home. [C3](../contracts/c03-update-report.md), [C19](../contracts/c19-home-process.md) and [C1](../contracts/c01-home-layout.md) describe them.
- `delorun recover` reports where the profile stands and runs one action per call: `rollback` through the one rollback table, `rollback --profile-only`, `restore <version>`, `safe-mode` and `exit-safe-mode`, and `discard <path>` for a copy or set-aside directory.
- No client compares versions before an update: `delorun update` offers the channel's release whenever it differs from the running one.
- The desktop app is upstream's, unchanged: its updater downloads and installs on the person's click and refuses a downgrade, checks no Delo manifest or log entry, keeps no previous release and offers no rollback.

## The rules

### The report names a data change

1. Each release carries a signed file, `data-formats.json`, in its runtime: `{ "schema": "delo.data-formats/1", "persistence": <SHA-256 of upstream's generated persistence schema at the built commit>, "deloRecords": { <record name>: <version> } }`. `deloRecords` lists the versioned records Delo's own packages keep under the home. The file is in the signed file list, so the release manifest does not change.
2. Equal files mean the two releases read each other's data. Any difference is one report item of kind `data`, reason `data-format-changed`, effect `changed`. A file that is missing or unreadable on either side is reason `data-format-unknown`, which is unverified and treated the same way. Delo does not judge the direction of a difference: every difference is treated as one-way. The comparison never refuses an update or a rollback.
3. The report format becomes `delo.update-report/2`, and its counts gain `data`.

### The copy is taken by default

4. When the data differs, the item's actions are `copy-session-data`, the default, and `continue-without-copy`. `delorun update --yes` takes the copy. Declining needs `--no-data-copy` or the prompt's second choice, and the report says beside that choice: "Without the copy, Delo cannot go back to `<from>` after `<to>` first starts." When nothing differs, no copy is offered, and `--data-copy` takes one anyway.
5. No update whose data differs applies before the person has seen the item and chosen about the copy.
6. The copy holds the home's `sessions/` and `storages/` as real copies (a file-system clone where the file system offers one, otherwise a full copy), never hard links. `attachments/` stays in place because nothing deletes from it, and `cache/` is left out and rebuilds.
7. Delo's own records under `secrets/` are never copied or restored, because restoring a device list would trust a removed device again. Instead the previous release reads every record the current release writes, and the [journey check](journey-check.md)'s rollback step tests it.
8. The copy is written to `data-copies/<to version>/` beside `copy.json`, which records both releases' `data-formats.json`, the file count and the byte total. It is written after the chat gate reports that no chat runs and the Host has stopped, while the home lock is held, under a temporary name that is renamed and synced before the runtime switches. The report shows the copy's size and the free space; a copy that does not fit refuses the update with `DATA_COPY_NO_SPACE` unless the person chose to continue without it.
9. One copy is kept. A later update's copy, or the person through `delorun recover`, removes the older one.

### Every way back uses one table

10. The update record `run/<profile>/update.json` records the two versions, whether the data differs, whether a copy exists, and `targetStarted`, which is written and synced before the target's process starts.
11. The handshake's `rollback`, the automatic rollback after a failed health check, the restart after an interrupted update and `delorun recover rollback` with no home process all read the update record and apply this table; none switches the runtime on its own.

| Data differs | Target started | Copy | A rollback |
| --- | --- | --- | --- |
| no | either | none offered | Restores the profile snapshot and switches to the previous runtime. Chats written since stay. |
| yes | no | either | The same; the target never opened the data. |
| yes | yes | present | Lists how many chats were created or changed since the update and says they are set aside, not deleted. Moves the live `sessions/` and `storages/` to `data-set-aside/<to version>-<time>/`, moves the copy into place, restores the profile snapshot and switches the runtime. |
| yes | yes | absent | Refuses with `ROLLBACK_NEEDS_DATA_COPY` and the reason, and offers `delorun recover rollback --profile-only`, which restores the profile snapshot and keeps the target runtime. |

12. A rollback deletes no chat data. Set-aside data stays until the person removes it with `delorun recover`, which lists each set-aside directory with its size. Set-aside chats come back through an archive import ([C8](../contracts/c08-archive-and-trash.md)).
13. An interrupted restore finishes before any Host starts. The restore writes a journal, `data-copies/restore.json`, before its first rename, and each step is one directory rename. The launcher, `delorun start` and `delorun recover` read the journal before they start a Host and complete the step in progress.

### Before the command is wired

14. The chat gate counts running chats, and the health check evaluates [C3's health-check criteria](../contracts/c03-update-report.md#health-check), before `delorun update` reaches the handshake.
15. The design holds for the CLI home only. The desktop app shares `sessions/` and takes no home lock, so it does not update through this procedure until one lock covers both installations and its updater follows the same table.

### No version goes down on its own

16. `delorun update` and the update channel refuse a target lower than the running version unless the person asks for a rollback, which reaches only a signed, logged release through the rollback table.

### The desktop app

17. Before the desktop app hands a download to electron-updater's `quitAndInstall`, it verifies a fresh timestamp, the manifest's signature, the downloaded file's SHA-512 and SHA-256 against the manifest's `desktop` entry and the manifest's log entry ([C2](../contracts/c02-release-manifest.md), [C18](../contracts/c18-release-log.md)). Any failure refuses the install and leaves the running version unchanged.
18. After an update applies, the app keeps the installer or update archive of the release it replaced in its update cache directory, verified against that release's manifest. The cache keeps exactly one previous release.
19. The feed refuses an automatic downgrade: a feed that names a version lower than or equal to the running one offers nothing.
20. A rollback the person requests installs the cached previous release, or an earlier release the person names, downloaded from GitHub Releases. The target must verify as signed (manifest and file digests) and logged (inclusion proof); an unsigned, unlogged or mismatching target is refused. After the install, the profile is restored from history.

## What this does not protect against

- Chats written after an update that the person then rolls back with a copy are set aside, not merged into the restored data. The person brings them back by import.
- A person who declines the copy cannot go back to the previous release after the target first starts; only the profile goes back.
- A running desktop app is not counted as a user of the chat data ([C1](../contracts/c01-home-layout.md#what-this-does-not-prove)): nothing under the home shows that it runs, so an update's copy, restore or rollback can run while it writes the same stores. Rule 15 keeps the desktop app out of this procedure; the gap is accepted while the desktop app is not shipped.
- Data a plugin keeps outside `sessions/` and `storages/` is not copied.
- The copy is plain files under the home with the home's modes, like the data it copies; it is not encrypted.
- The rename rules of Windows, where an open file cannot be renamed, are not covered.

## Denial tests

| Test | Proves |
| --- | --- |
| `c03-data-change-named` | A target whose `data-formats.json` differs produces one `data` item before anything changes. |
| `c03-unknown-data-format-is-unverified` | A missing or unreadable `data-formats.json` is `data-format-unknown`, unverified, and `--yes` does not confirm it. |
| `c03-yes-takes-the-copy` | `delorun update --yes` on a data change writes the copy before the runtime switches. |
| `c03-copy-without-space-refuses` | A copy larger than the free space refuses the update with `DATA_COPY_NO_SPACE`. |
| `c03-rollback-restores-copy-and-sets-aside` | A rollback after the target started restores the copy and moves the newer data to `data-set-aside/`, deleting nothing. |
| `c03-rollback-without-copy-refuses` | A rollback after the target started with no copy refuses with `ROLLBACK_NEEDS_DATA_COPY`, and `--profile-only` succeeds. |
| `c03-rollback-before-first-start-needs-no-copy` | A rollback before the target started needs no copy and leaves the data as it was. |
| `c03-pointer-swap-applies-the-table` | `delorun recover rollback` with no home process applies the table and never switches the runtime alone. |
| `c03-second-rollback-keeps-both-set-asides` | A second rollback keeps the first set-aside directory. |
| `c03-interrupted-restore-completes-before-a-host-starts` | A restore killed between renames is completed by the next `delorun start` before a Host starts. |
| `c03-previous-release-reads-delo-records` | The previous release reads every record under the home that the current release writes. |
| `an update to a lower version is refused` | `delorun update` against a channel that names a release lower than the running one offers nothing, and an update-channel request naming a lower installed version is refused. |
| `c02-desktop-refuses-bad-manifest` | A desktop update whose manifest signature fails, or whose downloaded file's SHA-512 differs from the manifest, is refused before `quitAndInstall`. |
| `c02-desktop-refuses-unrequested-downgrade` | A feed naming a lower version offers no update. |
| `c02-desktop-rollback-signed-logged` | A requested rollback to a signed, logged earlier release applies and restores the profile from history. |
| `c02-desktop-rollback-refuses-unsigned-or-unlogged` | A requested rollback to a release without a verifying manifest, or without a verified log entry, is refused. |

## What is built so far

Rules 1 to 14 and rule 16 are built for the CLI home, and C3, C19, C1 and C2 describe them: the runtime store refuses an update target lower than `current` with `TARGET_LOWER` before anything installs, and `delorun update` refuses a report whose target is lower than the running release. Rule 15's single lock for the CLI home and the desktop app, and the desktop app's rules 17, 18 and 20, are not built. Rule 19 holds through upstream's updater, which refuses a downgrade (`allowDowngrade` false).
