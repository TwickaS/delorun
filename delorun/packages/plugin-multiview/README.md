---
description: "The Multiview plugin, for people who follow several agents at once and for maintainers changing its entry points, settings and layout."
kind: "package-library"
---

# @delorun/plugin-multiview

English | [中文](README.zh.md)

## Summary

Multiview shows pinned agents (teammates, subagents, Claude Code and Codex) beside the main chat in a layout the person arranges. This package holds the entry points that put agents into Multiview: the pin button on each row of the header's agents list, the icon toggle at the end of the agents list's button, the layout picker in the list and in the toggle's popover, the one-time hint, the focus command, the observer that pins and opens on a hand-off, and the settings. The layout engine is in `src/layout`, the pager for narrow windows in `src/phone`, the panes in `src/panes` and the layer that draws them in the main chat's content in `src/panel`.

## Contents

- [Using it](#using-it)
- [Panes](#panes)
- [Configuration](#configuration)
- [Contract](#contract)
- [Limits](#limits)
- [Tests](#tests)

## Using it

- **Pin from the agents list.** Each row of the "N subagents" list has a pin button. A pinned agent shows a filled pin, and the same button unpins it. When the pane limit is reached, or the window has no room for another pane, the button of an unpinned agent is disabled and its tooltip and description say why.
- **The popover footer.** Under the agent rows, after a divider, the footer reads "3 pinned · room for 3 more", offers "Pin running" (every running agent that is not pinned, as far as the limit allows) on the same line, and under them "Open Multiview" ("Close Multiview" while it shows) across the rows' full width as the footer's one primary action. "Pin running" is disabled with a reason when no agent runs or every running agent is already pinned.
- **The toggle.** The "N subagents" button in the chat header ends, after a hairline divider, in an icon toggle: Multiview's own glyph (a main pane and two stacked panes, drawn apart from the sidebar's and side panel's icons), the accessible name "Multiview", `aria-pressed` and the theme's pressed fill while Multiview shows, the number of pinned agents in its description and an amber dot while a pinned agent waits for the person's approval. One press opens every pinned agent beside the main chat, and a second press closes it. With nothing pinned the first press pins every running agent first; with agents but nothing pinned or running it is disabled and says so; with no agents, nothing pinned and Multiview closed it is absent, as is the agents button when the chat has no agents. Its target is 32 px square, 44 px under a coarse pointer, and only its colour changes between states. An agent's own chat shows no toggle.
- **The layouts.** The footer starts with the layout picker, whether Multiview is open or not, and a right-click or a held touch on the toggle opens the same picker in a popover under it, which closes after a choice, on Escape (focus returns to the toggle) or on a press outside it. Until the tiling layouts land, `src/entry/picker.tsx` stands in with today's presets (Main and column, Side by side, Grid, Main on top) and Reset to default; presets rearrange the panes and never close one. The first time Multiview opens in a browser, a note under the toggle reads "Drag panes to rearrange · more layouts in the agents list" with a dismiss button; it waits while a menu or dialog is open, hides when one opens, is recorded as seen when it shows (`dsh.multiview-hint.v1.<host>` in `localStorage`, `src/entry/hint.ts`) and never shows again; a browser that blocks storage shows it at most once per page. The focus command, "Multiview: show the main chat only / show Multiview", switches the main view's chat between Multiview and the main chat alone and keeps the pins and the layout; it is listed in the keyboard settings with no default keys, and the toggle's tooltip shows its keys once the person sets them.
- **Hand-offs.** When the open chat hands work to a teammate, a subagent, Claude Code or Codex, the new agent pins itself while a pane is free and Multiview opens, every time, including after the person closed it. Agents already in the chat when it opened are not pinned.
- **Coming back.** Multiview is open or closed per chat, and the choice is kept: a chat that had Multiview open shows it again when the person returns to it, also after reloading the page, including after "Open full chat" on one of its agents. Closing Multiview with the button keeps it closed.

## Panes

Multiview is a layer in the `conversation.main.body` slot, which wraps the main Conversation's content (transcript and composer) under its header. While Multiview is closed the layer renders that content as it is. While it is open the layer draws the pane layout under the unchanged header (title, mode, and the agents list with the toggle), and the main chat's pane is that content itself. An agent's pane is the real chat, drawn by the shared Conversation content in its `pane` variant, so tool rows, approval cards and an agent's banner look and work as in the main view. A pane shows the newest part of its chat and follows the tail.

- **The header.** A grip to drag the pane by, the agent's monogram and name, its task, a status badge (`Working` with the time since the run began, `Needs approval`, `Done` with the run's duration; the main chat shows `Ready` at rest), then a Move to… menu (also swap places with another pane), Open full chat, Stop (while the chat runs and may be stopped) and Close. For a live Claude Code or Codex agent a line of chips shows the program's version, plan and five-hour and weekly use, read from the `agentSeat` projection when `@delorun/plugin-agent-seats` provides it; any other chat has no such line. A finished agent keeps its pane with the Done badge until it is closed. A pane whose chat waits for approval has an amber ring.
- **The reply box.** An agent's pane shows a one-line reply box (the editor and Send); with `compactComposer` off it shows the full composer. The main chat's pane always shows the full composer.
- **Stop** stops that chat only. **Open full chat** opens the chat in the main view, so the chat whose Multiview it was is no longer on screen. **Close** removes the pin and the pane, and closing the last pane returns to the normal chat.
- **References.** Each pane retains its chat with the `multiviewPane` reference source for as long as the pane is in the layout, held by the layer and not by the layout, so dragging a pane, hiding it for lack of room or paging past it on a phone never closes its chat. Closing Multiview releases every reference. A window too small for every pin draws the first panes that fit and says how many are hidden; they stay pinned.
- **On a phone.** Below 768 px the layer draws the pager from `src/phone` instead of the layout: the main chat is the first page and each pin follows in pin order. A page shows the agent's header, the chat, Open full chat and Stop buttons and the position dots above its reply box; the dots are a contribution to `conversation.input.dock`.

## Configuration

The Host row `delorun-multiview` has seven volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoOpen` | `true` | Whether a new hand-off opens Multiview. With `false` the agent still pins itself, the toggle gives the count and shows the amber dot, and nothing opens by itself. |
| `maxPanes` | `6` | Panes at most, the main chat included (2 to 12). |
| `minPaneWidth` | `340` | The least width of a pane in CSS pixels (240 to 1200); a narrow window holds fewer panes. |
| `minPaneHeight` | `240` | The least height of a pane in CSS pixels (160 to 1200). |
| `compactComposer` | `true` | Whether a pane shows the one-line reply box. With `false` every pane shows the full composer. The layer reads it. |
| `reopenOnReturn` | `true` | Whether a chat that had Multiview open reopens it on return. |
| `keepChats` | `50` | How many chats keep their pinned agents and layout in this browser (1 to 500); saving one more forgets the chat saved longest ago. |

## Contract

- **The Host half** ([`src/index.ts`](src/index.ts)) declares `Config` and mounts nothing. The settings service serves the row to the browser.
- **The browser half** ([`src/client/index.ts`](src/client/index.ts)) requires `slots`, `locale`, `sessions`, `configForms` and `uiWorkspace`. It registers the layer `multiview` in `conversation.main.body`, the slots `multiview.pane.header` and `multiview.pane.body`, the dots in `conversation.input.dock`, the dictionaries `delorunMultiview` and `delorunMultiviewPanes`, the pin button in `conversation.session.header.actions.subagent.row.trail`, the footer in `conversation.session.header.actions.subagent.footer`, the toggle in `conversation.session.header.actions.subagent.end`, and provides `ctx.multiview`. When the studio provides `shortcuts` it registers the command `multiview.toggle`, unbound on every profile, because no free and conventional combination exists across the keyboard settings' Web and Desktop profiles.
- **Inert without the layer.** The entry points are mounted only while the layer is registered in `conversation.main.body`. Without it the pin buttons, the footer, the toggle, the focus command and the hand-off observer are all absent, because "Open Multiview" would show nothing; `ctx.multiview` is still provided. The entry points appear when the layer registers and go when it is removed.
- **`ctx.multiview`** (`MultiviewService`) holds each chat's `{ pins, layout, open }` as an observable (`of(chat)`) and the operations `pin`, `unpin`, `pinAll`, `open`, `close`, `setLayout`, `applyPreset`, `resetLayout` and `reportArea`. Pins are the source of truth for which agents have a pane; the layout only places them and is reconciled with the pins on every change. The layer reads this service and calls `setLayout`, `unpin`, `close` and `reportArea`.
- **Opening** sets the chat's open flag in its state; nothing is selected or navigated, and the layer shows the panes at once. The slot `conversation.main.body` is declared by `@deepseek-ai/dsh-client-ui-conversation`, which the Delorun ledger lists (Multiview U3).
- **The hand-off observer** subscribes to the session list. The main chat is the session retained as `mainView`; its agent catalogue is its `subagentCatalog` projection. The agents in the catalogue when the chat becomes the main view, or when its projection is first read, are the baseline. Each later entry is a hand-off. Another chat becoming the main view starts a new baseline.
- **The limit** counts the main chat: with `maxPanes` 6 an agent can be pinned while fewer than 5 are. The window fits `floor(width / minPaneWidth) × floor(height / minPaneHeight)` panes at most; until the layout reports its own area the window's size is used.
- **Persistence** ([`src/store/persist.ts`](src/store/persist.ts)) is the only owner of the saved per-chat state, a client preference in `localStorage`: one key per chat (`dsh.multiview.v1.<host>.<chat>`) with the value `{ v: 1, pins, layout, open }`, validated with zod on read. A value that is not JSON, fails validation, holds more panes than the largest `maxPanes` (12), nests deeper than such a layout can or holds a layout that is not consistent is discarded, removed and reported with a warning, and the chat starts with nothing pinned. A layout may hold a pane the pins do not list; the store reconciles the two. A second key (`dsh.multiview-index.v1.<host>`) lists the saved chats, most recent first; saving a chat beyond `keepChats` removes the least recent chats' keys. A browser that blocks `localStorage` behaves as if nothing was saved. Nothing reaches a model request, so no session event is written.
- **Copy** is in English and Chinese ([`src/entry/locales.ts`](src/entry/locales.ts) and [`src/panes/locales.ts`](src/panes/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json).

## Limits

- The agents popover offers a footer, not a header, so the pinned count and "Pin running" sit in the footer beside "Open Multiview".
- Pinning is per chat. An agent that a chat's agent started (a nested row) pins into the top chat's Multiview.
- With `reopenOnReturn` off, a chat that had Multiview open is closed when the person leaves it and when a page load finds it open.

## Tests

`tests/entry/` runs with `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry`. It covers the hand-off watcher, the store (pins, limit, no-room, layout, persistence calls), `Config` defaults and bounds, the registration (auto-pin on a new catalogue entry and not on existing ones, auto-open each time, auto-open off, the limit, reopen on return, a close from outside), the components (pin states, the disabled reason, the footer, the toggle's pressed state, absence, description, amber dot and tooltip keys, the layout picker, the popover on right-click and long press, the hint and its preference) and the focus command (listed unbound, switching and back with the pins and layout kept, its refusals, the keys it gives the toggle).

`tests/store/` covers the persistence: the round trip, every discard case, the size limits, pruning to `keepChats` and blocked or full storage. `tests/entry/browser/shots.mts` builds a page with the real pin button, footer and toggle over the stock colour tokens and takes light-theme pictures in headless Chromium at 1440 and 390 px: `node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`. The page's header and agents rows stand in for the upstream catalogue component.

`tests/panes/` covers the status and the limits chips, the pane references (retained once, released on close, none left after unmount), the header (badge states, buttons, the Move to… menu), the body variants, the layer (one pane per pin, Stop reaching only its chat, Close, compact and full composer, the waiting ring, the phone pager) and the phone dots.

`tests/studio/shots.mts` takes pictures of the entry points in the built studio with no model key: it builds a scratch home with `delorun/apps/tools/src/demo-home.ts`, adds a hand-written chat that lists two agents, starts the studio on port 18843, pins both agents through the pin buttons and saves light-theme pictures at 1440 px in headless Chromium: `node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <directory> [--keep]`. Run it after `pnpm run build:artifacts` and a build of the `delorun/packages` that have a `build` script.
