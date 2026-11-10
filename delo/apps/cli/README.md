---
description: "The delorun command: its commands, how it prepares the ~/.delo home through @delo/home before upstream runs, selects the CLI profile, takes the home lock, hands a new home to setup and runs upstream's profile commands."
---

# @delo/cli

English | [中文](README.zh.md)

## Summary

This app is the `delorun` command. Before any upstream code runs, it resolves and prepares the Delo home through [`@delo/home`](../../packages/home/README.md), which implements [contract C1](../../docs/contracts/c01-home-layout.md)'s home, selects the CLI profile, and runs that profile through upstream's profile runner with the Delo home as `DSH_HOME`. A new home goes to setup's entry point first. A start runs the profile's home process of [`@delo/home-process`](../../packages/home-process/README.md) ([contract C19](../../docs/contracts/c19-home-process.md)), which holds the profile's home lock, so one home process runs per profile, and `stop` and `status` reach it through its update channel.

## Contents

- [Commands](#commands)
- [The home](#the-home)
- [Profiles](#profiles)
- [Setup](#setup)
- [The home process](#the-home-process)
- [How delorun runs upstream](#how-delorun-runs-upstream)
- [Extension points](#extension-points)
- [Not yet implemented](#not-yet-implemented)
- [Development](#development)

## Commands

| Command | What it does |
| --- | --- |
| `delorun [--profile <name>]` | Runs setup on a home without the CLI profile; otherwise starts the home process in this terminal and opens the studio |
| `delorun setup [<section>] [--profile <name>] [--yes \| --config <file>] [--check-key] [--list]` | Setup: Quick or Full in a terminal, or every default with `--yes`, or an answers document with `--config`; a finished setup is left unchanged. `<section>` runs one section again and `--list` lists them |
| `delorun start [--foreground] [--profile <name>]` | Starts the home process detached from the terminal and waits at most 120 seconds for it to report `running`; `--foreground` runs it in this terminal, and so does a start whose setup answers chose against the background. Neither opens the studio |
| `delorun stop [--now] [--profile <name>]` | Stops the home process once running chats end, waiting at most 1,800 seconds; `--now` cancels them first |
| `delorun status [--profile <name>] [--json]` | Prints the home, the profile, an inherited `DSH_HOME` that `delorun` ignored, and the home process's state, process id, start id, runtime versions, running chats and update in progress; `--json` prints its `status` answer alone |
| `delorun doctor [--port <n>]` | Checks the home, the Docker engine, the DeepSeek API key's format and the studio's port, one line per check; it contacts no model, starts no container and runs no command except the read-only `docker version` probe |
| `delorun trash list [--json] \| restore <id> \| purge <id> [--clear-logs] \| empty [--clear-logs] [--profile <name>]` | Lists the deleted chats and workspaces with the days each has left of its 30 in the trash, and every damaged item directory with its reason; restores a chat; deletes one or every item forever after a yes on the terminal, from the session generations, the projection cache, the attachments no other chat names, the spill files and the trash, naming each store it reached and how many shared attachments it kept. It states that fragments may remain in the operational logs for 14 days; `--clear-logs` clears every operational log of the home now, not only the item's records, and reports each log it could not clear. A workspace is restored in the studio's Trash section in Settings, which registers it again. `restore`, `purge` and `empty` run while holding the home lock of every profile, and are refused while any profile's home process runs ([contract C8](../../docs/contracts/c08-archive-and-trash.md)) |
| `delorun export <chat-or-workspace-id> --out <file> [--profile <name>]` | Writes one chat, or one workspace with its chats and the attachments they name, as an archive signed with the home key, `secrets/home-auth/home-key.pem`, which the first export creates. A secret found in the chat history is named by kind and chat, and nothing is written until the person says yes; the file is created new at mode 0600 and never replaces one. It reads the stores while holding the home lock of every profile, and is refused while any profile's home process runs |
| `delorun import <file> [--profile <name>]` | Checks the archive in full before anything is written, prints who signed it by the key's fingerprint before the fields the archive states about itself, each quoted with its control characters escaped, and imports after a yes. A signature that does not verify is refused; a key the home does not trust needs the fingerprint typed; an unsigned archive is imported only after `unverified` is typed. It reads files of at most 1 GiB and entries of at most 512 MiB, runs while holding the home lock of every profile, and first finishes an import a crash interrupted. The workspaces land under `archive/imported/` in the home, out of every model request; the studio does not open imported chats yet, and the customisation is listed and not applied |
| `delorun verify [--release <version>] [--offline] [--json]` | Checks the running release, or an installed one, and prints one line per registered check ([contract C15](../../docs/contracts/c15-verification-checks.md)): `passed`, `failed` or `not run`, with the reason. `release-signature` anchors `trust/root.json` on the roots the launcher that started it ships, named in `DELO_LAUNCHER_ROOTS`, through the chain an install walked, and checks its expiry; it then checks the stored manifest's signature, the freshness of `trust/timestamp.json` and the release-log bundle, and proves the log consistent online unless `--offline` ([contract C18](../../docs/contracts/c18-release-log.md)). Without the launcher's roots it holds the root to its own signatures only, says so, and leaves `release-signature` `not run`. `runtime-files` checks every installed file against the signed file list. The other registered checks are `not run`. It prints the trusted root's version and key, since when the release has stayed unchecked, and a summary that says it is not a full verification of Delo. It records the release-log state and the verified checkpoint under `trust/`, exits 1 when a check fails or `release-signature` falls short of a pass for any reason but an unreachable log, and exits 0 with a warning when the log cannot be reached. `--json` prints C15's report with the release, the root and the release-log record |
| `delorun plugin …` | Upstream's `dsh plugin …`, unchanged, against the Delo home |
| `delorun headless …` | Upstream's `dsh headless …`, unchanged, against the Delo home |
| `delorun --version [--json]` | Prints `Delo <delo>` and `DSH <dsh>`, the version of Delo and the version of the DSH it runs on; `--json` prints `{"delo":…,"dsh":…}` as one line. `-v` is the same as `--version` |

Exit codes: 0 done, 1 failed, 2 a wrong command line, 3 no home process runs for the profile (`status`). A failure prints one line on standard error that starts with C1's error code, such as `HOME_MODE`, and ends with the command that fixes it where one exists.

## The home

- **Resolution.** The home is `DELO_HOME` when it is set and not blank, otherwise `~/.delo`; `@delo/home` refuses the homes C1 forbids with `HOME_INVALID` or `HOME_IS_DSH_HOME`.
- **`DSH_HOME`.** `delorun` sets `DSH_HOME` and `DELO_HOME` to the home and `DELO_PROFILE` to the profile before any upstream code runs, so upstream, its `.env` layers and every child process use the Delo home. An inherited `DSH_HOME` is ignored, and `delorun status` names it.
- **`~/.dsh`.** `delorun` never reads, writes or migrates upstream's home.
- **`DELO_VERSION`.** Every invocation exports Delo's own version as `DELO_VERSION` before any upstream code runs, so the start preflight and the plugin manager check a plugin's `engines.delo` against this Delo ([contract C17](../../docs/contracts/c17-plugin-versions.md)); every child process inherits it. A plugin that requires a Delo this one is not, or whose `engines.delo` is not a range, is refused at install and disabled at start, and the message names both the Delo and the DSH version. A plugin that declares no `engines.delo` is unaffected.
- **The tree.** Every command except `status` creates the home's tree at mode 0700 with `ensureHomeTree` and stops with `HOME_MODE` and the fix `chmod 700 <path>` when the home, `secrets/` or `run/<profile>/` is laxer. `delorun` changes no mode itself.

## Profiles

The CLI profile is `default`, or the name `DELO_PROFILE` or `--profile` selects, under upstream's profile-name rules. The desktop app's `desktop` profile is refused in any letter case with the usage exit code, and `delorun plugin --profile desktop` is refused by upstream's own parser, so `delorun` never runs, initialises or changes `profiles/desktop/` or its lock. Setup's entry point creates the CLI profile with [`@delo/bundle-local`](../../packages/bundle-local/README.md)'s `DELO_PROFILE_BUNDLES`: upstream's `web` profile template, whose Web application serves the studio, followed by `@delo/bundle-local`. It then makes each Delo bundle importable as upstream makes its own bundles importable: a bundle that upstream's runtime resolution already supplies, as a released installation carries it beside upstream's packages, is left alone; one that only this `delorun` carries, as in a source checkout, is added with upstream's own `dsh plugin add link:<directory>` operation, which records it in the profile's `package.json` and installs it with pnpm.

A start loads the profile as upstream's boot does and refuses to boot it when a Delo bundle, any bundle in the `@delo/` scope, was skipped because it could not be resolved, read or accepted. Upstream would otherwise start with the remaining layers and its own defaults, which upload session logs to DeepSeek. The error names each skipped bundle with upstream's reason and its fix: in a source checkout, `delorun plugin --profile <name> add link:<directory>` for the bundle this `delorun` carries; otherwise reinstalling Delo or `delorun plugin --profile <name> install`. After the profile boots and its Loader settles, the start also checks every row a Delo bundle inserts and every row whose module is in the `@delo/` scope: when an enabled one did not activate, for example because it failed to import, `delorun` shuts the application down, releases the lock and exits 1, naming each row and its fix, below upstream's own warning with the cause. The Web application opens the studio in the browser when its Loader settles, so a refused start can leave a studio page open on a stopped server. A skipped upstream bundle and an inactive upstream row are reported as upstream reports them and do not stop the start.

## Setup

Setup ([`src/setup/`](src/setup/index.ts)) answers the questions of [contract C11](../../docs/contracts/c11-setup-answers.md) and writes the CLI profile. The three forms produce the same answers, and so the same writes:

- **The questions** need a terminal. The first screen asks for Quick (preselected) or Full. Quick asks the privacy note, the model key and the prompts question; Full adds the background and profile sections. Each question after the first can return to the one before it ("← Back" on a choice, an empty entry on a text or key question), and a review screen lists the answers before anything is written. A typed key is checked with one live request to the provider's origin before it is stored; a failed check says why and lets the person enter the key again or continue. The privacy note is [`@delo/bundle-local`](../../packages/bundle-local/README.md)'s, read from its `./statements` export. Setup no longer asks the four questions it only recorded (where commands run, the studio additions, help with other models, desktop analytics); the two upstream opt-ins stay off, and Settings → Privacy changes them.
- **`--yes`** takes every default and reads the model key from `DEEPSEEK_API_KEY`, and stops with an error that names the variable when it is unset. The key is not checked live unless `--check-key` is given.
- **`--config <file>`** reads an answers document. It refuses a document that enables reach, that carries a key setup no longer asks (the message names the removed keys), that carries a credential value in any field, or that names a schema version other than 2; a refusal names the field and never echoes a value.

Each topic is a section in the registry of [`src/setup/sections.ts`](src/setup/sections.ts): `privacy`, `key` and `prompts` run in both modes; `background` and `profile` run in Full only. `delorun setup <section>` runs one again on a profile that is set up, and `delorun setup --list` lists them. A later package adds its section with `SectionRegistry.register(section, { order })`; the `order` places it among the others, and the stock-home import will register between the privacy note and the key.

The prompts answer takes effect: "Safer prompts" and "Same as stock" write `config.enabled` of the rows `delo-permission-defaults`, `delo-instruction-consent`, `delo-mcp-consent` and `delo-schedule-consent` to the Delo default and the parity value of the matching switch in contract C16's registry. The fetch guard is a refusal, not a prompt, and stays on.

Setup runs its steps in order: create the CLI profile (under the name the profile section chose), then each section's writes (the typed key into upstream's `.credentials.yaml` at mode 0600, the prompts rows, the studio port row) into the profile's `cordis.patch.yml`. While a run is unfinished, `run/<profile>/setup-progress.json` holds the answers without any key and the steps that finished, so an interrupted run resumes at the first step that did not finish. When every step has finished, setup removes that file and writes the answers, including which sections were seen, answered or skipped, to `profiles/<profile>/setup-answers.json`, which the studio's onboarding and the start commands read; [`readBackgroundAnswer`](src/setup/background.ts) returns the background answer. Reach and credential forwarding are recorded as off until their sections exist.

A terminal run ends in [`src/setup/ending.ts`](src/setup/ending.ts): it offers `npm install -g delorun`, starts Delorun in the background or in the terminal as the background answer says, and opens the studio, or prints the address and an SSH port-forward line when the computer has no display or the terminal is an SSH session. It prints that Delorun keeps running after the terminal closes, the address, and `delorun status`, `delorun logs --follow` and `delorun stop`. `--yes` and `--config` start nothing and print the command to run.

## The home process

`delorun start --foreground` and a bare `delorun` run the home process in this process with `HomeProcess.start`: it takes `run/<profile>/home.lock`, writes a new start token, listens on the update channel `run/<profile>/update.sock` and boots the profile through upstream's profile runner as its Host. It logs to the `home-<profile>` operational log, and in the foreground the terminal also shows its output. Of any number of starts, exactly one holds the lock, including over the lock of a holder that died. A live holder is asked for its status over the update channel: when it answers, a second start prints the running process and exits 0; when it does not answer within 2 seconds, the start stops with `HOME_UNRESPONSIVE`. Whatever ends the process, the lock, the token file and the socket go with it; a process killed with `SIGKILL` leaves them, and the next start replaces them.

The start boots the profile with C1's confinement on upstream's local sandbox provider (row `sandbox`): `protectedHome` is the canonical Delo home, `protectedHomeReadable` C1's read exemptions, and `deniedSockets` the update channel's and the supervisor's sockets under `run/<profile>/` the active Docker context's socket with its real path, and Docker Desktop's macOS sockets under `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/` when present, so a confined workspace command cannot read the home or the token or connect to either channel where the dialect enforces those rules. The settings travel in an overlay patch, `run/<profile>/sandbox.patch.yml` at mode 0600, which exists while the Host runs; the row's other settings in the profile's own patch are kept, its own denied sockets included, and a start refuses that row's settings when they are expressions it cannot carry over.

`delorun start` without `--foreground` starts `delorun start --foreground` detached from the terminal, with standard input closed and its output in its log, and waits at most 120 seconds for the home process to report `running`; a home process that exits first or does not report `running` in time is reported with its log's location. `delorun stop` and `delorun status` read the token file and send `stop` or `status` over the update channel; with no live lock holder, `stop` prints that Delo is not running and exits 0, and `status` exits 3.

This build has no runtime store yet, so its home process refuses update requests, and its Host counts no running chats, so `stop` does not wait for one ([the home process's seams](../../packages/home-process/README.md#seams-for-other-packages)).

## How delorun runs upstream

`delorun` launches applications only through upstream's profile runner, as the root `AGENTS.md` requires. A start calls upstream's `runProfile` from `@deepseek-ai/dsh/profile-boot` with the CLI profile, as the desktop Host does for its profile, and `plugin` and `headless` call upstream's `runCli` with its `argv` option set to the arguments `dsh` would receive. That option is Delo's one change to upstream for this command, recorded as a `generic-fix` in the divergence ledger; upstream already resolves its home from `DSH_HOME`, so the home needs no change.

## Extension points

- **A command** is a module that exports one `CliCommand` (`src/command.ts`) and adds one row to `COMMANDS` in `src/main.ts`. `delorun doctor` belongs in `src/doctor/` and `delorun logs` in `src/logs/`, each through this row.
- **`delorun doctor` key lookup.** The key is read in this order, and the first source that holds one is checked: the reference setup stored in the home's `.credentials.yaml`, the `DEEPSEEK_API_KEY` process environment variable, the invoking directory's `.env`, then the home's `.env`. The check reports the source's name only and never prints the key; it checks the format offline and does not send the key to DeepSeek.
- **Setup** is `runSetup` in `src/setup/index.ts`, which both `delorun setup` and a first run call. Its sections are in `src/setup/sections.ts` and the step runner with the way back is `src/setup/steps.ts`, behind the `Prompter` interface of `src/setup/prompts.ts`, so a test runs them against a scripted prompter.
- **The home process's dependencies** are `StartDependencies` in `src/start.ts`: the profile preparation and runner, the environment loader, the holder probe (the update channel's `status` request), the exit hooks and the output capture, so a spec runs a start against stand-ins.

## Not yet implemented

- Start at login (`delorun start --at-login`, `delorun stop --at-login`), `delorun status --follow`, the runtime store's updates and the Host's chat gate ([the home process's seams](../../packages/home-process/README.md#seams-for-other-packages)), and the confinement probes of the start sequence.
- Setup's reach question and the import of a stock DeepSeek Harness home. Setup records reach as off.
- The Windows DACL check ([#48](https://github.com/Delo-Run/delo/issues/48)): on Windows the directory and protected-file checks look only at the file type.
- `delorun update`, `reach`, `devices` and `dev`.
- Opening imported chats in the studio.
- `delorun verify --mode`, and every registered check but `release-signature` and `runtime-files`. `delorun verify` reports the default mode, `warn`, because nothing reads `integrity.mode` yet.

## Development

Run `delorun` from a checkout with `pnpm --filter @delo/cli delorun <command>`; it needs `pnpm run build:artifacts` and `pnpm --filter @delo/bundle-local run build` first, because upstream's build does not build Delo's packages; setup links the bundle into the CLI profile. The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/apps/cli`, and the app typechecks with `node_modules/.bin/tsc --noEmit -p delo/apps/cli/tsconfig.json`. The specs use temporary OS homes and never touch the real `~/.delo` or `~/.dsh`.
