---
description: "The Browser choice that the setup guide and the new-workspace flow share, for maintainers who draw it or change it: the readiness reader, the component's props and its copy."
kind: "package-library"
---

# @delorun/browser-setup

English | [中文](README.zh.md)

## Summary

Two surfaces ask whether agents may use a web browser: the setup guide's Browser step ([`@delorun/plugin-onboarding`](../plugin-onboarding/README.md)) and the new-workspace flow. Both draw the same component from this package and read whether Browser is ready through the same reader. The package is a studio library, exported from source: it runs in the browser, imports no Cordis, and a plugin's browser bundle inlines it.

## Contents

- [Read whether Browser is ready](#read-whether-browser-is-ready)
- [Draw the choice](#draw-the-choice)
- [Contract](#contract)
- [Tests](#tests)

## Read whether Browser is ready

`createBrowserSetup(fetch, language)` (exported as `.`) is the page's copy of the Host's requirement check, `GET /api/delorunRequirements.check` of [`@delorun/bundle-local`](../bundle-local/README.md), narrowed to the Browser plugin pack (`BROWSER_BUNDLE`). It has `getSnapshot`, `subscribe` and `refresh`; nothing is read until `refresh` is called, and overlapping calls share one request. The Host reads the computer afresh on each request, so a need the person just met clears on the next read.

| `BrowserReadiness` | Meaning |
| --- | --- |
| `checking` | Before the first answer |
| `not-added` | The Host lists no row of the pack: it is not in the profile, or has not loaded yet |
| `ready` | Every need is met |
| `needs-setup` | The Host's `reason`, in the studio's language, and the `fix` that meets it: a command, a Settings section or a page |
| `problem` | The pack's own declaration could not be read; `message` says why |
| `failed` | The check itself could not be read |

`browserAdded(readiness)` is true for the three states the Host reports about the pack itself. The readiness cannot say which browser was found; `ready` covers an installed Chrome and a downloaded Chromium alike.

## Draw the choice

`BrowserChoices` (`./client`) draws one radio group and, under it, the readiness while the isolated browser is chosen.

| Prop | Meaning |
| --- | --- |
| `t` | The caller's bound translate function. The caller spreads this package's dictionaries (`./locales`, which include the preview chip's) into its own. |
| `heading` | The question above the choices, where the caller's differs from the home-wide "Can agents use a web browser?" |
| `choice`, `onChoice` | The choice in effect, `isolated` or `none`, and the callback for a change. The caller holds the choice and decides what it does. |
| `disabled` | Holds both choices, as while a change is being applied |
| `readiness` | A `BrowserReadiness` |
| `planned` | Shows the third choice, "Use my browser": a disabled radio with the Preview chip and a tooltip that says it is not built |
| `notAdded` | What to draw in place of the readiness while it is `not-added`, such as where adding the pack stands or a line that turns Browser on |
| `onRetry`, `onOpenSettings` | Read the readiness again after a failed read; open the Settings section a need is met in |

## Contract

- **Presentational.** The component makes no request and writes nothing. Storage is the caller's: the setup guide maps the choice to the Browser plugin pack being on or off, and the new-workspace flow keeps it per workspace.
- **The planned choice can never be chosen.** Its radio is disabled and has no change handler, so `onChoice` only ever reports `isolated` or `none`.
- **Readiness shows for the isolated browser only.** With No browser chosen, nothing about Browser's needs is drawn.
- **Tokens.** The styles read the studio's `--dsw-*` roles and the Delorun look's spacing steps with pixel fallbacks, so the group looks the same inside and outside the setup guide.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/browser-setup` runs [`browser-choices.client.spec.tsx`](tests/browser-choices.client.spec.tsx): the readiness for each answer of the check, the store, and the component's choices, its disabled third choice, each readiness state and each kind of fix.
