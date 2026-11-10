---
description: "The @delo/plugin-mcp-consent plugin: Delo's MCP add-time consent (mcpAddConsent), the acceptance store under the home's protected state that lets an accepted stdio server command start and holds every other command until the person accepts it."
---

# @delo/plugin-mcp-consent

English | [中文](README.zh.md)

## Summary

This package is the `mcpAddConsent` provider of Delo's MCP add-time consent, the protection the C16 switch [`mcp_add_consent`](../../docs/contracts/c16-parity-composition.md) turns on. A stdio MCP server command runs as a local child process outside the agent sandbox, so before such a server starts, the mcp-client plugin asks the mounted `mcpAddConsent` service whether the configured command is granted. This package answers from the acceptance store, one JSON file under the home's protected state: a command the person accepted with exactly the arguments under review starts at once, and every other review holds the server stopped with a refusal that names the command. No screen or command records an acceptance ([Recording an acceptance](#recording-an-acceptance)), so in effect every stdio server the store does not already hold stays stopped. Off, or without a mounted provider, an mcp-client starts every configured server exactly as upstream does; `@delo/bundle-local` mounts it on in the CLI profile that `delorun` starts, and `delorun headless` and the desktop app run upstream's profiles, which do not mount it.

## Contents

- [The service](#the-service)
- [The acceptance store](#the-acceptance-store)
- [Reviews](#reviews)
- [Recording an acceptance](#recording-an-acceptance)
- [The mcp_add_consent switch](#the-mcp_add_consent-switch)
- [Development](#development)

## The service

`DeloMcpConsent` extends the abstract `McpAddConsent` service of the `@deepseek-ai/dsh-mcp-client` seam, whose `review` the mcp-client consults before it starts each configured stdio server. The review never waits for a person: allowing a command starts the server, and refusing one fails the mcp-client's activation with the typed refusal that names the command and its arguments and carries the provider's reason, so the server stays stopped. A refusal repeats at every boot of the server row until the command is accepted, and an acceptance given after a refusal lets the next boot start the server.

The service resolves the home the process runs with for every review: `resolveDeloHome` of [`@delo/home`](../home/README.md) resolves it from `DELO_HOME` or `~/.delo`, so a home that cannot be resolved is one more review that asks again.

## The acceptance store

The store is `secrets/mcp-add-consent/acceptances.json` under the resolved home. It is a protected file of contract C1 ([`@delo/home`](../home/README.md)): it is read through the refusal rule and written at mode 0600 into a directory created at mode 0700, under the home's `secrets/` directory, which the sandbox's confinement rules deny to confined commands on Linux and macOS (the Windows runner does not confine reads) — a command an acceptance would let run outside the agent sandbox can neither read the list nor add itself to it.

The file is one JSON object `{ v, acceptances }` whose `v` is the format version and whose `acceptances` maps a command to the argument list accepted with it and the acceptance time. A store that exists but is not this version's format — no JSON document, not an object, another version, an unknown field, a wrong acceptance — is refused as a whole: no review counts anything as accepted, and the provider never adds an acceptance to a refused store, so the person fixes or removes the file first.

## Reviews

`review(command)` answers one configured server start:

- an acceptance for the command with exactly the reviewed arguments allows the command;
- an absent store, an unreadable or not this version's format store, a command with no acceptance, a changed argument list, and a home that cannot be resolved all refuse with the reason that asks the person again.

## Recording an acceptance

`accept(command, args)` records that the person accepted a command with an argument list, as the acceptance the reviews allow. Accepting a command again replaces its earlier acceptance, so a changed command is granted by accepting it with the arguments it now carries. The asking surface of Delo's MCP server add flow calls this; until such a surface is mounted, the store only grows through it and every unaccepted command keeps its server stopped.

## The mcp_add_consent switch

The `enabled` config field, the C16 switch `mcp_add_consent`, decides whether the plugin registers the service. It defaults to off — the parity value — and Delo's composition turns it on; a `cordis.yml` row mounts the package and names the switch's value. Off, the plugin registers nothing and every configured server starts exactly as upstream starts it.

## Development

The specs run with `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-mcp-consent`, and the package typechecks with `node_modules/.bin/tsc --noEmit -p delo/packages/plugin-mcp-consent/tsconfig.json`.
