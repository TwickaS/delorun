---
kind: upgrade-guide
description: "MCP add-time consent judges the whole resolved server start per server name and the contents of the files it runs, again before each reconnect: McpServerCommand gains fields, McpConsentRefusedError and accept take a start, and earlier acceptance stores no longer count."
---

# MCP add-time consent judges the whole server start

English | [中文](guide.zh.md)

## Change

A stdio MCP server's add-time consent now covers the server name, the command, its arguments, its working directory, its configured environment, what they resolve to, and the contents of the files the start runs. `McpServerCommand` from `@deepseek-ai/dsh-mcp-client` gains the required fields `env`, `cwd`, `resolvedCommand` (the absolute file a `PATH` lookup finds), `resolvedCwd` (the canonical working directory, the Host's for an empty `cwd`), and the optional `resolvedShell` (the canonical `COMSPEC` that runs a Windows `.cmd` or `.bat` file). With a consent mounted, the mcp-client resolves the start with the new `resolveServerStart`, reviews it at boot and again before every reconnect, and spawns exactly the resolved paths; a start it cannot resolve stops with `McpServerStartUnresolvedError`, and a refused reconnect stops reconnecting. On Windows that includes a file other than `.exe`, `.com`, `.bat` or `.cmd`, or with a `#!` line.

- `new McpConsentRefusedError(serverName, command, args, reason)` is now `new McpConsentRefusedError(start, reason)`; the error gains `cwd`, `envNames`, `resolvedCommand`, `resolvedCwd` and `resolvedShell`, and its message names no environment value.
- `DeloMcpConsent.accept(command, args)` from `@delo/plugin-mcp-consent` is now `accept(start, files?)`; omitted `files` are pinned when it runs. `PendingServer` and `AcceptedServer` gain `files`, `mcpReviewId` takes the start with its `files`, and a review whose pinned file changed reports the change `contents`.
- The acceptance store, `secrets/mcp-add-consent/acceptances.json` under the Delo home, moves to version 6: one acceptance per server name, covering the whole start, a digest of each environment value, and under `files` the canonical path and SHA-256 of the executable and of each file an argument names. A version 4 store allows nothing, and a start it held exactly is asked about once as `upgraded`. Version 1 to 3 and version 5 stores are superseded, so each stdio server they accepted asks again.
- A plugin that provides an `mcpAddConsent` service declares it with the module export `providesMcpAddConsent = true`. An mcp-client row waits for every Loader row that declares it, and keeps its server stopped with `McpConsentUnavailableError` when such a row fails to start.
- A discovered `.env` setting `COMSPEC` or `PATHEXT` stops launch; export them instead.

This affects plugins that construct `McpConsentRefusedError`, call `accept`, provide an `McpAddConsent` or read the store, and every person with earlier acceptances.

## Migration

1. Build a start with `resolveServerStart(config)`, or set `resolvedCommand` and `resolvedCwd` in stubs.
2. Replace `new McpConsentRefusedError(name, command, args, reason)` with `new McpConsentRefusedError(start, reason)`, and `consent.accept(command, args)` with `consent.accept(start)`; `env` is `{}` and `cwd` is `''` when unset.
3. In a module that provides an `McpAddConsent` service, add `export const providesMcpAddConsent = true`.
4. Accept each stdio server again when asked; never copy earlier entries.
5. Confirm: an accepted server connects; the store's `v` reads `6`.
