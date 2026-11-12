---
kind: upgrade-guide
description: "MCP add-time consent judges the whole resolved server start per server name: McpServerCommand gains fields, McpConsentRefusedError and accept take a start, and earlier acceptance stores no longer count."
---

# MCP add-time consent judges the whole server start

English | [中文](guide.zh.md)

## Change

A stdio MCP server's add-time consent now covers the server name, the command, its arguments, its working directory and its configured environment, and what they resolve to. `McpServerCommand` from `@deepseek-ai/dsh-mcp-client` gains the required fields `env`, `cwd`, `resolvedCommand` (the absolute file a `PATH` lookup finds, with `PATHEXT` on Windows, such as `C:\Program Files\nodejs\npx.cmd`), `resolvedCwd` (the canonical working directory, the Host's for an empty `cwd`), and the optional `resolvedShell` (the canonical `COMSPEC` that runs a Windows `.cmd` or `.bat` file). With a consent mounted, the mcp-client resolves the start with the new `resolveServerStart`, reviews it, and spawns exactly the resolved paths; a start it cannot resolve stops with `McpServerStartUnresolvedError`. On Windows that includes a file other than `.exe`, `.com`, `.bat` or `.cmd`, a file with a `#!` line, and a shim without an absolute `COMSPEC` file; the lookup skips the working directory.

- `new McpConsentRefusedError(serverName, command, args, reason)` is now `new McpConsentRefusedError(start, reason)`, `start` being the refused `McpServerCommand`. The error gains `cwd`, `envNames`, `resolvedCommand`, `resolvedCwd` and `resolvedShell`; its message names these, without environment values.
- `DeloMcpConsent.accept(command, args)` from `@delo/plugin-mcp-consent` is now `accept(start)`, where `start` is the `McpServerCommand` of the server row, with absolute `resolvedCommand` and `resolvedCwd`.
- The acceptance store, `secrets/mcp-add-consent/acceptances.json` under the Delo home, moves to version 5: one acceptance per server name, covering the whole start and its resolved paths, with a digest of each environment value. A version 4 store allows nothing, and a start it held exactly is asked about once as `upgraded`. Version 1 to 3 stores are superseded, so each stdio server they accepted asks again.
- A plugin that provides an `mcpAddConsent` service declares it with the module export `providesMcpAddConsent = true`. An mcp-client row waits for every Loader row that declares it, and keeps its server stopped with `McpConsentUnavailableError` when such a row fails to start.
- A discovered `.env` setting `COMSPEC` or `PATHEXT` stops launch, as for `PATH`; export them instead.

This affects plugins that construct `McpConsentRefusedError`, call `accept`, provide their own `McpAddConsent`, or read the store file, and every person whose store holds earlier acceptances.

## Migration

1. Build a start with `resolveServerStart(config)` from `@deepseek-ai/dsh-mcp-client`, or supply `resolvedCommand` and `resolvedCwd` yourself in stubs and tests.
2. Replace `new McpConsentRefusedError(name, command, args, reason)` with `new McpConsentRefusedError(start, reason)`, and `consent.accept(command, args)` with `consent.accept(start)`; the start carries the server row's name, its `env` (an empty object when none) and `cwd` (the empty string for the Host's working directory).
3. In a module that provides an `McpAddConsent` service, add `export const providesMcpAddConsent = true`.
4. Accept each stdio server again when asked; do not copy entries from an earlier store.
5. Confirm: an accepted server connects, and the store file's `v` reads `5`.
