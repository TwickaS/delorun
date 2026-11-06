---
description: "The delorun command: how it resolves and creates the ~/.delo home at contract C1's modes, refuses laxer files, selects the CLI profile, takes the home lock, hands a new home to setup and runs upstream's profile commands."
---

# @delo/cli

English | [中文](README.zh.md)

## Summary

This app is the `delorun` command. It resolves the Delo home, creates it and Delo's entries in it at mode 0700, refuses a home or protected file that other users can reach, selects the CLI profile, and runs that profile through upstream's profile runner with the Delo home as `DSH_HOME`. A new home goes to setup's entry point first. A start takes the profile's home lock, so one home process runs per profile. [Contract C1](../../docs/contracts/c01-home-layout.md) defines the home, and the [`@delo/contract-home-layout`](../../packages/contract-home-layout/README.md) package carries its names and limits.

## Contents

- [Commands](#commands)
- [The home](#the-home)
- [Profiles](#profiles)
- [The home lock](#the-home-lock)
- [How delorun runs upstream](#how-delorun-runs-upstream)
- [Extension points](#extension-points)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Commands

| Command | What it does |
| --- | --- |
| `delorun [--profile <name>]` | Runs setup on a home without the CLI profile; otherwise starts the home process in this terminal and opens the studio |
| `delorun setup [--profile <name>]` | Setup's entry point: creates the CLI profile and leaves an existing one unchanged |
| `delorun start --foreground [--profile <name>]` | Starts the home process in this terminal without opening the studio |
| `delorun status [--profile <name>]` | Prints the home, the profile, whether its home process runs, and an inherited `DSH_HOME` that `delorun` ignored |
| `delorun plugin …` | Upstream's `dsh plugin …`, unchanged, against the Delo home |
| `delorun headless …` | Upstream's `dsh headless …`, unchanged, against the Delo home |

Exit codes: 0 done, 1 failed, 2 a wrong command line, 3 no home process runs for the profile (`status`). A failure prints one line on standard error that starts with C1's error code, such as `HOME_MODE`, and ends with the command that fixes it where one exists.

## The home

- **Resolution.** The home is `DELO_HOME` when it is set and not blank, otherwise `~/.delo` (`%USERPROFILE%\.delo` on Windows). A leading `~` expands to the OS home directory. A relative path, the filesystem root and the OS home directory are refused with `HOME_INVALID`; upstream's `~/.dsh`, a path inside it and a link to either are refused with `HOME_IS_DSH_HOME`.
- **`DSH_HOME`.** `delorun` sets `DSH_HOME` and `DELO_HOME` to the home and `DELO_PROFILE` to the profile before any upstream code runs, so upstream, its `.env` layers and every child process use the Delo home. An inherited `DSH_HOME` is ignored, and `delorun status` names it.
- **`~/.dsh`.** `delorun` never reads, writes or migrates upstream's home.
- **The tree.** Every command except `status` creates the home and Delo's top-level entries (`runtimes/`, `staging/`, `trust/`, `status/`, `catalogue/`, `secrets/`, `run/`, `supervisor/`, `bin/`, `alerts/`) and `run/<profile>/` at mode 0700 through `mkdir` with that mode, so the umask can only narrow it. Upstream's entries, such as `profiles/` and `sessions/`, keep upstream's layout and modes.
- **Directory refusal.** The home, `secrets/` and `run/<profile>/` are refused with `HOME_MODE` when one is a symbolic link, another user's, or has a group or other bit set; the message names the path and the fix `chmod 700 <path>`. `delorun` changes no mode itself.
- **Protected files.** `writeProtectedFile` writes a file at mode 0600 through a sibling temporary file created exclusively at that mode, then renames it over the path. `readProtectedFile` refuses, with `SECRET_FILE_MODE`, a file that is a symbolic link, not a regular file, another user's, or has a group or other bit set, and names the fix `chmod 600 <path>`; it checks the path before opening it and the opened file again, so a file swapped in between is refused. Components that keep files under `secrets/`, `trust/`, `status/` and `catalogue/` use these two functions from `src/home/protected-file.ts`.

## Profiles

The CLI profile is `default`, or the name `DELO_PROFILE` or `--profile` selects, under upstream's profile-name rules. The desktop app's `desktop` profile is refused in any letter case with the usage exit code, and `delorun plugin --profile desktop` is refused by upstream's own parser, so `delorun` never runs, initialises or changes `profiles/desktop/` or its lock. Setup's entry point creates the CLI profile from upstream's `web` profile template, whose Web application serves the studio.

## The home lock

A start takes `run/<profile>/home.lock` before it boots the profile and holds it until the process exits. The lock holds C1's JSON record (`v`, `pid`, `startId`, `runtime`, `startedAt`) at mode 0600. The record is written to a temporary file and hard-linked to the lock path, so the lock appears whole or not at all, and of two starts exactly one link succeeds. A lock whose process no longer exists is moved aside and replaced; a live holder is never taken over, and a second start prints the running process and exits 0, as C19's `delorun start` does. The process removes the lock on exit when it still holds its own record. A process killed with `SIGKILL` leaves the lock, and the next start replaces it.

Until the update channel exists, a live holder cannot be asked for its status and counts as answering, so `HOME_UNRESPONSIVE` is not reported; `acquireHomeLock` takes the probe that decides between `HOME_RUNNING` and `HOME_UNRESPONSIVE` as a parameter. When three starts of one profile race over a stale lock within the same few system calls, the one whose new lock another moved aside can keep running without a lock file.

## How delorun runs upstream

`delorun` launches applications only through upstream's profile runner, as the root `AGENTS.md` requires. A start calls upstream's `runProfile` from `@deepseek-ai/dsh/profile-boot` with the CLI profile, as the desktop Host does for its profile, and `plugin` and `headless` call upstream's `runCli` with the same arguments `dsh` would receive. No upstream file is changed for the home: upstream already resolves its home from `DSH_HOME`.

## Extension points

- **A command** is a module that exports one `CliCommand` (`src/command.ts`) and adds one row to `COMMANDS` in `src/main.ts`. `delorun doctor` belongs in `src/doctor/` and `delorun logs` in `src/logs/`, each through this row.
- **Setup** is `runSetup` in `src/setup/index.ts`, which both `delorun setup` and a first run call. The setup screen replaces its body and keeps its signature.
- **The holder probe** is the `probe` of `StartDependencies` in `src/start.ts`; the home process's `status` request replaces the probe that counts a live holder as answering.

## Not yet implemented

- `delorun start` without `--foreground`, `delorun stop`, and the parts of `delorun status` that come from the home process: the background home process, its update channel, start token and confinement probes.
- Setup's questions: setup's entry point only creates the CLI profile.
- The Windows DACL check: on Windows the directory and protected-file checks look only at the file type.
- `delorun --version`, `verify`, `doctor`, `logs`, `update`, `recover`, `reach`, `devices`, `export`, `import` and `dev`.

## Development

Run `delorun` from a checkout with `pnpm --filter @delo/cli delorun <command>`; it needs `pnpm run build:artifacts` first. The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli`, and the app typechecks with `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json`. The specs use temporary OS homes and never touch the real `~/.delo` or `~/.dsh`.
