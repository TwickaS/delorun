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
- [Live chats](#live-chats)
- [Wiring](#wiring)
- [Tests](#tests)

## The trash store

One directory per item under the trash root, `<home>/trash`: the item's record `item.json` at 0600 inside a 0700 directory, and a `chats/` tree holding the session directories the delete moved in. A deleted chat's content lives in this one location and nowhere else, so the trash keeps the item's secrets until the purge, and the live stores hold none of them.

A record is written whole, to a temporary file renamed into place, and validated whenever it is read: each chat's origin and its place in the trash are two encoded path segments, so a tampered record cannot name a directory outside the configured sessions root or another item's content. `scan` returns the readable items and every damaged item directory with the reason; nothing restores, purges or expires a damaged item, and a person inspects its directory.

## Deleting

`TrashService.deleteChat` locates the chat's session directory under the session-persistence root — first through the project directory the chat's cwd derives, then across every project directory, because a session id is unique across the root — and moves it into the item, with every generation in it. The record names the chat's place in the trash before the move, so a crash between the two leaves either the chat at its origin, which `settle` moves in at the next start, or a record that follows it. `deleteWorkspace` moves every chat of a workspace into one item and records the workspace id that the workspace's browser entries name. A delete also records the chats the deleting home archived for it and, for a workspace, the registration it removed, so a restore can unarchive them and register the workspace again. A chat with nothing materialised still lands in the trash as a record without content, so its purge still reaches every store that names it.

## Restoring

`restore` moves every moved chat back to its origin session directory, byte for byte, and removes the item. It checks every target first and never overwrites a session directory that appeared at an origin after the delete; that refusal moves nothing. The record is rewritten after each chat returns, so a restore that stops partway leaves a record of exactly what the trash still holds, and a later purge never reaches a restored chat. An item directory that still holds chat content is never removed.

## Purging

`purge` removes the item from each store C8 lists:

- the item's rows in the SQLite FTS5 full-text index of `session-query-sqlite`, through the index seam;
- the session directory of each chat, with every generation in it, plus any generation that reappeared at an origin between the delete and the purge;
- each chat's projection-cache document under `<home>/storages/session_projcache/sessions`, including the copy the cache moved aside when it discarded an invalid record, because that document holds the chat's cached title, first message, plan, goal and todos;
- the attachments the item's chats name that no chat under the sessions root and no other item names: the image object, the file object and the file's alias directory of each, under the versioned attachment root; the report counts the attachments it kept because another chat names them;
- the item's spill directories in the `spill` storage;
- the item's draft entries in the browser that performs the purge, under every host scope, as the host-qualified keys contract sets.

The report names every store the purge reached. A store root that is a symbolic link, or that sits under one, is refused with `TRASH_STORE_REFUSED` instead of followed, so a link planted in the home cannot make a purge delete outside the store it names.

## The clear-logs offer

A purge states that fragments of the purged content may remain in the operational logs for up to 14 days, the retention of contract C20. `purge(id, { clearLogs: true })` accepts the offer and clears every local log of the home, not only the item's records: rotated files and startup reports are deleted, active files are emptied in place. The report says `cleared` only when nothing failed, and lists each log it could not clear. A retention purge is not a person's choice, so it never clears the logs; the residue stays until the operational logs' own retention removes it.

## Retention

An item's `expiresAt` is its `deletedAt` plus 30 days. `enforceRetention` purges every item whose retention has ended, and `list` marks each item expired or not, so a screen can show what the trash keeps. The pass trusts the clock only within bounds: it purges nothing and reports `clock-behind` when an item was deleted later than the clock reads or the clock reads earlier than the last pass recorded in `retention.json`, and `clock-jump` once when the clock reads more than 365 days past it.

## Live chats

The JSONL session backend holds a kernel lock on `session.lock` inside a chat's session directory while a write handle is open, which is the whole time a home process keeps the chat live. A delete takes the same lock before it moves the directory and releases it afterwards ([`lease.ts`](src/lease.ts)). When another holder keeps the lock, the chat is recorded as `pending` and stays at its origin; `settle` moves every pending chat in once its lock is free, and a home runs it at start. A purge removes a pending chat where it is, and a restore leaves it there. Windows holds that lock as a named semaphore, so there a chat with a session directory always counts as held.

## Wiring

The stores are the service's constructor config: `sessionsRoot`, `storagesRoot`, `spillRoots`, `attachmentsRoot` and `logsHome`, plus three seams: `sessionIndex`, the full-text index engine's `forgetSessions`; `projectionCache`, the live projection cache's `forget`, so a pending write-behind flush cannot write a purged chat's values back; and `draftStorage`, the browser storage of the connection performing the purge. A deployment that runs none of them passes no binding, and the report states only what the purge reached. [`@delo/plugin-trash`](../plugin-trash/README.md) wires the harness's services and `delorun trash` the home's files. The `session-text` helpers read a chat's generations, decompressing within 1 GiB, and the attachment digests they name; `delorun export` reads chats through them too. The browser half is the separate module `@delo/trash/drafts`, which imports nothing that needs Node, so the studio clears a purged item's drafts from its own `localStorage`, under the host-qualified keys and under the unqualified key a page without a host id writes.

## Tests

From the repository root, `node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/trash` runs the specs: delete, restore, purge with its canary matrix, the retention expiry, the seams, and the delete, restore and settle of a chat against upstream's own JSONL session backend, live writer included.
