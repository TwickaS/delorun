---
description: "Writing a Delorun plugin from nothing to running: delorun plugin new, the dev loop with delorun plugin dev, checking version ranges, installing from a folder, git or npm, build approvals, logs, the debugger, safe mode, and why a fork of a shipped package needs its own name."
---

# Write a plugin for Delorun

English | [中文](plugins.zh.md)

## Summary

Everything Delorun does is a plugin, and you can add your own: a tool the agent calls, an agent preset, a panel in the studio, or a bundle that changes how other plugins are set up. `delorun plugin new` writes a working package, `delorun plugin dev` loads it into your running studio and reloads it each time you save, `delorun plugin check` says which Delorun and DeepSeek Harness versions it runs on, and `delorun plugin add` installs it for good. A plugin runs inside Delorun with your access, outside the sandbox Delorun runs the agent's commands in, so install only plugins whose code you trust. To decide whether a plugin is the right tool for your change, see [Where to customise what](../customising/customise.md).

## Contents

- [Before you start](#before-you-start)
- [Create a plugin](#create-a-plugin)
- [From the studio](#from-the-studio)
- [In a chat](#in-a-chat)
- [Run it while you work on it](#run-it-while-you-work-on-it)
- [Check its versions](#check-its-versions)
- [Install it](#install-it)
- [Builds pnpm refuses](#builds-pnpm-refuses)
- [When it does not load](#when-it-does-not-load)
- [Attach a debugger](#attach-a-debugger)
- [Overlays for one start](#overlays-for-one-start)
- [Forking a plugin Delorun ships](#forking-a-plugin-delorun-ships)

## Before you start

New to plugins? [Your first plugin](first-plugin.md) walks through one from nothing to the studio.

You need a set-up Delorun (`delorun setup`), [Node.js](https://nodejs.org) 24.9 or newer, and pnpm to build TypeScript. pnpm is a separate tool: the copy Delorun carries is private to `delorun plugin` and is not on your command path, so install pnpm yourself, for example with `npm install -g pnpm` or as [pnpm.io](https://pnpm.io/installation) describes, and check it with `pnpm --version`. Every `delorun plugin` command works on your CLI profile, `default` unless you set `DELORUN_PROFILE` or pass `--profile <name>`. A plugin is an npm package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; its `cordis.patch.yml` inserts the plugin's rows into your profile. DeepSeek Harness's tutorials explain the plugin model itself: [your first plugin](../../../../docs/user/develop/basic/index.md), [a tool](../../../../docs/user/develop/basic/tool.md), [configuration](../../../../docs/user/develop/basic/config.md) and [packaging](../../../../docs/user/develop/basic/publish.md). Delorun runs those plugins unchanged.

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

The package is written to `./my-plugin`, or to the folder `--dir <folder>` names, which must be empty or missing. It holds `package.json` with the bundle declaration and version ranges for the running Delorun and DeepSeek Harness, `cordis.patch.yml`, the title the Plugins page shows, a README with these commands and, for `tool` and `ui`, the TypeScript source under `src/` with a `tsdown.config.ts` that builds it to `lib/` outside this repository. The `ui` build is deliberately small: it bundles no CSS files, images or fonts and writes one file without source maps, as its README says. `delorun plugin new` refuses a name in the `@deepseek-ai/` or `@delorun/` scope and the name of a package Delorun ships ([why](#forking-a-plugin-delorun-ships)).

## From the studio

At your computer, open Settings, Plugins and use Create a plugin. Give the plugin a name, choose what it adds (the same four kinds as `delorun plugin new`) and choose a workspace; the first workspace is the default. Delorun writes the same files `delorun plugin new` writes into the workspace's `plugins` folder, shows where they went and lists them. Open folder shows the folder in your file manager, where you and the agent can both work on it with the chat's usual approvals.

Creating a plugin does not turn it on. Turn on records the plugin as a change waiting in Changes, where you review its files and approve it; this is the same review `delorun plugin add link:<folder>` leads to, and it applies in dangerous mode too. A phone or another device can see the section but cannot create a plugin: it says to do this at your computer.

## In a chat

Ask the agent for a plugin and it loads the `delorun-plugin-authoring` skill: it scaffolds the plugin in the chat's workspace under `plugins/<name>` with `delorun plugin new`, edits the files, and checks them with `delorun plugin check` and the plugin's own tests. Its file writes and commands follow the chat's normal approvals. It cannot turn the plugin on or approve its build, whatever the chat's access or the protection setting: an install it asks for is listed in Changes for you to approve at your computer. It tells you where the plugin is; turn it on at your computer as above, or with `delorun plugin add link:<folder>`.

With changes protection on, a plugin you approved keeps running the approved files whoever edits its folder afterwards. An edit by the agent or by anyone else appears in Changes as a change waiting for your review and loads only after you approve it. Protection is off by default, so the agent's edits to a linked plugin reload live like yours and are logged as loaded without review; turn protection on and they wait for your approval.

## Run it while you work on it

```text
delorun start
delorun plugin dev ./my-plugin
```

`delorun plugin dev <folder>` links the folder into your profile, or reuses the link it made before, and then keeps Delorun loading the folder's current code until you press Ctrl+C:

- When a file under the folder changes, the running Delorun replaces the plugin's code without a restart. The studio swaps a plugin's browser half when its `lib/client.js` changes, and keeps your chats and workspaces; the plugin's own on-screen state starts afresh.
- A package with a `build` script is built once at the start and again after each change under `src/`. A failed build leaves the last good build loaded, and the error is on your terminal.
- A change to the plugin's `cordis.patch.yml` or `package.json` loads at the next start: `delorun stop`, then `delorun start`.
- Delorun does not have to run first: start it at any time, and it loads the plugin.
- With changes protection off, the default, every edit in that folder loads live while it runs, whether you or the agent made it. With protection on, an edit waits in Changes for your review like any other and loads only when you apply it; run `delorun changes work my-plugin` first to load your own edits live ([Working on a plugin](../customising/changing-your-harness.md#working-on-a-plugin)).

While it runs, `plugin dev` adds one entry, marked with a comment, to your profile's `cordis.patch.yml`: it sets the folders that upstream's `hmr` row watches. Ctrl+C removes the entry again; if the command was killed, the next `plugin dev` reuses it. If your profile patch already sets the `hmr` row itself, `plugin dev` refuses rather than replace your setting. The plugin stays installed when you stop; `delorun plugin remove my-plugin` uninstalls it. An update of Delorun waits while `plugin dev` runs.

## Check its versions

```text
delorun plugin check ./my-plugin
```

A plugin declares the versions it runs on in `package.json`: `engines.dsh` for DeepSeek Harness and `engines.delorun` for Delorun. Delorun refuses to install or load a plugin whose ranges exclude the running versions. `delorun plugin check` reads the folder's `package.json` without running any of its files, says what each range admits and prints the range that targets the running Delorun. When an update would turn a plugin off because of its range, see [Update Delorun with many plugins](updating-with-plugins.md). [What a Delorun version promises a plugin](../../contracts/c22-delorun-plugin-interface.md) says what may change between releases: before Delorun 1.0, `^0.y.0` admits one minor version and its patches.

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

pnpm runs no package's build script until you allow it. A plugin installed from git builds itself on install through its `prepare` script, and a native dependency builds through its install script, so their first `add` stops. `delorun plugin` then asks, for each refused package, whether to allow that one package's build, and runs the command again when you do. When Delorun's install check is on, only the installation runs again, on the lockfile the check already read, and a lockfile that differs from it is refused and the profile put back. Allowing it runs the package's code on this computer, now and at each later install, with your access and outside the sandbox. Without a terminal, or to answer in advance, name the package:

```text
delorun plugin add github:you/my-plugin#<commit> --allow-build my-plugin
```

`--allow-build` takes one package name, and never a wildcard; repeat it for more. A build you decline stays undecided in the profile's `pnpm-workspace.yaml`. `delorun plugin` takes `--allow-build` for itself, so pnpm's own flag of that name is not available through it. A plugin published to npm with its `lib/` already built needs no build approval.

## When it does not load

- `delorun doctor` lists your installed plugins, whether each is on, whether its version ranges admit the running Delorun, and the plugins that did not start at the last start.
- `delorun logs` shows the home process's log, where Delorun writes why a plugin failed to import or start; `delorun logs --follow` keeps printing while you work.
- `delorun recover safe-mode` makes the next start leave out every plugin you installed, so a plugin that breaks the studio cannot keep you out; `delorun recover exit-safe-mode` brings them back.

## Attach a debugger

```text
delorun start --foreground --inspect
```

`--inspect` opens Node's inspector on `127.0.0.1:9229` before Delorun loads your plugins, and prints its address; attach Chrome's `chrome://inspect` or your editor's Node debugger, then set breakpoints in your plugin's files. While the inspector listens, any process on this computer, including commands the agent runs inside the sandbox, can run code as Delorun outside the sandbox, so Delorun asks you to confirm first; without a terminal, `--inspect --yes` confirms it. Safe mode refuses it, and `delorun status` shows the inspector while it is open. Use it only while you debug, and start without `--inspect` afterwards.

## Overlays for one start

```text
delorun start --patch ./try.patch.yml
```

`--patch <file>`, which you may repeat, applies a patch file (an [overlay](../../reference/glossary.md#overlay)) over your profile for this start only, as `dsh --patch` does in DeepSeek Harness, without changing the profile. Delorun's own checks still apply: an overlay that turns off one of Delorun's protections is refused with the file's name. Safe mode refuses overlays, and the process an update starts runs without them.

## Forking a plugin Delorun ships

Delorun loads the packages it ships, the `@deepseek-ai/` and `@delorun/` ones, from its own installation. A package in your profile with the same name never loads: the shipped one does, and `delorun doctor` warns about it. To change a shipped plugin, copy it into a package with a new name, turn the shipped row off and insert yours, as [Where to customise what](../customising/customise.md#fork-a-shipped-plugin) shows.
