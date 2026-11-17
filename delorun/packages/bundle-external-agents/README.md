---
description: "Lets the agent hand a task to the Codex or Claude Code program you already have installed, and runs Python code in tool programs."
---

# @delorun/bundle-external-agents

## Summary

Switch on **External agents** in Plugins to let the agent hand a self-contained task to the Codex or Claude Code program already installed on this computer, through the `subagent_oar` tool. Each runs under your own sign-in (`~/.codex`, `~/.claude`), not Delorun's, with the permission settings fixed in the bundle's rows.

A program that is not on your PATH is left out, and with neither the tool does not mount, so turning the bundle on never fails. The bundle also adds a Python runtime for tool programs, which needs `python3` (CPython 3.10 or newer) on your PATH and is not available on Windows. It is experimental.

## Needs setup

- Needs the Codex or Claude Code program installed and signed in; python3 for the Python runtime. A missing one is left out.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
