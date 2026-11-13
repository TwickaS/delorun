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
- **Settings → Sidebar → Snooze and idle chats.** The section is a `<section>` named by its `<h3>` heading over one bordered box; the heading reads the settings layout's `--dsh-settings-card-heading-*` variables. The snooze presets show as chips worded as the snooze menu words them, up to eight. Picking a chip opens an editor for its kind, then its length (one minute to thirty days) or its day and time, with its removal, and Add starts a new one. Settle idle chats is off by default; turned on, it counts 3 idle days (1 to 90) after which a chat counts as settled until it changes or the person returns it.
- **Stock look.** The studio half applies only while the Delo look is on. With the stock look the chats keep their states on the harness and show in the stock sidebar without shelves, and switching back to the Delo look restores the shelves.
- **Without Delo's sidebar** the shelves show in upstream's one-list view (Group by, In one list); in the workspace views a snoozed or settled chat stays in its workspace.

## Contract

- **The harness half** ([`src/index.ts`](src/index.ts)) requires `connection` and `storageDomain`, and reads `sessionQuery` when it sweeps. It keeps each chat's `settledAt`, or `snoozedAt` and `snoozedUntil`, with `wokeAt` and `keptAt` (when the person last returned the chat to the list), and `missingSince` while the chat is missing from the session list, in the storage domain `delo_chat_states` (version 1, table `chats`, keyed by session id), and it registers two exact Connection Fetch routes ([`src/wire.ts`](src/wire.ts)). Times come from the harness's clock. The harness half does not depend on the Delo look.
- **`GET /api/deloChatStates.list`** answers every chat that is settled, snoozed or woke, as `{ chats }`. A snooze that ended by its time becomes `wokeAt`, its end, when the list is read. **`POST /api/deloChatStates.set`** takes one change, `settle`, `unsettle`, `snooze` with `until`, `wake` or `seen` (which clears `wokeAt`), for one session, and answers the states after it. Both answers are `no-store`.
- **Validation at the wire.** A request body is parsed against `ChatStateRequest` (strict objects, a session id of 1 to 200 characters from `A-Z a-z 0-9 . _ : -`, a positive integer `until`). A body that is not JSON, names an unknown action, has an extra field or an invalid id is refused with status 400 and the code `invalid-request`; a snooze that does not end between now and a year from now is refused with 400 and `snooze-out-of-range`. Nothing is stored for a refused request. A storage failure is logged with its cause and answered with 500 and `failed`; the answer carries a fixed sentence and none of the failure's text.
- **Validation of stored records.** The storage domain accepts any stored value in the table, and the plugin validates each record against `ChatState` (strict object of non-negative integer times) whenever it reads one. A record that fails is left out of the list, logged once per chat with the validation message, and replaced by the next change to that chat. A malformed record does not keep the plugin from starting or the list from answering.
- **Sweeps.** The harness half sweeps when it starts and then every `pruneMinutes`. A sweep compares the stored chats with the complete session list of `ctx.sessionQuery.listSessions()`. The first sweep that finds a stored chat missing records `missingSince` on its record (a validated field of the stored record that the routes never send); a sweep that finds the chat again clears it; a sweep forgets the record once the chat has been missing for `TRASH_RETENTION_DAYS` of `@delo/contract-archive-and-trash`, the time a trashed chat can be restored. A record that is not valid is not marked and is left to the limit. Then the sweep forgets the states with the oldest changes (the latest of `settledAt`, `snoozedAt`, `wokeAt` and `keptAt`; an invalid record counts as the oldest) until at most `maxRecords` remain. The list is read inside the queue of changes, so a change cannot land for a chat the list was read too early to contain. Nothing is marked or forgotten about missing chats when the harness has no session query service, when reading the list fails (a warning says why), or when the list is empty, which cannot be told from a corpus that has not loaded; the limit applies in each case.
- **Order of changes.** The harness half runs each read and change after the one before it, so concurrent requests for a chat end as if they were sent in turn. A change that fails does not stop the ones after it.
- **The studio half** ([`src/client/index.ts`](src/client/index.ts)) requires `slots`, `locale`, `uiWorkspace`, `configForms`, `contextMenus`, `workspaces` and `connection`, and registers everything inside `ctx.inject(['deloStudio'], applyStudio)`. `deloStudio` is the service `@delo/plugin-theme` provides while the Delo look is on, so with the stock look the entry stays active, as upstream's web boot requires, and registers nothing and provides no service. It reads the states when it starts, at the configured interval and when the window regains focus. An answer to a read that began while a change was waiting, or that a change began after, is not shown, and the answer to an earlier change does not replace the answer to a later one. A read that fails keeps the last states.
- **Shelves.** `ctx.uiWorkspace.registerShelf` adds Snoozed (`delo-snoozed`, order 10) and Settled (`delo-settled`, order 20) to the one-list view. A chat leaves a shelf when its latest prompt is newer than the time it was shelved.
- **Chat menu entries.** Two data contributions to `ctx.contextMenus` for the `session` target: `delo-chat-states.snooze` (order 350) and `delo-chat-states.settle` (order 360), between fork (300) and the copy of the session id (450). Each re-resolves when the states, the archive or the language change, offers nothing for an archived chat, and reads the states again when it runs. Their icons register in the `contextMenu.icon` seat.
- **Hover button.** `delo-settle` (order 50) in `sidebar.workspaces.session.row.action`, before archive (100) and pin (200).
- **Overlay entries.** The snooze dialog and the notice that a change could not be saved are `shell.overlay` entries. A failure to save, from a chat action or from Settings, is a small notice that disappears by itself.
- **Connection announcements.** [`ConnectionStatus.tsx`](src/client/ConnectionStatus.tsx) is the `shell.overlay` entry `delo-chat-states.connection`: a visually hidden polite live region (`role="status"`) over `connection.state`, which announces "Lost the connection to Delo. Reconnecting.", that the device is offline, and "Connected to Delo again." after either, and says nothing for the first connection. Upstream's connection indicator in the sidebar's foot is a button that is not a live region, so a screen reader would otherwise hear the change only on reaching it. The region belongs with the studio's other Delo-look overlay entries here until a sidebar package holds a connection dependency.
- **Settings section.** `settings.section` with the id `delo-chat-states` and order 3, after the Sidebar section. The settings editor's kind and unit, and the snooze dialog's way to pick the end and its unit, are radio groups (`ChoiceGroup` from [`@delo/settings-controls`](../settings-controls/README.md), which the browser bundle inlines from its source), and the section is one of its cards. It registers only while the Host serves the `delo-chat-states` settings namespace, and it writes through `ctx.configForms`. The harness half asks the settings service for no generated form for the namespace.
- **`ctx.deloChatStates`** (type `DeloChatStates`, exported from `@delo/plugin-chat-states/client`) shares `states`, `snoozed`, `settled`, `woke`, `kept` and `autoSettleDays` as observables, `change(request)`, `snoozeOptions()`, `snoozeLeft(until)` and `openCustom(sessionId)`. A sidebar that draws its own shelves reads it as an optional service. Auto-settle is derived by that sidebar and not stored: a chat counts as settled once `autoSettleDays` pass since its latest change or its `keptAt`.
- **Snooze rules** are pure and browser-safe in [`src/snooze.ts`](src/snooze.ts), with every function taking the clock it reads; their wording, from the dictionary and the browser's `Intl` formats, is in [`src/client/snooze-text.ts`](src/client/snooze-text.ts).
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json). CSS uses theme tokens only: `--dsw-*` for colour, type and radius, and `--delo-space-*` from `@delo/plugin-theme` for spacing, which exist only while the Delo look is on, as the studio half does.

