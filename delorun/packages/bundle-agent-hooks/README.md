---
description: "Runs the hooks from your Claude Code settings and your Codex hooks file at the same points in a Delorun turn, and loads Claude Code mods."
---

# @delorun/bundle-agent-hooks

## Summary

Switch on **Claude Code and Codex hooks** in Plugins to run the hooks you already wrote for those tools. The Claude Code bridge reads `~/.claude/settings.json`, the Codex bridge reads `~/.codex/hooks.json`, and the mods bridge with its band above the prompt loads Claude Code mods.

Your hook files are yours: if one is missing, that bridge registers no hooks and logs one warning. The mods bridge loads no mod until you add one to your profile. Hooks run your commands, so read the files before turning this on. It is experimental.

## Needs setup

- Needs your own ~/.claude/settings.json or ~/.codex/hooks.json; a missing file registers no hooks.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
