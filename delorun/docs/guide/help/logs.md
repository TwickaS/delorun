---
description: "Where Delorun keeps its operational logs: every log's location, what a log holds and never holds, how long logs are kept, how delorun logs shows and clears them, and how they differ from the session logs that record your chats."
---

# Where Delorun keeps its logs

English | [中文](logs.zh.md)

## Summary

This page helps you find out why something failed. You need Delorun installed ([Install and first run](../get-started/install.md)). When something goes wrong, the first place to look is a log. Delorun's own processes each write an [operational log](../../reference/glossary.md#operational-log): a file that records what the process did, so you, or an agent you ask for help, can find out why something failed. These logs are separate from your chats, which Delorun keeps until you delete them. Run `delorun logs` to see where every log is and the latest records of the running Delorun. Secrets are removed from every record before it is written, each log is capped in size, and old log files are deleted after 14 days.

## Contents

- [Log locations](#log-locations)
- [What a log holds](#what-a-log-holds)
- [How long logs are kept](#how-long-logs-are-kept)
- [Reading logs with delorun logs](#reading-logs-with-delorun-logs)
- [Clearing logs](#clearing-logs)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Log locations

The paths below are inside your Delorun home, `~/.delorun` unless you set `DELORUN_HOME`. `<profile>` is your profile's name, `default` unless you chose another.

Delorun writes one operational log: the running Delorun, meaning the background process that `delorun start` runs and the studio's server inside it. Its name is `home-<profile>` and its file is `logs/home-<profile>/home.log`. The parts of Delorun that would write the other logs `delorun logs` can name, the Docker supervisor, the desktop app and a self-hosted relay, are not included, so those logs show as not created ([Roadmap](../roadmap.md)).

No log leaves your computer. Delorun sends nobody your logs; they are files that only you read, or that you choose to share.

- **Older files.** When a log file reaches 10 MiB, it is renamed `<file>.1`, and older files move up to `<file>.4`. Each log keeps at most 5 files, 50 MiB in all.
- **DeepSeek Harness's startup reports.** DeepSeek Harness's own `dsh` command writes `logs/startup-*.log` when it fails to start. Those reports can contain your keys, because they hold raw diagnostics. `delorun` never writes them, and `delorun logs startup` lists them with that warning.
- **Your chats** are under `sessions/`. They are not operational logs: nothing on this page shortens, redacts, deletes or reads them.

## What a log holds

- **Delorun's own records** say what happened: operations, states, outcomes, durations, versions, ids and error codes. They never contain your messages, prompts, model replies, tool arguments, tool results or file contents.
- **Captured output** is what DeepSeek Harness's code prints while Delorun runs it, such as the studio server's console output. It can contain text from your chats, commands and files, for example an error line that quotes a command.
- **Secrets are removed.** Every record, captured output included, has secrets replaced with `[redacted:<kind>]` before it is written: model keys, tokens, session secrets, cookie values and the other secrets Delorun loads, and common forms such as `Authorization` headers, passwords in URLs, private keys and provider keys. A secret Delorun never loaded and that looks like none of these forms can get through.
- **Chat and turn ids.** A record written while a chat runs carries that chat's id and turn number, so `delorun logs --session <id> --turn <n>` finds the records behind one answer. You find a chat's id in square brackets in the records `delorun logs` prints from the time you used that chat; `delorun trash list` shows the id of a deleted chat.
- **Who can read them.** Only your user can open the log folders and files. Commands the model runs in a sandboxed workspace cannot change them, and cannot read them where your system enforces that rule ([What Delorun protects](../safety-and-updates/safety.md#the-sandbox)).

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
| `delorun logs home` | the last 50 records of the running Delorun; `-n <count>` prints up to 10,000 |
| `delorun logs startup` | DeepSeek Harness's startup reports, with their warning, without their contents |
| `--follow` | new records as they are written |
| `--since <duration>` | records newer than a duration, such as `30m` or `2d` |
| `--session <id>`, `--turn <n>` | the records of one chat, or of one of its turns |
| `--json` | the records as stored, one JSON object per line |
| `--path` | only the current file's path |
| `--profile <name>` | another profile's logs |

A record prints as `<time> <level> <log name> [<chat id>/<turn>] <message>`, for example `2026-11-16T09:12:03.412Z info home-default [<chat id>/2] turn finished`. Control characters from captured output are shown escaped, so a log line cannot change what your terminal shows.

## Clearing logs

- `delorun logs --clear <name>` asks first, then deletes that log's older files and empties its current file; a running Delorun keeps writing to the emptied file. `delorun logs --clear` without a name does this for every log on your computer and deletes DeepSeek Harness's startup reports. It needs a terminal to ask in.
- `delorun logs --prune` deletes every expired file now and prints each one.
- **After you delete a chat for good.** Pieces of it can remain in captured output until that log file is deleted. Add `--clear-logs` to `delorun trash purge <id>` or `delorun trash empty` to clear the logs and startup reports at the same time, as `delorun logs --clear` does.

<details>
<summary>Edge cases</summary>

- If you set `DELORUN_HOME` or `--profile`, then the paths and names change with them.
- If a log line shows escaped characters, then the original had control characters; they are escaped so a log line cannot change what your terminal shows.
- If you give an agent a log to read, then check it first: captured output can quote your commands and files, and a secret Delorun never loaded and that looks like none of the known forms can get through.

</details>

<details>
<summary>Go further</summary>

- Watch a problem as it happens: `delorun logs --follow`.
- Narrow to one answer: `delorun logs --session <id> --turn <n>`.
- Feed a script: `delorun logs --json` prints one JSON object per line, and `--path` prints only the current file's path.
- Free disk now: `delorun logs --prune`, or `delorun logs --clear <name>` for one log.

</details>

## Next

- Find a fix for what you saw: [Troubleshooting](troubleshooting.md).
- Check your setup: [Daily use](../everyday-use/daily-use.md#check-the-release-and-your-setup).

## For the technically curious

The exact rules for log names, rotation, redaction and retention are in the [operational logs contract](../../contracts/c20-operational-logs.md).
