---
description: "Your Delorun home: where delorun keeps your data, how to move it with DELORUN_HOME, profiles, why ~/.dsh stays untouched, and how to fix a home or secret file that other users can read."
---

# Your Delorun home

English | [中文](home.zh.md)

## Summary

This page tells you where Delorun keeps your data, how to move it, how profiles work, and what to do when Delorun refuses a file because other users can read it. You need nothing first; `delorun` creates the folder the first time it runs ([Install and first run](../get-started/install.md)). Delorun keeps everything in one folder, your [Delorun home](../../reference/glossary.md#home): `~/.delorun`. Your chats, workspaces, profiles, keys and Delorun's own records all live there. `delorun` creates it the first time it runs and makes it readable by you alone. Back up that folder and you have backed up Delorun.

## Contents

- [Where the home is](#where-the-home-is)
- [The first run](#the-first-run)
- [Profiles](#profiles)
- [Your DeepSeek Harness home](#your-deepseek-harness-home)
- [Fixing permissions](#fixing-permissions)
- [Next](#next)
- [For the technically curious](#for-the-technically-curious)

## Where the home is

To keep the home somewhere else, set `DELORUN_HOME`:

```sh
DELORUN_HOME=~/work/delorun delorun
```

The path must be absolute or start with `~`. `delorun` refuses your home folder itself, the root of the filesystem, and DeepSeek Harness's home `~/.dsh` or any folder inside it, because each of those holds other things Delorun must not mix with its own. `delorun status` prints the home in use.

## The first run

The first `delorun` on a new home runs setup ([Install and first run](../get-started/install.md)). After that, `delorun` starts Delorun in the background and opens the studio in your browser, unless you chose in setup to run it in the terminal. `delorun status` shows whether it runs, and `delorun stop` stops it once running chats finish, or at once with `delorun stop --now`. One Delorun runs per profile: a second start tells you it is already running. [Daily use](../everyday-use/daily-use.md) lists every command.

## Profiles

A [profile](../../reference/glossary.md#profile) is one setup of Delorun: its plugins, their settings and its studio port. Most people need only the one setup creates, `default`. To use another, pass `--profile <name>` or set `DELORUN_PROFILE`:

```sh
delorun --profile work          # sets up the profile the first time, then starts it
delorun status --profile work   # other commands take --profile after their name
```

A profile name has 1 to 32 lowercase letters, digits, `-` or `_`, and starts with a letter or a digit. Delorun refuses `desktop`, kept for a desktop app's own profile, and `headless`, which `delorun headless` uses. All profiles share your chats, workspaces and keys.

## Your DeepSeek Harness home

This section matters only if you used DeepSeek Harness, the program Delorun is built on, before. Delorun never changes or moves `~/.dsh`, the folder where DeepSeek Harness keeps its data. It reads it only when you import from it ([Switching from DeepSeek Harness](../get-started/switching.md)). If you set `DSH_HOME` for DeepSeek Harness, `delorun` ignores it and uses your Delorun home, and `delorun status` tells you so.

`delorun plugin` works as `dsh plugin` does, inside your Delorun home, and `delorun headless` answers one task as `dsh headless` does, with Delorun's sandbox protection and guards ([Daily use](../everyday-use/daily-use.md#the-plugin-and-headless-commands)).

## Fixing permissions

On Linux, your home and Delorun's folders in it must be readable by you alone (mode 700), and its secret files too (mode 600). If another user could read one of them, Delorun refuses to use it and prints the command that fixes it:

```text
Delorun stopped before using /home/you/.delorun/secrets/home-auth/home-key.pem.
Why: SECRET_FILE_MODE: /home/you/.delorun/secrets/home-auth/home-key.pem has mode 0640, which other users can read; it must be 0600
What you can do:
  Fix it with: chmod 600 /home/you/.delorun/secrets/home-auth/home-key.pem
```

Run the printed `chmod` command, then run `delorun` again. Delorun never changes these permissions for you, so a mistake stays visible. A home, folder or secret file that is a symbolic link, or belongs to another user, is refused too, with no command to fix it: move it away and let `delorun` create it again.

<details>
<summary>Edge cases</summary>

- If a profile name uses capitals, spaces, a first character other than a letter or digit, or more than 32 characters, or is `desktop` or `headless`, then `delorun` refuses it.
- If another user can read your home or a secret file, then Delorun refuses to use it and prints the `chmod` command that fixes it ([Fixing permissions](#fixing-permissions)).
- If a file or folder in the home is a symbolic link or belongs to another user, then Delorun refuses it with no command to fix it. Move it away and let `delorun` create it again.
- If two commands change the home at once, then the second refuses with `another process … holds the home lock`. Wait, then run it again ([Starting and stopping](../help/troubleshooting.md#starting-and-stopping)).

</details>

<details>
<summary>Go further</summary>

- Keep a work setup apart from a personal one: `delorun --profile work`. Profiles share chats, workspaces and keys but keep their own plugins, settings and port.
- Keep the whole home somewhere else, such as a larger disk: `DELORUN_HOME=~/work/delorun delorun`.
- Back up Delorun by copying the home folder while Delorun is stopped (`delorun stop`).
- Move single chats or workspaces between homes with `delorun export` and `delorun import` ([Daily use](../everyday-use/daily-use.md#trash-export-and-import)).

</details>

## Next

- Start and stop Delorun: [Daily use](../everyday-use/daily-use.md).
- Read where logs live: [Where Delorun keeps its logs](../help/logs.md).
- If a file was refused: [The home and its files](../help/troubleshooting.md#the-home-and-its-files).

## For the technically curious

The [home layout contract](../../contracts/c01-home-layout.md) lists every folder and file in the home, its required mode and the error codes; [Troubleshooting](../help/troubleshooting.md#the-home-and-its-files) explains each code.
