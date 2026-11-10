---
description: "Delo's chat list, for people who want to know what the sidebar shows and how to change it, and for maintainers changing its rows, shelves, art, workspace icons or settings."
kind: "package-library"
---

# @delo/plugin-sidebar

## Summary

The chat list of Delo's studio, in the style of T3 Code's sidebar: chats as cards with a status at each card's top right, the Working, Snoozed and Settled shelves held at the bottom, search, a workspace filter, Workspace folders, Alt jumps, a card of details on hover, workspace icons, and generated or T3 Code header art behind the top of the sidebar. The package registers the list, the art, the foot and the Sidebar section of Settings in upstream's sidebar seats, so upstream's rows, menus and dialogs keep working. The rows, sorting rules, shelves and art are ported from [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, under the MIT licence ([notice](THIRD_PARTY_NOTICES.md)); the data is the harness's Sessions and Workspaces. `@delo/bundle-studio` mounts the package as the row `delo-sidebar`. It loads only while the Delo look is on; with the stock look, upstream's list, foot and New Session button return.

## Contents

- [Using it](#using-it)
- [Contract](#contract)
- [Configuration](#configuration)
- [Limits](#limits)
- [Tests](#tests)

## Using it

- **Cards.** Pinned chats come first, in pin order, then the rest with the latest change first (or the latest created, by setting). A card shows its workspace's badge and name, a status (Working with the run's time, Approval, Question, Plan, Done for a finished unread run, Woke for an ended snooze) or the chat's age, its title and its model's mark. Working chats and quiet ready chats recede.
- **Hover and focus.** A card's status gives way to Snooze, Settle and a "..." button; a pinned card shows Unpin. Holding the pointer opens a card of details: the workspace and its folder, the model and the mode. The "..." button, a right-click and the menu key (or Shift+F10) open the chat's menu, which holds every plugin's entries. Double-click or F2 renames; Enter opens. On a screen without hover the status stays and the "..." button sits beside it; Snooze and Settle are in the menu.
- **Shelves.** Working, Snoozed and Settled fold at the bottom with their counts, and each viewer's folding is kept in the browser. A snoozed chat shows its time left and offers Wake now; a settled one offers Return to the list. Settled shows ten chats, then twenty-five more per Show more. A chat waiting on the person or working never sits on the Snoozed or Settled shelf.
- **Dragging**, in the cards view with a mouse or a pen: a card dropped among the pins pins it there, a pinned card dropped below the divider unpins it, a card dropped on Settled settles it, and a settled or snoozed row dropped among the cards returns or wakes it. The dragged row names what the drop does, the list scrolls while the pointer rests near its top or bottom, and Escape cancels. Pins keep the order they are dragged into, kept in the browser. A press that moves less than six pixels is a click. Touch presses scroll the list; every drop is also reachable from the row's buttons and menu.
- **Undo.** Settling, returning, snoozing, waking, pinning and unpinning show what changed and Undo for six seconds, as a small row in the sidebar's foot. It takes no focus and never covers the list.
- **The foot** is one row: a Settings button, the undo notice and upstream's other foot actions.
- **Search** matches titles and workspaces at once, then the chats' messages through upstream's search; the arrow keys and Enter pick a result, Escape clears.
- **Filter, Add workspace and New chat** sit beside the search field. The filter keeps one or more workspaces, and its submenus change a workspace's icon, rename it or remove it.
- **Alt jumps.** Holding Alt shows 1 to 9 on the first nine visible chats; Alt with a digit opens that chat, read from the physical key so layouts whose Alt types other characters still jump. Nothing happens while a text field or an editable region has the keys.
- **Workspace icons.** Change icon in the filter opens the icon picker: one to three letters, one of 36 icons, an emoji (32 offered, any typed) or a pattern generated from a seed (a mirrored 5 by 5 grid), in the workspace's own colour, one of eight named colours or any colour, a rounded, circle, square or hexagon shape, and a soft, solid or outline style, with Surprise me and Use initials. The chosen icon shows wherever the workspace's badge does.
- **Settings → Sidebar** chooses the header art (none, night sky, blueprint, or one of six generated scenes: waves, aurora, contours, constellation, halftone, shards, each drawn from a seed that Shuffle replaces) as one row of tiles that scrolls sideways with a swipe bar, its palette (Blueprint, Rose, Grove, Ocean, Ember, Iris or the studio's accent), its strength (subtle, standard, vivid) and style (behind the top, or a pill beside the name), the list's view (cards, or Workspace folders with one-line rows and a dot on a folded folder for what waits inside), the sort order (latest change or created), whether working chats gather on their shelf, whether unpinning asks first, the sidebar's width on a slider from 240 to 420 px with notches at T3 Code's 256 and upstream's 280, and a button into the stock look.

## Contract

- **Stock look.** The client half lists `deloStudio` in `inject`. `@delo/plugin-theme` provides that service only while the Delo look is on, so without it the plugin registers nothing and changes no layout. Disposing the plugin, or losing `deloStudio`, removes every registration and restores every `ctx.sidebarLayout` and `ctx.layout` change.
- **The list** fills upstream's `sidebar.workspaces.list` slot with [`src/client/Sidebar.tsx`](src/client/Sidebar.tsx). The slot's owner props give it the Session list, the Workspaces, opening and starting chats, the add-workspace flow, the rename and delete dialogs, message search and `openSessionMenu`, so each chat's menu is upstream's Session menu with every plugin's entries. The list reads `ctx.contextMenus.active` to keep the row whose menu is open lit. While it is mounted, `ctx.sidebarLayout.setNewSessionButton(false)` drops upstream's New Session button from the wide sidebar and `setFootRow(true)` lays the foot out as one row.
- **Sorting** is pure, in [`src/client/sections.ts`](src/client/sections.ts): a chat waiting on the person or working never sits on the Snoozed or Settled shelf; otherwise one shelved no earlier than its latest prompt sits there. Subagents, blank chats and archived chats stay out. Auto-settle is derived in the list from the chat states, not stored.
- **Chat states** come from `@delo/plugin-chat-states` through the optional service `ctx.deloChatStates`, followed as it comes and goes. Without it the list has no Snoozed or Settled shelves and no Snooze or Settle buttons.
- **Dragging** is [`src/client/drag.ts`](src/client/drag.ts): window pointer events, the row under the pointer found with `document.elementFromPoint`, T3 Code's drop rules from `sections.ts`, and a guard that keeps the click after a drop from opening the row. It uses no library.
- **The foot.** [`FootLauncher.tsx`](src/client/FootLauncher.tsx) fills upstream's `settings.launcher` seat at priority -2, over upstream's account launcher, with a 32px Settings button. [`UndoNotice.tsx`](src/client/UndoNotice.tsx) fills `sidebar.footer.action` at order -2. The list and the notice share one undo line ([`undo.ts`](src/client/undo.ts)).
- **The art** fills upstream's `sidebar.backdrop` slot with [`StageArt.tsx`](src/client/StageArt.tsx) and [`GenerativeArt.tsx`](src/client/GenerativeArt.tsx). The palettes are CSS custom properties with `light-dark()` values in [`StageArt.module.css`](src/client/StageArt.module.css), which are the art's own colour data; the accent palette mixes `--dsw-alias-brand-primary`. The generated scenes draw with a seeded mulberry32 source in the palette's `--stage-art-*` colours. The pill style marks itself `data-backdrop-plain` so the brand keeps its colours.
- **Workspace icons** are stored data. The `workspaceIcons` setting accepts any value so one bad icon cannot keep the row from loading; the list validates each icon where it reads it ([`readWorkspaceIcons`](src/workspace-icon.ts)), and a workspace whose stored icon is malformed, such as one naming an icon the picker no longer offers, shows its monogram. The glyphs are upstream's `Icon*Medium` components, chosen in [`WorkspaceBadge.tsx`](src/client/WorkspaceBadge.tsx).
- **Settings.** The width reaches `ctx.layout.setSidebarWidths` while that service exists, with the drag floor at 264 px or the width when narrower. The Sidebar section ([`SettingsSection.tsx`](src/client/SettingsSection.tsx)) has the id `delo-sidebar` and order 2, registers only while the Host serves the `delo-sidebar` settings namespace, writes through `ctx.configForms` and shows a notice when a write fails. The harness half asks the settings service for no generated form for the namespace. Its button into the stock look calls `ctx.deloStudio.useStockLook()`.
- **Lengths** are T3 Code's own (16px status icons, 36px slim rows, 32px foot buttons); corners and colours are the studio's tokens, so the list follows the theme. Hover-only styling is inside `@media (hover: hover)`; coarse pointers get 32px targets.
- **Exports.** `@delo/plugin-sidebar/client` exports `apply`, `inject`, `NS`, `SECTION`, `LAUNCHER_PRIORITY`, `UNDO_NOTICE`, the row and list types, `createUndoLine`, `useListDrag`, the art, badge and picker components, the pure functions of `sections.ts` and `workspace-icon.ts`, and the helpers `optionalSource`, `snoozeEnds` and `stateActions`. `@delo/plugin-sidebar` exports `apply`, `Config`, the setting types and the icon schema.
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)); the Plugins page names the row from [`locale/`](locale/en.json).

## Configuration

The row `delo-sidebar` has eleven volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs. Settings → Sidebar edits them, except that Shuffle replaces `artSeed` and the icon picker edits `workspaceIcons`.

| Field | Default | Meaning |
| --- | --- | --- |
| `headerArt` | `blueprint` | `none`, `night`, `blueprint`, `waves`, `aurora`, `contours`, `constellation`, `halftone` or `shards`. |
| `artPalette` | `accent` | `blueprint`, `rose`, `grove`, `ocean`, `ember`, `iris` or `accent`. |
| `view` | `cards` | `cards`, or `folders` for a folder per workspace. |
| `workingShelf` | `true` | Whether working chats gather on the Working shelf. |
| `artSeed` | `1` | The seed (1 to 2,147,483,647) a generated scene is drawn from. |
| `artStrength` | `standard` | `subtle`, `standard` or `vivid`. |
| `artStyle` | `artwork` | `artwork` behind the sidebar's top, or `pill` beside the brand. |
| `sort` | `updated` | `updated` (latest change) or `created`. |
| `confirmUnpin` | `false` | Whether unpinning asks first, from the button or a drag. |
| `width` | `256` | The sidebar's width in pixels, 240 to 420 in steps of 4. |
| `workspaceIcons` | `{}` | Each workspace's icon by workspace id; invalid entries are ignored when read. |

## Limits

- The pins' order is per browser: the harness keeps no order of its own for pinned chats, so a dragged order shows only where it was dragged.
- The list shows no git branch for a workspace and the foot has no cell status, Usage or update button, because no browser service provides them in this studio.
- Dragging works with a mouse or a pen. Touch and keyboard use the row's buttons and menu for the same operations.
- T3 Code's archive and delete confirmations are not repeated: upstream's archive notice offers Undo, and deleting a workspace always asks.
- The folded rail keeps upstream's list.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts packages/plugin-sidebar/` runs the specs; [`sidebar.spec.ts`](tests/sidebar.spec.ts) imports upstream's built packages, so it needs `pnpm run build:artifacts`. The client specs resolve upstream to its sources.

- [`sections.client.spec.ts`](tests/sections.client.spec.ts) checks statuses, receding, which chats are listed, the sections and shelves (a chat that waits or works is never shelved), search, the filter, badges, folders, auto-settle and the drop rules, verbs and the pins' order.
- [`workspace-icon.client.spec.tsx`](tests/workspace-icon.client.spec.tsx) checks the icon schema, that a malformed stored icon is left out when icons are read, the random icon and the seeded pattern.
- [`sidebar.client.spec.tsx`](tests/sidebar.client.spec.tsx) checks the cards and shelves, a shelf's folding kept, settling, snoozing, waking and unpinning with Undo, the chat's menu from its button, a right-click and the menu key, opening and renaming, the list without chat states, the Working shelf off, the filter and the icon picker, search by title and by message, the folders view, Alt jumps (not while typing), and every drop.
- [`drag.client.spec.tsx`](tests/drag.client.spec.tsx) checks the six-pixel threshold, the drop target, Escape and cancel, the touch and button exclusions, the click guard and the edge scrolling.
- [`icons.client.spec.tsx`](tests/icons.client.spec.tsx) checks the badge for each kind of icon and the picker.
- [`art.client.spec.tsx`](tests/art.client.spec.tsx) checks every scene and palette, the seeded scenes, and the pill style.
- [`settings-section.client.spec.tsx`](tests/settings-section.client.spec.tsx) checks each setting's write, the width slider, the swipe strip, a failed write and the read-only state.
- [`plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) checks the registrations and their removal, that the plugin registers nothing and changes no layout without the Delo look, the optional chat-states service, the foot, and that the Chinese copy has every English key.
- [`sidebar.spec.ts`](tests/sidebar.spec.ts) checks the `Config` defaults and refusals and the host half.
