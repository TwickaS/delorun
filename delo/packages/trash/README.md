---
description: "Delo's trash (C8): the delete, restore and purge of a chat or a workspace, the purge effects over every store the contract names, the clear-logs offer and the 30-day retention."
---

# @delo/trash

English | [中文](README.zh.md)

## Summary

This package implements the trash half of [contract C8](../../docs/contracts/c08-archive-and-trash.md): deleting a chat or a workspace moves it into the trash, the person can restore it before its 30-day retention ends, and a purge removes it from every store that holds its content. The retention and residue constants come from [`@delo/contract-archive-and-trash`](../contract-archive-and-trash/README.md), the persisted browser draft inventory from [contract C10](../../docs/contracts/c10-host-qualified-keys.md), and the clear effect the log-clearing offer runs from [`@delo/logs`](../logs/README.md).

## Contents

- [The trash store](#the-trash-store)
- [Deleting](#deleting)
- [Restoring](#restoring)
- [Purging](#purging)
- [The clear-logs offer](#the-clear-logs-offer)
- [Retention](#retention)
- [Wiring](#wiring)
- [Tests](#tests)

## The trash store

One directory per item under the trash root, `<home>/trash`: the item's record `item.json` at 0600 inside a 0700 directory, and a `chats/` tree holding the session directories the delete moved in. A deleted chat's content lives in this one location and nowhere else, so the trash keeps the item's secrets until the purge, and the live stores hold none of them.

## Deleting

`TrashService.deleteChat` locates the chat's session directory under the session-persistence root — first through the project directory the chat's cwd derives, then across every project directory, because a session id is unique across the root — and moves it into the item, with every generation in it. `deleteWorkspace` moves every chat of a workspace into one item and records the workspace id that the workspace's browser entries name. A chat with nothing materialized still lands in the trash as a record without content, so its purge still reaches every store that names it.

## Restoring

`restore` moves every moved chat back to its origin session directory, byte for byte, and removes the item. It never overwrites a session directory that appeared at the origin after the delete; that refusal destroys nothing.

## Purging

`purge` removes the item from each store C8 lists:

- the item's rows in the SQLite FTS5 full-text index of `session-query-sqlite`, through the index seam;
- the session directory of each chat, with every generation in it, plus any generation that reappeared at an origin between the delete and the purge;
- the item's attachment objects under the versioned attachment root;
- the item's spill directories in the `spill` storage;
- the item's draft entries in the browser that performs the purge, under every host scope, as the host-qualified keys contract sets.

The report names every store the purge reached.

## The clear-logs offer

A purge states that fragments of the purged content may remain in the operational logs for up to 14 days, the retention of contract C20. `purge(id, { clearLogs: true })` accepts the offer and clears the home's local logs: rotated files and startup reports are deleted, active files are emptied in place. A retention purge is not a person's choice, so it never clears the logs; the residue stays until the operational logs' own retention removes it.

## Retention

An item's `expiresAt` is its `deletedAt` plus 30 days. `enforceRetention` purges every item whose retention has ended, and `list` marks each item expired or not, so a screen can show what the trash keeps.

## Wiring

The stores are the service's constructor config: `sessionsRoot`, `spillRoots`, `attachmentsRoot` and `logsHome`, plus two seams — `sessionIndex`, wired to session-query-sqlite's engine `forgetSessions`, and `draftStorage`, the studio connection's browser storage. A deployment that runs none of them passes no binding, and the report states only what the purge reached.

## Tests

From the repository root, `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/trash` runs the specs: delete, restore, purge with its canary matrix, and the retention expiry.
