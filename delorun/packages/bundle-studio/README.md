---
description: "Delorun's studio bundle, for maintainers changing which studio plugins Delorun's CLI profiles mount and how the one switch back to the stock look reaches them."
kind: "package-bundle"
---

# @delorun/bundle-studio

English | [中文](README.zh.md)

## Summary

`@delorun/bundle-studio` is the bundle that mounts Delorun's studio additions in every Delorun CLI profile: the theme, the settings layout, chat states, the sidebar and onboarding, and two optional plugins, the cost meter and the Thinking tab, whose rows stay disabled until the person turns them on. It holds no code; its [`cordis.patch.yml`](cordis.patch.yml) inserts one row per plugin and turns on [C16](../../docs/contracts/c16-parity-composition.md) switch `studio_additions` on the theme row. One switch in Settings turns all of them off and leaves upstream's studio, the stock look.

## Contents

- [Use this bundle](#use-this-bundle)
- [Rows](#rows)
- [The first-run key dialog](#the-first-run-key-dialog)
- [The stock look](#the-stock-look)
- [Tests](#tests)

## Use this bundle

- **The bundle list.** `@delorun/bundle-local`'s [`DELORUN_PROFILE_BUNDLES`](../bundle-local/src/profile.ts) lists this bundle after `@delorun/bundle-local`, so `delorun setup` writes it into every CLI profile it creates and links it into the profile as it links every Delorun bundle. A profile created before this bundle existed does not list it and keeps the stock look.
- **Layer order.** The bundle applies after every upstream bundle and after `@delorun/bundle-local`, and before the profile's own `cordis.patch.yml`, so a setting the person changes in Settings, which writes the profile's patch, wins over a row here.
- **Loading.** `delorun` refuses to start a CLI profile whose loader skipped a bundle in the `@delorun/` scope, so a profile that lists this bundle and cannot resolve it does not start with half of the studio.
- **Building.** Each plugin's `pnpm --filter <package> run build` writes its `lib/index.js` and `lib/client.js`; upstream's `pnpm run build:artifacts` does not build Delorun's packages.

## Rows

| Row | Plugin | What it adds |
| --- | --- | --- |
| `delorun-theme` | [`@delorun/plugin-theme`](../plugin-theme/README.md) | Delorun's palette, accent, typefaces and density, the Appearance and Conversation sections, and the switch `studioAdditions`, set to `true` here |
| `delorun-settings-layout` | [`@delorun/plugin-settings-layout`](../plugin-settings-layout/README.md) | Settings grouped by topic, with search |
| `delorun-chat-states` | [`@delorun/plugin-chat-states`](../plugin-chat-states/README.md) | Snooze and settle chats, with their shelves |
| `delorun-sidebar` | [`@delorun/plugin-sidebar`](../plugin-sidebar/README.md) | The chat list as cards, workspace icons and header art |
| `delorun-onboarding` | [`@delorun/plugin-onboarding`](../plugin-onboarding/README.md) | The first-run guide that ends in a new chat; this bundle sets its `plugins` to five experimental plugins that ship with DeepSeek Harness: session search, the terminal bundle, the worktree tool, session titles and the DeepSeek website chat import (an optional bundle, off until turned on), and its `optionalRows` to the two rows below, which the guide offers to turn on |
| `delorun-preview-flags` | [`@delorun/preview-flags`](../preview-flags/README.md) | The preview flags: studio features a plugin declares as not ready for everyone, each off until this row's `flags` turns it on (`delorun preview on <flag>`) |
| `delorun-cost-meter` | [`@delorun/plugin-cost-meter`](../plugin-cost-meter/README.md) | The estimated chat cost under the composer; inserted with `disabled: true`, so it mounts only after the person turns it on under Components on the Delorun studio page of the sidebar's Plugins |
| `delorun-thinking-rsvp` | [`@delorun/plugin-thinking-rsvp`](../plugin-thinking-rsvp/README.md) | The Thinking tab, which shows the model's reasoning and reply word by word in the right sidebar; inserted with `disabled: true`, like the cost meter |

## The first-run key dialog

- **Off.** The bundle's `ui-settings-models` patch sets `credentialOnboarding: false` (and restates `welcomeNotice: false` from `@delorun/bundle-local`, because a patch replaces the row's whole config), so upstream's "Add an API key" dialog never opens, also after a reload. The no-key banner of `@delorun/plugin-onboarding` replaces it; Settings → Agent → Models and the model picker still add a key. The stock look keeps the patch, so upstream's dialog does not return there.

## The stock look

- **One switch.** The theme row's `studioAdditions` is C16 switch `studio_additions`. Its Config default is `false`, the parity value; this bundle sets it to `true`, and the registry's default value, `true`, is checked against this row by the `parity-switches` specs, so the two cannot drift.
- **How it reaches every plugin.** While the switch is on, the theme's browser half provides the `delorunStudio` service. The browser half of every other plugin here registers everything inside an injection of that service, so turning the switch off disposes all of it and the studio shows upstream's sidebar, Settings and look. The harness halves keep running: snoozed and settled chats stay stored and return when the switch is turned back on.
- **Where the person finds it.** With the Delorun look on, Settings → General → Look offers the choice; with the stock look, upstream's General section shows one row to turn the Delorun look back on, and nothing else of Delorun's look remains.
- **The parity composition.** No profile the recorded-session replay runs mounts this bundle, so the switch stays at its Config default, off, and none of the plugins mounts.

## Tests

- `delorun/apps/tools/tests/parity/switches.spec.ts` holds the registry's default value of `studio_additions` to the theme row of this bundle's patch.
- `delorun/packages/bundle-local/tests/composition.integration.spec.ts` composes a Delorun CLI profile with this bundle and checks the rows it inserts.
