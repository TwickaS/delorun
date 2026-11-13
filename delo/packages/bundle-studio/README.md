---
description: "Delo's studio bundle, for maintainers changing which studio plugins Delo's CLI profiles mount and how the one switch back to the stock look reaches them."
kind: "package-bundle"
---

# @delo/bundle-studio

## Summary

`@delo/bundle-studio` is the bundle that mounts Delo's studio additions in every Delo CLI profile: the theme, the settings layout, chat states, the sidebar and onboarding, and the optional cost meter, whose row stays disabled until the person turns it on. It holds no code; its [`cordis.patch.yml`](cordis.patch.yml) inserts one row per plugin and turns on [C16](../../docs/contracts/c16-parity-composition.md) switch `studio_additions` on the theme row. One switch in Settings turns all of them off and leaves upstream's studio, the stock look.

## Contents

- [Use this bundle](#use-this-bundle)
- [Rows](#rows)
- [The first-run key dialog](#the-first-run-key-dialog)
- [The stock look](#the-stock-look)
- [Tests](#tests)

## Use this bundle

- **The bundle list.** `@delo/bundle-local`'s [`DELO_PROFILE_BUNDLES`](../bundle-local/src/profile.ts) lists this bundle after `@delo/bundle-local`, so `delorun setup` writes it into every CLI profile it creates and links it into the profile as it links every Delo bundle. A profile created before this bundle existed does not list it and keeps the stock look.
- **Layer order.** The bundle applies after every upstream bundle and after `@delo/bundle-local`, and before the profile's own `cordis.patch.yml`, so a setting the person changes in Settings, which writes the profile's patch, wins over a row here.
- **Loading.** `delorun` refuses to start a CLI profile whose loader skipped a bundle in the `@delo/` scope, so a profile that lists this bundle and cannot resolve it does not start with half of the studio.
- **Building.** Each plugin's `pnpm --filter <package> run build` writes its `lib/index.js` and `lib/client.js`; upstream's `pnpm run build:artifacts` does not build Delo's packages.

## Rows

| Row | Plugin | What it adds |
| --- | --- | --- |
| `delo-theme` | [`@delo/plugin-theme`](../plugin-theme/README.md) | Delo's palette, accent, typefaces and density, the Appearance and Conversation sections, and the switch `studioAdditions`, set to `true` here |
| `delo-settings-layout` | [`@delo/plugin-settings-layout`](../plugin-settings-layout/README.md) | Settings grouped by topic, with search |
| `delo-chat-states` | [`@delo/plugin-chat-states`](../plugin-chat-states/README.md) | Snooze and settle chats, with their shelves |
| `delo-sidebar` | [`@delo/plugin-sidebar`](../plugin-sidebar/README.md) | The chat list as cards, workspace icons and header art |
| `delo-onboarding` | [`@delo/plugin-onboarding`](../plugin-onboarding/README.md) | The first-run guide that ends in a new chat; this bundle sets its `plugins` to four experimental plugins that ship with DeepSeek Harness: session search, the terminal bundle, the worktree tool and session titles |
| `delo-cost-meter` | [`@delo/plugin-cost-meter`](../plugin-cost-meter/README.md) | The estimated chat cost under the composer; inserted with `disabled: true`, so it mounts only after the person turns it on in Settings → Plugins |

## The first-run key dialog

- **Off.** The bundle's `ui-settings-models` patch sets `credentialOnboarding: false` (and restates `welcomeNotice: false` from `@delo/bundle-local`, because a patch replaces the row's whole config), so upstream's "Add an API key" dialog never opens, also after a reload. The no-key banner of `@delo/plugin-onboarding` replaces it; Settings → Models and the model picker still add a key. The stock look keeps the patch, so upstream's dialog does not return there.

## The stock look

- **One switch.** The theme row's `studioAdditions` is C16 switch `studio_additions`. Its Config default is `false`, the parity value; this bundle sets it to `true`, and the registry's default value, `true`, is checked against this row by the `parity-switches` specs, so the two cannot drift.
- **How it reaches every plugin.** While the switch is on, the theme's browser half provides the `deloStudio` service. The browser half of every other plugin here registers everything inside an injection of that service, so turning the switch off disposes all of it and the studio shows upstream's sidebar, Settings and look. The harness halves keep running: snoozed and settled chats stay stored and return when the switch is turned back on.
- **Where the person finds it.** With the Delo look on, Settings → Appearance offers the choice at its top; with the stock look, upstream's General section shows one row to turn the Delo look back on, and nothing else of Delo's look remains.
- **The parity composition.** No profile the recorded-session replay runs mounts this bundle, so the switch stays at its Config default, off, and none of the plugins mounts.

## Tests

- `delo/apps/tools/tests/parity/switches.spec.ts` holds the registry's default value of `studio_additions` to the theme row of this bundle's patch.
- `delo/packages/bundle-local/tests/composition.integration.spec.ts` composes a Delo CLI profile with this bundle and checks the rows it inserts.
