---
description: "Where Delorun keeps its operational logs: every log's location, what a log holds and never holds, how long logs are kept, how delorun logs shows and clears them, and how they differ from the session logs that record your chats."
---

# Where Delorun keeps its logs

English | [中文](logs.zh.md)

Delorun has no release yet; this page describes the first release.

## Summary

When something goes wrong, the first place to look is a log. Delorun's own processes each write an operational log: a file that records what the process did, so you, or an agent you ask for help, can find out why something failed. These logs are separate from your chats, which Delorun keeps until you delete them. Run `delorun logs` to see where every log is and the latest records of the running Delorun. Secrets are removed from every record before it is written, each log is capped in size, and old log files are deleted after 14 days.

## Contents

- [Log locations](#log-locations)
- [What a log holds](#what-a-log-holds)
- [How long logs are kept](#how-long-logs-are-kept)
- [Reading logs with delorun logs](#reading-logs-with-delorun-logs)
- [Clearing logs](#clearing-logs)
- [For the technically curious](#for-the-technically-curious)

## Log locations

The paths below are inside your Delorun home, `~/.delo` unless you set `DELO_HOME`. `<profile>` is your profile's name, `default` unless you chose another.

| What writes it | Log name | File |
| --- | --- | --- |
| The running Delorun: the background process that `delorun start` runs, and the studio's server inside it | `home-<profile>` | `logs/home-<profile>/home.log` |
| The Docker supervisor | `supervisor-<profile>` | `logs/supervisor-<profile>/supervisor.log` |
| The desktop app's server | `desktop-host` | `logs/desktop-host/desktop-host.log` |
| A self-hosted relay | `relay` | `/var/log/delo-relay/relay.log` inside the relay's container, not on your computer |

The first release uses only the first of these. Docker workspaces, a Delorun desktop app and a self-hosted relay are not available yet, so `delorun logs` shows the other logs as not created.

- **Older files.** When a log file reaches 10 MiB, it is renamed `<file>.1`, and older files move up to `<file>.4`. Each log keeps at most 5 files, 50 MiB in all.
- **DeepSeek Harness's startup reports.** DeepSeek Harness's own `dsh` command writes `logs/startup-*.log` when it fails to start. Those reports can contain your keys, because they hold raw diagnostics. `delorun` never writes them, and `delorun logs startup` lists them with that warning.
- **Your chats** are under `sessions/`. They are not operational logs: nothing on this page shortens, redacts, deletes or reads them.

## What a log holds

- **Delorun's own records** say what happened: operations, states, outcomes, durations, versions, ids and error codes. They never contain your messages, prompts, model replies, tool arguments, tool results or file contents.
- **Captured output** is what DeepSeek Harness's code prints while Delorun runs it, such as the studio server's console output. It can contain text from your chats, commands and files, for example an error line that quotes a command.
- **Secrets are removed.** Every record, captured output included, has secrets replaced with `[redacted:<kind>]` before it is written: model keys, tokens, session secrets, cookie values and the other secrets Delorun loads, and common forms such as `Authorization` headers, passwords in URLs, private keys and provider keys. A secret Delorun never loaded and that looks like none of these forms can get through.
- **Chat and turn ids.** A record written while a chat runs carries that chat's id and turn number, so `delorun logs --session <id> --turn <n>` finds the records behind one answer.
- **Who can read them.** Only your user can open the log folders and files. Commands the model runs in a sandboxed workspace cannot change them, and cannot read them where your system enforces that rule ([What Delorun protects](safety.md#the-sandbox)).

## How long logs are kept

| What | When |
| --- | --- |
| A file is rotated | at 10 MiB |
| Files kept per log | 5 |
| A file is deleted | once its oldest record is 14 days old |
| Delorun checks for old files | at each `delorun` command, except `--help` and `--version`, and when you run `delorun logs --prune` |

Delorun deletes old files only when you run a `delorun` command, so a log can stay longer while you run none.

## Reading logs with delorun logs

```sh
delorun logs                 # where every log is, then the latest records
delorun logs --follow        # watch new records as they arrive
delorun logs --since 30m     # the last half hour
```

| Command or option | Prints |
| --- | --- |
| `delorun logs` | every log with its location, whether it exists, its size and its oldest record, then the last 50 records of the running Delorun |
| `delorun logs <name>` | the last 50 records of `home`, `supervisor` or `desktop-host`; `-n <count>` prints up to 10,000 |
| `delorun logs startup` | DeepSeek Harness's startup reports, with their warning, without their contents |
| `delorun logs relay` | where the relay's log is inside its container, and a command to read it there |
| `--follow` | new records as they are written |
| `--since <duration>` | records newer than a duration, such as `30m` or `2d` |
| `--session <id>`, `--turn <n>` | the records of one chat, or of one of its turns |
| `--json` | the records as stored, one JSON object per line |
| `--path` | only the current file's path |
| `--profile <name>` | another profile's logs |

A record prints as `<time> <level> <log name> [<chat id>/<turn>] <message>`. Control characters from captured output are shown escaped, so a log line cannot change what your terminal shows.

## Clearing logs

- `delorun logs --clear <name>` asks first, then deletes that log's older files and empties its current file; a running Delorun keeps writing to the emptied file. `delorun logs --clear` without a name does this for every log on your computer and deletes DeepSeek Harness's startup reports. It needs a terminal to ask in.
- `delorun logs --prune` deletes every expired file now and prints each one.
- **After you delete a chat for good.** Pieces of it can remain in captured output until that log file is deleted. Add `--clear-logs` to `delorun trash purge <id>` or `delorun trash empty` to clear the logs and startup reports at the same time, as `delorun logs --clear` does.

## For the technically curious

The exact rules for log names, rotation, redaction and retention are in the [operational logs contract](../contracts/c20-operational-logs.md).
