---
kind: upgrade-guide
description: "MCP add-time consent judges the whole resolved server start per server name, so McpServerCommand gains fields, McpConsentRefusedError and the consent store's accept take a start, and version 1 to 3 acceptance stores no longer count."
---

# MCP add-time consent judges the whole server start

English | [中文](guide.zh.md)

## Change

A stdio MCP server's add-time consent now covers the server name, the command, its arguments, its working directory and its configured environment, and what they resolve to. `McpServerCommand` from `@deepseek-ai/dsh-mcp-client` gains the required fields `env`, `cwd`, `resolvedCommand` (the absolute file a `PATH` lookup finds, with `PATHEXT` on Windows, such as `C:\Program Files\nodejs\npx.cmd`), `resolvedCwd` (the canonical working directory, the Host's for an empty `cwd`), and the optional `resolvedShell` (the canonical `COMSPEC` that runs a Windows `.cmd` or `.bat` file). With a consent mounted, the mcp-client resolves the start with the new `resolveServerStart`, reviews it, and spawns exactly the resolved paths; a start it cannot resolve stops with `McpServerStartUnresolvedError`. On Windows that includes a file other than `.exe`, `.com`, `.bat` or `.cmd`, a file with a `#!` line, and a shim without an absolute `COMSPEC` file; the lookup skips the working directory.

- `new McpConsentRefusedError(serverName, command, args, reason)` is now `new McpConsentRefusedError(start, reason)`, where `start` is the `McpServerCommand` that was refused. The error gains `cwd`, `envNames`, `resolvedCommand`, `resolvedCwd` and `resolvedShell`; its message names these, without environment values.
- `DeloMcpConsent.accept(command, args)` from `@delo/plugin-mcp-consent` is now `accept(start)`, where `start` is the `McpServerCommand` carrying `serverName`, `command`, `args`, `cwd`, `env`, absolute `resolvedCommand` and `resolvedCwd`, and any `resolvedShell`. `revokeAcceptance(command, acceptedAt, confirmed)` is now `revokeAcceptance(acceptanceId, confirmed)`, and `declineReview` returns a promise.
- The acceptance store, `secrets/mcp-add-consent/acceptances.json` under the Delo home, moves to version 5, which keeps one acceptance per configured server name, covering the whole start and the paths it resolved to, with a digest of each environment variable's value instead of the values. A version 4 store, keyed by the command alone, allows nothing: a server whose exact resolved start it held is reviewed once with the change `upgraded`, and the next write keeps its records under `commandKeyed`. Version 1, 2 and 3 stores are superseded: none of their acceptances count, so each stdio server they accepted asks again, and the next write replaces such a store with a version 5 store that holds only that write.
- The studio route `POST /api/deloMcpConsent.revoke` and the home process's `mcp.revoke` take `acceptanceId` instead of `command` and `acceptedAt`, and `delorun mcp revoke` names the server instead of the command.
- A plugin that provides an `mcpAddConsent` service declares it with the module export `providesMcpAddConsent = true`. An mcp-client row waits for every Loader row that declares it, and keeps its server stopped with `McpConsentUnavailableError` when such a row fails to start.
- A discovered `.env` setting `COMSPEC` or `PATHEXT` stops launch, as for `PATH`; export them instead.

This affects plugins that construct `McpConsentRefusedError`, call `accept`, provide their own `McpAddConsent`, or read the store file, code that calls the revoke route or `mcp.revoke`, and every person whose store holds earlier acceptances.

## Migration

1. Build a start with `resolveServerStart(config)` from `@deepseek-ai/dsh-mcp-client`, or supply `resolvedCommand` and `resolvedCwd` yourself in stubs and tests.
2. Replace `new McpConsentRefusedError(name, command, args, reason)` with `new McpConsentRefusedError(start, reason)`, and `consent.accept(command, args)` with `consent.accept(start)`; the start carries the server row's name, its `env` (an empty object when none) and `cwd` (the empty string for the Host's working directory). Replace `revokeAcceptance(command, acceptedAt, true)` with `revokeAcceptance(acceptanceId, true)`, taking the id from `accepted()`, and await `declineReview`.
3. In a module that provides an `McpAddConsent` service, add `export const providesMcpAddConsent = true`.
4. Accept each stdio server again when its consent asks; do not copy entries from an earlier store.
5. Confirm by starting the profile: an accepted server connects, and the store file's `v` field reads `5`.
