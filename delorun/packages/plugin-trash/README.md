---
description: "Delorun's trash in the studio (C8): the Move to trash actions of a chat's and a workspace's menu, the Trash section in Settings that restores an item or deletes it forever, and the purge of expired items at each start."
---

# @delorun/plugin-trash

English | [中文](README.zh.md)

## Summary

Deleting a chat or a workspace in the studio moves it to the trash instead of destroying it, as [contract C8](../../docs/contracts/c08-archive-and-trash.md) requires. The plugin adds a "Move to trash" action to each chat's and each workspace's menu, a Trash section in Settings that lists what was deleted with the days each item has left, restores an item and deletes one or every item forever, and, at each start, deletes every item older than 30 days. [`@delorun/bundle-local`](../bundle-local/README.md) mounts it in every Delorun CLI profile. The trash itself is [`@delorun/trash`](../trash/README.md).

## Contents

- [How delete is taken over](#how-delete-is-taken-over)
- [The harness half](#the-harness-half)
- [The studio half](#the-studio-half)
- [Configuration](#configuration)
- [Tests](#tests)

## How delete is taken over

Upstream offers no way to delete a chat: its menu archives one, and its persistence has no delete. Upstream's workspace Delete removes the registration and keeps the folder and every chat, which then appear ungrouped. The plugin therefore edits no upstream file. It adds its own action through upstream's context-menu registry for the `session` and `workspace` targets, after upstream's Archive and Delete items, and leaves upstream's items as they are.

## The harness half

[`index.ts`](src/index.ts) serves the [`TRASH_PATHS`](src/wire.ts) routes, each an exact Connection Fetch route that only the owner reaches, with a JSON body it validates. [`operations.ts`](src/operations.ts) runs one operation at a time:

- **Move a chat to the trash**: archive it through upstream's workspace registry with its running work stopped, then move its session directory into the trash. A chat that a live writer holds stays at its origin, archived, until the next start moves it in.
- **Move a workspace to the trash**: archive its chats the same way, move them into one item that records the registration, then remove the registration.
- **Restore**: move the chats back, register a deleted workspace again with its chats, and unarchive every chat the delete archived. A restore that would overwrite a chat at its origin is refused with `TRASH_RESTORE_CONFLICT`.
- **Delete forever and empty**: purge the item from every store the harness mounts: the full-text index through the session-query engine's `forgetSessions`, the live projection cache's `forget` and its documents, the attachments no other chat names, the spill files under the spill store's root, the session generations and the trash's copy. `clearLogs` accepts the offer to clear every operational log of the home now; Empty trash clears them with its last purge, and each log that could not be cleared is reported.
- **At start**: move in the chats that were live when deleted, then purge every item whose 30 days ended, unless the clock is behind an item or the last pass, or jumped more than a year, which is logged.

A failure the plugin cannot name answers `TRASH_FAILED` and is logged with its cause.

## The studio half

[`src/client/`](src/client/index.ts) registers the menu actions, hides every chat in the trash from the sidebar through `uiWorkspace.hideSession`, reports each outcome in a frame-wide toast, and adds the Trash section (`settings.section`, after Privacy) with its trash glyph in the navigation (`settings.section.icon`). The studio half requires `slots`, `locale`, `contextMenus`, `uiWorkspace`, `sessions` and `workspaces`.

Upstream clears the main pane when the chat it shows is archived, which would leave "Choose a workspace to start" on screen and the keyboard on the page. [`leave.ts`](src/client/leave.ts) moves on instead, and only after the move succeeded; a failed move leaves the chat open. After the open chat moved, it opens a new chat in the chat's workspace through `uiWorkspace.startSession`, upstream's New chat, which reuses the workspace's blank chat; a chat in no workspace gets a new chat in the current or latest workspace. After the workspace holding the open chat moved, it waits until the workspace list drops it and opens a new chat in the latest remaining workspace, or leaves the main pane empty when none remains. Once the main pane no longer shows the moved chat, a keyboard left on the page body moves to the composer card (`[data-composer-card]`) without a focus ring, which does not raise a phone's keyboard; on a desktop upstream's composer has already put the keyboard in the message box. Delete forever and Empty trash ask first, state that fragments may remain in the operational logs for up to 14 days, and offer to clear every operational log now. The section lists each damaged item directory with its reason. After a purge the page removes the item's draft entries from its own `localStorage` with `@delorun/trash/drafts`.

## Configuration

| Field | Value in Delorun's CLI profiles |
| --- | --- |
| `trashRoot` | `<home>/trash` |
| `sessionsRoot` | `<home>/sessions` |
| `storagesRoot` | `<home>/storages` |
| `attachmentsRoot` | `<home>/attachments/v1` |
| `logsHome` | `<home>` |

## Tests

From the repository root, `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-trash` runs the harness specs over a scratch home and the studio specs in jsdom. [`leave.client.spec.tsx`](tests/leave.client.spec.tsx) checks where the main pane and the keyboard go after the open chat or its workspace moved to the trash.
