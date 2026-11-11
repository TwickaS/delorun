---
description: "Where to customise Delo: settings, the profile patch, agent presets, your own plugin, a renamed fork of a shipped plugin, and editing the harness itself, with what each costs you at every update."
---

# Where to customise what

English

Delo has no release yet; this page describes the first release.

## Summary

You can reshape Delo at six levels, from a setting in the studio to the harness's own source. Each level reaches further than the one before it and costs more at each update, so choose the first one that can make your change. Every level but the last leaves Delo's signed release untouched, and an update shows what it would turn off before it does ([updates never take your work away](trust.md)).

## Contents

- [The levels](#the-levels)
- [Change a plugin's settings](#change-a-plugins-settings)
- [Make an agent preset](#make-an-agent-preset)
- [Write a plugin](#write-a-plugin)
- [Fork a shipped plugin](#fork-a-shipped-plugin)
- [Edit the harness itself](#edit-the-harness-itself)

## The levels

| Level | What it changes | Where it lives | What an update costs you |
| --- | --- | --- | --- |
| Settings | What a plugin's settings page offers | The studio's Settings and Plugins pages | Nothing: settings carry over |
| Profile patch | Any plugin's configuration; turning a plugin off | Your profile's `cordis.patch.yml` | A key a new version renames or removes; a patch restates a plugin's whole `config` |
| Agent preset | The tools, instructions, skills and models an agent starts with | Presets made in Creator mode, kept in your profile | Little: a preset names plugins, so only a removed or renamed one breaks it |
| Your own plugin | New tools, studio parts, services, plugin rows | A package installed into your profile | Its `engines` ranges: a range that excludes the new release turns the plugin off until you widen it and test |
| Fork of a shipped plugin | How one of DeepSeek Harness's plugins behaves | A renamed copy installed into your profile, with the shipped row turned off | You merge every upstream change to that plugin yourself, and its interfaces can change in any minor release before 1.0 |
| The harness itself | Anything, the plugin loop included | A source checkout of Delorun | You merge every release yourself, and you run code Delo did not sign |

## Change a plugin's settings

Most plugins have a settings page in the studio, which saves into your profile. For what a page does not offer, your profile's `cordis.patch.yml`, under `~/.delo/profiles/<profile>/`, patches any plugin's row by its id. A patch replaces the row's whole `config`, so restate every key the plugin needs, and `disabled: true` turns a row off. DeepSeek Harness's [loading order](../../../docs/user/develop/basic/publish.md#the-loading-order) explains which layer wins. Delo refuses to start with a patch that turns off one of its protections, and names the file.

## Make an agent preset

An agent preset decides which tools, instructions, skills and model an agent starts with. Make one in the studio by starting a chat in Creator mode, or package one as a plugin with `delorun plugin new <name> --kind preset` ([Write a plugin for Delo](plugins.md)). A preset names the plugins it uses, so an update affects it only when one of them is removed or renamed.

## Write a plugin

A plugin adds behaviour without changing anything Delo ships: a tool, a part of the studio, a service other plugins use, or a bundle of settings for existing plugins. [Write a plugin for Delo](plugins.md) goes from `delorun plugin new` to an installed plugin. Declare `engines.dsh` and `engines.delo`: at an update, Delo turns off a plugin whose ranges exclude the new release and tells you before it does, and [what a Delo version promises a plugin](../contracts/c22-delo-plugin-interface.md) says what each release may change.

## Fork a shipped plugin

Delo loads the packages it ships from its own installation, so a package in your profile with a shipped package's name never loads. To change how one of DeepSeek Harness's plugins behaves:

1. Copy its package into a folder and give it a new name in `package.json`, such as `my-todo` for `@deepseek-ai/dsh-tool-todo`, with its own `engines` ranges and a `dsh.bundle` declaration.
2. In the copy's `cordis.patch.yml`, turn the shipped row off and insert yours under a new id, with the configuration the shipped row had:

   ```yaml
   - id: tool-todo
     disabled: true
   - insert:
       - id: my-todo
         name: my-todo
         config:
           allowParallelInProgress: true
   ```

3. Install the copy with `delorun plugin add ./my-todo`, or work on it with `delorun plugin dev ./my-todo`.

Delo's own plugins and the rows its protections need, such as the sandbox, cannot be replaced this way: Delo refuses to start with any of them off and names the file that turned it off. Change those through their settings, or [edit the harness](#edit-the-harness-itself). A fork keeps the plugin's code as it was when you copied it, so check each release's changelog for the plugin and bring its changes over yourself.

## Edit the harness itself

A change to the plugin loop, the composition or Delo's protections needs a source checkout of Delorun: run it with `pnpm install` and `pnpm run build`, then start it as the repository's README explains. You merge every release into your checkout yourself, and Delo's signature and release log no longer describe the code you run, so `delorun verify` cannot vouch for it. Prefer a plugin wherever one can make the change.
