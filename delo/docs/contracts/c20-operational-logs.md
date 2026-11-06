---
description: "Contract C20: where each Delo process writes its operational log, the record format keyed by upstream's session and turn ids, rotation at 10 MiB with 5 files kept and deletion after 14 days, the redaction rule over Delo's logger and captured child output, delorun logs, and purge's offer to clear process logs."
---

# C20 Operational logs

English | [中文](c20-operational-logs.zh.md)

## Summary

This contract defines the files where Delo's own processes record how they behaved, so a person or their agent can find out why something failed without a studio. The CLI home process, the desktop Host, the Docker supervisor and the self-hosted relay each write their own log at a fixed location, as JSON lines that carry upstream's session and turn ids where a record belongs to a chat. Logs rotate at 10 MiB, keep 5 files and are deleted after 14 days, which also bounds how long fragments of a purged chat can stay in them. Every record passes a redaction step, so no secret, token, key, owner code or cookie reaches a log. `delorun logs` shows each log and its location. Session logs are a different thing: they record chats and stay permanent. The types package [`@delo/contract-operational-logs`](../../packages/contract-operational-logs/README.md) carries the record type, surfaces and limits.

## Contents

- [Surfaces and destinations](#surfaces-and-destinations)
- [What a log holds](#what-a-log-holds)
- [Record format](#record-format)
- [Rotation and retention](#rotation-and-retention)
- [Redaction](#redaction)
- [delorun logs](#delorun-logs)
- [Purge and process logs](#purge-and-process-logs)
- [Limits](#limits)
- [Consumers](#consumers)
- [Compatibility](#compatibility)
- [Security](#security)
- [Enforcement per platform and dialect](#enforcement-per-platform-and-dialect)

## Surfaces and destinations

Each surface writes one log through Delo's logger, `@delo/logs`. Paths are relative to the Delo home (C1) unless the row says otherwise.

| Surface | Name | Active file | Writer |
| --- | --- | --- | --- |
| CLI home process | `home-<profile>` | `logs/home-<profile>/home.log` | the home process (C19), including its Host and its standard output and standard error |
| Docker supervisor | `supervisor-<profile>` | `logs/supervisor-<profile>/supervisor.log` | the supervisor (C9) |
| Desktop Host | `desktop-host` | `logs/desktop-host/desktop-host.log` | the desktop app's main process, from the Host child's standard output and standard error |
| Self-hosted relay | `relay` | `/var/log/delo-relay/relay.log` inside the relay container, on the volume the relay's guide names | the relay data plane |

- **The desktop Host.** The desktop app's main process writes the Host child's output to the file, as well as keeping the in-memory tail of standard error that upstream keeps, so the Host's diagnostic trail is never only in Electron's console.
- **The relay container.** Its standard output carries only a one-line start record and fatal errors, both redacted; its log is the file.
- **Upstream's reports.** Upstream's `logs/startup-*.log` files are written only by upstream's own `dsh` entry, which records raw diagnostics and states that they may contain credential values. `delorun` never writes them: a start failure of a `delorun` process is written through Delo's logger to that process's surface. `delorun logs` lists existing `startup-*.log` files with upstream's warning, and purge's offer covers them.
- **Session logs.** Session logs are upstream's session records under `sessions/`. This contract never rotates, redacts, deletes or reads them.

## What a log holds

- Delo's own records state operations, states, outcomes, durations, versions, ids and error codes. They never contain chat message text, prompts, model output, tool arguments, tool results or file contents.
- Captured output is the standard output and standard error of upstream code a surface runs: the CLI Host's console output in the home process and the desktop Host child's streams. It can contain text from chats, commands and files, such as an error line that quotes a command; it passes the same redaction as Delo's records.

## Record format

A log file is UTF-8 JSON Lines: one JSON object per line, each line at most 16,384 bytes including its newline.

| Field | Type | Present |
| --- | --- | --- |
| `ts` | RFC 3339 UTC time with milliseconds | always |
| `level` | `error`, `warn`, `info` or `debug` | always |
| `surface` | the surface name | always |
| `pid` | the writing process id | always |
| `startId` | C1's start id of the home process | on the `home-<profile>` and `supervisor-<profile>` surfaces |
| `logger` | the Cordis logger name, or `stdout` or `stderr` for captured output | always |
| `source` | `delo` or `captured` | always |
| `msg` | the redacted message | always |
| `sessionId` | upstream's session id | when the record belongs to a session |
| `turn` | the number of upstream's `turn/start` event | when the record belongs to a turn |
| `workspaceId` | upstream's workspace id | when the record belongs to a workspace |
| `err` | `name`, `code`, redacted `message` and redacted `stack` | on error records |
| `truncated` | the number of bytes removed | when a record was cut to fit |

- **Session and turn keys.** `sessionId` and `turn` are upstream's own values, so a chat's turn leads to the process records behind it. No field is added to any session-log event.
- **Long records.** A record that would exceed 16,384 bytes is redacted first and then cut: `msg` and `err.stack` are shortened and `truncated` states how many bytes were removed.
- **Captured lines.** Captured output is split at newlines, and each line becomes one record. A line is held until its newline arrives, up to 65,536 bytes; a longer line is redacted as a whole at that size, written as a record with `truncated`, and the rest of the line up to the next newline is dropped and counted.

## Rotation and retention

| Value | Setting |
| --- | --- |
| Rotation size | 10 MiB (10,485,760 bytes) |
| Files kept per surface | 5: the active file and 4 rotated files |
| Deletion age | 14 days (1,209,600 seconds) |
| Age check | at each start of a Delo process on the machine, then every 3,600 seconds while it runs |

- **Rotation.** Before a write that would take the active file past 10 MiB, the writer renames `<name>.log.3` to `<name>.log.4`, then each lower number up, the active file to `<name>.log.1`, and opens a new active file. A rotated file beyond `.4` is deleted. Each surface therefore holds at most 50 MiB.
- **Age.** At each age check, every file of a surface whose oldest record is older than 14 days is deleted; when that file is the active file, it is rotated first. Every `delorun` invocation runs the age check for every local surface it can reach, so logs of a stopped home process are also checked.
- **The bound.** A record is deleted at the first age check after it is 14 days old. On a machine where no Delo process runs, no check runs, and records stay until the next start of a Delo process.
- **Session logs** are never rotated or deleted by these rules.

## Redaction

Every record passes the redactor before it is written, both Delo's own records and captured output. The redactor runs before truncation, so it never sees a secret cut in half.

1. **Known values.** Every secret value a process holds or reads is registered with the redactor when it is loaded: model and provider keys, the start token, session secrets, cookie values, owner codes, device and relay keys, the S2 helper channel key and forwarded deploy keys and tokens. Each occurrence of a registered value of at least 8 characters is replaced with `[redacted:<kind>]`, including its base64, base64url, hexadecimal and URL-encoded forms.
2. **Structured fields.** Before serialisation, the value of every object key whose name contains `key`, `token`, `secret`, `password`, `passwd`, `cookie`, `credential`, `authorization` or `session` (in any case) is replaced with `[redacted]`. Ids that this contract names (`sessionId`, `startId`, `workspaceId`) are exempt.
3. **Patterns.** Text matching these forms is replaced with `[redacted:<kind>]`: the value of an `Authorization`, `Proxy-Authorization`, `Cookie` or `Set-Cookie` header; a `Bearer` or `Basic` credential; the user information of a URL; the value of a URL query parameter whose name contains `token`, `key`, `secret`, `password`, `code` or `sig`; a PEM private key block; a provider key beginning with `sk-`; GitHub tokens beginning with `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` or `github_pat_`; AWS access key ids beginning with `AKIA`; JSON Web Tokens; Slack tokens beginning with `xox`; a run of exactly 26 characters from `A`–`Z` and `2`–`7` between non-alphanumeric characters, the form of an owner code; and the value of a `NAME=value` pair whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `COOKIE`.
4. **Errors.** An error's message and stack pass steps 1 and 3; an error's own properties pass step 2.

## delorun logs

| Command | Prints |
| --- | --- |
| `delorun logs` | each local surface with its location, whether it exists, its size and its oldest record time, then the last 50 records of the active profile's home process |
| `delorun logs <surface>` | the last 50 records of that surface; `-n <count>` sets the count, at most 10,000 |
| `--follow` | new records as they are written, across rotations |
| `--since <duration>` | records newer than the duration, such as `30m` or `2d` |
| `--session <id>`, `--turn <n>` | records with that `sessionId`, and with that `turn` |
| `--json` | the records as stored |
| `--path` | only the active file's path |
| `--clear [<surface>]` | after confirmation, deletes the surface's rotated files and empties its active file; without a surface, every local surface and upstream's `startup-*.log` files |

- **Surface names.** `home` (the active profile's home process, or `--profile <name>`), `supervisor`, `desktop-host` and `startup`. `relay` is not local: `delorun logs relay` prints the location inside the relay container and the relay guide's command for reading it.
- **Human output.** `<ts> <level> <surface> [<sessionId>/<turn>] <msg>`.

## Purge and process logs

Purge (C8) removes a chat from every store Delo controls. Process logs can still hold fragments of it, in captured output or in an error line.

- **The statement.** Purge states that fragments of purged content may remain in process logs until this contract's retention deletes them, at most 14 days after they were written, as [rotation and retention](#rotation-and-retention) bounds it.
- **The offer.** Purge offers to clear the process logs at once. The affected logs are every local surface's files and upstream's `startup-*.log` files, because captured records do not always carry a session id. Choosing it runs the effect of `delorun logs --clear` for those files.
- **Running writers.** Clearing empties each active file in place and deletes each rotated file, so a running writer continues in the emptied file.

## Limits

| Limit | Value |
| --- | --- |
| Record line | at most 16,384 bytes |
| Held captured line | at most 65,536 bytes |
| Rotation size | 10 MiB |
| Files kept per surface | 5 |
| Deletion age | 14 days |
| Age check interval | 3,600 seconds |
| Minimum registered secret length | 8 characters |
| Records printed by default | 50 |
| `-n` | at most 10,000 |
| Mode of log directories | 0700 |
| Mode of log files | 0600 |

## Consumers

- `delo/packages/logs`: the logger, the Cordis logger exporter, capture, redaction, rotation and the cross-surface denial suite.
- `delo/apps/cli`: `delorun logs` and purge's offer.
- `delo/packages/home-process`, `delo/packages/supervisor` and `delo/apps/relay`: their surfaces.
- Upstream's `apps/desktop`: the desktop Host's log file.
- Purge and the trash (C8): the statement and the offer.

## Compatibility

- The file locations, surface names, `delorun logs` flags and record fields are external interfaces: an agent reads them. A field may be added; removing or renaming a field or moving a location is a breaking change with an upgrade guide under `delo/docs/upgrade-guide/`.
- Readers ignore unknown fields.
- Rotation and retention values change only in this contract, together with purge's statement.
- No change to this contract changes upstream's session format.
- The types package follows Delo's version and changes in the same pull request as this page.

## Security

### Requirements

1. No secret, token, key, owner code or cookie reaches a process log. Redaction covers Delo's own logger and the captured output of upstream code, and runs before truncation.
2. Delo's own records hold no chat text, prompt, model output, tool argument or result, or file content.
3. Log directories have mode 0700 and log files 0600, so only the person can read them, and they lie under the Delo home, where every sandbox dialect denies confined commands writes and, where C1's `home-read` is enforced, reads.
4. A record's `sessionId`, `turn`, `workspaceId` and `startId` are ids that carry no secret.
5. The supervisor never logs a request body, a credential or an environment value; the update channel logs refused authentications without the presented value.
6. Process logs are deleted after 14 days, and purge states that bound and offers to clear them at once.
7. `delorun` never writes upstream's raw startup reports.

### Denial tests

| Test | Proves |
| --- | --- |
| `log-canary-every-surface` | Canary secrets of every kind in step 1 of the redactor, planted through Delo's logger and through captured upstream output on every surface in the tree, never appear in any log file, rotated files included, in raw, base64, base64url, hexadecimal or URL-encoded form |
| `log-canary-split` | A canary secret split across two writes of captured output, and one in a line longer than 65,536 bytes, never appears in a log file |
| `log-canary-patterns` | A planted `Authorization` header, URL user information, PEM key and owner-code-shaped value in captured output are redacted |
| `log-desktop-host-file` | The desktop Host's output reaches `logs/desktop-host/desktop-host.log` |
| `log-rotation` | Writing past 10 MiB rotates the file, at most 5 files exist, files whose oldest record is older than 14 days are deleted at the next age check, and session logs are untouched |
| `log-modes` | Log directories are created at 0700 and files at 0600 |
| `log-session-keys` | The records of a turn carry its `sessionId` and `turn`, and the parity replay shows no session-log event with a new field |
| `log-purge-clear` | After a purge with the clear offer chosen, no canary residue of the purged chat remains in any log file |
| `log-confined-write-denied` | On every dialect, a confined command cannot write a log file (C1's `home-write`) |

## Enforcement per platform and dialect

| Requirement | Linux | macOS | Windows | Relay container |
| --- | --- | --- | --- | --- |
| Owner-only access | modes 0700 and 0600 | modes 0700 and 0600 | the DACL that C1 checks | modes 0700 and 0600 inside the container, owned by the relay's user |
| Confined commands cannot write logs | every dialect (C1's `home-write`) | Seatbelt (C1's `home-write`) | windows-acl (C1's `home-write`) | no agent commands run there |
| Confined commands cannot read logs | where C1's `home-read` is enforced: bwrap and Landlock | Seatbelt | where `windows-home-read-label` passes | no agent commands run there |
| Age check without a running Delo process | none | none | none | none while the container is stopped |

- **What redaction cannot catch.** Steps 1 and 3 catch registered values and listed forms. A secret that Delo never loaded and that matches no listed form, printed by upstream code, can pass; the denial suite proves the listed kinds, and the bound and purge's offer cover what remains.
