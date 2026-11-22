---
description: "Troubleshooting Delorun: how to read a refusal, the exit codes, and the common refusals with their codes and fixes, for the home and its files, starting, the model key, installs and release checks, updates and rollback, protections and plugins, remote access, and archives."
---

# Troubleshooting

English | [中文](troubleshooting.zh.md)

## Summary

This page helps you get unstuck when `delorun` cannot do what you asked, or when a phone cannot sign in to your studio. When `delorun` cannot do something, it prints a refusal: what it did or did not do, why, with an error code, and what you can do. Most refusals change nothing, so you can fix the cause and run the same command again.

Find yours by searching this page for the exact words or the code in the message. Every entry ends with a fix or says where to get help, and [When nothing here fits](#when-nothing-here-fits) says how to ask. You need nothing else first. Words such as [home](../../reference/glossary.md#home), [profile](../../reference/glossary.md#profile) and [sandbox](../../reference/glossary.md#sandbox) link to the [glossary](../../reference/glossary.md) the first time they appear.

## Contents

- [Reading a refusal](#reading-a-refusal)
- [The home and its files](#the-home-and-its-files)
- [The first day](#the-first-day)
- [Starting and stopping](#starting-and-stopping)
- [The studio port is busy](#the-studio-port-is-busy)
- [Setup and the model key](#setup-and-the-model-key)
- [Installs and release checks](#installs-and-release-checks)
- [Updates and rollback](#updates-and-rollback)
- [Repair the program and keep your data](#repair)
- [Last resort, by hand](#by-hand)
- [Protections and plugins](#protections-and-plugins)
- [Remote access and devices](#remote-access-and-devices)
- [What a phone shows when it cannot sign in](#what-a-phone-shows-when-it-cannot-sign-in)
- [Archives, imports and the trash](#archives-imports-and-the-trash)
- [The workspace list](#the-workspace-list)
- [When nothing here fits](#when-nothing-here-fits)
- [Report a problem that is not listed](#report-a-problem-that-is-not-listed)
- [Remove Delorun](#remove-delorun)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Reading a refusal

A refusal appears in your terminal in three parts: the first line says what happened, `Why:` names the error code and the path or value it concerns, and `What you can do:` lists the fixes in order. A refusal never shows a stack trace, and it hides keys and tokens the same way Delorun's logs do. The messages call the product "Delorun".

```text
Delorun stopped before using /home/you/.delorun.
Why: HOME_MODE: /home/you/.delorun has mode 0755, which other users can reach; it must be 0700
What you can do:
  Fix it with: chmod 700 /home/you/.delorun
```

A fix that runs a `delorun` command repeats the `--profile <name>` you gave, so you can copy it as printed. After you fix the cause, run the command that refused again; you should see it finish without a refusal.

`delorun` exits with one of four codes, which scripts can rely on:

| Exit code | Meaning |
| --- | --- |
| 0 | The command did what you asked, or found it already done. |
| 1 | The command failed; standard error says why. |
| 2 | The command line is wrong: an unknown command, option or value. |
| 3 | The command needs Delorun running for the profile, and it is not running. |

A command that fails without a code of its own starts with `delorun <command>:` and says what to do in the same sentence.

<details>
<summary>Edge cases</summary>

- If a refusal repeats after you fixed its cause, then run `delorun doctor` and read its lines before you try again.
- If a refusal names a file you cannot find, then it is inside your Delorun home, `~/.delorun` or the folder `DELORUN_HOME` names — list it with `ls -la` there.
- If you run `delorun headless`, then a consent or full-access question that would ask you is refused instead; the refusal names what to allow first ([Protections and plugins](#protections-and-plugins)).
- If the refusal says "Report this", then Delorun found something it cannot explain — see [When nothing here fits](#when-nothing-here-fits).

</details>

## The home and its files

| Code | What it means | What to do |
| --- | --- | --- |
| `HOME_MODE` | Your [Delorun home](../../reference/glossary.md#home), or one of its private folders, can be reached by other users, is a shortcut to somewhere else (a symbolic link), is not a folder, or belongs to another user. | Run the `chmod 700` command the refusal prints. For a shortcut or another owner, move it away and let `delorun` create the folder again. |
| `SECRET_FILE_MODE` | A secret file other users can read, a secret file that is a shortcut or belongs to another user, or one replaced while Delorun read it. | Run the `chmod 600` command the refusal prints. Delorun never changes these permissions for you. |
| `HOME_INVALID` | `DELORUN_HOME` is not an absolute path and does not start with `~`, or it names the root of the disk or your user folder itself. | Set `DELORUN_HOME` to a folder of its own, such as `~/.delorun`. |
| `HOME_IS_DSH_HOME` | `DELORUN_HOME` names DeepSeek Harness's home `~/.dsh` or a folder inside it. | Choose another folder; Delorun keeps `~/.dsh` untouched. |
| `SOCKET_PATH_TOO_LONG` | The home's path is too long for the local channel through which `delorun` commands talk to the running Delorun. | Choose a shorter home with `DELORUN_HOME`. |

You should see the command run without a refusal once the fix is in. [Your Delorun home](../customising/home.md) explains the home and its permissions.

A `.env` file in the folder you run `delorun` from, or in your Delorun home, may not set a name that starts with `DELORUN_`, because those names decide which home, profile and releases Delorun trusts. The refusal names the file. Remove the names from it, and set them in your shell instead if you need them.

<a id="the-first-day"></a>

## The first day

These are the problems people meet before Delorun is running. Each ends with the fix.

- **`Delorun needs Node 24.9 or newer to start`.** The message names the Node you have. A system package manager such as Ubuntu's `apt` often offers an older Node, so install a current one from [nodejs.org](https://nodejs.org) or with a version manager such as nvm, open a new terminal, check `node --version`, and run the command again. Every `delorun` command runs on Node, so Node must stay installed after the install; without it the shell prints `env: 'node': No such file or directory`.
- **`npm install -g delorun` fails with `EACCES` or "permission denied".** Your Node lives in a folder only an administrator can write, which is usual for a system-wide Node on Linux. Install into your own folder instead, with the line that setup printed and `--prefix ~/.local` added: `npm install -g --prefix ~/.local delorun@<version>`. Then put `~/.local/bin` on your `PATH` (`export PATH="$HOME/.local/bin:$PATH"`, and the same line in your shell's startup file so that it lasts), open a new terminal and check with `command -v delorun`. A Node installed in your home folder, as nvm does, never meets this.
- **The studio did not open in your browser.** Run `delorun open`. If it says `No browser took the studio link`, run `delorun open --print` and open the link it prints. A printed link signs in once and stops working after one minute, so run the command again for a new one. On a computer without a browser, see [A computer without a browser](../get-started/install.md#a-computer-without-a-browser).
- **Every command is refused, and `delorun doctor` says `fail sandbox: bubblewrap (bwrap) is not installed`.** On Linux, Delorun confines commands with bubblewrap. Without it, commands fall back to Landlock, which cannot hide the sockets that your login session or a terminal multiplexer such as tmux keeps in `/tmp`, so Delorun refuses every command while such a socket exists. Install the `bubblewrap` package (`sudo apt install bubblewrap` on Ubuntu and Debian), then run `delorun doctor` and start again. If `doctor` then says bubblewrap cannot create a sandbox, see [Protections and plugins](#protections-and-plugins).
- **`delorun doctor` shows `warn docker`.** Docker is optional. The warning means Docker is not installed or does not answer, and workspaces on your own computer's folders work without it.

## Starting and stopping

- **`Delorun is already running for the profile default`.** `delorun start` found Delorun running and did nothing; this is not a failure. Open the studio with `delorun open`.
- **`HOME_UNRESPONSIVE`.** A process claims to be running this profile (it holds the profile's lock file) but did not answer within 2 seconds. Stop that process, or, if it is not `delorun`, remove the lock file the refusal names, then run `delorun start` again.
- **`Delorun is running for the profile … and uses the stores this command changes`.** Commands such as `delorun trash`, `export` and `import` change chat data that the running Delorun uses. Run `delorun stop` first, as the refusal says.
- **`another process … holds the home lock`, or `Delorun did not go ahead: another process uses the chat data`.** Another `delorun` command is changing the same data. Wait for it to finish, then run your command again.
- **`Delorun is being repaired; wait for it to finish`.** `delorun repair` is running and replaces the program, so no start can run until it ends. Wait for it to finish, then run your command again. If no repair is running (it was killed), the next start reports the leftover mark, removes it and goes on.
- **`the CLI profile default is not set up`.** Run `delorun setup`.
- **`Delorun found no folder for the default workspace`.** None of the folders Delorun tries for the default workspace can be used; the refusal lists each with the reason. Name a folder of your own in your profile's `cordis.patch.yml`, as the refusal shows, and start again.
- **`UNAUTHENTICATED`.** The running Delorun refused a command that did not carry the token of its current start, which usually means another Delorun is running for the profile. Run `delorun status` to see which one.
- **`STUDIO_UNAVAILABLE`.** `delorun open` could not get a sign-in link from the running Delorun. Run `delorun status` to see whether it runs and where the studio listens; if it does not run, start it with `delorun start`.
- **`Delorun started no new turn: its start check did not finish`.** Delorun's check of its release at start has not finished. `delorun status` and `delorun logs` show what the start is doing; start Delorun with `delorun start`, then send the message again.
- **`delorun start: Delorun did not start. Delorun stopped with exit code 1 before it was running.`** The background process stopped while starting. A busy studio port is the most common cause; see [The studio port is busy](#the-studio-port-is-busy).
- **`delorun start: Delorun did not start. Delorun was not running after … seconds.`** The background process is still starting or is stuck. Run `delorun logs` to see why, then `delorun doctor`.

### The studio port is busy

The studio listens on one port on your own computer, 3080 unless your profile sets another. When another program already uses that port, the background process cannot start. You see:

```text
delorun start: Delorun did not start. Delorun stopped with exit code 1 before it was running.
Another program is using the studio's port. Choose another port with delorun setup profile, or set the port to 0 in the profile so Delorun picks a free one.
Run delorun logs to see why, then delorun doctor to check your setup.
```

To confirm the cause, run `delorun doctor`. It prints a failing `port` line that ends with "is in use by another process, so the studio cannot listen on it; stop that process, or choose another port with delorun setup profile". If your own Delorun already runs for the profile, the line instead says the port is in use by Delorun's studio and passes.

To fix it, either stop the other program, or run `delorun setup profile` (add `--profile <name>` for another profile) and answer a free port from 1024 to 65535 at "Port for the studio". Then run `delorun start` again. You should see "Delorun is running in the background for the profile default" with the studio's address, and `delorun doctor` shows `port` as passing.

<details>
<summary>Edge cases</summary>

- If the same message appears with the port free, then the process stopped for another reason — read the log the message names, or run `delorun logs home`.
- If `delorun doctor` says the port "cannot be bound" with a code other than `EADDRINUSE`, then the system refuses to open that port (the code names why) — choose another port.
- If you pass `--port` to `delorun doctor`, then it checks that port instead of the profile's.

</details>

<details>
<summary>Go further</summary>

- To let the system pick a free port at every start, set the studio's `port` to `0` in the `webserver` entry of `profiles/<profile>/cordis.patch.yml` in your Delorun home; `delorun setup profile` offers only ports from 1024 to 65535 and writes the entry for you. Keep the other keys of that entry. `delorun status` then shows the address, and `delorun doctor` reports that each start takes a free port.

</details>

## Setup and the model key

- **`The key was not checked successfully: …`.** Setup checks a typed key with the [provider](../../reference/glossary.md#provider) before it saves it, and the check failed; the reason follows. Choose **Enter the key again**, or **Continue without a successful check** to store it anyway, knowing that chats cannot answer if the key is wrong. You can change it later with `delorun setup key`.
- **`the key in DEEPSEEK_API_KEY was not accepted`.** You ran setup with `--check-key` and a key read from the environment, and the provider refused it. Check the key and run `delorun setup` again.
- **`DEEPSEEK_API_KEY is not set in this terminal`.** You chose to read the key from an environment variable that this terminal does not hold. Set it (for example `export DEEPSEEK_API_KEY=your-key` in your shell's startup file), then run `delorun stop` and `delorun start`.
- **`DEEPSEEK_BASE_URL is not a URL`.** Fix or unset `DEEPSEEK_BASE_URL`; setup cannot check the key without a valid address.
- **`the setup run for default is unfinished and needs the model key`.** A setup started with `--yes` or `--config` stopped before it had a key. Run `delorun setup` in a terminal to finish it.
- **`… holds …, which setup no longer asks`.** A `delorun setup --config` document names an answer setup no longer has. Remove it from the document.
- **`… is not a setup record; remove it to set up again`.** The record of an unfinished setup is damaged. Remove the file it names and run `delorun setup`.

## Installs and release checks

The npm launcher and `delorun update` verify every [release](../../reference/glossary.md#release) before they install it, and refuse one that does not verify; nothing is installed then. [Install and first run](../get-started/install.md) explains what they check.

| Code | What it means | What to do |
| --- | --- | --- |
| `DOWNLOAD_FAILED` | The download did not finish. | Check the connection and run the same command again. |
| `INSTALL_VERIFY_FAILED` | The release's signature or its signed file list did not match what was downloaded. | Run the same command again when the release page names a newer release; report it if it repeats. |
| `RELEASE_LOG_FAILED` | The release's entry in the public release log did not verify. | As above. `delorun verify` shows every check. |
| `ARCHIVE_REFUSED` | The runtime archive held something Delorun does not install. | As above. |
| `PLATFORM_NOT_RELEASED` | The release has no runtime for this computer's system and processor. | Use a computer whose platform the release lists. |
| `RELEASE_NOT_OFFERED` | You asked for a release your channel does not publish. | Name a published release, or leave the release out to install the current one. |
| `NO_TRUSTED_ROOT` | This launcher holds no key it can verify a release with. | Run `npx delorun@latest`, which ships the current release roots. |
| `TRUST_STATE_INVALID` | The file in which Delorun remembers which releases it has verified cannot be read. | Move the file the refusal names out of the way and run the command again. |
| `NO_ACTIVE_RUNTIME` | No installed runtime is marked active, or the active one is missing. | Run `npx delorun@latest repair` ([Repair](#repair)), or `delorun recover rollback` when `delorun` still starts. |
| `RUNTIME_INCOMPATIBLE` | The installed runtime needs a newer launcher, or the launcher a newer runtime. | Follow the remedy: update the runtime, or update the launcher. |
| `STORE_BUSY` | Another `delorun` command is changing the installed runtimes. | Wait for it to finish. |

Two refusals come from the public release log itself. "Delorun could not reach the release log" means a network failure: check the connection and try again. "The release log answered with something Delorun does not accept" means the log's answer did not hold together: report it if it repeats. No setting turns the release-log check off ([Release checks](../safety-and-updates/safety.md#release-checks)).

## Updates and rollback

[Updates](../safety-and-updates/updates.md) explains the update itself. These are the refusals you are most likely to see; each one changes nothing unless it says otherwise.

| Code | What it means | What to do |
| --- | --- | --- |
| `CHANNEL_UNREACHABLE` | The release channel could not be reached; nothing was downloaded. | Check the connection and try again. |
| `GIT_UNAVAILABLE` | Delorun saves your [profile](../../reference/glossary.md#profile)'s history with git before an update, so it can go back, and git cannot run here. | Install git and run `delorun update` again. |
| `REPORT_EXPIRED` | You confirmed a report that is older than ten minutes or unknown. | Run `delorun update` again to read a fresh report. |
| `CHATS_RUNNING`, `DRAIN_TIMEOUT` | Chats are running, or did not finish in time, so the update did not start. | Wait for the chats to finish and run the command again. |
| `UPDATE_IN_PROGRESS` | An update or rollback already runs. | Wait, then check with `delorun status`. |
| `DATA_COPY_NO_SPACE` | The copy of your chat data that the update keeps does not fit on the disk. | Free space, or run `delorun update --no-data-copy`. |
| `HEALTH_CHECK_FAILED` | The new release did not pass its health check after it started. | Run `delorun recover status` to see where the profile stands. |
| `ROLLBACK_NEEDS_DATA_COPY` | Going back would hand chat data written by the newer release to the older one, and no copy of the older data exists. | Keep this release and restore only the profile with `delorun recover rollback --profile-only`, or start in safe mode with `delorun recover safe-mode`. |
| `ROLLBACK_TARGET_UNUSABLE`, `NO_PREVIOUS`, `NO_UPDATE_RECORD` | The release to go back to is missing or fails its check, or no update is recorded. | Run `delorun recover status`. |
| `HOST_STOP_FAILED` | The studio did not stop in time, so the release was not switched, and it runs again. | Run the same command again. |
| `REPORT_TARGET_UNVERIFIED` | The release did not verify, so no update report was made. | Run `delorun verify`. |

`delorun update --yes` refuses a report that turns off or removes something, merges your change to one of Delorun's own files, or holds an item Delorun cannot predict, and it refuses when the release-log check did not pass: run `delorun update` without `--yes` and decide each item. When an update is waiting for running chats to end, a new message gets "Delorun started no new turn: an update is waiting for running chats"; send it again once Delorun is back.

A refusal that starts "Delorun refused the change and left the profile as it was" protects something you added to your profile, so nothing was lost. Its code names what would have been lost:

| Code | What would have been lost or changed |
| --- | --- |
| `ROW_NOT_CARRIED` | A [plugin](../../reference/glossary.md#plugin) entry you added to your profile (a row). |
| `CONFIGURATION_NOT_CARRIED` | A setting you wrote for a plugin. |
| `LOCAL_PLUGIN_NOT_CARRIED` | A plugin you installed from a folder on this computer. |
| `BUNDLE_LIST_NOT_CARRIED` | The order or the members of the profile's bundle list. |
| `UNNAMED_CHANGE` | Anything the update report does not name. |
| `EJECTED_PLUGIN_REINSTATED` | A plugin you ejected would come back. |
| `PROFILE_UNREADABLE` | A profile file cannot be read, so nothing can be checked; repair the file the refusal names. |
| `RESTORE_REFUSED`, `RECOVER_REFUSED` | An undo, restore, rollback or `delorun recover` action cannot be done as asked. |

Its fixes come from this list: do not take this update; keep the item and wait for a release that carries it; update the plugin; keep the plugin disabled; [eject](../../reference/glossary.md#eject) the plugin, which keeps its entries and settings in your profile; restore a profile history version with `delorun recover restore <version>`; go back with `delorun recover rollback`; or start in [safe mode](../../reference/glossary.md#profile-history) with `delorun recover safe-mode`. Run `delorun recover status` first to see where the profile stands. A refusal that starts "Delorun could not write the profile snapshot it takes before a change" (`SNAPSHOT_FAILED`) means nothing changed because the snapshot that makes the change undoable could not be written.

<a id="repair"></a>

## Repair the program and keep your data

If Delorun will not start because the installed program fails its check, or `delorun update` cannot run, replace the program and keep everything you made:

```sh
npx delorun@latest repair
```

Run it in a terminal. Delorun checks the release it installs the way an update does, asks `Replace the installed program … with …? Your chats, settings and keys stay. [y/N]`, and puts the old program in `runtimes.set-aside-<time>/` instead of deleting it. `delorun recover status` lists it and `delorun recover discard runtimes.set-aside-<time>` removes it once you are happy. Your chats, settings, keys, devices and trust records are not touched. Repair has no `--yes`, and it refuses while Delorun is running: stop it with `delorun stop` first.

<details>
<summary>Edge cases</summary>

- **`DATA_NEWER`.** A newer Delorun wrote your chats, and the release you asked for may not read them. Install the newer release (`npx delorun@latest repair`), or put back the copy the update took with `npx delorun@latest repair --release <old version> --restore-copy`. Today's chats are set aside, never deleted.
- **`DATA_UNREADABLE`.** The home records which release wrote your chats, and Delorun cannot compare that with the release you asked for because the release's data formats or a version cannot be read. Nothing is changed. Install the release that wrote your chats or a newer one (`npx delorun@latest repair`).
- **`DATA_COPY_NEWER`.** The copy for `--restore-copy` is not in a format the release reads, or its formats cannot be read. Nothing is changed. Install the newer release instead.
- **`TARGET_LOWER`.** The release is older than one this home already installed. Go back with `delorun recover rollback`.
- **`NO_TERMINAL`.** Run the command in a terminal, because Delorun must ask you.
- **`RESET_TRUST_REFUSED`.** `--reset-trust` works only when the launcher you run ships release keys newer than the ones this home trusts. Install the newest launcher from npm and try again.
- **`--reset-trust`.** Moves the home's `trust/` to `trust.set-aside-<time>/` so that the home trusts only the keys in the launcher. Use it only with a launcher you installed yourself from npm.
- **`--from <folder or https address>`.** Verifies the release from files you downloaded from its release page instead of the channel; the same signature, release-log and digest checks apply. If the channel cannot confirm the release is current, or you name an older `--release` than this home has seen, Delorun asks you in a terminal first; nothing else is loosened. For the same option on `delorun update`, see [Update from files you downloaded](../safety-and-updates/updates.md#update-from-files-you-downloaded).
- **A repair and a start at the same time.** The repair holds the lock of each profile until it finishes, so a Delorun started meanwhile stops with a message that the profile is held; start it again once the repair ends. It never runs the program that was set aside.
- **No data-format record.** A home made before Delorun recorded one has none. Repair says so, assumes your chats are in the formats of the release it installs, and carries on.
- Every run adds one line to `logs/repair.log`.

</details>

<a id="by-hand"></a>

## Last resort, by hand

Use this only if `npx delorun@latest repair` cannot run. It needs no Delorun code.

1. Stop Delorun: `delorun stop`, or end the `node` processes that run `@delorun/cli`.
2. Back up your data. Copying the whole home with `cp -a ~/.delorun ~/delorun-backup-$(date +%F)` also copies `runtimes/`, which holds every installed release at about 1.5 GB each, so check that `df -h ~` shows that much free space. Step 4 installs the programs again, so you can leave `runtimes/` out: `mkdir ~/delorun-backup-$(date +%F) && tar -C ~/.delorun --exclude=./runtimes -cf - . | tar -C ~/delorun-backup-$(date +%F) -xf -`. `delorun export` saves single chats or workspaces only, so it is not a backup of settings and keys.
3. Move the program aside, not your data: `mv ~/.delorun/runtimes ~/.delorun/runtimes.broken`, and `~/.delorun/staging` too if it exists.
4. Install again: `npx delorun@latest`. The program store is empty, so the launcher installs and checks the current release and starts it. Your chats, settings, keys and profiles are untouched.

<details>
<summary>Edge cases</summary>

- If the launcher refuses with `TRUST_STATE_INVALID` or a stored-root error, also move `~/.delorun/trust` aside and run step 4 again. The home then trusts only the keys that npm's launcher ships.
- If the new release cannot read your chats, move `sessions/` and `storages/` aside, put in the copy from `data-copies/<version>/`, and bring individual exported chats back with `delorun import`.

</details>

## Protections and plugins

- **`the profile default would boot without protections Delorun requires`.** A setting in your profile turns off a protection, such as the sandbox or one of Delorun's guards. The refusal lists each one with the file that sets it. Remove those settings, or start without your plugins with `delorun recover safe-mode`.
- **`the profile default could not load Delorun's bundle`** or **`plugins of Delorun's bundles did not start`.** Delorun stops rather than start without its guards and privacy settings, because the profile would otherwise run with DeepSeek Harness's own defaults. The refusal names each package, the cause and the fix.
- **`the landlock sandbox cannot deny the sockets in "<directory>"`.** Your Linux system has no working bubblewrap, so commands would run under Landlock, which cannot hide the sockets of your login session, and Delorun refuses every sandboxed command while such a directory exists. If the refusal says to install bubblewrap, install the `bubblewrap` package and start again. If it says bubblewrap's check did not finish in time, your computer was busy when Delorun started: start it again. If it says bubblewrap is installed but could not create a sandbox, `delorun doctor` shows why on its `sandbox` line, or run `bwrap --ro-bind / / true` to see why; on Ubuntu the usual cause is its AppArmor restriction on user namespaces (`kernel.apparmor_restrict_unprivileged_userns`), which [a profile for `bwrap`](#letting-bubblewrap-run-under-ubuntus-apparmor-restriction) lifts for `bwrap` alone. Turning the restriction off for the whole system also works, but lowers its protection for every program.
- **`the sandbox row sets the runner itself`** or **`is configured with expressions`.** Delorun adds its home protection to the sandbox's settings at start, so those settings must leave the choice of sandbox to Delorun and use plain YAML values. Remove what the refusal names.
- **`delorun headless: … asks for full access in "<folder>", which you have not granted full access`.** A headless task asked to run outside the [sandbox](../../reference/glossary.md#sandbox) in a folder you have not put on [full access](../../reference/glossary.md#full-access), so it did not start. Run `delorun workspace full-access <folder> on` at your computer, or turn it on in the studio's Settings, Safety, Permissions, then run the task again. Or run the task without full access.
- **`full access for the workspace "<folder>" needs one consent for that workspace first`.** The model tried to switch a chat to full access in a [workspace](../../reference/glossary.md#workspace) you have not allowed. A [consent](../../reference/glossary.md#consent) is a yes you give at your own computer. It stays on the safer preset. Allow it with the approval card's **Allow for this chat**, in Settings, Safety, Permissions, or with the `delorun workspace full-access <folder> on` command the message prints; see [Full access](../safety-and-updates/safety.md#full-access).
- **"Approve this at your computer".** You tried to allow full access, an [MCP server](../../reference/glossary.md#mcp-server) or another permission change from a phone. These answers are accepted only at the computer that runs Delorun. Do it there; see [What an approved phone can and cannot do](../everyday-use/reach.md#what-an-approved-phone-can-and-cannot-do).
- **`This needs your confirmation: …`.** A phone answered a prompt that grants something, such as full access or an external agent, without confirming it. Answer again and confirm with Face ID or your PIN when the phone asks, or answer at your computer ([Confirm with Face ID](../everyday-use/reach.md#confirm-with-face-id)).
- **`The network setting could not be read, so every workspace's commands have no network`.** The file that holds the network setting is damaged or other users can read it. Settings, Safety, Network names the problem. Repair or remove the file it names; the workspaces count as Off until you do.
- **A command is refused because the workspace network is Allowlist or Off.** Your sandbox cannot enforce those settings (only bubblewrap on Linux can), so Delorun refuses the command rather than run it with your network. Set the workspace back to Open in Settings, Safety, Network ([The network setting](../safety-and-updates/safety.md#the-network-setting)).
- **`Delorun could not use the Docker engine`.** Docker did not answer, or refused the request with the HTTP status the refusal names. Start Docker and run the command again.

### Letting bubblewrap run under Ubuntu's AppArmor restriction

From Ubuntu 23.10, AppArmor keeps a program from creating user namespaces unless a profile allows it, and `kernel.apparmor_restrict_unprivileged_userns` reads 1. bubblewrap needs them, so `delorun doctor` then fails its `sandbox` line and every sandboxed command is refused. A profile for `bwrap` alone allows them. Save this as `/etc/apparmor.d/bwrap`, with `/usr/bin/bwrap` replaced by the path `command -v bwrap` prints if it differs:

```text
abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

Load it with `sudo apparmor_parser -r /etc/apparmor.d/bwrap`, check that `bwrap --ro-bind / / true` exits without an error, and restart Delorun. Any program can then create user namespaces through `bwrap`, which is what the restriction holds back, but every other program stays restricted.

## Remote access and devices

| Code | What it means | What to do |
| --- | --- | --- |
| `APPROVALS_UNAVAILABLE` | The running Delorun does not load remote access. | Run `delorun reach on tailscale`, then restart Delorun. |
| `LOOPBACK_REQUIRED` | A device request did not come from your own `delorun` on this computer. | Approve devices at this computer with `delorun devices approve`. |
| `APPROVAL_FAILED` | The approval or cancellation did not happen. | Run `delorun devices approve` and ask from the device again. |
| `REMOVAL_FAILED` | The device was not removed. | Check `delorun devices list`. |
| `ELEVATION_FAILED` | Sensitive actions were not unlocked on the device, or the unlock did not end. | Run `delorun devices elevate` and look at the list again. |
| `PIN_FAILED` | PIN mode did not change, for example because the PIN was too weak. | Choose a PIN of at least 6 digits that is not a repeat or a run, or a passcode of at least 10 characters. |

These entries come from `delorun reach` and `delorun devices` at your computer. [Reach the studio from your phone](../everyday-use/reach.md) explains what remote access needs.

`delorun reach on tailscale` and `delorun reach off` print Tailscale's problems as `delorun reach: <what happened> (<CODE>)`, and `reach on` adds "Remote access stays off." Nothing is turned on after such a refusal.

| Code | Message starts | What to do |
| --- | --- | --- |
| `TAILSCALE_NOT_INSTALLED` | "Tailscale is not installed on this computer." | Install it from tailscale.com/download, sign in, and run the command again. |
| `TAILSCALE_NOT_LOGGED_IN` | "Tailscale is not running and signed in to a tailnet on this computer." | Run `tailscale up`, sign in, and run the command again. The same code also reports other `tailscale serve` failures; the message then says "tailscale serve failed:" with Tailscale's own words. |
| `TAILSCALE_HTTPS_DISABLED` | "Your tailnet does not have HTTPS certificates turned on." | Turn on HTTPS in the DNS page of the Tailscale admin console, then run the command again. |
| `TAILSCALE_SERVE_NOT_PERMITTED` | "Your user may not configure tailscale serve yet." | Run the one command it prints, `sudo tailscale set --operator=$USER`, then run the command again. Delorun never runs it for you. |
| `TAILSCALE_FUNNEL_ON` | "Tailscale Funnel is on for …, which would put this studio on the public internet, so remote access stays off." | Run the `tailscale funnel --https=<port> off` command it prints, then run `delorun reach on tailscale` again. |
| `TAILSCALE_SERVE_CONFLICT` | "Tailscale still serves …" or "tailscale … failed (…), so Tailscale may still serve …" | Stop the `tailscale serve` or `tailscale funnel` that holds the port, or run the command the message prints, then run the command again. |
| `TAILSCALE_ADDRESS_MISMATCH` | "The configured address … is not this machine's Tailscale address …" | Your computer's Tailscale name changed. Run `delorun reach on tailscale` again. |

A refusal that starts "Delorun could not read or change what Tailscale serves for remote access" carries the same codes in its `Why:` line.

If `delorun reach on tailscale` says "the running Delorun did not make the address ready. Fix what the line above names, then run delorun reach on tailscale again", read the line above it, fix that, and run the command again. If it says "the running Delorun did not apply it" or "did not close its remote listener", restart Delorun with the command it prints.

These messages come from `delorun devices`:

- **`Delorun isn't running. Start it with: delorun start`.** `delorun devices approve` and `delorun devices elevate` need the running Delorun. Run `delorun start`, then run the command again.
- **`delorun devices: No device asked for approval before the window closed. Run delorun devices approve again`.** Nobody asked within 5 minutes. Run the command again, then open your address on the phone and choose **Ask for approval**.
- **`That request is no longer waiting.`** The request ended on its own (it expired, or was cancelled on the phone). The command lists the waiting requests again; choose another, or ask again from the phone.
- **`That code is not the one the device shows. Try again.`** You may type it again. After the third wrong code the request is cancelled; ask again from the phone for a new code.
- **`Remote access is off for this profile, so a phone cannot reach your studio: turn it on with delorun reach on tailscale`.** `delorun devices approve` waits, but no phone can reach you. Run `delorun reach on tailscale`.
- **`DEVICE_NOT_TRUSTED`, "This home does not trust that device on this address. Ask for approval at the home's computer".** The home refused a sign-in from a device it does not trust at this address: it was removed, or it was approved for another address. Ask for approval from the phone again, and approve it at your computer ([Approve a device](../everyday-use/reach.md#approve-a-device)).

### What a phone shows when it cannot sign in

The sign-in page on the phone names the problem in its title.

| The phone shows | What to do |
| --- | --- |
| "Your computer isn’t ready yet" | The approval window is closed. At your computer run `delorun devices approve`, or choose **Add a device** in Settings → Devices, then choose **Try again**. |
| "Too many devices waiting" | Five devices already wait. At your computer, cancel the ones you do not recognise, then ask again. |
| "This code expired" | A code lasts 5 minutes. Choose **Ask again**; open approval at your computer first if it has closed. |
| "Request cancelled" | Your computer cancelled it, or the code was typed wrong three times. Choose **Ask again** for a new code. |
| "Too many tries" | Wait a minute, then try again. |
| "This device has too many sign-ins" | At your computer, remove this device in Settings → Devices and approve it again. |
| "Can’t reach your computer" | Check that the phone is connected in the Tailscale app and that Delorun runs on your computer (`delorun status`). |
| "This browser can’t sign in" | Open the page in a current Safari, Chrome, Edge or Firefox, not in a private window. |
| "Something went wrong" with "Error code: …" | Choose **Try again**. If it keeps happening, restart Delorun on your computer and report the code to support@delorun.com. |

When an unlock request fails, the phone says one of: "The code expired before your computer approved it." (choose **Try again**), "Your computer declined the request, or it was cancelled there." (ask again if you meant to unlock), "Your computer can't be reached right now. Check that Delorun is running there.", or "Too many requests are waiting at your computer. Answer them there, then try again." (open Settings → Devices at your computer, or run `delorun devices elevate`).

<details>
<summary>Edge cases</summary>

- If the phone cannot open the address at all, then check the phone's Tailscale app is connected, then run `delorun reach status` at your computer — it shows whether the address is ready.
- If an approved phone stops signing in after you changed profile or address, then it is approved for the old address only — approve it again.
- If you removed a phone by mistake, then approve it again; nothing else is lost.
- If you lost power while remote access was on, then run `delorun reach off` if you share the computer ([Turn remote access off](../everyday-use/reach.md#turn-remote-access-off)).

</details>

## Archives, imports and the trash

- **"Delorun refused the archive and changed nothing."** `delorun import` checks an archive before it writes anything; the code names the entry it refused.
- **"Delorun stopped at the stock DeepSeek Harness home import."** The import from `~/.dsh` was refused, or a start found an interrupted import it could not remove; the code and detail say which. [Switching from DeepSeek Harness](../get-started/switching.md) explains the import.
- **`TRASH_ITEM_NOT_FOUND`.** The trash holds no item with that id; `delorun trash list` shows what it holds.

## The workspace list

Delorun keeps your [workspaces](../../reference/glossary.md#workspace) in one file, `storages/workspace.json` in your home. A damaged file never stops Delorun from starting. Delorun starts with every workspace record it can read, moves the rest to a file named `workspace.json.quarantined-<date and time>.json` next to it, writes the cleaned list, and logs a warning that names the file and each record. `delorun doctor` lists the set-aside files. Delorun never deletes a set-aside file. If the whole file cannot be read, Delorun starts with no workspaces and sets the whole file aside. Your folders and chats are not touched.

Before every change to the list, Delorun keeps the previous good file as `workspace.json.previous`.

- **Check it.** `delorun doctor` has a `workspaces` line. It opens the file without changing it and prints `pass` for a readable list, `warn` when records would be set aside or earlier ones were, and `fail` for a file that cannot be read, naming the broken records and the set-aside files.
- **Bring the previous list back.** Stop Delorun (`delorun stop`), then run `delorun recover workspaces`. It shows what the current file and the previous copy hold, asks you to confirm (`--yes` answers for a script), moves the current file aside, and writes the previous copy in its place. It deletes nothing, and the copy stays. Run it at your own computer; it does not run while Delorun runs.
- **Use the studio to rename.** The agent renames a workspace with its `rename_workspace` tool after you allow it, so it never needs to edit the file by hand. If you edit `workspace.json` yourself, stop Delorun first.

## When nothing here fits

Run `delorun doctor`. It checks Docker, the model key's format, your home, the studio's port, the sandbox (the `sandbox` line), the workspace list (`workspaces`), whether the profile would run without its protections (`dangerous-mode`), the release-log check, the last update check, the last import from a DeepSeek Harness home (`import`), your changes and your CLI profile's plugins, and prints one line for each. Run `delorun logs home` to read the running Delorun's recent records; [Where Delorun keeps its logs](logs.md) explains each log.

A refusal that says "Report this" means Delorun found something it cannot explain. Report it with the refusal's text.

### Report a problem that is not listed

Choose **Report a problem** at the foot of the studio's sidebar, or in Settings → About. It opens a short review of a GitHub issue already filled in with your Delorun version, your system and recent errors, with secrets removed. You read it, then open it in your browser or copy it; Delorun sends nothing itself. You can also ask the assistant in a chat to "Help me report this", and it drafts the issue for you to send.

By hand, include:

- the version from `delorun --version`;
- the output of `delorun doctor`;
- the smallest steps that repeat the problem;
- the relevant lines of `delorun logs`. Read them first and remove anything private.

Send it to [GitHub Discussions](https://github.com/twickas/delorun/discussions) for a question, the [issue templates](https://github.com/twickas/delorun/issues/new/choose) for a bug, or support@delorun.com. [SUPPORT.md](../../../../SUPPORT.md) lists the routes. Report a suspected vulnerability only privately, as [SECURITY.md](../../../../SECURITY.md) describes.

<details>
<summary>Go further</summary>

- `delorun verify` shows every release and setup check, and `delorun recover status` shows where the profile stands after an update ([Daily use](../everyday-use/daily-use.md#check-the-release-and-your-setup)).
- `delorun logs --follow` follows the running Delorun's log as it happens.
- `delorun start` and the other commands accept `--profile <name>` to work on a profile other than `default`.

</details>

## Remove Delorun

1. If you turned on phone access, run `delorun reach off`. It removes the Tailscale rule that forwards your phone to the studio.
2. Run `delorun stop`.
3. Remove the `delorun` command: `npm uninstall -g delorun`, adding `--prefix ~/.local` if you installed it that way.
4. Delete your Delorun home, `~/.delorun` or the folder `DELORUN_HOME` names, only if you no longer want your data.

The home holds your chats, your workspace list, your settings, your keys, your approved devices and the installed Delorun releases. Deleting it loses all of that and cannot be undone; save chats you want first with `delorun export` ([Daily use](../everyday-use/daily-use.md#trash-export-and-import)). The folders of your workspaces, including the default workspace `Delorun/default-workspace` in your Documents folder, and DeepSeek Harness's `~/.dsh` are outside it and stay. If you leave the home in place, installing Delorun again picks up where you stopped.

## Next

- To check your setup after a fix, run `delorun doctor`, then `delorun status`.
- To understand what Delorun protects, read [What Delorun protects](../safety-and-updates/safety.md).
- To read how logs help you, read [Where Delorun keeps its logs](logs.md).
- To set up remote access, read [Reach the studio from your phone](../everyday-use/reach.md).

## For the technically curious

Each code belongs to a contract that defines when it is raised: the [home layout contract](../../contracts/c01-home-layout.md) for the home and installs, the [home process contract](../../contracts/c19-home-process.md) for starting, updates and devices, the [reach providers contract](../../contracts/c07-reach-providers.md) for the Tailscale codes, and the [update report contract](../../contracts/c03-update-report.md) for the update report and rollback. The codes that protect your profile are listed in the [profile safety README](../../../packages/profile-safety/README.md).
