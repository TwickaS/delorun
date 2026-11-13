---
description: "Writing a Delo plugin from nothing to running: delorun plugin new, the dev loop with delorun plugin dev, checking version ranges, installing from a folder, git or npm, build approvals, logs, the debugger, safe mode, and why a fork of a shipped package needs its own name."
---

# Write a plugin for Delo

English

Delo has no release yet; this page describes the first release.

## Summary

Everything Delo does is a plugin, and you can add your own: a tool the agent calls, an agent preset, a panel in the studio, or a bundle that changes how other plugins are set up. `delorun plugin new` writes a working package, `delorun plugin dev` loads it into your running studio and reloads it each time you save, `delorun plugin check` says which Delo and DeepSeek Harness versions it runs on, and `delorun plugin add` installs it for good. A plugin runs inside Delo with your access, outside the sandbox Delo runs the agent's commands in, so install only plugins whose code you trust. To decide whether a plugin is the right tool for your change, see [Where to customise what](customise.md).

## Contents

- [Before you start](#before-you-start)
- [Create a plugin](#create-a-plugin)
- [Run it while you work on it](#run-it-while-you-work-on-it)
- [Check its versions](#check-its-versions)
- [Install it](#install-it)
- [Builds pnpm refuses](#builds-pnpm-refuses)
- [When it does not load](#when-it-does-not-load)
- [Attach a debugger](#attach-a-debugger)
- [Overlays for one start](#overlays-for-one-start)
- [Forking a plugin Delo ships](#forking-a-plugin-delo-ships)

## Before you start

You need a set-up Delo (`delorun setup`), Node.js 24 and pnpm to build TypeScript. Every `delorun plugin` command works on your CLI profile, `default` unless you set `DELO_PROFILE` or pass `--profile <name>`. A plugin is an npm package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; its `cordis.patch.yml` inserts the plugin's rows into your profile. DeepSeek Harness's tutorials explain the plugin model itself: [your first plugin](../../../docs/user/develop/basic/index.md), [a tool](../../../docs/user/develop/basic/tool.md), [configuration](../../../docs/user/develop/basic/config.md) and [packaging](../../../docs/user/develop/basic/publish.md). Delo runs those plugins unchanged.

## Create a plugin

```text
delorun plugin new my-plugin --kind tool
cd my-plugin
pnpm install
pnpm run build
```

`--kind` chooses the example the package starts from:

| Kind | What it adds |
| --- | --- |
| `tool` (the default) | A `greet` tool the agent can call, written in TypeScript with `defineTool` |
| `preset` | No code: an agent preset row naming the persona and the tools an agent starts with, for profiles whose studio offers presets |
| `ui` | A Settings page in the studio: a browser half built to `lib/client.js`, and an empty host half that makes the studio serve it |
| `bundle` | No code: a `cordis.patch.yml` that turns on an existing plugin, upstream's read-before-edit guard |

The package is written to `./my-plugin`, or to the folder `--dir <folder>` names, which must be empty or missing. It holds `package.json` with the bundle declaration and version ranges for the running Delo and DeepSeek Harness, `cordis.patch.yml`, the title the Plugins page shows, a README with these commands and, for `tool` and `ui`, the TypeScript source under `src/` with a `tsdown.config.ts` that builds it to `lib/` outside this repository. The `ui` build is deliberately small: it bundles no CSS files, images or fonts and writes one file without source maps, as its README says. `delorun plugin new` refuses a name in the `@deepseek-ai/` or `@delo/` scope and the name of a package Delo ships ([why](#forking-a-plugin-delo-ships)).

## Run it while you work on it

```text
delorun start
delorun plugin dev ./my-plugin
```

`delorun plugin dev <folder>` links the folder into your profile, or reuses the link it made before, and then keeps Delo loading the folder's current code until you press Ctrl+C:

- When a file under the folder changes, the running Delo replaces the plugin's code without a restart. The studio swaps a plugin's browser half when its `lib/client.js` changes, and keeps your chats and workspaces; the plugin's own on-screen state starts afresh.
- A package with a `build` script is built once at the start and again after each change under `src/`. A failed build leaves the last good build loaded, and the error is on your terminal.
- A change to the plugin's `cordis.patch.yml` or `package.json` loads at the next start: `delorun stop`, then `delorun start`.
- Delo does not have to run first: start it at any time, and it loads the plugin.

While it runs, `plugin dev` adds one entry, marked with a comment, to your profile's `cordis.patch.yml`: it sets the folders that upstream's `hmr` row watches. Ctrl+C removes the entry again; if the command was killed, the next `plugin dev` reuses it. If your profile patch already sets the `hmr` row itself, `plugin dev` refuses rather than replace your setting. The plugin stays installed when you stop; `delorun plugin remove my-plugin` uninstalls it. An update of Delo waits while `plugin dev` runs.

## Check its versions

```text
delorun plugin check ./my-plugin
```

A plugin declares the versions it runs on in `package.json`: `engines.dsh` for DeepSeek Harness and `engines.delo` for Delo. Delo refuses to install or load a plugin whose ranges exclude the running versions. `delorun plugin check` reads the folder's `package.json` without running any of its files, says what each range admits and prints the range that targets the running Delo. [What a Delo version promises a plugin](../contracts/c22-delo-plugin-interface.md) says what may change between releases: before Delo 1.0, `^0.y.0` admits one minor version and its patches.

## Install it

`delorun plugin <pnpm arguments>` runs pnpm in your profile, as DeepSeek Harness's `dsh plugin` does, so every pnpm command works:

| Source | Command |
| --- | --- |
| A folder on this computer | `delorun plugin add ./my-plugin`, or `link:<full path>` to keep it linked to the folder |
| npm | `delorun plugin add my-plugin` |
| git | `delorun plugin add github:you/my-plugin#<commit>` |
| A tarball from `pnpm pack` | `delorun plugin add ./my-plugin-0.1.0.tgz` |

The studio's Plugins page installs the same sources; a folder there needs its full path, because the studio cannot tell which folder a relative path means. `delorun plugin remove <name>` uninstalls a plugin, and the Plugins page turns one off and on. Pin a git install to a commit, so a later push cannot change the code you run.

## Builds pnpm refuses

pnpm runs no package's build script until you allow it. A plugin installed from git builds itself on install through its `prepare` script, and a native dependency builds through its install script, so their first `add` stops. `delorun plugin` then asks, for each refused package, whether to allow that one package's build, and runs the command again when you do. When Delo's install check is on, only the installation runs again, on the lockfile the check already read, and a lockfile that differs from it is refused and the profile put back. Allowing it runs the package's code on this computer, now and at each later install, with your access and outside the sandbox. Without a terminal, or to answer in advance, name the package:

```text
delorun plugin add github:you/my-plugin#<commit> --allow-build my-plugin
```

`--allow-build` takes one package name, and never a wildcard; repeat it for more. A build you decline stays undecided in the profile's `pnpm-workspace.yaml`. `delorun plugin` takes `--allow-build` for itself, so pnpm's own flag of that name is not available through it. A plugin published to npm with its `lib/` already built needs no build approval.

## When it does not load

- `delorun doctor` lists your installed plugins, whether each is on, whether its version ranges admit the running Delo, and the plugins that did not start at the last start.
- `delorun logs` shows the home process's log, where Delo writes why a plugin failed to import or start; `delorun logs --follow` keeps printing while you work.
- `delorun recover safe-mode` makes the next start leave out every plugin you installed, so a plugin that breaks the studio cannot keep you out; `delorun recover exit-safe-mode` brings them back.

## Attach a debugger

```text
delorun start --foreground --inspect
```

`--inspect` opens Node's inspector on `127.0.0.1:9229` before Delo loads your plugins, and prints its address; attach Chrome's `chrome://inspect` or your editor's Node debugger, then set breakpoints in your plugin's files. While the inspector listens, any process on this computer, including commands the agent runs inside the sandbox, can run code as Delo outside the sandbox, so Delo asks you to confirm first; without a terminal, `--inspect --yes` confirms it. Safe mode refuses it, and `delorun status` shows the inspector while it is open. Use it only while you debug, and start without `--inspect` afterwards.

## Overlays for one start

```text
delorun start --patch ./try.patch.yml
```

`--patch <file>`, which you may repeat, applies a patch file over your profile for this start only, as `dsh --patch` does in DeepSeek Harness, without changing the profile. Delo's own checks still apply: an overlay that turns off one of Delo's protections is refused with the file's name. Safe mode refuses overlays, and the process an update starts runs without them.

## Forking a plugin Delo ships

Delo loads the packages it ships, the `@deepseek-ai/` and `@delo/` ones, from its own installation. A package in your profile with the same name never loads: the shipped one does, and `delorun doctor` warns about it. To change a shipped plugin, copy it into a package with a new name, turn the shipped row off and insert yours, as [Where to customise what](customise.md#fork-a-shipped-plugin) shows.
