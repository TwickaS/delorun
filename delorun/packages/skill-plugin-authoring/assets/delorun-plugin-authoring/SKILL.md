---
name: delorun-plugin-authoring
description: Make or change a Delorun plugin for the person (a tool, an agent preset, a studio page or a bundle) in the current workspace. Load when the person asks for a new plugin or a change to one of their own.
---

# Making a Delorun plugin

A plugin is a folder with a `package.json`. Make it in the current workspace, in `plugins/<name>`, so the person can read and review every file.

## Scaffold

1. Pick a kind: `tool` (a tool you can call), `preset` (an agent preset), `ui` (a page in the studio) or `bundle` (a set of other plugins).
2. From the workspace folder, run `delorun plugin new <name> --kind <kind> --dir plugins/<bare name>`. The name is lowercase letters, digits and dashes, optionally under the person's own scope such as `@you/`; `<bare name>` is the name without its scope. The command refuses a folder that already holds files, and a name under `@delorun/` or `@deepseek-ai/`.
3. Edit the files it wrote. Keep every change inside `plugins/<bare name>`; never write into the Delorun home or into another plugin.

## Test

- `delorun plugin check <folder>` reports whether the plugin fits the running release.
- Run the plugin's own tests with the package scripts the scaffold wrote.
- `delorun plugin dev <folder>` is the person's loop: it links the folder into their harness and reloads it on each save, so it is a way of turning the plugin on. Offer it to the person; do not run it yourself.

## Turning it on is the person's step

You cannot turn a plugin on, approve its build or change plugin settings. At every protection level `plugin_manager` records an install as a change waiting at the person's computer and refuses a turn-on or a settings change. Do not try to work around that.

Tell the person what you made and where, then tell them to turn it on at their computer: in the studio, Settings, Plugins, Create a plugin, open the plugin and choose Turn on; or run `delorun plugin add link:<absolute folder>`. Delorun then lists it in Changes with its files, and the person approves it there. After that, with the person's changes protection on, every later edit to the plugin's files waits for their approval in Changes before it loads. Protection is off by default: edits to a plugin that is already on then reload live and are logged as loaded without review. Either way, say what you changed each time.
