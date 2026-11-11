---
kind: upgrade-guide
description: "MCP add-time consent judges the whole server start, so McpConsentRefusedError and the consent store's accept take a start, and version 1 acceptance stores no longer count."
---

# MCP add-time consent judges the whole server start

English | [中文](guide.zh.md)

## Change

A stdio MCP server's add-time consent now covers the command, its arguments, its working directory and its configured environment. `McpServerCommand` from `@deepseek-ai/dsh-mcp-client` gains the fields `env` and `cwd`.

- `new McpConsentRefusedError(serverName, command, args, reason)` is now `new McpConsentRefusedError(start, reason)`, where `start` is the `McpServerCommand` that was refused. The error gains `cwd` and `envNames`, and its message names environment variables without their values.
- `DeloMcpConsent.accept(command, args)` from `@delo/plugin-mcp-consent` is now `accept(start)`, where `start` carries `command`, `args`, `cwd` and `env`.
- The acceptance store, `secrets/mcp-add-consent/acceptances.json` under the Delo home, moves to version 2, which keys each acceptance on all four and keeps a digest of the environment instead of its values. A version 1 store is read as superseded: none of its acceptances count, so every stdio server it accepted is asked about again. Accepting into it writes a version 2 store that holds only the new acceptance.
- A plugin that provides an `mcpAddConsent` service declares it with the module export `providesMcpAddConsent = true`. An mcp-client row waits for every Loader row that declares it, and keeps its server stopped with `McpConsentUnavailableError` when such a row fails to start.

This affects plugins that construct `McpConsentRefusedError`, call `accept`, provide their own `McpAddConsent`, or read the store file, and every person whose store holds version 1 acceptances.

## Migration

1. Replace `new McpConsentRefusedError(name, command, args, reason)` with `new McpConsentRefusedError({ serverName: name, command, args, env, cwd }, reason)`.
2. Replace `consent.accept(command, args)` with `consent.accept({ command, args, env, cwd })`, passing the server row's configured `env` (an empty object when none) and `cwd` (the empty string for the Host's working directory).
3. In a module that provides an `McpAddConsent` service, add `export const providesMcpAddConsent = true`.
4. Accept each stdio server again when its consent asks; do not copy entries from a version 1 store.
5. Confirm by starting the profile: an accepted server connects, and the store file's `v` field reads `2`.
