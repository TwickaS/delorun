---
description: "Delorun's arrangement of Settings, for people who want to know where a setting lives and for maintainers placing a new section or row."
kind: "package-library"
---

# @delorun/plugin-settings-layout

English | [中文](README.zh.md)

## Summary

Delorun's Settings is one large panel with the navigation grouped by topic, a search field, and pages that gather upstream's General rows into cards with headings. The package registers a layout with upstream's Settings shell through upstream's settings layout seam (`ctx.settingsLayout`), so every stock and third-party section and row keeps working. It loads only while the Delorun look and upstream's general Settings are on; with the stock look, upstream's flat list and its 800 × 800 panel return.

## Contents

- [Using Settings](#using-settings)
- [Contract](#contract)
- [Tests](#tests)
- [Development](#development)
- [Limits](#limits)

## Using Settings

The navigation has five groups: General, Agent, Safety, Devices and Data. Each page shows only the sections and rows that are registered, and a page with none is left out. Every heading is in sentence case: the layout heads its cards, and each Delorun section draws its own headings, so it reads the same where another Settings shows it without this layout.

| Group | Page | What it holds | Ids it places |
| --- | --- | --- | --- |
| General | General | Language; Look (Delorun or the stock look); Updates (the release check and the current versions on one line); Keyboard shortcuts; Getting started (show onboarding again); How Delorun runs (the command for each choice the first-run guide leaves to the terminal); Advanced (the coding view) | rows `language`, `delorun-look`, `delorun-update-check`, `delorun-versions`, `shortcuts`, `delorun-onboarding`, `developer-tools`; section `delorun-setup-commands` |
| General | Appearance | Delorun's Colours section, then a Text and density card: typeface, font size with more font settings, density | section `delorun-appearance`; rows `delorun-typeface`, `font-size`, `delorun-density` |
| General | Sidebar | The sidebar's Header and Chat list, then Snooze and idle chats | sections `delorun-sidebar`, `delorun-chat-states` |
| General | Conversation | Detail and Folding | section `delorun-conversation` |
| General | Chat | Composer (send behaviour while busy, reasoning effort labels), Links and usage | rows `composer-enter`, `delorun-effort-labels`, `link-opening`, `performance-usage` |
| General | Account | Upstream's account section; Delorun's composition hides it, so the page shows only where it is registered | section `account` |
| Agent | Models | Upstream's model providers | section `models` |
| Agent | Modes | Upstream's agent presets | section `agent-presets` |
| Agent | Tools | Tool settings: a link to each tool's page in Plugins | section `delorun-tool-settings` |
| Agent | Plugins | Upstream's inventory of built-in plugins, the npm mirror switch, then Create a plugin, which keeps its own heading because the page title names only the inventory | sections `plugins`, `delorun-plugin-installs`, `delorun-create-plugin` |
| Agent | Browser | Whether agents may use a web browser, its status, a download and a test | section `delorun-browser` |
| Safety | Permissions | A New chats card with the default permission mode, then Full access and MCP servers | row `permission`; section `delorun-permissions` |
| Safety | External agents | The delegation consent: the switch that asks before an external agent runs, its run time limit, and the agents allowed to start without asking, each with a revoke | section `delorun-external-agents` |
| Safety | Network | Each workspace's network access for sandboxed commands and `web_fetch` | section `delorun-network` |
| Safety | Privacy | The session-log upload switch, the desktop analytics line and feedback | section `delorun-privacy` |
| Devices | Devices | Remote access and the approved devices | section `delorun-devices` |
| Data | Trash | Deleted chats and workspaces | section `delorun-trash` |
| Data | Changes | The review of plugin and harness changes, with protection on or off | section `delorun-changes` |
| Data | Setup versions | The profile history's versions, what a switch changes, Save this setup and Switch to this version | section `delorun-setup-versions` |
| Data | About | The Versions card (Delorun and the DeepSeek Harness), licences and project links, all drawn by the About section | section `delorun-about` |

After Data, each third-party plugin that names its sections in `settingsPluginGroups` has a group of its own, titled with the plugin's display title, with one page per section. The search field finds pages, cards and rows by name and by keywords in English and Chinese. Anything neither the layout nor a plugin group places, such as an unnamed third-party section or a new upstream General row, appears under Other, so no section or row disappears.

Privacy is a page of its own under Safety because it holds a consent decision the person should find by name and by search. Upstream's session-log upload row is hidden: the Privacy section's switch edits the same configuration row behind its consent dialog, and every Delorun CLI profile mounts the Privacy section with this layout.

## Contract

- **Stock look and other Settings.** The client half injects `delorunStudio` and `settingsLayout` inside `apply` (`ctx.inject(['delorunStudio', 'settingsLayout'], applyStudio)`), so its entry stays active under the stock look and where a plugin turns upstream's general Settings (`ui-settings-general`, the `settingsLayout` provider) off and draws its own Settings, as DS Bot does; upstream's web boot requires every entry to activate. `@delorun/plugin-theme` provides `delorunStudio` only while the Delorun look is on. Without either service the plugin registers nothing. The host half mounts nothing.
- **The layout** ([`src/client/layout.ts`](src/client/layout.ts)) names sections and General rows by their registration ids; `SECTIONS` and `ITEMS` list them. Devices and Trash take the icons their sections register under `settings.section.icon`; every other page has its own glyph. `HIDDEN_ITEMS` holds the three upstream rows Delorun's sections replace: `appearance` (Light, Dark and System, replaced by Appearance), `transcript-view` (Work details, replaced by Conversation) and `session-log-deepseek` (the upload switch, replaced by Privacy). Hidden rows show nowhere, not even under Other.
- **Plugin groups.** While the layout is registered, the plugin provides `ctx.settingsPluginGroups` ([`src/client/plugin-groups.ts`](src/client/plugin-groups.ts)). A third-party plugin, or the bridge that adapts it, injects it and registers `{ id, label, sections }`: its package name, its display title and its `settings.section` ids. The layout is registered again with a group per plugin after Data, in registration order, and a page per section titled with the section's registered label; a section the layout already places stays where it is. `register` returns the disposer and throws when a group with the same id is registered already.
- **The panel** is about 1080 wide and 88% of the window tall, with a navigation at most 220 wide and at most two fifths of a narrow window. [`PANEL_STYLE`](src/client/index.ts) sets upstream's panel custom properties in one style element tagged `@delorun/plugin-settings-layout`. Upstream's own rule below 768px takes the panel to the full window. Rows fill the content column, so every control and switch sits at its right edge. The same style element sets upstream's `--dsh-settings-card-heading-*` properties, so the card headings are sentence-case headings in the label colour; Delorun's sections read the same properties for their own headings.
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)); the dictionaries load under the `settings.delorunLayout` namespace. Every page title comes from the layout, so upstream's Agent presets and Built-in plugins sections read as Modes and Plugins; on a titled page, upstream's sections hide their own titles.
- **Tool settings** ([`src/client/ToolSettingsSection.tsx`](src/client/ToolSettingsSection.tsx)) is the `delorun-tool-settings` section. It lists upstream's `plugins.item` ledger by id and name in the active language, only while upstream's `pluginNavigation` service exists. A row calls `openItem(id)` and closes Settings. The section renders nothing while no tool has a settings page. Long tool names wrap, so the full name stays visible.
- **Disposal.** Disposing the plugin, or losing `delorunStudio`, removes the layout, the dictionaries, the Tool settings section and the style element.
- **Locale files.** [`locale/en.json`](locale/en.json) and [`locale/zh.json`](locale/zh.json) hold the Plugins page's `meta.title` and `meta.description`.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts --maxWorkers=2 packages/plugin-settings-layout/` runs the specs.

- [`tests/layout.client.spec.tsx`](tests/layout.client.spec.tsx) projects the layout over the registered sections and rows: every id it names is in `SECTIONS` or `ITEMS`, each pane stacks its sections and headed cards in order, External agents and Network show once their sections register, an unattributed section or row lands under Other while a plugin group's section lands in its plugin's group, the hidden rows show nowhere, search finds pages, cards and rows, the Chinese copy has every English key, and the plugin registers nothing without `delorunStudio` or `settingsLayout`, stays active without them, removes everything when either leaves or the plugin is disposed, and re-registers the layout as plugin groups come and go.
- [`tests/tool-settings.client.spec.tsx`](tests/tool-settings.client.spec.tsx) checks the list from the ledger, nothing without the navigation, a row opening its page and closing Settings, and nothing rendered with no tools.
- [`tests/ids.spec.ts`](tests/ids.spec.ts) checks that upstream's client sources still register the upstream section and General row ids the layout names.
- [`tests/host.spec.ts`](tests/host.spec.ts) checks that the host entry mounts nothing.

## Development

`pnpm --filter @delorun/plugin-settings-layout run build` writes `lib/index.js` and `lib/client.js` with upstream's client preset. The browser page's module table does not provide Delorun's packages, so the client half imports none of them at run time.

## Limits

- **Tool forms open on the Plugins page.** They register into the Plugins page's own slot, which Settings cannot render, so Tool settings links to each page instead of holding the forms.
- **A new upstream General row** appears under Other until the layout places it.
