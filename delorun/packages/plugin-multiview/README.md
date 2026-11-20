---
description: "The Multiview plugin, for people who follow several agents at once and for maintainers changing its entry points, settings and layout."
kind: "package-library"
---

# @delorun/plugin-multiview

## Summary

Multiview shows pinned agents (teammates, subagents, Claude Code and Codex) beside the main chat in a layout the person arranges. This package holds the entry points that put agents into Multiview: the pin button on each row of the header's agents list, the header's Multiview button with the Layout menu, the observer that pins and opens on a hand-off, and the settings. The layout engine is in `src/layout`; the `main` panel that draws the panes belongs to the panes lane of the Multiview build.

## Contents

- [Using it](#using-it)
- [Configuration](#configuration)
- [Contract](#contract)
- [Limits](#limits)
- [Tests](#tests)

## Using it

- **Pin from the agents list.** Each row of the "N subagents" list has a pin button. A pinned agent shows a filled pin, and the same button unpins it. When the pane limit is reached, or the window has no room for another pane, the button of an unpinned agent is disabled and its tooltip and description say why.
- **The popover footer.** The footer reads "3 pinned · room for 3 more", offers "Pin running" (every running agent that is not pinned, as far as the limit allows) and "Open Multiview". "Pin running" is disabled with a reason when no agent runs or every running agent is already pinned.
- **The Multiview button.** The chat header shows a Multiview button after the agents list, with the number of pinned agents and an amber dot while a pinned agent waits for the person's approval. One press opens every pinned agent beside the main chat, and a second press closes it. With nothing pinned the first press pins every running agent first; with nothing pinned and nothing running the button is disabled and says so. An agent's own chat shows no button.
- **The Layout menu.** While Multiview shows, a chevron beside the button opens the Layout menu: Main and column, Side by side, Grid, Main on top, and Reset to default. Presets rearrange the panes and never close one.
- **Hand-offs.** When the open chat hands work to a teammate, a subagent, Claude Code or Codex, the new agent pins itself while a pane is free and Multiview opens, every time, including after the person closed it. Agents already in the chat when it opened are not pinned.
- **Coming back.** A chat that had Multiview open opens it again when the person returns to it, also after reloading the page. Closing Multiview with the button, or leaving it with "Open full chat", keeps it closed.

## Configuration

The Host row `delorun-multiview` has seven volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoOpen` | `true` | Whether a new hand-off opens Multiview. With `false` the agent still pins itself, the header button shows the count and the amber dot, and nothing opens by itself. |
| `maxPanes` | `6` | Panes at most, the main chat included (2 to 12). |
| `minPaneWidth` | `340` | The least width of a pane in CSS pixels (240 to 1200); a narrow window holds fewer panes. |
| `minPaneHeight` | `240` | The least height of a pane in CSS pixels (160 to 1200). |
| `compactComposer` | `true` | Whether a pane shows the one-line reply box. With `false` every pane shows the full composer. The panes lane reads it. |
| `reopenOnReturn` | `true` | Whether a chat that had Multiview open reopens it on return. |
| `keepChats` | `50` | How many chats keep their pinned agents and layout in this browser (1 to 500); saving one more forgets the chat saved longest ago. |

## Contract

- **The Host half** ([`src/index.ts`](src/index.ts)) declares `Config` and mounts nothing. The settings service serves the row to the browser.
- **The browser half** ([`src/client/index.ts`](src/client/index.ts)) requires `slots`, `locale`, `sessions`, `layout` and `configForms`. It registers the dictionary `delorunMultiview`, the pin button in `conversation.session.header.actions.subagent.row.trail`, the footer in `conversation.session.header.actions.subagent.footer`, the Multiview button in `conversation.session.header.actions` (order 11, after the agents list at 10), and provides `ctx.multiview`.
- **`ctx.multiview`** (`MultiviewService`) holds each chat's `{ pins, layout, open }` as an observable (`of(chat)`) and the operations `pin`, `unpin`, `pinAll`, `open`, `close`, `setLayout`, `applyPreset`, `resetLayout` and `reportArea`. Pins are the source of truth for which agents have a pane; the layout only places them and is reconciled with the pins on every change. The panes lane's `main` panel, whose id is `multiview`, reads this service and calls `setLayout` and `reportArea`.
- **Opening** selects the `multiview` main panel through `ctx.layout.selectPanel`. Until that panel is registered, opening records the open flag and selects nothing.
- **The hand-off observer** subscribes to the session list. The main chat is the session retained as `mainView`; its agent catalog is its `subagentCatalog` projection. The agents in the catalog when the chat becomes the main view, or when its projection is first read, are the baseline. Each later entry is a hand-off. Another chat becoming the main view starts a new baseline.
- **The limit** counts the main chat: with `maxPanes` 6 an agent can be pinned while fewer than 5 are. The window fits `floor(width / minPaneWidth) × floor(height / minPaneHeight)` panes at most; until the layout reports its own area the window's size is used.
- **Persistence** ([`src/store/persist.ts`](src/store/persist.ts)) is the only owner of the saved per-chat state, a client preference in `localStorage`: one key per chat (`dsh.multiview.v1.<host>.<chat>`) with the value `{ v: 1, pins, layout, open }`, validated with zod on read. A value that is not JSON, fails validation, holds more panes than the largest `maxPanes` (12), nests deeper than such a layout can or holds a layout that is not consistent is discarded, removed and reported with a warning, and the chat starts with nothing pinned. A layout may hold a pane the pins do not list; the store reconciles the two. A second key (`dsh.multiview-index.v1.<host>`) lists the saved chats, most recent first; saving a chat beyond `keepChats` removes the least recent chats' keys. A browser that blocks `localStorage` behaves as if nothing was saved. Nothing reaches a model request, so no session event is written.
- **Copy** is in English and Chinese ([`src/entry/locales.ts`](src/entry/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json).

## Limits

- The agents popover offers a footer, not a header, so the pinned count and "Pin running" sit in the footer beside "Open Multiview".
- Pinning is per chat. An agent that a chat's agent started (a nested row) pins into the top chat's Multiview.
- Reopening on return selects the panel after the chat has opened, so the normal chat can show for a moment first.

## Tests

`tests/entry/` runs with `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry`. It covers the hand-off watcher, the store (pins, limit, no-room, layout, persistence calls), `Config` defaults and bounds, the registration (auto-pin on a new catalog entry and not on existing ones, auto-open each time, auto-open off, the limit, reopen on return, a close from outside) and the components (pin states, the disabled reason, the footer, the count and the amber dot, the Layout menu).

`tests/store/` covers the persistence: the round trip, every discard case, the size limits, pruning to `keepChats` and blocked or full storage. `tests/entry/browser/shots.mts` builds a page with the real pin button, footer and header button over the stock colour tokens and takes light-theme pictures in headless Chromium at 1440 and 390 px: `node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`. The page's header and agents rows stand in for the upstream catalog component.
