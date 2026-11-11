---
description: "Your Delorun home: where delorun keeps your data, how to move it with DELO_HOME, profiles, why ~/.dsh stays untouched, and how to fix a home or secret file that other users can read."
---

# Your Delorun home

English | [中文](home.zh.md)

## Summary

Delorun keeps everything in one folder, your Delorun home: `~/.delo`, or `%USERPROFILE%\.delo` on Windows. Your chats, workspaces, profiles, keys and Delorun's own records all live there. `delorun` creates it the first time it runs and makes it readable by you alone. Back up that folder and you have backed up Delorun.

## Contents

- [Where the home is](#where-the-home-is)
- [The first run](#the-first-run)
- [Profiles](#profiles)
- [Your DeepSeek Harness home](#your-deepseek-harness-home)
- [Fixing permissions](#fixing-permissions)
- [For the technically curious](#for-the-technically-curious)

## Where the home is

To keep the home somewhere else, set `DELO_HOME`:

```sh
DELO_HOME=~/work/delo delorun
```

The path must be absolute or start with `~`. `delorun` refuses your home folder itself, the root of the filesystem, and DeepSeek Harness's home `~/.dsh` or any folder inside it, because each of those holds other things Delorun must not mix with its own. `delorun status` prints the home in use.

## The first run

The first `delorun` on a new home runs setup ([Install and first run](install.md)). After that, `delorun` starts Delorun in the background and opens the studio in your browser, unless you chose in setup to run it in the terminal. `delorun status` shows whether it runs, and `delorun stop` stops it once running chats finish, or at once with `delorun stop --now`. One Delorun runs per profile: a second start tells you it is already running. [Daily use](daily-use.md) lists every command.

## Profiles

A profile is one setup of Delorun: its plugins, their settings and its studio port. Most people need only the one setup creates, `default`. To use another, pass `--profile <name>` or set `DELO_PROFILE`:

```sh
delorun --profile work          # sets up the profile the first time, then starts it
delorun status --profile work   # other commands take --profile after their name
```

A profile name has 1 to 32 lowercase letters, digits, `-` or `_`. Delorun refuses `desktop`, kept for a desktop app's own profile, `headless`, which `delorun headless` uses, and Windows device names such as `con`. All profiles share your chats, workspaces and keys.

## Your DeepSeek Harness home

Delorun never changes or moves `~/.dsh`. It reads it only when you import from it ([Switching from DeepSeek Harness](switching.md)). If you set `DSH_HOME` for DeepSeek Harness, `delorun` ignores it and uses your Delorun home, and `delorun status` tells you so.

`delorun plugin` works as `dsh plugin` does, inside your Delorun home, and `delorun headless` answers one task as `dsh headless` does, with Delorun's sandbox protection and guards ([Daily use](daily-use.md#the-plugin-and-headless-commands)).

## Fixing permissions

On Linux, your home and Delorun's folders in it must be readable by you alone (mode 700), and its secret files too (mode 600). If another user could read one of them, Delorun refuses to use it and prints the command that fixes it:

```text
Delo stopped before using /home/you/.delo/secrets/home-auth/home-key.pem.
Why: SECRET_FILE_MODE: /home/you/.delo/secrets/home-auth/home-key.pem has mode 0640, which other users can read; it must be 0600
What you can do:
  Fix it with: chmod 600 /home/you/.delo/secrets/home-auth/home-key.pem
```

Run the printed `chmod` command, then run `delorun` again. Delorun never changes these permissions for you, so a mistake stays visible. A home, folder or secret file that is a symbolic link, or belongs to another user, is refused too, with no command to fix it: move it away and let `delorun` create it again. On Windows, Delorun does not check these permissions yet.

## For the technically curious

The [home layout contract](../contracts/c01-home-layout.md) lists every folder and file in the home, its required mode and the error codes; [Troubleshooting](troubleshooting.md#the-home-and-its-files) explains each code.
