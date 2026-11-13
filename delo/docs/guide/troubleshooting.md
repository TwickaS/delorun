---
description: "Troubleshooting Delorun: how to read a refusal, the exit codes, and the common refusals with their codes and fixes, for the home and its files, starting, the model key, installs and release checks, updates and rollback, protections and plugins, remote access, and archives."
---

# Troubleshooting

English

## Summary

When `delorun` or its npm launcher cannot do what you asked, it prints a refusal: what Delorun did or did not do, why, with an error code, and what you can do. Most refusals change nothing, so you can fix the cause and run the same command again. This page shows how to read a refusal and lists the common ones by code, with their fixes.

## Contents

- [Reading a refusal](#reading-a-refusal)
- [The home and its files](#the-home-and-its-files)
- [Starting and stopping](#starting-and-stopping)
- [Setup and the model key](#setup-and-the-model-key)
- [Installs and release checks](#installs-and-release-checks)
- [Updates and rollback](#updates-and-rollback)
- [Repair the program and keep your data](#repair)
- [Last resort, by hand](#by-hand)
- [Protections and plugins](#protections-and-plugins)
- [Remote access and devices](#remote-access-and-devices)
- [Archives, imports and the trash](#archives-imports-and-the-trash)
- [When nothing here fits](#when-nothing-here-fits)
- [For the technically curious](#for-the-technically-curious)

## Reading a refusal

A refusal goes to standard error in three parts: the first line says what happened, `Why:` names the error code and the path or value it concerns, and `What you can do:` lists the remedies in order. A refusal never shows a stack trace, and it passes the same redaction as Delorun's logs, so it shows no key or token. The messages call the product "Delo".

```text
Delo stopped before using /home/you/.delo.
Why: HOME_MODE: /home/you/.delo has mode 0755, which other users can reach; it must be 0700
What you can do:
  Fix it with: chmod 700 /home/you/.delo
```

A remedy that runs a `delorun` command repeats the `--profile <name>` you gave, so you can copy it as printed.

`delorun` exits with one of four codes, which scripts can rely on:

| Exit code | Meaning |
| --- | --- |
| 0 | The command did what you asked, or found it already done. |
| 1 | The command failed; standard error says why. |
| 2 | The command line is wrong: an unknown command, option or value. |
| 3 | The command needs Delorun running for the profile, and it is not running. |

A command that fails without a code of its own starts with `delorun <command>:` and says what to do in the same sentence.

## The home and its files

| Code | What it means | What to do |
| --- | --- | --- |
| `HOME_MODE` | Your Delorun home, or one of its private folders, can be reached by other users, is a symbolic link, is not a folder, or belongs to another user. | Run the `chmod 700` command the refusal prints. For a link or another owner, move it away and let `delorun` create the folder again. |
| `SECRET_FILE_MODE` | A secret file other users can read, a secret file that is a symbolic link or belongs to another user, or one replaced while Delorun read it. | Run the `chmod 600` command the refusal prints. Delorun never changes these permissions for you. |
| `HOME_INVALID` | `DELO_HOME` is not an absolute path and does not start with `~`, or it names the filesystem root or your home folder itself. | Set `DELO_HOME` to a folder of its own, such as `~/.delo`. |
| `HOME_IS_DSH_HOME` | `DELO_HOME` names DeepSeek Harness's home `~/.dsh` or a folder inside it. | Choose another folder; Delorun keeps `~/.dsh` untouched. |
| `SOCKET_PATH_TOO_LONG` | The home's path is too long for the local socket through which `delorun` commands talk to the running Delorun. | Choose a shorter home with `DELO_HOME`. |

On Windows, Delorun does not check these permissions yet. [Your Delorun home](home.md) explains the home and its permissions.

A `.env` file in the folder you run `delorun` from, or in your Delorun home, may not set a name starting with `DELO_`, because those names decide which home, profile, releases and runtime Delorun trusts. The refusal names the file; remove the names from it, and export them in your shell instead if you need them.

## Starting and stopping

- **`Delo is already running for the profile default`.** `delorun start` found Delorun running and did nothing; this is not a failure. Open the studio with `delorun open`.
- **`HOME_UNRESPONSIVE`.** A process holds the profile's lock but did not answer within 2 seconds. Stop that process, or remove the lock file the refusal names if the process is not `delorun`.
- **`Delo is running for the profile … and uses the stores this command changes`.** Commands such as `delorun trash`, `export` and `import` change chat data that the running Delorun uses. Run `delorun stop` first, as the refusal says.
- **`another process … holds the home lock`, or `Delo did not go ahead: another process uses the chat data`.** Another `delorun` command is changing the same data. Wait for it to finish, then run your command again.
- **`Delorun is being repaired; wait for it to finish`.** `delorun repair` is running and replaces the program, so no start can run until it ends. Wait for it to finish, then run your command again. If no repair is running (it was killed), the next start reports the leftover mark, removes it and goes on.
- **`the CLI profile default is not set up`.** Run `delorun setup`.
- **`Delo found no folder for the default workspace`.** None of the folders Delorun tries for the default workspace can be used; the refusal lists each with the reason. Name a folder of your own in your profile's `cordis.patch.yml`, as the refusal shows, and start again.
- **`UNAUTHENTICATED`.** The running Delorun refused a command that did not carry the token of its current start. Run `delorun status` to see which Delorun runs for the profile.
- **`STUDIO_UNAVAILABLE`.** `delorun open` could not get a sign-in link from the running Delorun. Run `delorun status` to see whether it runs and where the studio listens.
- **`Delo started no new turn: its start check did not finish`.** Delorun's check of its release at start has not finished. Run `delorun status` and `delorun logs` to see what the start is doing.

## Setup and the model key

- **`the key in DEEPSEEK_API_KEY was not accepted`.** Setup checks the key with the provider before it saves it, and the provider refused it. Check the key and run `delorun setup` again.
- **`DEEPSEEK_BASE_URL is not a URL`.** Fix or unset `DEEPSEEK_BASE_URL`; setup cannot check the key without a valid address.
- **`the setup run for default is unfinished and needs the model key`.** A setup started with `--yes` or `--config` stopped before it had a key. Run `delorun setup` in a terminal to finish it.
- **`… holds …, which setup no longer asks`.** A `delorun setup --config` document names an answer setup no longer has. Remove it from the document.
- **`… is not a setup record; remove it to set up again`.** The record of an unfinished setup is damaged. Remove the file it names and run `delorun setup`.

## Installs and release checks

The npm launcher and `delorun update` verify every release before they install it, and refuse one that does not verify; nothing is installed then. [Install and first run](install.md) explains what they check.

| Code | What it means | What to do |
| --- | --- | --- |
| `DOWNLOAD_FAILED` | The download did not finish. | Check the connection and run the same command again. |
| `INSTALL_VERIFY_FAILED` | The release's signature or its signed file list did not match what was downloaded. | Run the same command again when the release page names a newer release; report it if it repeats. |
| `RELEASE_LOG_FAILED` | The release's entry in the public release log did not verify. | As above. `delorun verify` shows every check. |
| `ARCHIVE_REFUSED` | The runtime archive held something Delorun does not install. | As above. |
| `PLATFORM_NOT_RELEASED` | The release has no runtime for this computer's system and processor. | Use a computer whose platform the release lists. |
| `RELEASE_NOT_OFFERED` | You asked for a release your channel does not publish. | Name a published release, or leave the release out to install the current one. |
| `NO_TRUSTED_ROOT` | This launcher holds no key it can verify a release with. | Install Delorun from the install script on its release page. |
| `TRUST_STATE_INVALID` | The file in which Delorun stores what it learned about verified releases cannot be read. | Move the file the refusal names out of the way and run the command again. |
| `NO_ACTIVE_RUNTIME` | No installed runtime is marked active, or the active one is missing. | Run `delorun update` to install the release again, or `delorun recover rollback`. |
| `RUNTIME_INCOMPATIBLE` | The installed runtime needs a newer launcher, or the launcher a newer runtime. | Follow the remedy: update the runtime, or update the launcher. |
| `STORE_BUSY` | Another `delorun` command is changing the installed runtimes. | Wait for it to finish. |

Two refusals come from the public release log itself. "Delo could not reach the release log" means a network failure: check the connection and try again. "The release log answered with something Delo does not accept" means the log's answer did not hold together: report it if it repeats. No setting turns the release-log check off ([Release checks](safety.md#release-checks)).

## Updates and rollback

[Updates](updates.md) explains the update itself. These are the refusals you are most likely to see; each one changes nothing unless it says otherwise.

| Code | What it means | What to do |
| --- | --- | --- |
| `CHANNEL_UNREACHABLE` | The release channel could not be reached; nothing was downloaded. | Check the connection and try again. |
| `GIT_UNAVAILABLE` | Delorun saves your profile's history with git before an update, so it can go back, and git cannot run here. | Install git and run `delorun update` again. |
| `REPORT_EXPIRED` | You confirmed a report that is older than ten minutes or unknown. | Run `delorun update` again to read a fresh report. |
| `CHATS_RUNNING`, `DRAIN_TIMEOUT` | Chats are running, or did not finish in time, so the update did not start. | Wait for the chats to finish and run the command again. |
| `UPDATE_IN_PROGRESS` | An update or rollback already runs. | Wait, then check with `delorun status`. |
| `DATA_COPY_NO_SPACE` | The copy of your chat data that the update keeps does not fit on the disk. | Free space, or run `delorun update --no-data-copy`. |
| `HEALTH_CHECK_FAILED` | The new release did not pass its health check after it started. | Run `delorun recover status` to see where the profile stands. |
| `ROLLBACK_NEEDS_DATA_COPY` | Going back would hand chat data written by the newer release to the older one, and no copy of the older data exists. | Keep this release and restore only the profile with `delorun recover rollback --profile-only`, or start in safe mode with `delorun recover safe-mode`. |
| `ROLLBACK_TARGET_UNUSABLE`, `NO_PREVIOUS`, `NO_UPDATE_RECORD` | The release to go back to is missing or fails its check, or no update is recorded. | Run `delorun recover status`. |
| `HOST_STOP_FAILED` | The studio did not stop in time, so the release was not switched, and it runs again. | Run the same command again. |
| `REPORT_TARGET_UNVERIFIED` | The release did not verify, so no update report was made. | Run `delorun verify`. |

`delorun update --yes` refuses a report that turns off or removes something, or holds an item Delorun cannot predict: run `delorun update` without `--yes` and decide each item. When an update is waiting for running chats to end, a new message gets "Delo started no new turn: an update is waiting for running chats"; send it again once Delorun is back.

A refusal that starts "Delo refused the change and left the profile as it was" protects something you added to your profile. Its code names what would have been lost:

| Code | What would have been lost or changed |
| --- | --- |
| `ROW_NOT_CARRIED` | A plugin entry you added to your profile (a row). |
| `CONFIGURATION_NOT_CARRIED` | A setting you wrote for a plugin. |
| `LOCAL_PLUGIN_NOT_CARRIED` | A plugin you installed from a folder on this computer. |
| `BUNDLE_LIST_NOT_CARRIED` | The order or the members of the profile's bundle list. |
| `UNNAMED_CHANGE` | Anything the update report does not name. |
| `EJECTED_PLUGIN_REINSTATED` | A plugin you ejected would come back. |
| `PROFILE_UNREADABLE` | A profile file cannot be read, so nothing can be checked; repair the file the refusal names. |
| `RESTORE_REFUSED`, `RECOVER_REFUSED` | An undo, restore, rollback or `delorun recover` action cannot be done as asked. |

Its remedies come from this list: do not take this update; keep the item and wait for a release that carries it; update the plugin; keep the plugin disabled; eject the plugin, which keeps its entries and settings in your profile; restore a profile history version with `delorun recover restore <version>`; go back with `delorun recover rollback`; or start in safe mode with `delorun recover safe-mode`. A refusal that starts "Delo could not write the profile snapshot it takes before a change" (`SNAPSHOT_FAILED`) means nothing changed because the snapshot that makes the change undoable could not be written.

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
- **`TARGET_LOWER`.** The release is older than one this home already installed. Go back with `delorun recover rollback`.
- **`NO_TERMINAL`.** Run the command in a terminal, because Delorun must ask you.
- **`RESET_TRUST_REFUSED`.** `--reset-trust` works only when the launcher you run ships release keys newer than the ones this home trusts. Install the newest launcher from npm and try again.
- **`--reset-trust`.** Moves the home's `trust/` to `trust.set-aside-<time>/` so that the home trusts only the keys in the launcher. Use it only with a launcher you installed yourself from npm.
- **`--from <folder or https address>`.** Verifies the release from files you downloaded from its release page instead of the channel; the same signature, release-log and digest checks apply. If the channel cannot confirm the release is current, or you name an older `--release` than this home has seen, Delorun asks you in a terminal first; nothing else is loosened. For the same option on `delorun update`, see [Update from files you downloaded](updates.md#update-from-files-you-downloaded).
- **A repair and a start at the same time.** The repair holds the lock of each profile until it finishes, so a Delorun started meanwhile stops with a message that the profile is held; start it again once the repair ends. It never runs the program that was set aside.
- **No data-format record.** A home made before Delorun recorded one has none. Repair says so, assumes your chats are in the formats of the release it installs, and carries on.
- Every run adds one line to `logs/repair.log`.

</details>

<a id="by-hand"></a>

## Last resort, by hand

Use this only if `npx delorun@latest repair` cannot run. It needs no Delorun code.

1. Stop Delorun: `delorun stop`, or end the `node` processes that run `@delo/cli`.
2. Back up the whole home. On Linux or macOS: `cp -a ~/.delo ~/delo-backup-$(date +%F)`. On Windows: `robocopy %USERPROFILE%\.delo %USERPROFILE%\delo-backup /E /COPY:DAT`. `delorun export` saves single chats or workspaces only, so it is not a backup of settings and keys.
3. Move the program aside, not your data: `mv ~/.delo/runtimes ~/.delo/runtimes.broken`, and `~/.delo/staging` too if it exists.
4. Install again: `npx delorun@latest`. The program store is empty, so the launcher installs and checks the current release and starts it. Your chats, settings, keys and profiles are untouched.

<details>
<summary>Edge cases</summary>

- If the launcher refuses with `TRUST_STATE_INVALID` or a stored-root error, also move `~/.delo/trust` aside and run step 4 again. The home then trusts only the keys that npm's launcher ships.
- If the new release cannot read your chats, move `sessions/` and `storages/` aside, put in the copy from `data-copies/<version>/`, and bring individual exported chats back with `delorun import`.

</details>

## Protections and plugins

- **`the profile default would boot without protections Delo requires`.** A setting in your profile turns off a protection, such as the sandbox or one of Delorun's guards. The refusal lists each one with the file that sets it. Remove those settings, or start without your plugins with `delorun recover safe-mode`.
- **`the profile default could not load Delo's bundle`** or **`plugins of Delo's bundles did not start`.** Delorun stops rather than start without its guards and privacy settings, because the profile would otherwise run with DeepSeek Harness's own defaults. The refusal names each package, the cause and the fix.
- **`the landlock sandbox cannot deny the sockets in "<directory>"`.** Your Linux system has no working bubblewrap, so commands would run under Landlock, which cannot hide the sockets of your login session, and Delorun refuses every sandboxed command while such a directory exists. If the refusal says to install bubblewrap, install the `bubblewrap` package and start again. If it says bubblewrap's check did not finish in time, your computer was busy when Delorun started: start it again. If it says bubblewrap is installed but could not create a sandbox, `delorun doctor` shows why on its `sandbox` line, or run `bwrap --ro-bind / / true` to see why; on Ubuntu the usual cause is its AppArmor restriction on user namespaces (`kernel.apparmor_restrict_unprivileged_userns`), which [a profile for `bwrap`](#letting-bubblewrap-run-under-ubuntus-apparmor-restriction) lifts for `bwrap` alone. Turning the restriction off for the whole system also works, but lowers its protection for every program.
- **`the sandbox row sets the runner itself`** or **`is configured with expressions`.** Delorun adds its home protection to the sandbox's settings at start, so those settings must leave the choice of sandbox to Delorun and use plain YAML values. Remove what the refusal names.
- **`delorun headless: … asks for full access in "<folder>", which you have not granted full access`.** A headless task asked to run outside the sandbox in a folder you have not put on full access. Open the folder as a workspace in the studio and choose Full access once, or run the task without full access.
- **`Delo could not use the Docker engine`.** Docker did not answer, or refused the request with the HTTP status the refusal names. Start Docker and run the command again.

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

"Delo could not read or change what Tailscale serves for remote access" comes with Tailscale's own code and message. [Reach the studio from your phone](reach.md) explains what remote access needs.

## Archives, imports and the trash

- **"Delo refused the archive and changed nothing."** `delorun import` checks an archive before it writes anything; the code names the entry it refused.
- **"Delo stopped at the stock DeepSeek Harness home import."** The import from `~/.dsh` was refused, or a start found an interrupted import it could not remove; the code and detail say which. [Switching from DeepSeek Harness](switching.md) explains the import.
- **`TRASH_ITEM_NOT_FOUND`.** The trash holds no item with that id; `delorun trash list` shows what it holds.

## When nothing here fits

Run `delorun doctor` to check Docker, the model key's format, the home, the studio's port, the release-log check and the last update check, and `delorun logs home` to read the running Delorun's recent records. [Where Delorun keeps its logs](logs.md) explains each log. A refusal that says "Report this" means Delorun found something it cannot explain: report it with the refusal's text: a suspected vulnerability privately, as [SECURITY.md](../../../SECURITY.md) describes, and anything else with the issue templates that [CONTRIBUTING.md](../../../CONTRIBUTING.md) names, or to support@delorun.com.

## For the technically curious

Each code belongs to a contract that defines when it is raised: the [home layout contract](../contracts/c01-home-layout.md) for the home and installs, the [home process contract](../contracts/c19-home-process.md) for starting, updates and devices, and the [update report contract](../contracts/c03-update-report.md) for the update report and rollback. The codes that protect your profile are listed in the [profile safety README](../../packages/profile-safety/README.md).
