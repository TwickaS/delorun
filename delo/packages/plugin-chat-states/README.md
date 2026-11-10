---
description: "The chat-states plugin, for people who want chats out of the sidebar's way for a while and for maintainers changing where the states are kept, which routes serve them and which sidebar seams the studio half uses."
kind: "package-bundle"
---

# @delo/plugin-chat-states

## Summary

A person snoozes a chat until later or settles a chat that is done, and it moves to a folded Snoozed or Settled shelf below the sidebar's chat list. The harness keeps each chat's state in its storage, outside the session log, so the model never sees it and every browser and phone shows the same sidebar. The studio half registers the shelves, adds Snooze and Settle to a chat's menu, adds a settle hover button, and edits the snooze presets and auto-settle in Settings. The snooze presets and the snooze dialog are ported from [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, under the MIT licence ([notice](THIRD_PARTY_NOTICES.md)). `@delo/bundle-studio` mounts the package as the row `delo-chat-states`.

## Contents

- [Using it](#using-it)
- [Contract](#contract)
- [Configuration](#configuration)
- [Limits](#limits)
- [Tests](#tests)

## Using it

- **Snooze.** A chat's menu offers Snooze, which opens the snooze dialog. The dialog lists the person's presets as quick picks, each with the time the chat comes back and none that has already passed today, then a date and time or a length in minutes, hours or days, with the time the chat comes back shown before it is snoozed. A snoozed chat offers Wake now. A snooze ends at its time or when the person sends the chat a new message. A chat whose snooze ended by its time is marked as woke until the person opens it or dismisses the mark.
- **Settle.** A chat's menu and its hover buttons offer Settle, and a settled chat offers Return to the list. A settled chat opens normally from its shelf, and a new message returns it to the list.
- **One shelf at a time.** Settling ends a snooze and snoozing ends a settle. A pinned chat stays under Pinned, a chat that is running or waiting on the person stays in the list, and an archived chat offers neither action.
- **Settings, Snooze and settle.** The snooze presets show as chips worded as the snooze menu words them, up to eight. Picking a chip opens an editor for its length (one minute to thirty days) or its day and time, with its removal, and Add starts a new one. Settle idle chats is off by default; turned on, it counts 3 idle days (1 to 90) after which a chat counts as settled until it changes or the person returns it.
- **Stock look.** The studio half applies only while the Delo look is on. With the stock look the chats keep their states on the harness and show in the stock sidebar without shelves, and switching back to the Delo look restores the shelves.
- **Without Delo's sidebar** the shelves show in upstream's one-list view (Group by, In one list); in the workspace views a snoozed or settled chat stays in its workspace.

## Contract

- **The harness half** ([`src/index.ts`](src/index.ts)) requires `connection` and `storageDomain`. It keeps each chat's `settledAt`, or `snoozedAt` and `snoozedUntil`, with `wokeAt` and `keptAt` (when the person last returned the chat to the list), in the storage domain `delo_chat_states` (version 1, table `chats`, keyed by session id), and it registers two exact Connection Fetch routes ([`src/wire.ts`](src/wire.ts)). Times come from the harness's clock. The harness half does not depend on the Delo look.
- **`GET /api/deloChatStates.list`** answers every chat that is settled, snoozed or woke, as `{ chats }`. A snooze that ended by its time becomes `wokeAt`, its end, when the list is read. **`POST /api/deloChatStates.set`** takes one change, `settle`, `unsettle`, `snooze` with `until`, `wake` or `seen` (which clears `wokeAt`), for one session, and answers the states after it. Both answers are `no-store`.
- **Validation at the wire.** A request body is parsed against `ChatStateRequest` (strict objects, a session id of 1 to 200 characters from `A-Z a-z 0-9 . _ : -`, a positive integer `until`). A body that is not JSON, names an unknown action, has an extra field or an invalid id is refused with status 400 and the code `invalid-request`; a snooze that does not end between now and a year from now is refused with 400 and `snooze-out-of-range`. Nothing is stored for a refused request. A storage failure is logged with its cause and answered with 500 and `failed`; the answer carries a fixed sentence and none of the failure's text.
- **Validation of stored records.** The storage domain accepts any stored value in the table, and the plugin validates each record against `ChatState` (strict object of non-negative integer times) whenever it reads one. A record that fails is left out of the list, logged once per chat with the validation message, and replaced by the next change to that chat. A malformed record does not keep the plugin from starting or the list from answering.
- **Order of changes.** The harness half runs each read and change after the one before it, so concurrent requests for a chat end as if they were sent in turn. A change that fails does not stop the ones after it.
- **The studio half** ([`src/client/index.ts`](src/client/index.ts)) requires `slots`, `locale`, `uiWorkspace`, `configForms`, `contextMenus` and `workspaces`, and registers everything inside `ctx.inject(['deloStudio'], applyStudio)`. `deloStudio` is the service `@delo/plugin-theme` provides while the Delo look is on, so with the stock look the entry stays active, as upstream's web boot requires, and registers nothing and provides no service. It reads the states when it starts, at the configured interval and when the window regains focus. An answer to a read that began while a change was waiting, or that a change began after, is not shown, and the answer to an earlier change does not replace the answer to a later one. A read that fails keeps the last states.
- **Shelves.** `ctx.uiWorkspace.registerShelf` adds Snoozed (`delo-snoozed`, order 10) and Settled (`delo-settled`, order 20) to the one-list view. A chat leaves a shelf when its latest prompt is newer than the time it was shelved.
- **Chat menu entries.** Two data contributions to `ctx.contextMenus` for the `session` target: `delo-chat-states.snooze` (order 350) and `delo-chat-states.settle` (order 360), between fork (300) and the copy of the session id (450). Each re-resolves when the states, the archive or the language change, offers nothing for an archived chat, and reads the states again when it runs. Their icons register in the `contextMenu.icon` seat.
- **Hover button.** `delo-settle` (order 50) in `sidebar.workspaces.session.row.action`, before archive (100) and pin (200).
- **Overlay entries.** The snooze dialog and the notice that a change could not be saved are `shell.overlay` entries. A failure to save, from a chat action or from Settings, is a small notice that disappears by itself.
- **Settings section.** `settings.section` with the id `delo-chat-states` and order 3, after the Sidebar section. It registers only while the Host serves the `delo-chat-states` settings namespace, and it writes through `ctx.configForms`. The harness half asks the settings service for no generated form for the namespace.
- **`ctx.deloChatStates`** (type `DeloChatStates`, exported from `@delo/plugin-chat-states/client`) shares `states`, `snoozed`, `settled`, `woke`, `kept` and `autoSettleDays` as observables, `change(request)`, `snoozeOptions()`, `snoozeLeft(until)` and `openCustom(sessionId)`. A sidebar that draws its own shelves reads it as an optional service. Auto-settle is derived by that sidebar and not stored: a chat counts as settled once `autoSettleDays` pass since its latest change or its `keptAt`.
- **Snooze rules** are pure and browser-safe in [`src/snooze.ts`](src/snooze.ts), with every function taking the clock it reads; their wording, from the dictionary and the browser's `Intl` formats, is in [`src/client/snooze-text.ts`](src/client/snooze-text.ts).
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json). CSS uses theme tokens only.

## Configuration

The row `delo-chat-states` has three volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs. The studio's Snooze and settle section edits the first two.

| Field | Default | Meaning |
| --- | --- | --- |
| `snoozePresets` | T3 Code's five: in 1 hour, in 3 hours, today 18:00, tomorrow 09:00, Monday 09:00 | One to eight presets, each `{ kind: after, minutes }` (1 to 43,200) or `{ kind: at, day, time }` with a day from `today` through `sunday` and a `HH:MM` time. |
| `autoSettleDays` | `0` | Idle days (0 to 90) after which a chat counts as settled until it changes or is returned; 0 is off. |
| `refreshSeconds` | `30` | Seconds (5 to 3600) between the studio's reads of the states. |

The longest snooze, one year, is a limit of the routes and not a setting.

## Limits

- The studio shows no mark in the workspace views for a snoozed or settled chat.
- The harness does not remove the state of a chat that is deleted.
- The harness records a waking when the list is next read; a studio that is open shows it at the snooze's end from its own clock.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-chat-states` runs the specs; the harness specs import upstream's built packages, so they need `pnpm run build:artifacts`.

- [`chat-states.spec.ts`](tests/chat-states.spec.ts) checks the changes (settle, return, snooze, wake, seen, one shelf at a time, an ended snooze turned into a waking), the refusal of a snooze that ends now, in the past or beyond a year, the order of concurrent changes, the routes (answers, uncached, refusals with their codes and status, a storage failure answered without its text, closing with the plugin), and the settings limits. Denial tests: each malformed request body is refused and stores nothing, and each malformed stored record, in memory and in a file under the real JSON storage, is left out, logged once, replaced by the next change, and does not stop the list or the start.
- [`api.client.spec.tsx`](tests/api.client.spec.tsx) checks the studio's calls and that an answer that does not match the documented messages is rejected.
- [`store.client.spec.tsx`](tests/store.client.spec.tsx) checks the shelves' members, the wake at a snooze's end, reads at the interval and on focus, the interval's re-arming, a failed read, a failed change's notice, and answers that arrive out of order.
- [`actions.client.spec.tsx`](tests/actions.client.spec.tsx) checks the hover button, the failure notice and the snooze dialog's quick picks, date and duration, refusals and keyboard submit.
- [`settings.client.spec.tsx`](tests/settings.client.spec.tsx) checks the preset chips and their editor, auto-settle, a refused or failed save, and the read-only state.
- [`plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) checks the registrations and their removal, that the plugin registers nothing without the Delo look, the menu entries and what they send, and `ctx.deloChatStates`.
- [`snooze.client.spec.tsx`](tests/snooze.client.spec.tsx) checks the presets, their labels and times across weekdays and past times, picking, the time left, custom snoozes and their refusals, and the wording.
