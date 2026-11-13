---
description: "Using Delorun day to day: starting, opening and stopping the studio, status, doctor, verify and logs, workspaces and what the model may change in them, the prompts setting, your own changes, safe mode and recovery, the trash and archives, and the plugin and headless commands."
---

# Daily use

English

## Summary

Delorun runs as one background process per profile, the home process, which serves the studio in your browser. A handful of commands start, open, stop and check it. In the studio, each chat works in a workspace, a folder whose files the model may read and change; commands the model runs are confined to it, and Delorun keeps its own home out of reach. When something you added stops Delorun from starting, safe mode starts it without your plugins until you fix it.

## Contents

- [Start, open and stop](#start-open-and-stop)
- [Check the release and your setup](#check-the-release-and-your-setup)
- [Workspaces and what the model may change](#workspaces-and-what-the-model-may-change)
- [Make Delorun yours](#make-delorun-yours)
- [Safe mode and recovery](#safe-mode-and-recovery)
- [Trash, export and import](#trash-export-and-import)
- [The plugin and headless commands](#the-plugin-and-headless-commands)
- [For the technically curious](#for-the-technically-curious)

## Start, open and stop

| Command | What it does |
| --- | --- |
| `delorun` | Starts Delorun and opens the studio; on a new home it runs setup first ([Install and first run](install.md)). |
| `delorun start` | Starts Delorun without opening the studio; `--open` also opens it. |
| `delorun start --foreground` | Runs Delorun in this terminal; Ctrl-C stops it. |
| `delorun open` | Opens the studio in your browser with a link that signs in once; `--print` prints the link instead ([A computer without a browser](install.md#a-computer-without-a-browser)). |
| `delorun status` | Shows the home, the profile, whether Delorun runs, its process, the running and previous release, running chats and the studio's address; `--json` prints it as JSON. |
| `delorun stop` | Stops Delorun once running chats end their turns. |
| `delorun stop --now` | Stops at once: cancels running turns and background jobs. |

`delorun` and `delorun start` run Delorun in the background, where it keeps running after you close the terminal, unless you answered No to the background question in Full setup; `delorun setup background` asks it again. A background start prints `Delo is running in the background for the profile default (process <pid>) at <address>`, and a start when Delorun already runs says so and changes nothing.

`delorun stop` refuses new turns, prints `Waiting for N running chat(s) to end…`, and waits up to 30 minutes for running chats before it stops anyway. `delorun stop --now` cancels them; if the process does not end, it is stopped with a signal, and Delorun then warns that commands it started may still be running.

Most commands take `--profile <name>` after their name to act on another profile, such as `delorun status --profile work`, and `DELO_PROFILE` sets it for every command, `delorun doctor` included ([Your Delorun home](home.md#profiles)). A command that needs Delorun running exits with code 3 when it is not ([Troubleshooting](troubleshooting.md#reading-a-refusal)).

## Check the release and your setup

- **`delorun doctor`** checks your home's permissions, whether Docker answers, the DeepSeek key's format (without sending it), whether the studio's port is free, on Linux whether bubblewrap can sandbox commands, the last release-log check and the last update check. Each line starts with `pass`, `warn` or `fail`; it exits with 1 when a check fails.
- **`delorun verify`** checks the installed release against its signed manifest and the public release log. The first release runs two of its checks, the release signature and the installed files, and lists the others as `not run`; its report ends with `this is not a full verification of this Delo`. `--offline` skips the online log check, `--release <version>` checks another release, and `--json` prints the report as JSON. The checks run as you, so a program running as you could change them.
- **`delorun logs`** prints where each log is and the recent records of the running Delorun; `delorun logs --follow` follows it ([Where Delorun keeps its logs](logs.md)).
- **`delorun --version`** prints the Delorun version and the DeepSeek Harness version it runs on.

## Workspaces and what the model may change

A workspace is a folder on your computer. Every chat works in one, and the workspace's permission preset decides what the model's commands may do:

- **Workspace Write**, the preset every new workspace starts on, whatever the deployment default is. Commands may write inside the workspace and the permitted temporary folders. A command that needs more asks you first, and you approve or deny that one command.
- **Full access**: commands run outside the sandbox and can write anywhere your user can, without asking.

Commands the model runs in a Workspace Write workspace cannot write under your Delorun home, read its secrets or tokens, or connect to its control sockets, where your system enforces those rules ([What Delorun protects](safety.md#the-sandbox)). Delorun also refuses some folders as a workspace: the filesystem root, your home folder itself, your Delorun home or DeepSeek Harness's home, and a folder that contains either.

With setup's default **Safer prompts**, Delorun asks once per workspace before full access, and other consents ask before the model edits instruction files, adds an MCP server or schedules work ([Consents](safety.md#consents)). A single command can still ask to run outside the sandbox, which you approve or deny. With **Same as stock**, chosen in `delorun setup prompts`, a workspace switches to full access as in DeepSeek Harness, after the studio's own confirmation.

A chat you copied from DeepSeek Harness or another home that ran with full access opens on Workspace Write.

## Make Delorun yours

Delorun is built to be reshaped: change plugin settings, build agent presets, skills and plugins in Creator mode, link your own plugins, or edit Delorun's own files. Delorun records each change to what it runs, so you can see it and undo it, and an update carries your changes to the new release or names, before you confirm, any it cannot carry ([Updates](updates.md)).

- [Where to customise what](https://docs.delorun.com/guide/customise) compares the ways to change Delorun and what each costs at an update.
- [Write a plugin for Delo](https://docs.delorun.com/guide/plugins) goes from a new plugin to one that loads in your studio.
- [Changing your harness](https://docs.delorun.com/guide/changing-your-harness) explains what `delorun changes` records, protection, which is off by default so your changes load without review and stay undoable, `delorun changes protection on`, editing Delorun itself with `delorun changes edit-harness`, and undo.

Every change Delorun makes to your profile is also a version of the profile's history, which `delorun recover` can restore.

## Safe mode and recovery

When a plugin or a profile change stops Delorun from starting, or makes it misbehave, start it without your own plugins:

```sh
delorun recover safe-mode        # the next start leaves out your plugins
delorun start
delorun recover exit-safe-mode   # once it works: the next start loads everything again
```

Safe mode leaves out every bundle and plugin you added, including plugins installed from a folder, and keeps DeepSeek Harness's own bundles and Delorun's. It changes no file: your plugins and their settings stay in your profile, and each start in safe mode says what it leaves out. `delorun recover safe-mode --reason <text>` records why you turned it on. Safe mode takes effect at the next start, so stop Delorun first if it runs. Delorun does not turn safe mode on by itself.

`delorun recover` with no subcommand shows where your profile stands: whether safe mode is on, the last update, the profile versions you can restore, and the plugins you ejected or kept disabled. `delorun recover restore <version>` brings back a saved profile version, and `delorun recover rollback` goes back to the release before the last update ([Updates](updates.md#going-back)).

Delorun refuses to start a profile that would run without its protections, such as one whose settings turn off the sandbox, and names the setting and its file; remove it, or start in safe mode ([Troubleshooting](troubleshooting.md#protections-and-plugins)).

## Trash, export and import

| Command | What it does |
| --- | --- |
| `delorun trash list` | Lists deleted chats and workspaces. |
| `delorun trash restore <id>` | Restores a deleted chat; a workspace is restored in the studio. |
| `delorun trash purge <id>`, `delorun trash empty` | Deletes one item, or every item, forever. |
| `delorun export <chat-or-workspace> --out <file>` | Writes a chat, or a workspace with its chats, as an archive signed by this home. It never overwrites a file, and asks first when the archive would hold something that looks like a secret. |
| `delorun import <file>` | Checks an archive, shows who signed it and what it holds, and imports it after you confirm. |

These commands change chat data the studio uses, so stop Delorun first; they refuse while it runs.

## The plugin and headless commands

- **`delorun plugin --profile <name> …`** runs DeepSeek Harness's `dsh plugin` inside your Delorun home, so plugins install as in stock. It applies none of Delorun's protections. `delorun plugin check <directory>` reads a plugin's `package.json`, runs none of its files, and says whether this release would accept the plugin's version ranges.
- **`delorun headless …`** answers one task and exits, as `dsh headless` does, with Delorun's sandbox protection and guards. It refuses a task that asks for full access, with `--permission-mode` or its environment variable, in a folder without a full-access grant, and the studio cannot record such a grant yet.

## For the technically curious

The [home process contract](../contracts/c19-home-process.md) defines start, stop, status and their exit codes, the [update report contract](../contracts/c03-update-report.md) defines safe mode and `delorun recover`, and the [archive and trash contract](../contracts/c08-archive-and-trash.md) defines the trash and archives.
