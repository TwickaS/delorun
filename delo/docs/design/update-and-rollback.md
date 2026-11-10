---
description: "Design of Delo's update and rollback: the update report's data item, the copy of chat data taken by default, the one rollback table, interrupted restores, and the rule that a rollback deletes nothing."
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

- `@delo/update` builds an update report in format `delo.update-report/1`. Its items are plugins, bundles and profile rows that the target release would disable, remove or change, each with a reason from a closed list. No command produces a report: `delorun` has no `update` command.
- The home process answers the handshake operations `update.prepare`, `update.apply`, `rollback` and `update.cancel`, and no command calls them. The chat gate that `delorun start` gives the home process counts no chats, and its health check always reports healthy.
- `delorun recover` reports where the profile stands, rolls the profile back to the snapshot an update took (`--rollback`), restores a named profile history version (`--restore <version>`), and enters or leaves safe mode. It writes profile files only, never chat data and never the runtime store.
- Upstream's readers refuse data newer than they know: a chat log in a newer session format is refused, a whole-unit storage file of a newer version is refused, and a per-record storage file of an unknown version reads as absent. A runtime that goes back to an older release can therefore lose access to chats the newer release wrote or migrated.
- Upstream's attachment store only adds files, and the full-text index of the shipped profile is held in memory.

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

## What this does not protect against

- Chats written after an update that the person then rolls back with a copy are set aside, not merged into the restored data. The person brings them back by import.
- A person who declines the copy cannot go back to the previous release after the target first starts; only the profile goes back.
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

## What is built so far

The report format `delo.update-report/1` with plugin, bundle and row items, the handshake operations, and the profile snapshot rollback of `delorun recover --rollback` are built. The data item, the copy, the update record, the rollback table, the set-aside directories, the restore journal and the `delorun update` command are not built.
