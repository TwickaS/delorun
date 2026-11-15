---
description: "Delorun's brand as one package: tokens, the hex mark and the component set that the studio, PIN mode, the website and the docs share, for maintainers adding or changing a component or a brand value."
kind: "package-library"
---

# @delorun/brand

English | [中文](README.zh.md)

## Summary

`@delorun/brand` is the one source of Delorun's brand: the colours, the typefaces, the radii and spacing, the hex mark, and the components that carry them. Each component renders upstream's studio primitive for keyboard, focus and accessibility behaviour and adds Delorun's look and API. The package needs no Cordis host: the studio's plugins, the website and the docs import it as plain React and CSS. `@delorun/plugin-theme` stays the plugin that registers the look in the studio.

## Contents

- [Use this package](#use-this-package)
- [Tokens](#tokens)
- [Components](#components)
- [Contract](#contract)
- [The drift gate](#the-drift-gate)
- [The desktop icon](#the-desktop-icon)
- [Tests](#tests)

## Use this package

The package exports its source, as [`@delorun/settings-controls`](../settings-controls/README.md) does.

- **A studio plugin** lists `@delorun/brand` in `dependencies` and inlines it into its browser bundle with aliases for `@delorun/brand` and, when it imports the mark alone, `@delorun/brand/mark` in its `tsdown.config.ts`; `@delorun/bundle-local` and `@delorun/plugin-theme` show both.
- **The website and the docs** import `@brand` and `@design/mark` through their tsconfig `paths`, and `@delorun/site-design`'s `tokens.css` imports the brand's `tokens.css` and `fonts.css`. The website's links, sign-up fields and buttons are the brand's `Link`, `TextField` and `Button`. Both sites resolve `#upstream` to `src/upstream.web.tsx` in their Vite config and tsconfig `paths`.

| Export | Holds |
| --- | --- |
| `@delorun/brand` | The components, `Mark`, `MARK` and the tokens; importing it loads `tokens.css`, which is why the manifest declares no `sideEffects` |
| `@delorun/brand/tokens` | `BRAND_COLOURS`, `BRAND_FONTS`, `BRAND_RADII`, `BRAND_SPACE` as data |
| `@delorun/brand/tokens.css` | The same values as `--dl-*` custom properties |
| `@delorun/brand/fonts.css` | `@font-face` for Schibsted Grotesk and JetBrains Mono, Latin subset, SIL OFL 1.1 |
| `@delorun/brand/mark` | `MARK` (the path data) and `Mark` (the component) |

## Tokens

- **One brand colour.** Peach `#E5734A` is the brand colour on every surface: fills, focus rings and the mark's plug. White text on peach reaches only 3.05:1, so text on a peach fill is `#111110`, which reaches 6.19:1.
- **A text-safe peach for links.** On a light page, links and accent text use `#B84A1B`, which reaches 5.21:1 on white and 5.07:1 on `#FCFCFC`, above WCAG AA's 4.5:1 for body text. On a dark page, peach itself reaches 6.19:1 on `#111110`. `tests/tokens.spec.ts` computes these ratios.
- **Typefaces.** Schibsted Grotesk for text and JetBrains Mono for code, on every surface.
- **Dark mode follows the system.** `tokens.css` sets `color-scheme: light dark` and defines each colour with `light-dark()`; a page that sets its own `color-scheme` or a `.dark` ancestor overrides it.
- **Studio roles first.** Each `--dl-*` token reads the studio's `--dsw-*` role where one exists, so inside the studio the components follow the palette, the accent setting and the density; on a page without a studio the brand values apply.

## Components

Each is a function component with a documented props interface. "Upstream" means the primitive in `@deepseek-ai/dsh-client-ui-primitives`.

| Component | Upstream behaviour it composes | What it adds |
| --- | --- | --- |
| `Button` | `Button` | `primary`, `secondary`, `destructive` and `ghost` variants |
| `TextField` | `Input` | Visible label, help and error lines wired with `aria-describedby`, an announced error |
| `Pill` | `Pill` | Tones |
| `Dialog` | `Modal` | Actions footer and a `warning` tone |
| `Card` | none | Bordered section named by its `<h3>` |
| `Notice` | none | Four tones, optional icon, title, sentence and actions, caller-chosen live-region role |
| `OutcomePanel` | none | A centred full-panel result: icon disc, heading, sentence, actions |
| `StatusCard` | `Pill` | Icon disc, title, detail and a state pill |
| `PinDots`, `Keypad` | none | PIN entry: dots that carry no value, and a 72 px round keypad of real buttons |
| `ConfirmAction` | `Button` | A destructive action with one inline confirmation |
| `Link` | none | Text-safe peach, underlined |
| `Mark` | none | The hex mark; the nut takes the text colour and the plug takes `--dl-accent` |
| `ChipGroup`, `ThemePicker`, `AccentPicker`, `StudioLookSwitch` | none | The chip radio group (44 px targets, one tab stop, arrow keys) and the theme, accent and studio-look pickers built on it, which Settings → Appearance and onboarding's Look step share; `@delorun/plugin-theme/controls` re-exports them. They read the studio's `--dsw-*` and `--delorun-space-*` properties |
| `SettingsCard`, `SettingHeading`, `SettingRow`, `ChoiceGroup`, `RadioList`, `TileGroup` | none | The Settings sections' controls, for the studio only: they read the studio's `--dsw-*` and `--delorun-space-*` properties. [`@delorun/settings-controls`](../settings-controls/README.md) re-exports them |

## Contract

- **`#upstream` is the one seam.** Components import `Button`, `Input`, `Modal` and `Pill` from `#upstream`. The package's `imports` field resolves it to `src/upstream.ts`, which re-exports upstream's primitives, so the studio gets upstream's behaviour. A static site cannot carry upstream's primitives, which pull in the studio's stores and syntax highlighting, so the website and the docs resolve `#upstream` to `src/upstream.web.tsx`: a native `button`, `input` and modal `<dialog>`, which give focus, keyboard and Escape behaviour from the browser. A component that needs a primitive neither file exports adds it to both.
- **No product copy.** Every component takes localised text from its caller; the package holds none.
- **No secrets in the DOM.** `PinDots` renders no entered value, in text or in an attribute, and is `aria-hidden`.
- **Switch off.** With the studio's look off, `--dl-*` still resolves through upstream's `--dsw-*` roles, so the components take upstream's palette.
- **Motion.** Durations use `--dl-motion`, which is `0ms` under `prefers-reduced-motion: reduce`.
- **React.** The peer range is `^18.2.0 || ^19.0.0`: the studio runs React 18 and the sites run React 19.

## The drift gate

[`gates:brand-drift`](../../apps/tools/src/checks/gates/brand-drift.ts) refuses, in the sources of every Delorun package and in the sources, public files and scripts of the website and the docs outside this package, a brand colour literal (`#E5734A`, `#B84A1B`), a named typeface in `font-family` and a second copy of the mark's path. Each file that keeps a literal is listed with a reason in [`brand-drift.allowlist.json`](../../apps/tools/src/checks/gates/brand-drift.allowlist.json); the list only shrinks.

The website's social card page, `apps/website/scripts/og.html`, is generated from the mark and the brand's custom properties by `scripts/render-og.ts` (`node_modules/.bin/tsx delorun/packages/brand/scripts/render-og.ts --write`). Its mark path is the one allowlisted copy, and `tests/og.spec.ts` fails when the committed page differs from [`src/og.ts`](src/og.ts). `public/og.png` is a screenshot of that page at 1200 by 630: `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og-png.ts` from the repository root loads it in a browse session on 127.0.0.1, waits for the brand fonts, and writes the PNG. `tests/og.spec.ts` checks the PNG's size.

## The desktop icon

[`src/icons.ts`](src/icons.ts) draws every application icon from the mark and the brand colours: an ink tile with the nut in paper and the plug in peach. `node_modules/.bin/tsx delorun/packages/brand/scripts/render-icon.ts --write` rewrites `apps/desktop/resources/icon*.svg|png`, `tray-windows.ico` (through `apps/desktop/scripts/render-tray-icon.ts`, which enlarges the hex in the `tray-glyph` group for 16 to 64 px) and the web app's favicons and PNG icons. `--previews <dir>` writes previews at 16, 32, 256 and 1024 px on a light and a dark background. `tests/icons.spec.ts` fails when a committed SVG differs from its builder.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/brand` runs [`tests/tokens.spec.ts`](tests/tokens.spec.ts), which checks the contrast ratios, that `tokens.css`, `tokens.ts`, both favicons and the studio theme's default accent agree, and [`tests/components.client.spec.tsx`](tests/components.client.spec.tsx), which checks each component's roles, names and callbacks. `preview/` is a local gallery for screenshots: `vite --config delorun/packages/brand/preview/vite.config.ts`.
