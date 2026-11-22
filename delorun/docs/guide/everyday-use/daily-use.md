---
description: "Using Delorun day to day: starting, opening and stopping the studio, status, doctor, verify and logs, workspaces and what the model may change in them, your own changes, safe mode and recovery, the trash and archives, and the plugin and headless commands."
---

# Daily use

English | [中文](daily-use.zh.md)

## Summary

This page shows the commands you use every day and the choices you make about what the model may change. It assumes Delorun is installed and set up ([Install and first run](../get-started/install.md)). Delorun runs as one background program per [profile](../../reference/glossary.md#profile), the [home process](../../reference/glossary.md#home-process), which serves the [studio](../../reference/glossary.md#studio) in your browser. A few commands start, open, stop and check it. Each chat works in a [workspace](../../reference/glossary.md#workspace), a folder whose files the model may read and change. When something you added stops Delorun from starting, safe mode starts it without your plugins until you fix it.

## Contents

- [Start, open and stop](#start-open-and-stop)
- [Check the release and your setup](#check-the-release-and-your-setup)
- [Workspaces and what the model may change](#workspaces-and-what-the-model-may-change)
- [Make Delorun yours](#make-delorun-yours)
- [Safe mode and recovery](#safe-mode-and-recovery)
- [Trash, export and import](#trash-export-and-import)
- [The plugin and headless commands](#the-plugin-and-headless-commands)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Start, open and stop

| Command | What it does |
| --- | --- |
| `delorun` | Starts Delorun and opens the studio. On a new home it runs setup first, which then starts Delorun in the terminal ([Install and first run](../get-started/install.md)). |
| `delorun start` | Starts Delorun without opening the studio. `--open` also opens it. |
| `delorun start --foreground` | Runs Delorun in this terminal. Ctrl-C stops it. |
| `delorun open` | Opens the studio in your browser with a link that signs in once. `--print` prints the link instead ([A computer without a browser](../get-started/install.md#a-computer-without-a-browser)). |
| `delorun status` | Shows whether Delorun runs, the studio's address, the running release and the number of running chats. `--verbose` adds the process id, the start id and the previous release. `--json` prints it as JSON. |
| `delorun stop` | Stops Delorun once running chats end their turns. |
| `delorun stop --now` | Stops at once. It cancels running turns and background jobs. |

`delorun` and `delorun start` run Delorun in the background, so it keeps running after you close the terminal, unless you turned that off. The first start, at the end of setup, runs in the terminal and says how to keep it running: `delorun start --background`. Settings → General → How Delorun runs, or `delorun setup background`, changes the default. A background start prints `Delorun is running in the background for the profile default at <address>; it keeps running after this terminal closes.`, then how to see, follow and stop it.

`delorun stop` stops new turns, prints `Waiting for N running chat(s) to end…`, and waits up to 30 minutes before it stops anyway. When it is done it prints `Delorun stopped for the profile default.` `delorun stop --now` cancels the running chats instead.

Most commands take `--profile <name>` after their name to act on another profile, such as `delorun status --profile work`. `DELORUN_PROFILE` sets it for every command ([Your Delorun home](../customising/home.md#profiles)).

<details>
<summary>Edge cases</summary>

- If Delorun already runs, then `delorun start` says so and changes nothing. Open it with `delorun open`.
- If a command needs Delorun running and it is not, then the command exits with code 3. Start it with `delorun start`. Exit codes: 0 done, 1 failed, 2 wrong command line, 3 not running ([Troubleshooting](../help/troubleshooting.md#reading-a-refusal)).
- If `delorun start` ends with `Delorun did not start. Delorun stopped with exit code 1 before it was running.`, then run `delorun logs` to see why, and `delorun doctor` to check your setup. A busy studio port shows as `fail port` ([Starting and stopping](../help/troubleshooting.md#starting-and-stopping)).
- If `delorun stop --now` cannot end the process, then it stops it with a signal and warns that commands it started may still be running.
- If you run a `delorun trash`, `export` or `import` command while Delorun runs, then it refuses and asks you to run `delorun stop` first.

</details>

<details>
<summary>Go further</summary>

- Run a second profile beside the first with `delorun --profile work` ([Your Delorun home](../customising/home.md#profiles)).
- Keep Delorun in a terminal instead of the background with `delorun setup background`, or turn it off in Settings → General → How Delorun runs.
- Reach the studio from your phone: [Reach the studio from your phone](reach.md). The commands are `delorun reach` and `delorun devices`.

</details>

## Check the release and your setup

- **`delorun doctor`** checks your home's permissions, whether Docker answers, the format of your DeepSeek key (without sending it), whether the studio's port is free, on Linux whether bubblewrap can sandbox commands (the `sandbox` line), whether the workspace registry reads, whether a profile would run without its protections (`dangerous-mode`), the last release-log check, the last update check and the last import of a DeepSeek Harness home (`import`). Each line starts with `pass`, `warn` or `fail`. It exits with 1 when a check fails; it also reports your changes and your CLI profile's plugins. `warn docker` on a computer without Docker is harmless: workspaces on your computer's own folders work without it.
- **`delorun verify`** checks the installed release against its signed manifest and the public release log. It runs two checks, the release signature and the installed files, and lists the others as `not run`. Its report ends with `this is not a full verification of this Delorun`.
- **`delorun logs`** prints where each log is and the recent records of the running Delorun ([Where Delorun keeps its logs](../help/logs.md)).
- **`delorun --version`** prints the Delorun version and the DeepSeek Harness version it runs on.

<details>
<summary>Edge cases</summary>

- If `doctor` shows a `!` line for `key`, then no DeepSeek key is set. Add it in the studio (the welcome screen asks for it, and Settings → Agent → Models changes it), run `delorun setup key`, or set `DEEPSEEK_API_KEY`.
- If `doctor` shows `warn release-log`, then no release-log check is recorded yet. Run `delorun verify`.
- If you run from a source checkout, then `doctor` reports that it checks no release channel.
- If `verify` runs offline, then add `--offline` to skip the online log check. The checks run as you, so a program running as you could change them.

</details>

<details>
<summary>Go further</summary>

`delorun verify --release <version>` checks another installed release. `delorun verify --json` and `delorun status --json` print JSON for scripts.

</details>

## Workspaces and what the model may change

A workspace is a folder on your computer. Every chat works in one. Nothing undoes what an agent does to the files in a workspace: undo covers your chats and Delorun's setup, not your project ([What undo covers](../help/known-issues.md#what-undo-covers)). Keep important workspaces in git and commit before you let an agent change many files. The workspace's permission preset decides what the commands the model runs may do:

- **[Workspace Write](../../reference/glossary.md#workspace-write).** The preset every new workspace starts on. Commands run in the [sandbox](../../reference/glossary.md#sandbox), a fenced area: they may write inside the workspace and the permitted temporary folders. A command that needs more asks you first, and you approve or deny that one command.
- **[Full access](../../reference/glossary.md#full-access).** Commands run outside the sandbox and can write anywhere your user can, without asking.

Commands the model runs in a Workspace Write workspace cannot write under your Delorun home, read its secrets or tokens, or connect to its control sockets, where your system enforces those rules ([What Delorun protects](../safety-and-updates/safety.md#the-sandbox)).

With setup's default **Ask me first**, Delorun asks you once for each workspace before it gives it full access. You answer on the computer Delorun runs on: pick Full access in a chat, use Settings → Safety → Permissions, or choose Allow for this chat on an approval card that asks for it ([Full access](../safety-and-updates/safety.md#full-access)). Other [consents](../../reference/glossary.md#consent) ask before the model edits instruction files, adds an MCP server or schedules work ([Consents](../safety-and-updates/safety.md#consents)).

<details>
<summary>Edge cases</summary>

- If you choose **Ask less (like DeepSeek Harness)** in `delorun setup prompts`, then a workspace switches to full access without asking each time, as DeepSeek Harness does, after the studio's own confirmation.
- If a chat was copied from DeepSeek Harness or another home and ran with full access there, then it opens on Workspace Write. Turn full access on for its workspace again.
- If you pick a folder that Delorun refuses as a workspace, then it names the reason. Refused folders are the filesystem root, your home folder itself, your Delorun home, DeepSeek Harness's home, and a folder that contains either.
- If you use the studio from a phone, then granting full access asks for Face ID or your PIN each time, unless a Face ID pass is open ([Reach the studio from your phone](reach.md)).
- If you want full access off again, then use Revoke in Settings → Safety → Permissions, pick Workspace Write in a chat, or run `delorun workspace full-access <folder> off`.

</details>

<details>
<summary>Go further</summary>

- `delorun workspace full-access` lists the workspaces and their preset. `delorun workspace full-access <folder> on` shows what full access means and records it after you confirm in the terminal. `off` withdraws it without asking.
- `delorun workspace external-agents` lists the external agents allowed to start in a workspace without asking. [What Delorun protects](../safety-and-updates/safety.md#external-agents) explains them.
- `delorun mcp list`, `accept`, `decline` and `revoke` answer MCP server questions from the terminal ([MCP servers](../safety-and-updates/safety.md#mcp-servers)).
- Limit what sandboxed commands can reach on the network in Settings → Safety → Network ([Prompt injection and data exfiltration](../safety-and-updates/prompt-injection.md)).

</details>

## Make Delorun yours

Delorun is built to be reshaped. You can change plugin settings, build agent presets, skills and plugins in Creator mode, link your own plugins, or edit Delorun's own files. Delorun records each change to what it runs, so you can see it and undo it. An update carries your changes to the new release or names, before you confirm, any it cannot carry ([Updates](../safety-and-updates/updates.md)).

- [Where to customise what](../customising/customise.md) compares the ways to change Delorun and what each costs at an update.
- [Write a plugin for Delorun](../plugin-guides/plugins.md) goes from a new plugin to one that loads in your studio.
- [Changing your harness](../customising/changing-your-harness.md) explains what `delorun changes` records, protection, and undo.

Every change Delorun makes to your profile is also a version of the profile's history, which `delorun recover` can restore.

## Safe mode and recovery

When a plugin or a profile change stops Delorun from starting, or makes it misbehave, start it without your own plugins:

```sh
delorun recover safe-mode        # the next start leaves out your plugins
delorun start
delorun recover exit-safe-mode   # once it works: the next start loads everything again
```

Safe mode leaves out every bundle and plugin you added, including plugins installed from a folder, and keeps DeepSeek Harness's own bundles and Delorun's. It changes no file: your plugins and their settings stay in your profile, and each start in safe mode says what it leaves out. You should see that line at the start.

`delorun recover` with no subcommand shows where your profile stands: whether safe mode is on, the last update, the profile versions you can restore, and the plugins you ejected or kept disabled.

<details>
<summary>Edge cases</summary>

- If Delorun runs, then stop it first: safe mode takes effect at the next start.
- If you want to remember why, then use `delorun recover safe-mode --reason <text>`.
- If your profile would run without its protections, for example because its settings turn off the sandbox, then Delorun refuses to start and names the setting and its file. Remove the setting, or start in safe mode ([Protections and plugins](../help/troubleshooting.md#protections-and-plugins)).
- If you wonder whether Delorun went into safe mode on its own, then it did not: it never turns safe mode on by itself.

</details>

<details>
<summary>Go further</summary>

`delorun recover restore <version>` brings back a saved profile version. `delorun recover rollback` goes back to the release before the last update ([Going back](../safety-and-updates/updates.md#going-back)).

</details>

## Trash, export and import

| Command | What it does |
| --- | --- |
| `delorun trash list` | Lists deleted chats and workspaces, each with its id and the days left before it is deleted for good. |
| `delorun trash restore <id>` | Restores a deleted chat; take the id from `trash list`. A workspace is restored in the studio. |
| `delorun trash purge <id>`, `delorun trash empty` | Deletes one item, or every item, forever. |
| `delorun export <chat-or-workspace> --out <file>` | Writes a chat, or a workspace's record with its chats and attachments, as an archive signed by this home. The files in the workspace's folder are not included. |
| `delorun import <file>` | Checks an archive, shows who signed it and what it holds, and imports it after you confirm. |

These commands change chat data the studio uses, so stop Delorun first. They refuse while it runs. A deleted item stays in the trash for 30 days. While Delorun runs, Settings → Data → Trash in the studio lists, restores and deletes items too.

<details>
<summary>Edge cases</summary>

- If the export file already exists, then `export` does not overwrite it.
- If the archive would hold something that looks like a secret, then `export` asks first.
- If you delete a chat for good, then pieces of it can stay in captured log output. Add `--clear-logs` to `trash purge` or `trash empty` ([Clearing logs](../help/logs.md#clearing-logs)).
- If you import an archive from someone else, then the chat shows a banner naming its source. Read it before you trust it ([Archives, imports and the trash](../help/troubleshooting.md#archives-imports-and-the-trash)).

</details>

## The plugin and headless commands

- **`delorun plugin --profile <name> …`** runs DeepSeek Harness's `dsh plugin` inside your Delorun home, so plugins install the way they do in DeepSeek Harness itself. It applies none of Delorun's protections. `delorun plugin check <directory>` reads a plugin's `package.json`, runs none of its files, and says whether this release would accept the plugin's version ranges.
- **`delorun headless …`** answers one task and exits, as `dsh headless` does, with Delorun's sandbox protection and guards.

<details>
<summary>Edge cases</summary>

- If a headless task asks for full access, with `--permission-mode` or its environment variable, in a folder without a full-access grant, then `delorun headless` refuses it. Grant full access at this computer first with `delorun workspace full-access <folder> on`.

</details>

## Next

- Keep Delorun current: [Updates](../safety-and-updates/updates.md).
- Choose the model: [Model providers](../get-started/providers.md).
- Understand the protections: [What Delorun protects](../safety-and-updates/safety.md).
- If something went wrong: [Troubleshooting](../help/troubleshooting.md).

## For the technically curious

The [home process contract](../../contracts/c19-home-process.md) defines start, stop, status and their exit codes. The [update report contract](../../contracts/c03-update-report.md) defines safe mode and `delorun recover`. The [archive and trash contract](../../contracts/c08-archive-and-trash.md) defines the trash and archives.
