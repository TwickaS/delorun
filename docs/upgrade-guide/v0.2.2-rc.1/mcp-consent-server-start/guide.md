---
kind: upgrade-guide
description: "MCP add-time consent judges the whole resolved server start, so McpServerCommand gains fields, McpConsentRefusedError and the consent store's accept take a start, and version 1 and 2 acceptance stores no longer count."
---

# MCP add-time consent judges the whole server start

English | [中文](guide.zh.md)

## Change

A stdio MCP server's add-time consent now covers the command, its arguments, its working directory and its configured environment, and the paths they resolve to. `McpServerCommand` from `@deepseek-ai/dsh-mcp-client` gains the required fields `env`, `cwd`, `resolvedCommand` (the absolute file a `PATH` lookup finds, with `PATHEXT` on Windows, such as `C:\Program Files\nodejs\npx.cmd`) and `resolvedCwd` (the canonical working directory, the Host's for an empty `cwd`). With a consent mounted, the mcp-client resolves the start with the new `resolveServerStart`, reviews it, and spawns exactly the resolved paths; a start it cannot resolve stops with `McpServerStartUnresolvedError`. On Windows that includes a file other than `.exe`, `.com`, `.bat` or `.cmd`, a file with a `#!` line, and a shim when `COMSPEC` is not an absolute path to a file, and the lookup does not search the working directory first.

- `new McpConsentRefusedError(serverName, command, args, reason)` is now `new McpConsentRefusedError(start, reason)`, where `start` is the `McpServerCommand` that was refused. The error gains `cwd`, `envNames`, `resolvedCommand` and `resolvedCwd`; its message names the executable and directory and the environment variables without their values.
- `DeloMcpConsent.accept(command, args)` from `@delo/plugin-mcp-consent` is now `accept(start)`, where `start` carries `command`, `args`, `cwd`, `env`, and absolute `resolvedCommand` and `resolvedCwd`.
- The acceptance store, `secrets/mcp-add-consent/acceptances.json` under the Delo home, moves to version 3, which keys each acceptance on all of these and keeps a digest of the environment instead of its values. Version 1 and 2 stores are read as superseded: none of their acceptances count, so every stdio server they accepted is asked about again. Accepting into one writes a version 3 store that holds only the new acceptance.
- A plugin that provides an `mcpAddConsent` service declares it with the module export `providesMcpAddConsent = true`. An mcp-client row waits for every Loader row that declares it, and keeps its server stopped with `McpConsentUnavailableError` when such a row fails to start.

This affects plugins that construct `McpConsentRefusedError`, call `accept`, provide their own `McpAddConsent`, or read the store file, and every person whose store holds version 1 acceptances.

## Migration

1. Build a start with `resolveServerStart(config)` from `@deepseek-ai/dsh-mcp-client`, or supply `resolvedCommand` and `resolvedCwd` yourself in stubs and tests.
2. Replace `new McpConsentRefusedError(name, command, args, reason)` with `new McpConsentRefusedError(start, reason)`, and `consent.accept(command, args)` with `consent.accept(start)`; the start carries the row's `env` (an empty object when none) and `cwd` (the empty string for the Host's working directory).
3. In a module that provides an `McpAddConsent` service, add `export const providesMcpAddConsent = true`.
4. Accept each stdio server again when its consent asks; do not copy entries from a version 1 store.
5. Confirm by starting the profile: an accepted server connects, and the store file's `v` field reads `3`.
