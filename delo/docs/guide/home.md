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

The first `delorun` on a new home runs setup, which creates the CLI profile. After that, `delorun` starts Delo in your terminal and opens the studio in your browser; press Ctrl-C to stop it. `delorun start --foreground` starts it without opening the browser. Only one Delo runs per profile: a second start says that one is already running.

## Profiles

The command line uses the profile `default`. Set `DELO_PROFILE`, or pass `--profile <name>`, to use another one. The desktop app keeps its own profile, `desktop`, which `delorun` refuses to run or change. Both share your sessions, workspaces and credentials.

## Your DeepSeek Harness home

Delo never reads, changes or moves `~/.dsh`. If you set `DSH_HOME` for DeepSeek Harness, `delorun` ignores it and uses your Delo home, and `delorun status` tells you so. `delorun plugin` and `delorun headless` work as `dsh plugin` and `dsh headless` do, inside your Delo home.

## Fixing permissions

Your home and Delo's folders in it are readable only by you (mode 700), and Delo's secret files only by you (mode 600). If another user could read one of them, Delo refuses to use it and prints the command that fixes it, for example:

```text
delorun: SECRET_FILE_MODE: /home/you/.delo/secrets/home-auth/device.key has mode 0640, which other users can read; it must be 0600; fix it with: chmod 600 /home/you/.delo/secrets/home-auth/device.key
```

Run the printed `chmod 700` or `chmod 600` command, then run `delorun` again. Delo never changes these permissions for you. On Windows, Delo does not check them yet.
