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
- [Layouts](#layouts)
- [Settings](#settings)
- [Keyboard](#keyboard)
- [Configuration](#configuration)
- [Contract](#contract)
- [Limits](#limits)
- [Tests](#tests)

## Using it

- **Pin from the agents list.** Each row of the "N subagents" list has a pin button. A pinned agent shows a filled pin, and the same button unpins it. When the pane limit is reached, or the window has no room for another pane, the button of an unpinned agent is disabled and its tooltip and description say why.
- **The popover footer.** Under the agent rows, after a divider, the footer reads "3 pinned · room for 3 more", offers "Pin running" (every running agent that is not pinned, as far as the limit allows) on the same line, and under them "Open Multiview" ("Close Multiview" while it shows) across the rows' full width as the footer's one primary action. "Pin running" is disabled with a reason when no agent runs or every running agent is already pinned.
- **The toggle.** The "N subagents" button in the chat header ends, after a hairline divider, in an icon toggle: Multiview's own glyph (a main pane and two stacked panes, drawn apart from the sidebar's and side panel's icons), the accessible name "Multiview", `aria-pressed` and the theme's pressed fill while Multiview shows, the number of pinned agents in its description and an amber dot while a pinned agent waits for the person's approval. One press opens every pinned agent beside the main chat, and a second press closes it. With nothing pinned the first press pins every running agent first; with agents but nothing pinned or running it is disabled and says so; with no agents, nothing pinned and Multiview closed it is absent, as is the agents button when the chat has no agents. Its target is 32 px square, 44 px under a coarse pointer, and only its colour changes between states. An agent's own chat shows no toggle.
- **The layouts.** The footer starts with the layout picker, whether Multiview is open or not, and a right-click or a held touch on the toggle opens the same picker in a popover under it, which closes after a choice, on Escape (focus returns to the toggle) or on a press outside it. The picker is `LayoutPicker` from `src/layout`: a strip of thumbnails in the footer, thumbnails with names in the popover; a choice rearranges the panes and never closes one. The first time Multiview opens in a browser, a note under the toggle reads "Drag panes to rearrange · more layouts in the agents list" with a dismiss button; it waits while a menu or dialog is open, hides when one opens, is recorded as seen when it shows (`dsh.multiview-hint.v1.<host>` in `localStorage`, `src/entry/hint.ts`) and never shows again; a browser that blocks storage shows it at most once per page. The focus command, "Multiview: show the main chat only / show Multiview", switches the main view's chat between Multiview and the main chat alone and keeps the pins and the layout; it is listed in the keyboard settings with no default keys, and the toggle's tooltip shows its keys once the person sets them.
- **Hand-offs.** When the open chat hands work to a teammate, a subagent, Claude Code or Codex, the new agent pins itself while a pane is free and Multiview opens, every time, including after the person closed it. Agents already in the chat when it opened are not pinned.
- **Coming back.** Multiview is open or closed per chat, and the choice is kept: a chat that had Multiview open shows it again when the person returns to it, also after reloading the page, including after "Open full chat" on one of its agents. Closing Multiview with the button keeps it closed.

## Panes

Multiview is a layer in the `conversation.main.body` slot, which wraps the main Conversation's content (transcript and composer) under its header. While Multiview is closed the layer renders that content as it is. While it is open the layer draws the pane layout under the unchanged header (title, mode, and the agents list with the toggle), and the main chat's pane is that content itself. An agent's pane is the real chat, drawn by the shared Conversation content in its `pane` variant, so tool rows, approval cards and an agent's banner look and work as in the main view. A pane shows the newest part of its chat and follows the tail.

- **The header.** A grip to drag the pane by, the agent's monogram and name, its task, a status badge (`Working` with the time since the run began, `Needs approval`, `Done` with the run's duration; the main chat shows `Ready` at rest), then a Move to… menu (also swap places with another pane), Open full chat, Stop (while the chat runs and may be stopped) and Close. For a live Claude Code or Codex agent a line of chips shows the program's version, plan and five-hour and weekly use, read from the `agentSeat` projection when `@delorun/plugin-agent-seats` provides it; any other chat has no such line. A finished agent keeps its pane with the Done badge until it is closed. A pane whose chat waits for approval has an amber ring.
- **The reply box.** An agent's pane shows a one-line reply box (the editor and Send); with `compactComposer` off it shows the full composer. The main chat's pane always shows the full composer.
- **Stop** stops that chat only. **Open full chat** opens the chat in the main view, so the chat whose Multiview it was is no longer on screen. **Close** removes the pin and the pane, and closing the last pane returns to the normal chat.
- **References.** Each pane retains its chat with the `multiviewPane` reference source for as long as the pane is in the layout, held by the layer and not by the layout, so dragging a pane, turning it into a tab for lack of room or paging past it on a phone never closes its chat. Closing Multiview releases every reference.
- **On a phone.** Below 768 px the layer draws the pager from `src/phone` instead of the layout: the main chat is the first page and each pin follows in pin order. A page shows the agent's header, the chat, Open full chat and Stop buttons and the position dots above its reply box; the dots are a contribution to `conversation.input.dock`.

## Layouts

Every layout only places the panes the pins name; none opens or closes one. The engine is [`src/layout/presets.ts`](src/layout/presets.ts) (the layouts), [`fit.ts`](src/layout/fit.ts) (the least pane size), [`arrange.ts`](src/layout/arrange.ts) (what a chat shows) and [`shape.ts`](src/layout/shape.ts) (Yours). The picker ([`LayoutPicker.tsx`](src/layout/LayoutPicker.tsx)) is a radio group with a thumbnail and an English and Chinese name per layout, in a `row` variant for the agents list's footer and a `grid` variant for a dialog.

| Layout | Panes |
| --- | --- |
| Auto (the default) | Up to `autoColumns` panes (3) side by side. From four: stacked rows when the area is taller than wide (tabs when a row would be lower than `minPaneHeight`), Centred main when the area's aspect is at least 2.1 or it is at least 2560 px wide, and Main and stack with a grid stack otherwise. |
| Main and stack | The main chat on the `mainSide` beside the others, stacked as rows, columns, a grid or a spiral (`stackStyle`), at the `mainShare` (56 %, 25 to 75). Dragging the divider changes the share. A layout saved as `main-column` reads as Main and stack on the left with rows. |
| Side by side, Stacked rows, Grid, Main on top | Columns, rows, a grid that fills by rows, the main chat over a row of the others. |
| Spiral | Each pane halves the space left, turning right, down, left and up. Dwindle is left out because its thumbnail reads like Spiral. |
| Centred main | The main chat in the middle at about 50 %, the others alternately right and left. |
| Activity mosaic | Working and waiting panes in a grid over the top 72 %, finished ones in a strip below. It changes 700 ms after the activity settles and never while the person is busy. |
| Tabs | Every pane as a tab of one leaf; unrelated to the header's focus key. |
| Yours | The person's own arrangement, kept as a shape of slots (slot 0 the main chat, then pin order, unless a swap changed it) rather than chat ids, so it applies to any chat's agents. |

- **The least pane size.** A pane that would be narrower than `minPaneWidth` or lower than `minPaneHeight`, after the `paneGap` space around it, joins its nearest neighbour as a tab, the smallest first; no pane is hidden.
- **When Auto rearranges.** On a pin or unpin at once, and on a resize of the area 200 ms after it settles. Not while the pointer is down in the layout or within 1.5 s of a key typed in a pane's text field ([`src/panel/busy.ts`](src/panel/busy.ts)); the layout keys are not typing.
- **Motion.** A layout change glides each pane from its old to its new place by a transform only, for 240 ms, interruptible ([`flip.ts`](src/layout/flip.ts)). Reduced motion turns it off, and `mosaicMotion` `reduced` turns it off for the mosaic.
- **Yours.** Moving a pane (and resizing, unless `saveOn` is `move`) saves the arrangement as Yours for the `rememberScope` and makes it the default. A toast says "Saved as your default layout · Undo", naming the workspace or the chat for those scopes; Undo restores the previous default and the chat's previous arrangement. Reset to Auto clears Yours and the default at the studio and in the chat's workspace. Choosing a layout in the picker also makes it the default for new Multiviews; a chat already arranged keeps its own until the person chooses for it.

## Settings

Settings has a Multiview page (`settings.section` `delorun-multiview`, order 18, after Browser) with four groups, each option with one sentence and the default layout with thumbnails: **Layout** (`defaultLayout`, `mainSide`, `stackStyle`, `mainShare`, `autoColumns`, `mosaicMotion`), **Your arrangement** (`rememberScope`, `saveOn`, and Reset to Auto), **Panes** (`maxPanes`, `minPaneWidth`, `minPaneHeight`, `paneGap` as a slider with its number, `compactComposer`) and **Behaviour** (`autoOpen`, `reopenOnReturn`, `keepChats`). The page writes through `configForms`, and the Plugins page's row form edits the same fields. The studio and workspace defaults are Host settings, so every device of the studio shares them; which workspace a chat belongs to comes from `ctx.workspaces`. The narrowest scope that has a value wins: the chat's own arrangement, then its workspace's, then the studio's.

## Keyboard

The commands register in `ctx.shortcuts` with no keys, so the person binds them in Settings, Keyboard: `multiview.layout.next` and `.previous`, `multiview.focus.left`, `.right`, `.up` and `.down`, `multiview.pane.swapMain` and `multiview.main.grow` and `.shrink` ([`src/panel/keys.ts`](src/panel/keys.ts)). They act on the most recently opened Multiview and pass when none is open. They ship unbound because every conventional chord for these moves types a character with AltGr on many keyboards or switches desktops in common window systems. Focus moves to the nearest pane in that direction; grow and shrink change the main share by 5 points, or the main chat's own size in Yours.

## Configuration

The Host row `delorun-multiview` has eighteen volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs.

| Field | Default | Meaning |
| --- | --- | --- |
| `autoOpen` | `true` | Whether a new hand-off opens Multiview. With `false` the agent still pins itself, the toggle gives the count and shows the amber dot, and nothing opens by itself. |
| `maxPanes` | `6` | Panes at most, the main chat included (2 to 12). |
| `minPaneWidth` | `340` | The least width of a pane in CSS pixels (240 to 1200); a narrow window holds fewer panes. |
| `minPaneHeight` | `240` | The least height of a pane in CSS pixels (160 to 1200). |
| `paneGap` | `0` | The space between panes and around the layout's edge in CSS pixels (0 to 32), changed live; the least pane size and the divider hit areas (at least 12 px, 24 px under a finger) still hold. |
| `compactComposer` | `true` | Whether a pane shows the one-line reply box. With `false` every pane shows the full composer. The layer reads it. |
| `reopenOnReturn` | `true` | Whether a chat that had Multiview open reopens it on return. |
| `keepChats` | `50` | How many chats keep their pinned agents and layout in this browser (1 to 500); saving one more forgets the chat saved longest ago. |
| `defaultLayout` | `auto` | The layout a new Multiview takes: one of the layouts above, or `yours`. |
| `mainSide` | `left` | Main and stack's side for the main chat (`left` or `right`). |
| `stackStyle` | `rows` | How Main and stack places the others: `rows`, `columns`, `grid` or `spiral`. |
| `mainShare` | `56` | The main chat's share in percent (25 to 75); dragging the divider sets it. |
| `autoColumns` | `3` | How many panes Auto puts side by side before it changes layout (1 to 6). |
| `mosaicMotion` | `on` | `reduced` turns off the mosaic's glide. |
| `rememberScope` | `studio` | Where Yours is saved: `studio`, `workspace` or `chat`. |
| `saveOn` | `move-or-resize` | With `move`, resizing a pane keeps the change with that chat. |
| `yours` | `null` | Hidden: the studio's Yours shape. |
| `workspaceLayouts` | `{}` | Hidden: per workspace id, its `defaultLayout`, `yours`, `mainSide` and `stackStyle`. |

## Contract

- **The Host half** ([`src/index.ts`](src/index.ts)) declares `Config` and mounts nothing. The settings service serves the row to the browser.
- **The browser half** ([`src/client/index.ts`](src/client/index.ts)) requires `slots`, `locale`, `sessions`, `configForms`, `uiWorkspace`, `workspaces` and `shortcuts`. It registers the layer `multiview` in `conversation.main.body`, the slots `multiview.pane.header` and `multiview.pane.body`, the dots in `conversation.input.dock`, the dictionaries `delorunMultiview`, `delorunMultiviewPanes` and `delorunMultiviewLayouts`, the Multiview settings section, the pin button in `conversation.session.header.actions.subagent.row.trail`, the footer in `conversation.session.header.actions.subagent.footer`, the toggle in `conversation.session.header.actions.subagent.end`, and provides `ctx.multiview`. It registers the command `multiview.toggle` and the layout keys, all unbound on every profile, because no free and conventional combination exists across the keyboard settings' Web and Desktop profiles.
- **Inert without the layer.** The entry points are mounted only while the layer is registered in `conversation.main.body`. Without it the pin buttons, the footer, the toggle, the focus command and the hand-off observer are all absent, because "Open Multiview" would show nothing; `ctx.multiview` is still provided. The entry points appear when the layer registers and go when it is removed.
- **`ctx.multiview`** (`MultiviewService`) holds each chat's `{ pins, layout, open }` as an observable (`of(chat)`) and the operations `pin`, `unpin`, `pinAll`, `open`, `close`, `setLayout`, `applyPreset`, `resetLayout` and `reportArea`, and the layout operations `defaultsOf`, `arrangementOf`, `layoutFor`, `chooseLayout`, `adoptArrangement`, `undoDefault`, `resetToAuto`, `setMainShare`, `setStackOptions`, `cycleLayout`, `swapWithMain` and `resizeMain`. Pins are the source of truth for which agents have a pane; the layout only places them and is reconciled with the pins on every change. The layer reads this service and calls `setLayout`, `unpin`, `close` and `reportArea`.
- **Opening** sets the chat's open flag in its state; nothing is selected or navigated, and the layer shows the panes at once. The slot `conversation.main.body` is declared by `@deepseek-ai/dsh-client-ui-conversation`, which the Delorun ledger lists (Multiview U3).
- **The hand-off observer** subscribes to the session list. The main chat is the session retained as `mainView`; its agent catalogue is its `subagentCatalog` projection. The agents in the catalogue when the chat becomes the main view, or when its projection is first read, are the baseline. Each later entry is a hand-off. Another chat becoming the main view starts a new baseline.
- **The limit** counts the main chat: with `maxPanes` 6 an agent can be pinned while fewer than 5 are. The window fits `floor(width / minPaneWidth) × floor(height / minPaneHeight)` panes at most; until the layout reports its own area the window's size is used.
- **Persistence** ([`src/store/persist.ts`](src/store/persist.ts)) is the only owner of the saved per-chat state, a client preference in `localStorage`: one key per chat (`dsh.multiview.v1.<host>.<chat>`) with the value `{ v: 1, pins, layout, open }` and, since the layout picker, the optional `arrangement` (the layout the chat follows, or `custom`), `slots` and `shape` (the chat's own copy of Yours); a value saved before them loads unchanged and keeps its layout. It is validated with zod on read. A value that is not JSON, fails validation, holds more panes than the largest `maxPanes` (12), nests deeper than such a layout can or holds a layout that is not consistent is discarded, removed and reported with a warning, and the chat starts with nothing pinned. A layout may hold a pane the pins do not list; the store reconciles the two. A second key (`dsh.multiview-index.v1.<host>`) lists the saved chats, most recent first; saving a chat beyond `keepChats` removes the least recent chats' keys. A browser that blocks `localStorage` behaves as if nothing was saved. Nothing reaches a model request, so no session event is written.
- **Copy** is in English and Chinese ([`src/entry/locales.ts`](src/entry/locales.ts), [`src/panes/locales.ts`](src/panes/locales.ts) and [`src/layout/locales.ts`](src/layout/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json).

## Limits

- The agents popover offers a footer, not a header, so the pinned count and "Pin running" sit in the footer beside "Open Multiview".
- Pinning is per chat. An agent that a chat's agent started (a nested row) pins into the top chat's Multiview.
- With `reopenOnReturn` off, a chat that had Multiview open is closed when the person leaves it and when a page load finds it open.

## Tests

`tests/entry/` runs with `node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/plugin-multiview/tests/entry`. It covers the hand-off watcher, the store (pins, limit, no-room, layout, persistence calls), `Config` defaults and bounds, the registration (auto-pin on a new catalogue entry and not on existing ones, auto-open each time, auto-open off, the limit, reopen on return, a close from outside), the components (pin states, the disabled reason, the footer, the toggle's pressed state, absence, description, amber dot and tooltip keys, the layout picker, the popover on right-click and long press, the hint and its preference) and the focus command (listed unbound, switching and back with the pins and layout kept, its refusals, the keys it gives the toggle).

`tests/layout/tiling.spec.ts` runs every layout at one to eight panes in 1440×900, 3440×1440 and 900×1400 and covers the least pane size, Auto's switch points, Main and stack, the shapes, the keyboard moves and cycling. `tests/store/defaults.client.spec.ts` covers scope resolution, Yours across chats, Undo, Reset to Auto and the moving-only rule. `tests/layout/browser/tiling-shots.mts` takes pictures of every layout at 1440 px with 2, 3, 5 and 7 panes, the picker and the Settings page in light and dark: `node --import tsx/esm delorun/packages/plugin-multiview/tests/layout/browser/tiling-shots.mts <directory>`.

`tests/store/` covers the persistence: the round trip, values saved before the layout picker, every discard case, the size limits, pruning to `keepChats` and blocked or full storage. `tests/entry/browser/shots.mts` builds a page with the real pin button, footer and toggle over the stock colour tokens and takes light-theme pictures in headless Chromium at 1440 and 390 px: `node --import tsx/esm delorun/packages/plugin-multiview/tests/entry/browser/shots.mts <directory>`. The page's header and agents rows stand in for the upstream catalogue component.

`tests/panes/` covers the status and the limits chips, the pane references (retained once, released on close, none left after unmount), the header (badge states, buttons, the Move to… menu), the body variants, the layer (one pane per pin, Stop reaching only its chat, Close, compact and full composer, the waiting ring, the phone pager) and the phone dots.

`tests/studio/shots.mts` takes pictures of the entry points in the built studio with no model key: it builds a scratch home with `delorun/apps/tools/src/demo-home.ts`, adds a hand-written chat that lists two agents, starts the studio on port 18843, pins both agents through the pin buttons and saves light-theme pictures at 1440 px in headless Chromium: `node --import tsx/esm delorun/packages/plugin-multiview/tests/studio/shots.mts <directory> [--keep]`. Run it after `pnpm run build:artifacts` and a build of the `delorun/packages` that have a `build` script.
