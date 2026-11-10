---
description: "Delo's arrangement of Settings, for people who want to know where a setting lives and for maintainers placing a new section or row."
kind: "package-library"
---

# @delo/plugin-settings-layout

## Summary

Delo's Settings is one large panel with the navigation grouped by topic, a search field, and pages that gather upstream's General rows into cards with headings. The package registers a layout with upstream's Settings shell through upstream's settings layout seam (`ctx.settingsLayout`), so every stock and third-party section and row keeps working. It loads only while the Delo look is on; with the stock look, upstream's flat list and its 800 × 800 panel return.

## Contents

- [Using Settings](#using-settings)
- [Contract](#contract)
- [Tests](#tests)
- [Development](#development)
- [Limits](#limits)

## Using Settings

The navigation has three groups. Each page shows only the sections and rows that are registered, and a page with none is left out.

| Group | Page | What it holds | Ids it places |
| --- | --- | --- | --- |
| You | Appearance | Delo's Appearance section, a Text card with the font size, then the Conversation section | sections `delo-appearance`, `delo-conversation`; row `font-size` |
| You | Sidebar | The chat list's header art, view and sort order, then the snooze presets and Settle idle chats | sections `delo-sidebar`, `delo-chat-states` (from the sidebar and chat-states plugins, not yet on this branch) |
| You | Chat | Composer (Enter key, keyboard shortcuts), Links and usage, View (coding view) | rows `composer-enter`, `shortcuts`, `link-opening`, `performance-usage`, `developer-tools` |
| You | Language | The interface language | row `language` |
| You | Privacy | The Privacy section, with its statements and the consent switches | section `delo-privacy` |
| You | Account | Upstream's account section; Delo's composition hides it, so the page shows only where it is registered | section `account` |
| Agent | Models | Upstream's model providers | section `models` |
| Agent | Modes | Upstream's agent presets | section `agent-presets` |
| Agent | Permissions | A New chats card with the default permission mode | row `permission` |
| Agent | Tools | Tool settings, then upstream's inventory of built-in plugins | sections `delo-tool-settings`, `plugins` |
| Delo | About | Version, then a Getting started card with Show onboarding again | rows `current-version`, `delo-onboarding` (from the onboarding plugin, not yet on this branch) |

The search field finds pages, cards and rows by name and by keywords in English and Chinese. Anything the layout does not place, such as a third-party plugin's section or a new upstream General row, appears under More, so no section or row disappears.

Privacy is a page of its own under You, not part of About, because it holds a consent decision the person should find by name and by search. Upstream's session-log upload row is hidden: the Privacy section's switch edits the same configuration row behind its consent dialog, and every Delo CLI profile mounts the Privacy section with this layout.

## Contract

- **Stock look.** The client half injects `deloStudio` inside `apply` (`ctx.inject(['deloStudio'], applyStudio)`), so its entry stays active under the stock look, which upstream's web boot requires of every entry. `@delo/plugin-theme` provides that service only while the Delo look is on, so without it the plugin registers nothing. The host half mounts nothing.
- **The layout** ([`src/client/layout.ts`](src/client/layout.ts)) names sections and General rows by their registration ids; `SECTIONS` and `ITEMS` list them. `HIDDEN_ITEMS` holds the three upstream rows Delo's sections replace: `appearance` (Light, Dark and System, replaced by Appearance), `transcript-view` (Work details, replaced by Conversation) and `session-log-deepseek` (the upload switch, replaced by Privacy). Hidden rows show nowhere, not even under More.
- **The panel** is about 1080 wide and 88% of the window tall, with a navigation at most 220 wide and at most two fifths of a narrow window. [`PANEL_STYLE`](src/client/index.ts) sets upstream's panel custom properties in one style element tagged `@delo/plugin-settings-layout`. Upstream's own rule below 768px takes the panel to the full window. Rows fill the content column, so every control and switch sits at its right edge.
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)); the dictionaries load under the `settings.deloLayout` namespace. Every page title comes from the layout, so upstream's Agent presets and Built-in plugins sections read as Modes and Tools; on a titled page, upstream's sections hide their own titles.
- **Tool settings** ([`src/client/ToolSettingsSection.tsx`](src/client/ToolSettingsSection.tsx)) is the `delo-tool-settings` section. It lists upstream's `plugins.item` ledger by id and name in the active language, only while upstream's `pluginNavigation` service exists. A row calls `openItem(id)` and closes Settings. The section renders nothing while no tool has a settings page. Long tool names wrap, so the full name stays visible.
- **Disposal.** Disposing the plugin, or losing `deloStudio`, removes the layout, the dictionaries, the Tool settings section and the style element.
- **Locale files.** [`locale/en.json`](locale/en.json) and [`locale/zh.json`](locale/zh.json) hold the Plugins page's `meta.title` and `meta.description`.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts --maxWorkers=2 packages/plugin-settings-layout/` runs the specs.

- [`tests/layout.client.spec.tsx`](tests/layout.client.spec.tsx) projects the layout over the registered sections and rows: every id it names is in `SECTIONS` or `ITEMS`, an unplaced section or row lands under More, the hidden rows show nowhere, search finds pages, cards and rows, the Chinese copy has every English key, and the plugin registers nothing without `deloStudio` and removes everything when it leaves or is disposed.
- [`tests/tool-settings.client.spec.tsx`](tests/tool-settings.client.spec.tsx) checks the list from the ledger, nothing without the navigation, a row opening its page and closing Settings, and nothing rendered with no tools.
- [`tests/ids.spec.ts`](tests/ids.spec.ts) checks that upstream's client sources still register the upstream section and General row ids the layout names.
- [`tests/host.spec.ts`](tests/host.spec.ts) checks that the host entry mounts nothing.

## Development

`pnpm --filter @delo/plugin-settings-layout run build` writes `lib/index.js` and `lib/client.js` with upstream's client preset. The browser page's module table does not provide Delo's packages, so the client half imports none of them at run time.

## Limits

- **Tool forms open on the Plugins page.** They register into the Plugins page's own slot, which Settings cannot render, so Tool settings links to each page instead of holding the forms.
- **A new upstream General row** appears under More until the layout places it.
