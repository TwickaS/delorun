---
name: delorun-plugin-authoring
description: Make or change a Delorun plugin for the person (a tool, an agent preset, a studio page or a bundle) in the current workspace. Load when the person asks for a new plugin or a change to one of their own; use it instead of dsh-doc for plugin work on this install.
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
- `delorun plugin dev <folder>` links the folder into the person's harness and reloads it on each save, so it turns the plugin on. With protection off, once the person has given the full-access approval, you may run it yourself; with protection on, offer it to the person and do not run it.

## Turning it on depends on protection

What you may do to plugins depends on the person's protection setting, which Delorun checks at each `plugin_manager` call. If a call tells you it cannot read the protection setting, treat protection as on.

- **Protection off (the default).** `plugin_manager` works as in stock DeepSeek Harness after the person gives its one full-access approval, which you never skip or answer for them: you may install, remove, turn on, configure, undo and restore plugins, and run `delorun plugin dev <folder>` yourself. Edits to a linked plugin reload when you save. Delorun lists every step in Changes as loaded without review, and the person can undo each there. Say what you changed each time.
- **Protection on.** You cannot turn a plugin on, approve its build or change plugin settings: `plugin_manager` records an install as a change waiting at the person's computer and refuses a turn-on, undo, restore or settings change. Do not try to work around that. Tell the person what you made and where, then tell them to turn it on at their computer: in the studio, Settings, Plugins, Create a plugin, open the plugin and choose Turn on; or run `delorun plugin add link:<absolute folder>`. Delorun then lists it in Changes with its files, and the person approves it there. After that, every later edit to the plugin's files waits for their approval in Changes before it loads. Say what you changed each time.
