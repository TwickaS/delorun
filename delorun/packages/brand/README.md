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
| `@delorun/brand/tokens` | `BRAND_COLOURS`, `BRAND_FONTS`, `BRAND_MOTION`, `BRAND_RADII`, `BRAND_SPACE` as data |
| `@delorun/brand/tokens.css` | The same values as `--dl-*` custom properties |
| `@delorun/brand/fonts.css` | `@font-face` for Schibsted Grotesk and JetBrains Mono, Latin subset, SIL OFL 1.1 |
| `@delorun/brand/mark` | `MARK` (the path data) and `Mark` (the component) |
| `@delorun/brand/alert` | `Alert`, `ALERT_CLASSES` and `ALERT_EXIT_MS`, the studio's alert (also exported from the index) |
| `@delorun/brand/toast` | `Toaster`, `showToast` and `ToastCard`, for the website and the docs only: the toast is drawn through Sonner, which the studio does not load |

## Tokens

- **One brand colour.** Peach `#E5734A` is the brand colour on every surface: fills, focus rings and the mark's plug. White text on peach reaches only 3.05:1, so text on a peach fill is `#111110`, which reaches 6.19:1.
- **A text-safe peach for links.** On a light page, links and accent text use `#B84A1B`, which reaches 5.21:1 on white and 5.07:1 on `#FCFCFC`, above WCAG AA's 4.5:1 for body text. On a dark page, peach itself reaches 6.19:1 on `#111110`. `tests/tokens.spec.ts` computes these ratios.
- **Typefaces.** Schibsted Grotesk for text and JetBrains Mono for code, on every surface.
- **Dark mode follows the system.** `tokens.css` sets `color-scheme: light dark` and defines each colour with `light-dark()`; a page that sets its own `color-scheme` or a `.dark` ancestor overrides it.
- **Motion.** One easing family: `--dl-ease-out` for arrivals, `--dl-ease-in-out` for movement across the screen and `--dl-ease` for colour; nothing uses an ease-in. The durations are `press` (120 ms), `quick` (180 ms), `move` (260 ms), `explain` (360 ms, the theme change only) and `leave` (100 ms, shorter than any arrival). `--dl-duration-*` times colour and opacity; `--dl-motion-*` times transform and clip-path and becomes 0 ms under reduced motion, which also sets `--dl-scale-pressed` (0.97) and `--dl-scale-enter` (0.95) to 1. The library's stylesheets hold no other easing curve or duration, which `tests/tokens.spec.ts` checks.
- **Studio roles first.** Each `--dl-*` token reads the studio's `--dsw-*` role where one exists, so inside the studio the components follow the palette, the accent setting and the density; on a page without a studio the brand values apply.

## Components

Each is a function component with a documented props interface. "Upstream" means the primitive in `@deepseek-ai/dsh-client-ui-primitives`.

| Component | Upstream behaviour it composes | What it adds |
| --- | --- | --- |
| `Button` | `Button` | `primary`, `secondary`, `destructive` and `ghost` variants; a pressed shrink, hover only under a fine pointer, the focus ring, and `unavailable`: `aria-disabled`, still focusable, no press or hover change, readable at AA |
| `TextField` | `Input` | Visible label, help and error lines wired with `aria-describedby`, an announced error |
| `Pill` | `Pill` | Tones |
| `Dialog` | `Modal` | Actions footer and a `warning` tone |
| `Card` | none | Bordered section named by its `<h3>` |
| `Alert` | none | The studio's alert: kinds `info`, `success`, `warning`, `error` and `progress`, each with its own glyph in a tinted circle; a title, one muted line, a tinted primary and a quiet secondary action, an optional close; `inline`, `toast` and `banner` variants; role `alert` for a warning or an error and `status` otherwise unless the caller names one; `closing` plays the leave and `onClosed` reports its end. It holds no styles: `@delorun/plugin-theme` styles `ALERT_CLASSES` while the Delorun look is on (its README, "Alerts and pop-ups") |
| `Notice` | none | Four tones, optional icon, title, sentence and actions, caller-chosen live-region role |
| `OutcomePanel` | none | A centred full-panel result: icon disc, heading, sentence, actions |
| `StatusCard` | `Pill` | Icon disc, title, detail and a state pill |
| `PinDots`, `Keypad` | none | PIN entry: dots that carry no value, and a 72 px round keypad of real buttons |
| `ConfirmAction` | `Button` | A destructive action with one inline confirmation |
| `Link` | none | Text-safe peach, underlined |
| `SectionHeading` | none | A section's heading (level 1 to 3) and lead sentence in an `<hgroup>`, fluid size, tight tracking, balanced lines |
| `TabList`, `TabPanel` | none | One tab stop, the arrow keys, Home and End select; the panel is named by its selected tab, may sit above or beside the row, and leaves the tab order with `focusable={false}` when it holds controls; there are no disabled tabs; on a narrow screen the row scrolls sideways and snaps |
| `CodeBlock` | none | Code in the brand's monospace face with a copy button that answers in place (a tick and the copied text in the button, or the failed text on its own line under the code, which a failed copy also selects) and announces every copy; every string is a prop; the button appears once scripts run without moving the block |
| `Frame` | none | The box a replica sits in: 12 px radius, the line colour, a size fixed by the content's width and height, and a still shown until the content is ready |
| `Toaster`, `showToast` (`@delorun/brand/toast`) | none (Sonner) | One toast at a time, a new one replacing the last; it waits while it has focus or the pointer, its action is a real button reachable by keyboard (and Alt+T), and it leaves by swipe |
| `Mark` | none | The hex mark; the nut takes the text colour and the plug takes `--dl-accent` |
| `LookChooser` | none | The colour scheme row, the theme tile grid ending in Custom, the custom panel (shown only for Custom) and the live sample; Settings → Appearance and onboarding's Look step both render it with their own text |
| `ChipGroup`, `ThemePicker`, `AccentPicker`, `StudioLookSwitch` | none | The chip radio group (44 px targets, one tab stop, arrow keys) and the theme and accent pickers built on it, which Settings → Appearance and onboarding's Look step share, and the Delorun look switch (on; turning it off chooses Stock) that Settings → General uses; `@delorun/plugin-theme/controls` re-exports them |
| `SettingsCard`, `SettingHeading`, `SettingRow`, `ChoiceGroup`, `RadioList`, `TileGroup` | none | The Settings sections' controls. Their CSS (and the chip controls') reads the studio's `--dsw-*` and `--delorun-space-*` properties with a `--dl-*` or pixel fallback, so they also render outside the studio, as the website's package-manager picker does. `ChoiceGroup` takes the arrow keys, Home and End, and `fill` and `mono` for a full-width group set in the brand's monospace face. [`@delorun/settings-controls`](../settings-controls/README.md) re-exports them |

