---
description: "Delorun's live external agents, for maintainers: Claude Code and Codex as child chats of the chat that handed work over, behind the externalAgents.liveAgents preview flag."
kind: "package-library"
---

# @delorun/plugin-agent-seats

English | [中文](README.zh.md)

## Summary

This package makes Claude Code and Codex live agents: a child chat of the chat that handed work over, whose model is the external program, which a person can watch, message and stop. The whole package sits behind the preview flag `externalAgents.liveAgents`, off by default. This is the package skeleton; the provider, hand-off tools, adapter, executor, relay and studio views land in later commits.

## Contents

- [Configuration](#configuration)

## Configuration

The row `delorun-agent-seats` holds `seats`, a list of `{ provider, route, preset, toolName, maxDepth }`. The default has one seat each for Claude Code (`claude_code`) and Codex (`codex`).
