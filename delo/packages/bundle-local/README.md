---
description: "Delo's local bundle, for maintainers changing what Delo's CLI profiles compose over upstream's web template: the bundle list, the privacy defaults for upstream's two opt-ins, the Privacy section in Settings and the specs that hold the composition to upstream's."
kind: "package-bundle"
---

# @delo/bundle-local

English | [中文](README.zh.md)

## Summary

`@delo/bundle-local` is the bundle that Delo's CLI profiles add after upstream's `web` profile template. Its patch holds Delo's local integration rows, each listed with its reason in [`LOCAL_ROWS`](src/rows.ts), so a Delo CLI profile composes upstream's web profile with those rows changed or added and nothing else. It turns off upstream's two opt-ins, DeepSeek's session-log upload and the desktop app's analytics, and adds the Privacy section in Settings, where the person turns each one on after a consent dialog and off again ([C11](../../docs/contracts/c11-setup-answers.md)). Delo's infrastructure plugins add their rows as they arrive.

## Contents

- [Use this bundle](#use-this-bundle)
- [Rows](#rows)
- [The Privacy section](#the-privacy-section)
- [Tests](#tests)
- [Limits](#limits)

## Use this bundle

- **The bundle list.** [`DELO_PROFILE_BUNDLES`](src/profile.ts), exported from `@delo/bundle-local/profile`, is the ordered `dsh.profile.bundles` list of a Delo CLI profile: upstream's `web` template, read from `@deepseek-ai/dsh-official-bundles`, followed by `@delo/bundle-local`. Upstream's own templates do not list this bundle, so `dsh --profile web` and the recorded-session replay compose upstream's bundles alone.
- **What `delorun` owns.** `delorun`, which creates the CLI profiles under `~/.delo/profiles/` ([C1](../../docs/contracts/c01-home-layout.md#profiles)), writes `DELO_PROFILE_BUNDLES` into each CLI profile it creates, and refuses to start a CLI profile when upstream's profile loader reports this bundle in `skippedBundles`, because the privacy defaults hold only while the bundle loads. This package does neither itself.
- **Layer order.** The bundle applies after every upstream bundle and before the profile's own `cordis.patch.yml`, the home patch and `--patch` overlays, so a person's setting in the profile still wins over a row here ([upstream's profile layers](../../../apps/cli/README.md#profiles)). The Privacy section writes to the profile's `cordis.patch.yml`.
- **Reading the composition.** `dsh --profile <name> --dump-config` prints every composed row under a `# ==` line naming the bundle that inserted it and each bundle that patched it; a row this bundle writes names `@delo/bundle-local` there.
- **Loading.** The bundle declares no `engines.dsh` range and no upstream peer, so upstream's compatibility check never skips it after a version change; a profile whose bundle list names it and cannot resolve it reports the bundle as skipped.
- **Building.** `pnpm --filter @delo/bundle-local run build` writes `lib/index.js`, the Host half of the `delo-privacy` row, and `lib/client.js`, the Privacy section. Upstream's `pnpm run build:artifacts` does not build Delo's packages.

## Rows

[`LOCAL_ROWS`](src/rows.ts) lists each row in which a Delo CLI profile differs from upstream's web profile, and the row's form in the C16 parity composition:

| Row | Kind | In a Delo CLI profile | In upstream's web profile | In the parity composition |
| --- | --- | --- | --- | --- |
| `session-log-deepseek` | changed | `config.enabled: false`: model requests carry no `dsh_session_log` field | the plugin's default, `true` | upstream's composition: the overlay leaves the row out, because it follows each replay's root configuration, which sets the upload per corpus |
| `product-analytics` | changed | `config.enabled: false`, with upstream's `appVersion` restated and upstream's `disabled` condition kept, so the row mounts only in the desktop profile and accepts no event there | `config.enabled: true` | as written here; the replay mounts no desktop Host |
| `delo-privacy` | added | the Privacy section in Settings | absent | present and disabled, because recorded web scenarios compare upstream's interface output |

The [parity overlay](../../apps/tools/src/parity/composition/parity.overlay.yml) mounts this bundle by restating its patch in that form; [`parityPatches`](src/rows.ts) derives the form from this bundle's `cordis.patch.yml`, and `parity-switches` fails when the overlay differs from it. Upstream's feedback telemetry row `session-telemetry-otel` is unchanged: it sends a session-log prefix only when the person sends feedback, and the Privacy section states that. No row names a Delo host.

## The Privacy section

The browser half ([`src/client/index.ts`](src/client/index.ts)) registers the `settings.section` `delo-privacy` ([`PRIVACY_SECTION_ID`](src/client/index.ts)), after upstream's Plugins section. It shows C11's statements (Delo has no telemetry of its own; both opt-ins are off unless the person turns them on; sending feedback includes a session-log prefix and happens only on sending), then one row per opt-in:

- **DeepSeek session-log upload** edits `session-log-deepseek`, and **Desktop analytics** edits `product-analytics`, each through upstream's configuration form for that row ([`OPT_IN_ROWS`](src/client/index.ts), from `@delo/contract-setup-answers`). A write changes only that row's `config.enabled`.
- **Turning on** opens a dialog that names what is sent and where; nothing is written until the person chooses Turn on, and Cancel writes nothing. **Turning off** writes at once.
- The switch shows the value the Host accepted. A refused or failed write leaves it unchanged and says so in the row.
- A profile that does not serve an opt-in's row shows no switch for it; for desktop analytics, the row says that only the desktop app collects it.

Setup and other surfaces open the section with `ctx.settingsShell.openSection('delo-privacy')`. Upstream's own **Settings → General** switch for session-log upload stays, and it edits the same row without the dialog. The section's copy is in English and Chinese.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/bundle-local` runs the package's specs, which import upstream's built packages and so need `pnpm run build:artifacts`; Delo's check runner starts it when the build is missing.

- [`composition.spec.ts`](tests/composition.spec.ts) builds a Delo CLI profile under a temporary `DSH_HOME` and reads it through upstream's real `dsh --profile <name> --dump-config`: every bundle of the list loads and none is skipped; the dump prints every row under a label whose writers are bundles of the list, prints nothing before the first label and nothing on stderr, and lists exactly the rows of `LOCAL_ROWS` as written by this bundle; the composition equals upstream's `web` profile row for row, except the rows of `LOCAL_ROWS`, which are changed in place or added after upstream's rows as each entry says.
- [`privacy-defaults.spec.ts`](tests/privacy-defaults.spec.ts) mounts upstream's own plugins with the rows each profile composes, against local network fixtures. With a Delo CLI profile's rows, no model request body to a mock DeepSeek API carries `dsh_session_log`, and a local OTLP collector receives no analytics record; with upstream's web profile rows, the same fixtures receive both. No string in the composition, `!!js` expressions included, names a Delo host, and the only rows naming a Delo package are this bundle's added rows.
- [`privacy-section.client.spec.tsx`](tests/privacy-section.client.spec.tsx) renders the section: each opt-in turns on only after the dialog's Turn on, writes only its own row, and turns off again from the same switch; Cancel writes nothing; a failed write keeps the accepted value; an unserved analytics row shows its reason; the plugin registers the section and writes each opt-in to its upstream row.
- `apps/web/tests/delo-privacy-consent.e2e.ts` builds this package, boots the studio with it as a profile bundle against a mock DeepSeek API and drives the section in Chromium: the first model request carries no session log, desktop analytics and session-log upload each turn on alone after consent, the next request carries the session log, and turning upload off again from the section removes it from the following request.

## Limits

- The bundle list is a constant for `delorun` to write; no shipped upstream template names it, so the recorded-session replay mounts this bundle only through the parity overlay.
- A profile created before a change to `DELO_PROFILE_BUNDLES` keeps the list it was created with.
- The privacy defaults hold only while the profile loads this bundle. Upstream reports a bundle it cannot load as skipped and starts without it, and session-log upload is then on; `delorun`'s refusal to start such a profile is what keeps the defaults.
- Desktop analytics mounts only in upstream's `desktop` profile, which `delorun` does not run, so a Delo CLI profile's section shows that row's reason instead of a switch.