## Configuration

The row `delo-chat-states` has five volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs. The studio's Snooze and idle chats section edits the first two; the last two bound the harness's store.

| Field | Default | Meaning |
| --- | --- | --- |
| `snoozePresets` | T3 Code's five: in 1 hour, in 3 hours, the same day at 18:00, the next day at 09:00, Monday at 09:00 | One to eight presets, each `{ kind: after, minutes }` (1 to 43,200) or `{ kind: at, day, time }` with a day from `today` through `sunday` and a `HH:MM` time. |
| `autoSettleDays` | `0` | Idle days (0 to 90) after which a chat counts as settled until it changes or is returned; 0 is off. |
| `refreshSeconds` | `30` | Seconds (5 to 3600) the studio waits between its reads of the states. |
| `maxRecords` | `2000` | Chats (100 to 100,000) whose states the harness keeps; the states with the oldest changes are forgotten beyond it. |
| `pruneMinutes` | `60` | Minutes (1 to 1440) between the sweeps. |

The longest snooze, one year, is a limit of the routes and not a setting.

## Limits

- The studio shows no mark in the workspace views for a snoozed or settled chat.
- The state of a chat moved to the trash is kept, marked with `missingSince`, until the chat has been missing for the trash retention (30 days); a chat restored before then keeps its state. After that the state is forgotten, and a chat restored by other means returns to the list. A chat that is missing for any other reason is treated the same way.
- `maxRecords` can forget the state of a chat that is still in its retention, oldest change first.
- The harness records a waking when the list is next read; a studio that is open shows it at the snooze's end from its own clock.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-chat-states` runs the specs; the harness specs import upstream's built packages, so they need `pnpm run build:artifacts`.

- [`chat-states.spec.ts`](tests/chat-states.spec.ts) checks the sweeps (a missing chat marked and kept, the mark cleared on return, the state forgotten only after the retention and intact when restored within it, nothing changed from a failed, empty or missing list, the limit held oldest first, a periodic sweep until disposal), the changes (settle, return, snooze, wake, seen, one shelf at a time, an ended snooze turned into a waking), the refusal of a snooze that ends now, in the past or beyond a year, the order of concurrent changes, the routes (answers, uncached, refusals with their codes and status, a storage failure answered without its text, closing with the plugin), and the settings limits. Denial tests: each malformed request body is refused and stores nothing, and each malformed stored record, in memory and in a file under the real JSON storage, is left out, logged once, replaced by the next change, and does not stop the list or the start.
- [`api.client.spec.tsx`](tests/api.client.spec.tsx) checks the studio's calls and that an answer that does not match the documented messages is rejected.
- [`store.client.spec.tsx`](tests/store.client.spec.tsx) checks the shelves' members, the wake at a snooze's end, reads at the interval and on focus, the interval's re-arming, a failed read, a failed change's notice, and answers that arrive out of order.
- [`actions.client.spec.tsx`](tests/actions.client.spec.tsx) checks the hover button, the failure notice and the snooze dialog's quick picks, date and duration, refusals and keyboard submit.
- [`connection.client.spec.tsx`](tests/connection.client.spec.tsx) checks that the connection announcements are a polite live region present before anything is said, what each change of the connection state announces, and that the first connection says nothing.
- [`settings.client.spec.tsx`](tests/settings.client.spec.tsx) checks the preset chips and their editor, auto-settle, a refused or failed save, and the read-only state.
- [`plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) checks the registrations and their removal, that the plugin registers nothing without the Delo look, the menu entries and what they send, and `ctx.deloChatStates`.
- [`snooze.client.spec.tsx`](tests/snooze.client.spec.tsx) checks the presets, their labels and times across weekdays and past times, picking, the time left, custom snoozes and their refusals, and the wording.