## Contract

- **`#upstream` is the one seam.** Components import `Button`, `Input`, `Modal`, `Pill` and `Switch` from `#upstream`. The package's `imports` field resolves it to `src/upstream.ts`, which re-exports upstream's primitives, so the studio gets upstream's behaviour. A static site cannot carry upstream's primitives, which pull in the studio's stores and syntax highlighting, so the website and the docs resolve `#upstream` to `src/upstream.web.tsx`: a native `button`, `input`, `switch`-role `button` and modal `<dialog>`, which give focus, keyboard and Escape behaviour from the browser. A component that needs a primitive neither file exports adds it to both.
- **No product copy.** Every component takes localised text from its caller; the package holds none.
- **No secrets in the DOM.** `PinDots` renders no entered value, in text or in an attribute, and is `aria-hidden`.
- **Switch off.** With the studio's look off, `--dl-*` still resolves through upstream's `--dsw-*` roles, so the components take upstream's palette.
- **Motion.** Every transition and animation reads the motion tokens; under `prefers-reduced-motion: reduce` movement stops and colour and opacity changes keep their timing.
- **React.** The peer range is `^18.2.0 || ^19.0.0`: the studio runs React 18 and the sites run React 19.

## The drift gate

[`gates:brand-drift`](../../apps/tools/src/checks/gates/brand-drift.ts) refuses, in the sources of every Delorun package and in the sources, public files and scripts of the website and the docs outside this package, a brand colour literal (`#E5734A`, `#B84A1B`), a named typeface in `font-family` and a second copy of the mark's path. Each file that keeps a literal is listed with a reason in [`brand-drift.allowlist.json`](../../apps/tools/src/checks/gates/brand-drift.allowlist.json); the list only shrinks.

The website's social card page, `apps/website/scripts/og.html`, is generated from the mark and the brand's custom properties by `scripts/render-og.ts` (`node_modules/.bin/tsx delorun/packages/brand/scripts/render-og.ts --write`). Its mark path is the one allowlisted copy, and `tests/og.spec.ts` fails when the committed page differs from [`src/og.ts`](src/og.ts). `public/og.png` is a screenshot of that page at 1200 by 630: `node_modules/.bin/tsx delorun/packages/brand/scripts/render-og-png.ts` from the repository root loads it in a browse session on 127.0.0.1, waits for the brand fonts, and writes the PNG. `tests/og.spec.ts` checks the PNG's size.

## The desktop icon

[`src/icons.ts`](src/icons.ts) draws every application icon from the mark and the brand colours: an ink tile with the nut in paper and the plug in peach. `node_modules/.bin/tsx delorun/packages/brand/scripts/render-icon.ts --write` rewrites `apps/desktop/resources/icon*.svg|png`, `tray-windows.ico` (through `apps/desktop/scripts/render-tray-icon.ts`, which enlarges the hex in the `tray-glyph` group for 16 to 64 px) and the web app's favicons and PNG icons. `--previews <dir>` writes previews at 16, 32, 256 and 1024 px on a light and a dark background. `tests/icons.spec.ts` fails when a committed SVG differs from its builder.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/brand` runs [`tests/tokens.spec.ts`](tests/tokens.spec.ts), which checks the contrast ratios, that `tokens.css`, `tokens.ts`, both favicons and the studio theme's default accent agree, that the motion tokens agree and are the only timings in the stylesheets, [`tests/components.client.spec.tsx`](tests/components.client.spec.tsx), which checks each component's roles, names and callbacks, and [`tests/site-parts.client.spec.tsx`](tests/site-parts.client.spec.tsx) and [`tests/toast.client.spec.tsx`](tests/toast.client.spec.tsx), which check the sites' parts. `preview/` is a local gallery for screenshots on port 18620: `vite --config delorun/packages/brand/preview/vite.config.ts`, and with `BRAND_PREVIEW_SEAM=web` the sites' parts at `/parts.html` in a light and a dark column.
