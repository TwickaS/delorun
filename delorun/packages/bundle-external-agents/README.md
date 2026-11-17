---
description: "Lets the agent hand a task to the Codex or Claude Code program you already have installed, and runs Python code in tool programs."
---

# @delorun/bundle-external-agents

English | [中文](README.zh.md)

## Summary

Switch on **External agents** in Plugins to let the agent hand a self-contained task to the Codex or Claude Code program already installed on this computer, through the `subagent_oar` tool. Each runs under your own sign-in (`~/.codex`, `~/.claude`), not Delorun's, with the permission settings fixed in the bundle's rows.

Every row starts off. Plugins shows "Needs setup" with the reason, for example "Needs codex installed", while a row's program is not on your PATH, and a row you turn on lists only the programs that are present when the studio starts. The bundle also adds a Python runtime for tool programs, which needs `python3` (CPython 3.10 or newer) on your PATH and is not available on Windows. It is experimental.

## Needs setup

- Each row needs its own program on your PATH: `codex` for Codex, `claude` for Claude Code, either of them for the delegation tool, and `python3` for the Python runtime (not on Windows). Plugins shows what is missing and how to install it; you also need to be signed in to the program. Turn on a row once its "Needs setup" line is gone.

The bundle is off in a new profile. [`@delorun/bundle-local`](../bundle-local/README.md) does not list it; a person switches it on in Plugins, and the release carries it as an optional pack rather than in the default install.
