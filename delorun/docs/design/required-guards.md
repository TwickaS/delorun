---
description: "Design of required guards: a marker on upstream's guard lookups so that a guard Delorun composes and then loses, through a reload, a failed plugin or a composition without it, refuses the guarded action instead of letting it run unguarded, and why headless runs mount the guards that ask a person."
---

# Required guards

English | [中文](required-guards.zh.md)

## Summary

Delorun's guards reach upstream through optional service lookups: upstream asks for the guard with `ctx.get`, and an absent guard means upstream's own behaviour, which allows the action. That is the right default for upstream, which ships without Delorun's guards, and the wrong one for Delorun: a guard that is reloaded, fails to start or is missing from a composition leaves its action unguarded until it comes back, and nothing refuses. This design adds one marker, a list of required guard names in the consuming row's config, so that a consumer whose guard is required and absent refuses the action with a typed error that names the guard. It also mounts the guards that ask a person in `delorun headless`, where no person answers, so that each refuses there instead of being absent.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [Implementation status](#implementation-status)

## What exists today

- Upstream reads each guard with an optional lookup, and an absent guard allows the action: `fetchGuard` in `packages/web/web-fetch-http/src/index.ts`, `writeConsent` in `packages/fs/tool-fs/src/consent.ts`, `mcpAddConsent` in `packages/mcp/mcp-client/src/index.ts`, `scheduleConsent` in `packages/schedule/schedule/src/runtime.ts` and `packages/schedule/tool-schedule/src/index.ts`, and `sandboxModeGuard` in `packages/interaction/permission-presets/src/index.ts`.
- Delorun provides each guard from its own plugin in `@delorun/bundle-local`'s rows. [C19](../contracts/c19-home-process.md)'s Host invariants check, before boot and once after it, that every row a Delorun bundle inserts is active in the CLI profile. Nothing checks again after boot, so a row that a reload stops, or that fails as it restarts, leaves its guard absent while the Host runs.
- `delorun headless` boots the home's `headless` profile, upstream's `headless` template with `@delorun/bundle-headless` linked into it. It has C1's sandbox overlay, safe mode and the bundle's guard rows, which C19's Host invariants hold before and after boot. Of the guarded consumers it mounts `web-fetch-http`, `tool-fs` and `permission-presets`; it mounts no MCP client and no schedule runtime, and the bundle's MCP and schedule consents guard one that the person's own patch adds. Its approval service has no answerer, so an ask resolves `unavailable` and the asking guard refuses.

## The rules

### The marker

1. Each upstream consumer of a guard takes an optional `requiredGuards` list in its row's config, of the guard service names it consults. The default is the empty list, which keeps upstream's behaviour.
2. A consumer reads a guard through one upstream helper, `guardOf(ctx, name, requiredGuards)`, which returns the guard when it is registered, `undefined` when it is absent and not listed, and throws `GuardMissingError` naming the guard and the consumer when it is absent and listed. The consumer lets that error refuse the action exactly as the guard's own refusal would: the fetch fails, the write is refused, the MCP server does not start, the scheduled delivery does not run, and the mode switch is not appended.
3. The helper reads the guard on every action, as the consumers do today, so a guard that comes back after a reload guards the next action without a restart.
4. Delorun's bundle sets `requiredGuards` on every consuming row it composes, and the composition invariants check that each list names every guard Delorun provides for that row.

### Headless

5. `delorun headless` adds a Delorun overlay, before the sandbox overlay, that mounts the fetch guard, the instruction write consent and the permission defaults, with the same switches as the CLI profile, and sets the `requiredGuards` of the consumers the profile mounts. The headless invariants require those rows active.
6. Under headless, a guard that asks a person refuses, because no answerer is composed: a model write to an instruction file, and a full-access selection for a workspace without a recorded grant, are refused with the guard's reason. A workspace whose full access the person granted in the studio keeps it, because the grant is recorded in the home.
7. The update gate is mounted in headless only to hold the task's first step until the post-boot check passes (`holdUntilChecked`): a headless run is not a home process, no update or stop waits on its chats, and an update or a rollback refuses while it is listed as a data user ([C1](../contracts/c01-home-layout.md)).

### Files the change touches

- Upstream: a new zero-dependency package `packages/util/required-guard` with `guardOf` and `GuardMissingError`, where `guardOf` takes the lookup `ctx.get` as a function, and the six consumer sites above, each gaining the `requiredGuards` config field and its README entry.
- Delorun: `@delorun/bundle-local`'s rows set `requiredGuards`; a headless overlay beside them; `delorun/apps/cli/src/compose.ts` gains the headless rows and the `requiredGuards` check; C16 and C19 state the rules.

## What this does not protect against

- **A guard that is present and wrong.** The marker refuses only an absent guard; a registered guard that allows what it should refuse is outside this design.
- **Delorun rows with their own lifecycle gaps.** `plugin-main-chat` restricts the main chat's tools on `agent/created`, so a chat created while the row is stopped keeps them; the trash, workspaces and chat-state plugins let queued work run after their row is disposed. Each needs its own fix in its plugin.
- **Safe mode.** Safe mode keeps Delorun's guard rows, so it does not drop the marker's guards; it does drop third-party rows, which the marker does not cover.

## Denial tests

- `a required fetch guard that is absent refuses the fetch and names the guard`
- `a required write consent that is absent refuses the write`
- `a required MCP consent that is absent leaves the stdio server stopped`
- `a required schedule consent that is absent refuses the delivery`
- `a required sandbox mode guard that is absent refuses the switch and appends no mode event`
- `an unlisted absent guard keeps upstream's behaviour`
- `a guard that returns after a reload guards the next action`
- `a headless model write to an instruction file is refused`
- `a headless full-access selection without a recorded grant is refused`

## Implementation status

The headless rules 5 to 7 are built as `@delorun/bundle-headless`, a bundle linked into the `headless` profile, not as an overlay; the `requiredGuards` marker and the rules before them are not built.
