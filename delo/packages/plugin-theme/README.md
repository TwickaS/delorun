---
description: "Delo's look across the studio and the switch back to the stock look, for maintainers changing the palette, the accent, the typefaces, the Appearance and Conversation sections, or the `studio_additions` switch."
kind: "package-reference"
---

# @delo/plugin-theme

## Summary

`@delo/plugin-theme` owns C16 switch `studio_additions`. While the switch is on it lays Delo's Soft palette, an accent and Delo's typefaces over upstream's theme tokens, adds the Appearance and Conversation sections to Settings, sets Delo's New Session headline and vocabulary, and provides the `deloStudio` browser service, which every other Delo studio plugin requires. Turning the switch off unloads all of them, and the studio is upstream's. The plugin then registers one row in Settings, General, that turns the switch on again.

## Contents

- [Contract](#contract)
- [Configuration](#configuration)
- [The look](#the-look)
- [The stock look](#the-stock-look)
- [Palettes and attribution](#palettes-and-attribution)
- [Tests](#tests)
- [Limits](#limits)

## Contract

- **The switch.** The `studioAdditions` setting is a live-editable boolean in the `delo-theme` row's `Config` ([`THEME_ROW_ID`](src/config.ts)). Its default is `false`, which is the parity value: a profile that mounts the row without setting it gets upstream's look. `@delo/bundle-studio`'s row sets it `true`, which is Delo's default composition ([C16](../../docs/contracts/c16-parity-composition.md)). The switch changes what a person sees and reaches nothing the model reads.
- **`ctx.deloStudio`.** `@delo/plugin-theme/client` merges `deloStudio: DeloStudio` into the browser `Context`. The service exists exactly while the stored switch is on and is withdrawn when it is off. A Delo studio plugin lists `'deloStudio'` in its `inject`, so the stock look unloads it. `DeloStudio.useStockLook(): Promise<boolean>` writes `studioAdditions: false` through upstream's configuration form and returns whether the Host accepted the write.
- **Before the Host answers.** While the settings form is loading, or when the Host does not serve the row, the plugin registers nothing and provides no service.
- **Exports.** `@delo/plugin-theme/client` exports `THEME_ROW_ID` (`'delo-theme'`), `ThemeSettings` with the choice lists and types (`ACCENT_CHOICES`, `PALETTES`, `TYPEFACES`, `DENSITIES`, `EFFORT_DISPLAYS`, `DEFAULT_SETTINGS`), `DeloStudio`, the section ids (`SECTION_ID`, `CONVERSATION.id`, `LOOK_ROW.id`) with their orders, `STOCK_ATTRIBUTE` and `ThemeController`. A package that offers the look choice elsewhere, such as onboarding, writes the `studioAdditions` field of `THEME_ROW_ID` through `ctx.configForms`.
- **Host half.** [`src/index.ts`](src/index.ts) stores the settings and tells the settings service to build no automatic form for the row, because the Appearance section is its page. While the switch is on it prints the palette, accent, density and contrast as a `style` row through `webserver/index-inject`, so the first paint is already Delo's look. While it is off the host prints nothing.

## Configuration

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| `studioAdditions` | boolean | `false` | C16 switch `studio_additions`: on, Delo's look and every Delo studio plugin; off, upstream's stock look. |
| `palette` | `soft`, `t3-code`, `t3-chat`, `grove`, `ocean`, `ember`, `iris` | `soft` | The palette. A T3 Code theme brings its own accent. |
| `accent` | `peach`, `cobalt`, `moss`, `mono`, `custom` | `peach` | The accent of primary buttons, links, switches and focus, on the Soft palette. |
| `customAccent` | `#RRGGBB` | `#E5734A` | The colour used when `accent` is `custom`. |
| `typeface` | `delo`, `system` | `delo` | Schibsted Grotesk and JetBrains Mono, or upstream's stacks. |
| `density` | `compact`, `comfortable`, `spacious` | `comfortable` | `--dsh-density`, the scale spacing rules multiply by: 0.8, 1 and 1.2. |
| `contrast` | 50 to 200, step 5 | `100` | Quiet text and rules move towards the page below 100 and towards primary text above it. |
| `effort` | `label`, `bars` | `label` | How the model picker shows reasoning effort. |

Every field is volatile, so the Appearance section edits it while the studio runs.

## The look

While the switch is on, the browser half ([`src/client/index.ts`](src/client/index.ts)) registers, and releases when the switch turns off or the plugin is disposed:

- **Token layers** through `ctx.theme.overrideTokens`, one source per layer: palette, accent, type, density and contrast ([`LAYERS`](src/client/controller.ts)). Colours are OKLCH seeds that generate both schemes from upstream's token sheet; the accent is a separate layer, and each text role gets a text-safe shade that reaches 4.5:1 on its surface. Light, dark and system stay upstream's preference.
- **Faces and effort bars** as one `<style data-plugin="@delo/plugin-theme">` element: the two Latin font files from `src/client/assets/fonts`, and the rules that draw the model picker's `data-effort-level` caption as bars while `effort` is `bars`.
- **Settings sections.** `delo-appearance` (order 1) edits this plugin's settings: the look choice at its top, the colour scheme, the palette, the accent, the typeface, the density, the contrast and the effort display. `delo-conversation` (order 2) edits upstream's `ui-chat` display settings, with a live preview, and appears only while the Host serves that namespace.
- **The New Session headline**, in `conversation.hero.headline`. The brand mark in the sidebar belongs to `@delo/bundle-local`, and Delo has no approved mark, so the hero's mark seat keeps upstream's.
- **The vocabulary.** One `ctx.locale.override` per namespace and locale of [`src/client/vocabulary.ts`](src/client/vocabulary.ts), which says "chat" where upstream says "session", then the hand-written fixes of [`src/client/copy.ts`](src/client/copy.ts). `scripts/gen-vocabulary.ts` writes the first file from upstream's dictionaries.
- **`ctx.deloStudio`**, provided for the same span.

The CSS of the sections uses upstream's tokens (`--dsw-alias-*`, `--dsw-radius-*`) and `--dsh-density`; palette seeds are data in TypeScript. The Appearance section reflows at phone width: tiles keep their rows and shrink, and every other row wraps.

## The stock look

While the switch is off, nothing of Delo's look applies: no token layer, no font faces, no style element, no first-paint style, no sections, no headline, no vocabulary and no service. The plugin registers one row in `settings.general.item` (`delo-look`, after Language) with a switch labelled "Delo look" and a one-line description; turning it on writes `studioAdditions: true`, and the studio comes up without a reload. It also sets `data-delo-stock` on `<html>`, which retires a first-paint style that the page was served with before the switch was turned off. The Appearance section's look choice is the same switch from the other side: Stock calls `useStockLook()`.

## Palettes and attribution

Soft is Delo's. T3 Code's six themes are seeded from [`src/palette/t3-themes.ts`](src/palette/t3-themes.ts), copied by [`scripts/sync-t3-themes.ts`](scripts/sync-t3-themes.ts) from T3 Code (MIT, © 2026 T3 Tools Inc.) at a recorded commit; [`src/palette/t3.ts`](src/palette/t3.ts) derives each palette from it: the tint of its greys, the lightness of its light page and sidebar, and its accent in both schemes. The generator fills the rest. [`src/palette/stock.ts`](src/palette/stock.ts) is a copy of upstream's token sheet that `scripts/sync-stock-palette.ts` writes. The typefaces are Schibsted Grotesk and JetBrains Mono, each under the SIL Open Font License 1.1. The licence texts and the T3 Code notice are in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`fonts/`](fonts), and the package publishes both.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/plugin-theme` runs the package's specs. The `.spec.ts` specs import upstream's built packages and need `pnpm run build:artifacts`; the `.spec.tsx` specs run in jsdom against upstream's sources.

- [`palette.spec.ts`](tests/palette.spec.ts) holds the generated palettes to upstream's token sheet and to WCAG: body text roles reach 4.5:1 on their surfaces and marks 3:1, for Soft with each preset accent and edge-case custom accents, and for each T3 Code theme, in both schemes. It also covers the contrast setting, the first-paint style and the colour arithmetic.
- [`t3.spec.ts`](tests/t3.spec.ts) and [`t3-broken.spec.ts`](tests/t3-broken.spec.ts) cover the T3 Code source parser, the shipped themes and the refusals of a theme file that lacks a role.
- [`vocabulary.spec.ts`](tests/vocabulary.spec.ts) fails when the committed vocabulary differs from what the generator writes from upstream's dictionaries, and checks the hand-written fixes and the attributes the effort bars read.
- [`host.spec.ts`](tests/host.spec.ts) checks the settings defaults, that `studioAdditions` is volatile with default `false`, and that the first-paint style is printed only while the switch is on.
- [`studio.client.spec.tsx`](tests/studio.client.spec.tsx) proves the switch: off, there is no service, layer, style element, face, section or vocabulary, and only the General row is registered; on, the service and the look are present; `useStockLook()` unloads a dependent plugin; nothing is registered before the Host answers.
- [`appearance.client.spec.tsx`](tests/appearance.client.spec.tsx), [`conversation.client.spec.tsx`](tests/conversation.client.spec.tsx), [`look-row.client.spec.tsx`](tests/look-row.client.spec.tsx) and [`controller.client.spec.tsx`](tests/controller.client.spec.tsx) render the sections, the row and the controller.

## Limits

- The browser half cannot import another Delo package at run time, because the page's module table provides upstream's packages only.
- The hero's mark seat keeps upstream's mark; this plugin registers no sidebar brand.
- Turning the switch off does not reload the page; `data-delo-stock` on `<html>` retires the first-paint style the page was served with.
