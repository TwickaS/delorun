---
description: "Your Delo home: where delorun keeps your data, how to move it with DELO_HOME, the CLI profile, why ~/.dsh stays untouched, and how to fix a home or secret file that other users can read."
---

# Your Delo home

English | [中文](home.zh.md)

## Summary

Delo keeps everything it knows about you in one directory, your home: `~/.delo`, or `%USERPROFILE%\.delo` on Windows. Your profiles, sessions, workspaces, credentials and Delo's own keys and records all live there. The `delorun` command creates the home the first time it runs and sets it up so that only you can open it.

## Contents

- [Where the home is](#where-the-home-is)
- [The first run](#the-first-run)
- [Profiles](#profiles)
- [Your DeepSeek Harness home](#your-deepseek-harness-home)
- [Fixing permissions](#fixing-permissions)

## Where the home is

Set `DELO_HOME` to keep the home somewhere else, such as `DELO_HOME=~/work/delo delorun`. The path must be absolute or start with `~`. `delorun` refuses your home directory itself, the filesystem root, and DeepSeek Harness's own home `~/.dsh` or any directory inside it. `delorun status` prints the home it uses.

## The first run

The first `delorun` on a new home runs setup, which creates the CLI profile. After that, `delorun` starts Delo in the background and opens the studio in your browser, unless you chose in setup to run it in the terminal. `delorun status` shows whether Delo runs, its process and the runtime version, and `delorun stop` stops it once running chats end, or at once with `delorun stop --now`. Only one Delo runs per profile: a second start says that one is already running. [Daily use](daily-use.md) lists every command.

## Profiles

The command line uses the profile `default`. Set `DELO_PROFILE`, or pass `--profile <name>`, to use another one. A profile name has 1 to 32 lowercase letters, digits, `-` or `_`. The names `desktop`, reserved for a desktop app's own profile, and `headless`, which `delorun headless` uses, are refused, and so are Windows device names such as `con`. All profiles share your sessions, workspaces and credentials.

## Your DeepSeek Harness home

Delo never changes or moves `~/.dsh`, and reads it only when you import it ([Switching from DeepSeek Harness](switching.md)). If you set `DSH_HOME` for DeepSeek Harness, `delorun` ignores it and uses your Delo home, and `delorun status` tells you so. `delorun plugin` works as `dsh plugin` does, inside your Delo home, and `delorun headless` answers one task as `dsh headless` does, with Delo's sandbox protection and guards ([Daily use](daily-use.md#the-plugin-and-headless-commands)).

## Fixing permissions

Your home and Delo's folders in it are readable only by you (mode 700), and Delo's secret files only by you (mode 600). If another user could read one of them, Delo refuses to use it and prints the command that fixes it, for example:

```text
Delo stopped before using /home/you/.delo/secrets/home-auth/home-key.pem.
Why: SECRET_FILE_MODE: /home/you/.delo/secrets/home-auth/home-key.pem has mode 0640, which other users can read; it must be 0600
What you can do:
  Fix it with: chmod 600 /home/you/.delo/secrets/home-auth/home-key.pem
```

Run the printed `chmod 700` or `chmod 600` command, then run `delorun` again. A home, private folder or secret file that is a symbolic link or belongs to another user is refused too, without a command to fix it: move it away and let `delorun` create it again. Delo never changes these permissions for you. On Windows, Delo does not check them yet.
