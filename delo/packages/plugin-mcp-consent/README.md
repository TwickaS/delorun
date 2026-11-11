---
description: "The @delo/plugin-mcp-consent plugin: Delo's MCP add-time consent (mcpAddConsent), the acceptance store under the home's protected state that lets an accepted stdio server command start and holds every other command until the person accepts it."
---

# @delo/plugin-mcp-consent

English | [中文](README.zh.md)

## Summary

This package is the `mcpAddConsent` provider of Delo's MCP add-time consent, the protection the C16 switch [`mcp_add_consent`](../../docs/contracts/c16-parity-composition.md) turns on. A stdio MCP server command runs as a local child process outside the agent sandbox, so before such a server starts, the mcp-client plugin asks the mounted `mcpAddConsent` service whether the configured command is granted. This package answers from the acceptance store, one JSON file under the home's protected state: a command the person accepted with exactly the arguments, working directory, configured environment and resolved executable path, command shell and working directory under review starts at once, and every other review holds the server stopped with a refusal that names the command. No screen or command records an acceptance ([Recording an acceptance](#recording-an-acceptance)), so in effect every stdio server the store does not already hold stays stopped. Off, or without a mounted provider, an mcp-client starts every configured server exactly as upstream does; `@delo/bundle-local` mounts it on in the CLI profile that `delorun` starts, `@delo/bundle-headless` mounts it on in the profile `delorun headless` runs, and the desktop app runs upstream's profiles, which do not mount it.

## Contents

- [The service](#the-service)
- [The acceptance store](#the-acceptance-store)
- [Reviews](#reviews)
- [Recording an acceptance](#recording-an-acceptance)
- [The mcp_add_consent switch](#the-mcp_add_consent-switch)
- [Development](#development)

## The service

`DeloMcpConsent` extends the abstract `McpAddConsent` service of the `@deepseek-ai/dsh-mcp-client` seam, whose `review` the mcp-client consults before it starts each configured stdio server. The review never waits for a person: allowing a command starts the server, and refusing one fails the mcp-client's activation with the typed refusal that names the command and its arguments and carries the provider's reason, so the server stays stopped. A refusal repeats at every boot of the server row until the command is accepted, and an acceptance given after a refusal lets the next boot start the server.

A review is shown the server's whole start: the command, its arguments, its working directory and its configured environment entries, with the absolute executable path and canonical working directory the mcp-client resolved them to, and on Windows the canonical `COMSPEC` that runs a `.cmd` or `.bat` file. The mcp-client resolves an empty or relative working directory against the Host's working directory and looks a bare command up in the `PATH` the server would be started with, then spawns the server with those resolved paths, so an accepted start runs the executable the person accepted even when the Host starts in another directory or its `PATH` changes. A command it cannot resolve stops the server with `McpServerStartUnresolvedError` before any review. The refusal names the resolved executable, the working directory and the names of the configured environment variables but none of their values, because a value may be a credential.

The module exports `providesMcpAddConsent` as `true`, the declaration the mcp-client's consent lookup reads under the Loader: an mcp-client row that finds no `mcpAddConsent` service waits until every row has imported its module and this row has started, so a server never starts unreviewed because its row started before this one. If this row fails to start, the server stays stopped with `McpConsentUnavailableError`; with the switch off, the row starts and registers nothing, and the server starts as upstream starts it.

The service resolves the home the process runs with for every review: `resolveDeloHome` of [`@delo/home`](../home/README.md) resolves it from `DELO_HOME` or `~/.delo`, so a home that cannot be resolved is one more review that asks again.

## The acceptance store

The store is `secrets/mcp-add-consent/acceptances.json` under the resolved home. It is a protected file of contract C1 ([`@delo/home`](../home/README.md)): it is read through the refusal rule and written at mode 0600 into a directory created at mode 0700, under the home's `secrets/` directory, which the sandbox's confinement rules deny to confined commands on Linux and macOS (the Windows runner does not confine reads) — a command an acceptance would let run outside the agent sandbox can neither read the list nor add itself to it.

The file is one JSON object `{ v, acceptances }` whose `v` is the format version, 4, and whose `acceptances` maps a command to what was accepted with it: the argument list, the configured working directory, the absolute executable path and canonical working directory they resolved to, for a Windows batch file the canonical `COMSPEC` as `resolvedShell` (absent otherwise), the sorted names of the configured environment variables, a SHA-256 digest of the environment's name and value pairs sorted by name, and the acceptance time. The store holds no environment value in plain text, and the digest is the same whatever order the environment's keys were written in. A store of version 1, written before an acceptance covered the working directory and the environment, of version 2, written before it covered the resolved executable path and working directory, or of version 3, written before it covered the command shell, is superseded: no review counts any of its acceptances, and the next acceptance replaces it with a version 4 store that holds only that acceptance. Any other store that exists but is not this version's format — no JSON document, not an object, another version, an unknown field, a wrong acceptance — is refused as a whole: no review counts anything as accepted, and the provider never adds an acceptance to a refused store, so the person fixes or removes the file first.

## Reviews

`review(command)` answers one configured server start:

- an acceptance for the command with exactly the reviewed arguments, working directory, resolved executable path, command shell, resolved working directory and environment allows the command;
- an absent store, an unreadable, superseded or not this version's format store, a command with no acceptance, a changed argument list, a changed working directory, a command that now resolves to another executable, a batch file that now runs through another `COMSPEC` or none, a working directory that now resolves to another directory, a changed environment variable name or value, and a home that cannot be resolved all refuse with the reason that asks the person again; no reason names an environment value.

The review covers the executable's path, not the file's contents or a symbolic link's target, and the interpreter a script's `#!` line names is looked up in the server's own `PATH` after the spawn.

## Recording an acceptance

`accept(start)` records that the person accepted a server start — the command, its arguments, its working directory, its configured environment and the resolved executable path, command shell and working directory a review was shown — as the acceptance the reviews allow; a start whose resolved paths are not absolute is refused. Accepting a command again replaces its earlier acceptance, so a changed start is granted by accepting it with the arguments, working directory, environment and resolved paths it now carries. The asking surface of Delo's MCP server add flow calls this; until such a surface is mounted, the store only grows through it and every unaccepted command keeps its server stopped.

## The mcp_add_consent switch

The `enabled` config field, the C16 switch `mcp_add_consent`, decides whether the plugin registers the service. It defaults to off — the parity value — and Delo's composition turns it on; a `cordis.yml` row mounts the package and names the switch's value. Off, the plugin registers nothing and every configured server starts exactly as upstream starts it.

## Development

The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-mcp-consent`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delo/packages/plugin-mcp-consent/tsconfig.json`.
