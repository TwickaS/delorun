---
description: "Your first Delorun plugin from nothing to the studio: what you need installed, making a small tool plugin, loading it, finding it on the studio's Plugins page, changing it while it runs, and removing it again."
---

# Your first plugin

English | [中文](first-plugin.zh.md)

## Summary

This page takes you from an empty folder to a plugin you can see in the studio, then removes it again. The plugin is a small tool that greets someone by name. You need a set-up Delorun, Node.js 24.9 or newer and pnpm; the first section says how to check them. Nothing here needs a model key. When you have finished, you will have made one plugin, changed it while Delorun ran, and uninstalled it. [Write a plugin for Delorun](plugins.md) is the full reference, and [Where to customise what](../customising/customise.md) helps you decide whether a plugin is the right tool for your change.

## Contents

- [What you need](#what-you-need)
- [Make the plugin](#make-the-plugin)
- [Load it](#load-it)
- [See it in the studio](#see-it-in-the-studio)
- [Change it while it runs](#change-it-while-it-runs)
- [Remove it](#remove-it)
- [Go further](#go-further)

## What you need

- A set-up Delorun: `delorun setup` has finished ([Install and first run](../get-started/install.md)).
- [Node.js](https://nodejs.org) 24.9 or newer. Check it with `node --version`.
- pnpm, which you install yourself. The pnpm that Delorun carries is private to `delorun plugin` and is not on your command path. Install pnpm with `npm install -g pnpm`, or as [pnpm.io](https://pnpm.io/installation) describes, and check it with `pnpm --version`.

A plugin runs inside Delorun with your access, outside the sandbox that confines the agent's commands, so install only plugins whose code you trust. This one is yours, and you can read all of it.

## Make the plugin

In a folder where you keep projects, run:

```text
delorun plugin new hello-plugin
cd hello-plugin
pnpm install
pnpm run build
```

`delorun plugin new` writes a folder named `hello-plugin` and prints the files it made: `package.json`, `cordis.patch.yml`, `locale/en.json`, `src/index.ts`, `tsdown.config.ts`, `tsconfig.json`, `.gitignore` and `README.md`. `src/index.ts` is the whole plugin: it registers one tool, `hello_plugin`, that returns `Hello, <name>!`. `pnpm install` fetches the build tools and `pnpm run build` writes `lib/index.js`, the file Delorun loads.

Check that your Delorun accepts the plugin:

```text
delorun plugin check .
```

It prints which Delorun and DeepSeek Harness versions the plugin's `package.json` admits and ends with `The installer admits it on this release.`

## Load it

```text
delorun start
delorun plugin dev .
```

`delorun start` starts Delorun in the background. `delorun plugin dev .` links the folder into your profile and keeps running, so leave that terminal open and use another for the next steps. It rebuilds and reloads the plugin each time you save a file.

In the second terminal, ask what Delorun did:

```text
delorun changes list
```

Under `Recent changes` it lists `Loaded without review: hello-plugin from` and the folder. Delorun records every change to what it runs. Changes protection is off by default, so a plugin you link loads without waiting for you; [Changing your harness](../customising/changing-your-harness.md) explains what protection on does instead.

## See it in the studio

Open the studio with `delorun open`. If it was open already, reload the page. In the sidebar, choose Plugins. Under Installed plugins you now see Hello plugin, with the line `Gives the agent the hello_plugin tool, which greets someone by name.` Choose it to see its page: its version, `v0.1.0`, its README, and an Uninstall button.

The title and the line come from `locale/en.json` in your folder. The plugin gives the agent the `hello_plugin` tool; to use it in a chat you need a model key ([Model providers](../get-started/providers.md)).

## Change it while it runs

With `delorun plugin dev .` still running, open `src/index.ts` and change the tool's description from `Greet someone by name.` to `Greet someone warmly by name.` Save the file. Delorun builds the plugin and loads the new code without a restart, and `delorun changes list` shows a second line, `Loaded without review: hello-plugin: changes in` and the folder.

If you turn changes protection on, an edit waits for your review instead and loads only when you apply it. To load your own edits live with protection on, run `delorun changes work hello-plugin` first, and `delorun changes done hello-plugin` when you have finished ([Changing your harness](../customising/changing-your-harness.md#working-on-a-plugin)).

## Remove it

1. In the terminal that runs `delorun plugin dev .`, press Ctrl+C. The plugin stays installed.
2. In the studio, choose Plugins in the sidebar, then Hello plugin, then Uninstall. The studio says `What it provides goes away once it is uninstalled.` Choose Uninstall again to confirm. Hello plugin is gone from Installed plugins, and `delorun doctor` no longer lists it.

`delorun changes undo <id>` takes one recorded change back, but it stops what that change loaded without uninstalling the plugin: Hello plugin stays on the Plugins page as not running until you uninstall it, and the undo prints the command that does: `delorun plugin remove hello-plugin`. Your `hello-plugin` folder is never deleted; remove it yourself when you no longer want it.

## Go further

- [Write a plugin for Delorun](plugins.md): the other kinds of plugin (an agent preset, a page in the studio, a bundle of settings), installing from a folder, git or npm, version ranges, logs, a debugger and safe mode.
- [Changing your harness](../customising/changing-your-harness.md): review, apply, discard and undo what your plugins and your agent change.
- DeepSeek Harness's tutorial on [writing a tool](../../../../docs/user/develop/basic/tool.md).
