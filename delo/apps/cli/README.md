---
description: "The delorun command: its commands, how it prepares the ~/.delo home through @delo/home before upstream runs, selects the CLI profile, takes the home lock, hands a new home to setup and runs upstream's profile commands."
---

# @delo/cli

English | [中文](README.zh.md)

## Summary

This app is the `delorun` command. Before any upstream code runs, it resolves and prepares the Delo home through [`@delo/home`](../../packages/home/README.md), which implements [contract C1](../../docs/contracts/c01-home-layout.md)'s home, selects the CLI profile, and runs that profile through upstream's profile runner with the Delo home as `DSH_HOME`. A new home goes to setup's entry point first. A start takes the profile's home lock, so one home process runs per profile.

## Contents

- [Commands](#commands)
- [The home](#the-home)
- [Profiles](#profiles)
- [Setup](#setup)
- [The home lock](#the-home-lock)
- [How delorun runs upstream](#how-delorun-runs-upstream)
- [Extension points](#extension-points)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Commands

| Command | What it does |
| --- | --- |
| `delorun [--profile <name>]` | Runs setup on a home without the CLI profile; otherwise starts the home process in this terminal and opens the studio |
| `delorun setup [--profile <name>] [--yes \| --config <file>]` | Setup: asks its questions in a terminal, or applies every default with `--yes`, or an answers document with `--config`; a finished setup is left unchanged |
| `delorun start --foreground [--profile <name>]` | Starts the home process in this terminal without opening the studio |
| `delorun status [--profile <name>]` | Prints the home, the profile, whether its home process runs, and an inherited `DSH_HOME` that `delorun` ignored |
| `delorun plugin …` | Upstream's `dsh plugin …`, unchanged, against the Delo home |
| `delorun headless …` | Upstream's `dsh headless …`, unchanged, against the Delo home |

Exit codes: 0 done, 1 failed, 2 a wrong command line, 3 no home process runs for the profile (`status`). A failure prints one line on standard error that starts with C1's error code, such as `HOME_MODE`, and ends with the command that fixes it where one exists.

## The home

- **Resolution.** The home is `DELO_HOME` when it is set and not blank, otherwise `~/.delo`; `@delo/home` refuses the homes C1 forbids with `HOME_INVALID` or `HOME_IS_DSH_HOME`.
- **`DSH_HOME`.** `delorun` sets `DSH_HOME` and `DELO_HOME` to the home and `DELO_PROFILE` to the profile before any upstream code runs, so upstream, its `.env` layers and every child process use the Delo home. An inherited `DSH_HOME` is ignored, and `delorun status` names it.
- **`~/.dsh`.** `delorun` never reads, writes or migrates upstream's home.
- **The tree.** Every command except `status` creates the home's tree at mode 0700 with `ensureHomeTree` and stops with `HOME_MODE` and the fix `chmod 700 <path>` when the home, `secrets/` or `run/<profile>/` is laxer. `delorun` changes no mode itself.

## Profiles

The CLI profile is `default`, or the name `DELO_PROFILE` or `--profile` selects, under upstream's profile-name rules. The desktop app's `desktop` profile is refused in any letter case with the usage exit code, and `delorun plugin --profile desktop` is refused by upstream's own parser, so `delorun` never runs, initialises or changes `profiles/desktop/` or its lock. Setup's entry point creates the CLI profile with [`@delo/bundle-local`](../../packages/bundle-local/README.md)'s `DELO_PROFILE_BUNDLES`: upstream's `web` profile template, whose Web application serves the studio, followed by `@delo/bundle-local`. It then makes each Delo bundle importable as upstream makes its own bundles importable: a bundle that upstream's runtime resolution already supplies, as a released installation carries it beside upstream's packages, is left alone; one that only this `delorun` carries, as in a source checkout, is added with upstream's own `dsh plugin add link:<directory>` operation, which records it in the profile's `package.json` and installs it with pnpm.

A start loads the profile as upstream's boot does and refuses to boot it when a Delo bundle, any bundle in the `@delo/` scope, was skipped because it could not be resolved, read or accepted. Upstream would otherwise start with the remaining layers and its own defaults, which upload session logs to DeepSeek. The error names each skipped bundle with upstream's reason and its fix: in a source checkout, `delorun plugin --profile <name> add link:<directory>` for the bundle this `delorun` carries; otherwise reinstalling Delo or `delorun plugin --profile <name> install`. After the profile boots and its Loader settles, the start also checks every row a Delo bundle inserts and every row whose module is in the `@delo/` scope: when an enabled one did not activate, for example because it failed to import, `delorun` shuts the application down, releases the lock and exits 1, naming each row and its fix, below upstream's own warning with the cause. The Web application opens the studio in the browser when its Loader settles, so a refused start can leave a studio page open on a stopped server. A skipped upstream bundle and an inactive upstream row are reported as upstream reports them and do not stop the start.

## Setup

Setup ([`src/setup/`](src/setup/index.ts)) answers the questions of [contract C11](../../docs/contracts/c11-setup-answers.md) and writes the CLI profile. The three forms produce the same answers, and so the same writes:

- **The questions** need a terminal. Setup states that Delo has no telemetry of its own and that both upstream opt-ins, desktop analytics and DeepSeek's session-log upload, are off unless the person turns them on; it shows what each sends before the question. The statements are [`@delo/bundle-local`](../../packages/bundle-local/README.md)'s, read from its `./statements` export.
- **`--yes`** takes every default and reads the model key from `DEEPSEEK_API_KEY`, and stops with an error that names the variable when it is unset.
- **`--config <file>`** reads an answers document. It refuses a document that enables reach or an upstream opt-in, that carries a credential value in any field, or that names a schema version other than 1; a refusal names the field and never echoes a value.

Setup runs its steps in order: create the CLI profile, store a typed key in upstream's `.credentials.yaml` at mode 0600 (a key read from the environment is stored nowhere), write the session-log row to the profile's `cordis.patch.yml`, and record the desktop analytics answer. While a run is unfinished, `run/<profile>/setup-progress.json` holds the answers without any key and the steps that finished, so an interrupted run resumes at the first step that did not finish. When every step has finished, setup removes that file and writes the answers to `profiles/<profile>/setup-answers.json`, which the screens that apply them read. Reach and credential forwarding are recorded as off until their screens exist.

The Docker runtime option carries C1's label on a system whose sandbox dialect cannot enforce `docker-connect`: Landlock, Windows and a system without a sandbox.

Desktop analytics is recorded, not written. Setup records the answer and writes no row to the desktop app's profile, because desktop packaging is outside the MVP and the desktop app keeps upstream's own profile; the desktop app applies the recorded answer once it composes Delo's bundle. A spec pins this behaviour. Also not written by setup yet: the model selection, the studio additions, the onboarding flag and the runtime, whose targets arrive with their own packages. Setup records each of those answers in the answers record.

## The home lock

A start takes `run/<profile>/home.lock` with `@delo/home`'s `acquireHomeLock` before it boots the profile, and releases it when the process exits. Of any number of starts, exactly one holds the lock, including over the lock of a holder that died. A live holder is never taken over, and a second start prints the running process and exits 0, as C19's `delorun start` does. A process killed with `SIGKILL` leaves the lock, and the next start replaces it. Until the update channel exists, a live holder cannot be asked for its status and counts as answering, so `HOME_UNRESPONSIVE` is not reported.

## How delorun runs upstream

`delorun` launches applications only through upstream's profile runner, as the root `AGENTS.md` requires. A start calls upstream's `runProfile` from `@deepseek-ai/dsh/profile-boot` with the CLI profile, as the desktop Host does for its profile, and `plugin` and `headless` call upstream's `runCli` with its `argv` option set to the arguments `dsh` would receive. That option is Delo's one change to upstream for this command, recorded as a `generic-fix` in the divergence ledger; upstream already resolves its home from `DSH_HOME`, so the home needs no change.

## Extension points

- **A command** is a module that exports one `CliCommand` (`src/command.ts`) and adds one row to `COMMANDS` in `src/main.ts`. `delorun doctor` belongs in `src/doctor/` and `delorun logs` in `src/logs/`, each through this row.
- **Setup** is `runSetup` in `src/setup/index.ts`, which both `delorun setup` and a first run call. Its questions are in `src/setup/interactive.ts` behind the `Prompter` interface of `src/setup/prompts.ts`, so a test runs them against a scripted prompter.
- **The holder probe** is the `probe` of `StartDependencies` in `src/start.ts`; the home process's `status` request replaces the probe that counts a live holder as answering.

## Not yet implemented

- `delorun start` without `--foreground`, `delorun stop`, and the parts of `delorun status` that come from the home process: the background home process, its update channel, start token and confinement probes.
- Setup's reach question and the import of a stock DeepSeek Harness home. Setup records reach as off.
- The Windows DACL check ([#48](https://github.com/Delo-Run/delo/issues/48)): on Windows the directory and protected-file checks look only at the file type.
- `delorun --version`, `verify`, `doctor`, `logs`, `update`, `recover`, `reach`, `devices`, `export`, `import` and `dev`.

## Development

Run `delorun` from a checkout with `pnpm --filter @delo/cli delorun <command>`; it needs `pnpm run build:artifacts` and `pnpm --filter @delo/bundle-local run build` first, because upstream's build does not build Delo's packages; setup links the bundle into the CLI profile. The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli`, and the app typechecks with `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json`. The specs use temporary OS homes and never touch the real `~/.delo` or `~/.dsh`.
