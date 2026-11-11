---
description: "Where Delo keeps its operational logs: every log's location, what a log holds and never holds, how long logs are kept, how delorun logs shows and clears them, and how they differ from the session logs that record your chats."
---

# Where Delo keeps its logs

English | [中文](logs.zh.md)

Delo has no release yet; this page describes the first release.

## Summary

Each of Delo's own processes writes an operational log: a file that records how the process behaved, so you or your agent can find out why something failed. Operational logs are separate from session logs, which record your chats and are kept until you delete the chat. `delorun logs` prints every log's location and the recent records of your home process. Delo's contract requires every record to pass redaction before it is written, every log to rotate at 10 MiB, and every log file to be deleted once its oldest record is 14 days old, at the next `delorun` command.

## Contents

- [Log locations](#log-locations)
- [What a log holds](#what-a-log-holds)
- [How long logs are kept](#how-long-logs-are-kept)
- [Reading logs with delorun logs](#reading-logs-with-delorun-logs)
- [Clearing logs](#clearing-logs)

## Log locations

Paths are under your Delo home, `~/.delo` unless you set `DELO_HOME`, where `<profile>` is your CLI profile, `default` unless you set `DELO_PROFILE`.

| Process | Log name | Active file |
| --- | --- | --- |
| The home process that `delorun start` runs, with its Host | `home-<profile>` | `logs/home-<profile>/home.log` |
| The Docker supervisor | `supervisor-<profile>` | `logs/supervisor-<profile>/supervisor.log` |
| The desktop app's Host | `desktop-host` | `logs/desktop-host/desktop-host.log` |
| A self-hosted relay | `relay` | `/var/log/delo-relay/relay.log` inside the relay's container, not on your computer |

- **Older files.** When an active file reaches 10 MiB it is renamed `<file>.1`, and older files move up to `<file>.4`; each process keeps at most 5 files, 50 MiB in all.
- **Upstream's startup reports.** DeepSeek Harness's own `dsh` command writes `logs/startup-*.log` when it fails to start. Those reports hold raw diagnostics that can include credential values; `delorun` never writes them, and `delorun logs startup` lists them with that warning.
- **Session logs.** Your chats are under `sessions/`. They are not operational logs: nothing on this page rotates, redacts, deletes or reads them.

## What a log holds

- **Delo's own records** state operations, states, outcomes, durations, versions, ids and error codes. They do not contain your messages, prompts, model output, tool arguments, tool results or file contents.
- **Captured output** is what DeepSeek Harness code prints while Delo runs it, such as the Host's console output. It can contain text from your chats, commands and files, such as an error line that quotes a command.
- **Redaction.** Every record, captured lines included, passes redaction before it is written. Model keys, tokens, owner codes, session secrets, cookie values and the other secrets a Delo process loads are replaced with `[redacted:<kind>]`, as are listed forms such as `Authorization` headers, passwords in URLs, private keys and provider keys. Redaction cannot recognise a secret that Delo never loaded and that has none of the listed forms.
- **Chat and turn ids.** A record written while a chat runs carries that chat's session id and turn number, so `delorun logs --session <id> --turn <n>` finds the process records behind a turn. Your session logs gain no field for this.
- **Access.** Log directories have mode 0700 and log files mode 0600, so only your user can read them. Delo's contract requires that commands the model runs in a confined workspace cannot write them, and cannot read them where your system enforces Delo's read rule; `delorun verify` reports which rules your system enforces.

## How long logs are kept

| Rule | Value |
| --- | --- |
| Rotation | at 10 MiB |
| Files kept per process | 5 |
| Deletion | of each file once its oldest record is 14 days old, so no record stays longer |
| Checked | at each `delorun` command, except `--help` and `--version`, and on `delorun logs --prune` |

While no Delo process runs, nothing deletes expired files; they go at the next start of a Delo process or when you run `delorun logs --prune`.

## Reading logs with delorun logs

| Command | Prints |
| --- | --- |
| `delorun logs` | every log with its location, whether it exists, its size and its oldest record, then the last 50 records of your home process |
| `delorun logs <name>` | the last 50 records of `home`, `supervisor` or `desktop-host`; `-n <count>` prints up to 10,000 |
| `delorun logs startup` | upstream's startup reports, with upstream's warning, without their contents |
| `delorun logs relay` | the relay's log location inside its container and a command to read it there |
| `--follow` | new records as they are written, across rotations |
| `--since <duration>` | records newer than a duration, such as `30m` or `2d` |
| `--session <id>`, `--turn <n>` | records of one chat, and of one of its turns |
| `--json` | the records as stored, one JSON object per line |
| `--path` | only the active file's path |
| `--profile <name>` | another CLI profile's logs |

A record prints as `<time> <level> <log name> [<session id>/<turn>] <message>`. Control characters from captured output are shown escaped.

## Clearing logs

- `delorun logs --clear <name>` asks for confirmation, then deletes that log's older files and empties its active file; a running process continues in the emptied file. `delorun logs --clear` without a name does this for every local log and deletes upstream's startup reports.
- `delorun logs --prune` deletes every expired file now and prints each one.
- **After you purge a chat.** Fragments of a purged chat can remain in captured output in operational logs until their file is deleted, once its oldest record is 14 days old. `delorun trash purge <id> --clear-logs` and `delorun trash empty --clear-logs` also clear the operational logs and startup reports, as `delorun logs --clear` does.
