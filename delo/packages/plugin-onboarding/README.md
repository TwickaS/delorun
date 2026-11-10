---
description: "Delo's first-run onboarding in the studio, for people seeing the studio for the first time and for maintainers adding a step to it or changing what the terminal setup record leaves out."
kind: "package-library"
---

# @delo/plugin-onboarding

## Summary

The studio's first minute is one dialog that ends in a chat. It opens on the preview notice, then asks for the language and look, offers the Claude Code and Codex delegation bundles, offers the recommended plugins, explains reach where reach is available, and finishes by opening a new chat in the default workspace, or in a folder the person chooses where there is no default workspace. That chat's empty state offers three starting prompts that write into the message box and send nothing. Onboarding leaves out what the terminal setup already covered, shows again from Settings → About, and loads only while the Delo look is on: with the stock look, the preview notice keeps its own step.

## Contents

- [The steps](#the-steps)
- [Contract](#contract)
- [Configuration](#configuration)
- [Limits](#limits)
- [Tests](#tests)

## The steps

| Step | Shown | What it does |
| --- | --- | --- |
| Preview notice | On the first run, while this browser has not acknowledged the notice | Shows the notice's title and paragraphs from `@delo/bundle-local`'s dictionary. Continue records the acknowledgement through `ctx.deloNotice`, so the notice's own step then completes without a second dialog. Without `ctx.deloNotice` the screen is left out. |
| Language and look | Always | Chips for the language (upstream's locale service), the colour scheme, the palette with a light and dark preview, and the accent presets while the Soft palette is chosen. A last choice, Delo or Stock, says before it is made that the stock look turns Delo's studio additions and this guide off. |
| Agents | Always | Cards for `@deepseek-ai/dsh-subagent-claude-code` and `@deepseek-ai/dsh-subagent-codex` with their state from the plugin manager. The copy says that Claude Code and Codex run as their own programs, with their own permissions, outside Delo's permission prompts. A card adds its bundle only when the person presses Add. A bundle this installation cannot install shows Not included in this installation with an Open Plugins button, which is a normal state and not an error. |
| Recommended plugins | When the row's `plugins` list is not empty | A card per configured package, with the title and description the plugin manager lists for it, and the same Add button. |
| Reach | Only while `ctx.deloReach` exists and says reach is not set up, and the terminal setup record does not say it is, including after a skip | Says that reach opens this studio from a phone, that it is turned on at the computer that runs Delo with `delorun reach on tailscale`, and that a phone session cannot grant full access or approve devices, which the [reach design](../../docs/design/reach.md) states and no built code enforces. Without `ctx.deloReach` the step is left out, and no plugin provides it. |
| Start | Always, last | Says where the chat opens. It records that onboarding is done and opens a new chat in the default workspace. Where no default workspace resolves it says so and its button is Choose a folder. |

Steps other plugins add through `ctx.deloOnboarding` sit between Reach and Start. Skip for now, on every screen but the notice, records that onboarding is done and opens no chat. Settings → About has a row, `delo-onboarding`, whose Show again button reopens the flow from Language and look and keeps every other setting.

The starting prompts show above the message box of the chat the last button opened, until that chat has a message, the person types something of their own, or the person hides them. Their text is in the dictionary, so each language has its own.

## Contract

- **Stock look.** The studio half injects `deloStudio` inside `apply` (`ctx.inject(['deloStudio'], applyStudio)`), so its entry stays active under the stock look, which upstream's web boot requires of every entry. `@delo/plugin-theme` provides that service only while the Delo look is on, so without it the plugin registers nothing and provides no service. `settingsShell`, which the Settings shell provides under every look, is in the top-level `inject`: Show again calls `ctx.settingsShell.openOnboarding`, which cordis refuses on a service the plugin did not inject.
- **The onboarding step** is a `settings.onboarding` entry with the id `delo-onboarding` at order -200, before `delo-notice` (-100) from `@delo/bundle-local` and the model step of upstream. It registers only while the host serves the row `delo-onboarding`. With `done` set and no `explicit` flag it calls `complete()` at once, and so does a row that cannot be read. The dialog owns the page's inert root while it shows, takes focus to the step's heading at each step and is closed only by its buttons. No step has a text field, so the dialog never raises the on-screen keyboard.
- **Progress** is the row's volatile configuration: `done`, `step` (the id of the step reached, which resumes the flow) and `starterSession`. A write that fails is logged and the flow goes on. The notice screen is shown from the start while it is owed, whatever step was saved.
- **Language and look** write only the theme row's `palette` and `accent` through `ctx.configForms`, and the colour scheme through upstream's theme service. Choosing Stock calls `ctx.deloStudio.useStockLook()`, which unloads this plugin. Palette and accent labels come from `@delo/plugin-theme`'s dictionary `settings.deloAppearance`, and the preview colours in [`src/client/previews.ts`](src/client/previews.ts) are copies that a test compares with the theme's own.
- **Agents and plugins** use the plugin manager's remote namespace, read from the store as the `remote.pluginManager` service (a property access on `remote` reaches a namespace only for a plugin that injects it, and injecting it would hold the guide until a plugin manager mounts). `listBundles` only reads. A bundle the installation ships is switched on with `setBundleEnabled`; a catalog entry is installed from its `installTarget` with `installBundle` and then enabled. A result of `applied` shows Added, `restart-required` shows that Delo needs a restart, and anything else, or a plugin manager that cannot be asked, shows a failure with a button that opens Plugins. A catalog entry with no install target, or with an error beside its target (such as a source checkout whose built runtime is missing, or an unsupported platform), is not installable here: it shows Not included in this installation with the same button. Nothing installs without a press.
- **The setup record.** The harness half requires `connection` and serves one exact route, `GET /api/deloOnboarding.setupRecord`, uncached ([`src/wire.ts`](src/wire.ts)). It answers `{ sections?, reachSetUp }` from `setup-answers.json` in the CLI profile's directory (`ctx.profileContext.dir`), which `delorun setup` writes and onboarding never writes. `reachSetUp` is true when `reach.option` is a non-empty string other than `none`; `sections` is the list of lower-case section names (at most 32, each up to 40 characters) when it validates. Only these two fields are read, other fields are tolerated and never served or logged, a file over 64 KiB or that is not a regular file is not read, and a missing, unreadable or invalid file answers `{ reachSetUp: false }` so every step shows. A reason is logged without quoting the file. The studio parses the answer strictly and treats any failure the same way.
- **Sections.** A section name equal to `look`, `agents` or `plugins` leaves that step out. The notice, Reach and Start are never left out by name; Reach follows `ctx.deloReach` and `reachSetUp`.
- **First chat.** When the dialog opens it calls `ctx.workspaces.initializeDefault()` once, which the host answers with the existing default workspace and creates one only while it holds no workspace and no chat, so the Start step knows what its button does. The last button calls `ctx.uiWorkspace.openWorkspace` and writes the opened chat's id to `starterSession` before the chat is shown. Where the lookup resolves nothing or fails and other workspaces exist, the workspace UI's own New Session applies and no prompts follow. Where it resolves nothing and no workspace exists, the Start step says so and its button is Choose a folder: it calls `ctx.uiWorkspace.pickDirectory()`, adds the folder with `ctx.workspaces.create`, and opens a chat there with the prompts. A closed chooser keeps the dialog open. Where the host has no native chooser (its chooser is a page dialog) and the sidebar's optional `ctx.deloSidebar` says `canAddWorkspace()`, the dialog closes, `starterSession` becomes `pending` and `deloSidebar.addWorkspace()` starts upstream's add-workspace flow, which starts a chat in the picked folder. While `pending`, the first empty chat whose input dock mounts takes the prompts (`starterSession` becomes its id); the chat open when the prompts became pending does not. Where neither chooser can run, or a folder cannot be added, New Session applies and no prompts follow. A `pending` value stays until an empty chat takes it or the person dismisses the prompts. The workspace UI's own startup lookup raises the notice `defaultWorkspaceFailed` when the default workspace cannot be created. While the dialog shows it holds that notice through `ctx.uiWorkspace.holdDefaultWorkspaceNotice()`; when the dialog closes the notice is dropped if the Start step said there is no default workspace, and shows otherwise, for example after Skip. The prompts are an entry in `conversation.input.dock` (id `delo-onboarding.starters`, order 10). A chip calls `setDraft` on that chat's input through `ctx.sessions` and `ctx.conversation`, and focuses the box only for a pointer that can hover, so a phone keeps its keyboard down.
- **`ctx.deloReach`** is an optional service the reach plugin provides when reach can be turned on in this installation: `interface DeloReach { readonly available: true; setUp(): boolean }`, where `setUp()` says whether reach is already on at this computer. Onboarding reads it with `ctx.get('deloReach')`, follows it as it comes and goes, and shows the Reach step only while it exists and `setUp()` is false and the setup record does not say `reachSetUp`. No plugin provides it yet, so the step is hidden. The step's copy names that one command and no other way to reach.
- **`ctx.deloOnboarding.registerStep(step)`** adds an `OnboardingStep` (`id`, `order` 600 to 999, `title`, `component` taking `next`) and returns its disposer; a step with an earlier step's id replaces it.
- **Copy** is in English and Chinese ([`src/client/locales.ts`](src/client/locales.ts)) under the namespace `deloOnboarding`; the Plugins page names the plugin from [`locale/`](locale/en.json). CSS uses theme tokens only: `--delo-space-*` for spacing, upstream's font tokens for type, and no label weaker than the secondary label for any text. Below 768 px the dialog is the whole window, the list of steps becomes a count with a bar, and the footer stays at the bottom.

## Configuration

The row `delo-onboarding` has four volatile fields ([`src/config.ts`](src/config.ts)), validated when the configuration loads and changeable while the studio runs.

| Field | Default | Meaning |
| --- | --- | --- |
| `done` | `false` | Whether the person finished or skipped onboarding. |
| `step` | empty | The id of the step reached. |
| `starterSession` | empty | The chat whose empty state offers the starting prompts. |
| `plugins` | empty | Up to eight npm package names the recommended-plugins step offers. With none, the step is left out. |

`plugins` is empty by default: no Delo plugin on this base is a recommendation, and an empty list leaves the step out instead of showing an empty screen. A deployment sets the list in `cordis.yml`.

## Limits

- **Delegation consent.** Adding Claude Code or Codex asks for nothing beyond the press of Add, and Delo asks nothing before a delegated agent acts. The per-workspace consent for a first delegation is not built on this base, and the Agents step does not say it exists.
- **Reach.** No plugin provides `ctx.deloReach` yet, so the Reach step never shows. The command it names, `delorun reach on tailscale`, belongs to the reach plugin.
- **Folder chooser.** The page dialog that a browser-only host uses is a slot occupant that only the workspace UI renders, so onboarding reaches it through `ctx.deloSidebar` (typed structurally as `SidebarWorkspaceAdder`). Without that service such a host falls back to New Session. The folder the person picks may already be a workspace whose blank chat upstream reuses; that chat's dock mounts before `pending` and takes the prompts only if it mounts afterwards.
- **Section names.** The terminal setup writes a `sections` record (schema version 2): one `{ id, status }` row per section it showed. The harness serves the ids whose status is `seen` or `answered`, and the flow leaves out a step whose id is among them; a `skipped` row covers nothing. Reach is decided by the reach answer and the `deloReach` service, not by this list.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts --maxWorkers=2 packages/plugin-onboarding/` runs the specs; add `--coverage.enabled --coverage.provider=v8 --coverage.reporter=text --coverage.include='packages/plugin-onboarding/src/**'` for coverage, which is complete.

- [`tests/host.spec.ts`](tests/host.spec.ts) checks the configuration's validation, the record reader with a missing, malformed, oversized, directory-named and hostile file (no field outside the two used is served, and no log line quotes the file), and the route.
- [`tests/steps.client.spec.tsx`](tests/steps.client.spec.tsx), [`tests/bundles.client.spec.tsx`](tests/bundles.client.spec.tsx) and [`tests/dialog.client.spec.tsx`](tests/dialog.client.spec.tsx) check each step, that bundles install only on a press, the notice acknowledgement and its absence, finished progress, a reopened flow, resume, skipping and the steps left out.
- [`tests/plugin.client.spec.tsx`](tests/plugin.client.spec.tsx) checks that nothing registers without `deloStudio`, the registrations and their disposal, that Show again opens the dialog through a Settings shell that loads after the plugin, the reach service following `ctx.deloReach`, the record loader, the default workspace lookup, choosing a folder (native and in-page), opening the first chat and its fallbacks, and the starting prompts' services.
- [`tests/starters.client.spec.tsx`](tests/starters.client.spec.tsx) checks that a chip writes the draft and sends nothing, when the prompts show, and which chat takes them while they are pending.
- [`tests/previews.spec.ts`](tests/previews.spec.ts) compares the preview colours with the theme's, and [`tests/locales.spec.ts`](tests/locales.spec.ts) the English and Chinese copy.
