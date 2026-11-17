---
description: "Delorun's preview flags, for maintainers who add a studio feature that is not ready for everyone: how a plugin declares a flag, how a profile turns it on and how the Host, the studio and the CLI read it."
kind: "package-library"
---

# @delorun/preview-flags

English | [中文](README.zh.md)

## Summary

A **preview flag** marks a studio feature that is built far enough to look at and not far enough to ship to everyone. A plugin declares the flag, one profile row turns it on, and the Host, the studio and `delorun preview` read the same state. Every flag is off until the row sets it. The package is the row's Host plugin (`src/index.ts`, exported as `.`) and a studio library (`./client`), both from source.

## Contents

- [Declare a flag](#declare-a-flag)
- [Turn a flag on](#turn-a-flag-on)
- [Read a flag](#read-a-flag)
- [Contract](#contract)
- [Tests](#tests)

## Declare a flag

A flag has an id, a kind, the package name of the plugin that owns it, and a title and description in English and Chinese. The id is dot-separated camel-case words: the feature area, then the flag's own name, such as `onboarding.previewSteps`. The only kind is `boolean`; `PreviewFlagDeclaration` is a union over `kind`, so another kind adds a member there and its value to the row's `flags` schema.

A flag is declared in two places, which a spec holds equal.

1. The plugin's Host half declares it for as long as the plugin runs, as an effect:

   ```ts
   export const PREVIEW_STEPS: PreviewFlagDeclaration = {
     id: previewFlagId('onboarding.previewSteps'), kind: 'boolean', owner: '@delorun/plugin-onboarding',
     title: { en: 'Planned setup steps', zh: '计划中的设置步骤' },
     description: { en: 'Shows setup steps that are planned and not built yet.', zh: '显示已计划但尚未实现的设置步骤。' },
   }
   ctx.inject(['previewFlags'], (child) => { child.effect(() => child.previewFlags.declare(PREVIEW_STEPS)) })
   ```

2. The bundle that inserts the plugin's row lists the id in its `package.json`, keyed by the row id its patch declares:

   ```json
   "delorun": { "previewFlags": { "delorun-onboarding": ["onboarding.previewSteps"] } }
   ```

The list exists because two readers cannot run plugins: `delorun preview`, which also works while Delorun is stopped, and the Host for a row that is off. The Host refuses a declaration whose id no bundle lists, after reading the lists again for a bundle added while Delorun runs, and `assertFlagsIndexed` (`./manifest`) lets the plugin's spec fail when the list and the declarations differ.

## Turn a flag on

The row `delorun-preview-flags`, which `@delorun/bundle-studio` inserts, holds the flags a profile sets.

| Field | Meaning |
| --- | --- |
| `flags` | A record of flag id to `true` or `false`. A flag that is absent is off. The default is no flags. |

`delorun preview on <flag>` and `delorun preview off <flag>` write the row in the profile's own `cordis.patch.yml`, holding the profile's writer lock; `delorun preview list` shows each flag, whether it is on and the plugin that declares it. The row can also be written by hand, in the profile's patch or in a `--patch` overlay:

```yaml
- id: delorun-preview-flags
  config:
    flags:
      onboarding.previewSteps: true
```

A change applies the next time Delorun starts. The row checks its `flags` when it loads:

- A flag that no bundle of the profile lists stops the row, with a message that names the flag and the known flags. `delorun preview on` refuses such a flag before it is written, and `delorun preview off` removes one that is already set.
- A flag that is on while the row that declares it is off is logged as a warning and changes nothing; `delorun preview list` says so beside the flag.
- A bundle whose list cannot be read is logged as an error, and its flags are unknown until it is fixed.

## Read a flag

| Reader | How |
| --- | --- |
| Host plugin | `ctx.previewFlags.isOn(id)` is true when the row sets the flag and its plugin runs. It throws for an id that is neither declared nor listed. |
| Studio | `GET /api/delorunPreviewFlags.list` answers the flags the running plugins declare, each with `on`. Any signed-in device may read it. |
| Studio component | `usePreviewFlag(id)` under a `PreviewFlagsProvider` that holds one `createPreviewFlagsStore()`. It is false until the Host answers, when the read fails and when the flag or its plugin is off. |
| Terminal | `delorun preview list`. |

`PreviewChip` is the label a previewed feature carries: the word "Preview", small and muted, with a tooltip. A plugin spreads the chip's dictionaries (`./locales`) into its own and passes its bound translate function; the `tooltip` prop replaces the general sentence with the feature's own. The studio library imports no Cordis, and a plugin's browser bundle inlines it.

## Contract

- **A preview flag changes studio UI only.** It never changes what reaches a model: no prompt, tool, tool result or request field may depend on a flag. A future flag that would change model-visible input adds a session event first, so the input stays reconstructable from the session log, and that event, not the flag, is what the request is built from.
- **Off by default.** A flag is on only where a profile's row sets it to `true`; no plugin and no bundle patch turns one on.
- **No Settings page.** The row is written by `delorun preview` or by hand.
- **One owner per flag.** Two rows that list one id, or two plugins that declare it, are refused.

`tests/ui-only.spec.ts` enforces the first rule as far as the package can: nothing in the package imports the session, model or tool packages, and the Host API exposes no way to change a flag while Delorun runs.

## Tests

`node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/packages/preview-flags` runs [`registry.spec.ts`](tests/registry.spec.ts) (the index, the unknown-flag refusal, declarations and `isOn`), [`plugin.spec.ts`](tests/plugin.spec.ts) (the mounted row and its route), [`ui-only.spec.ts`](tests/ui-only.spec.ts), [`client.client.spec.tsx`](tests/client.client.spec.tsx) (the store, the hook and the chip) and [`chip-style.spec.ts`](tests/chip-style.spec.ts) (the chip's quiet look). The CLI's round trip is [`command.integration.spec.ts`](../../apps/cli/tests/preview/command.integration.spec.ts).
