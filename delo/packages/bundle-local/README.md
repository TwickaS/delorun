---
description: "Delo's local bundle, for maintainers changing what Delo's CLI profiles compose over upstream's web template: the bundle list, the rows the bundle writes and the specs that hold the composition to upstream's."
kind: "package-bundle"
---

# @delo/bundle-local

English | [中文](README.zh.md)

## Summary

`@delo/bundle-local` is the bundle that Delo's CLI profiles add after upstream's `web` profile template. Its patch holds Delo's local integration rows, each listed with its reason in [`LOCAL_ROWS`](src/profile.ts), so a Delo CLI profile composes upstream's web profile with those rows changed or added and nothing else. The bundle writes no rows yet: Delo's infrastructure plugins add theirs as they arrive.

## Contents

- [Use this bundle](#use-this-bundle)
- [Rows](#rows)
- [Tests](#tests)
- [Limits](#limits)

## Use this bundle

- **The bundle list.** [`DELO_PROFILE_BUNDLES`](src/profile.ts) is the ordered `dsh.profile.bundles` list of a Delo CLI profile: upstream's `web` template, read from `@deepseek-ai/dsh-official-bundles`, followed by `@delo/bundle-local`. `delorun` writes it into each CLI profile it creates under `~/.delo/profiles/` ([C1](../../docs/contracts/c01-home-layout.md#profiles)). Upstream's own templates do not list this bundle, so `dsh --profile web`, the recorded-session replay and the [parity composition](../../docs/contracts/c16-parity-composition.md) compose upstream's bundles alone.
- **Layer order.** The bundle applies after every upstream bundle and before the profile's own `cordis.patch.yml`, the home patch and `--patch` overlays, so a person's setting in the profile still wins over a row here ([upstream's profile layers](../../../apps/cli/README.md#profiles)).
- **Reading the composition.** `dsh --profile <name> --dump-config` prints every composed row under a `# ==` line naming the bundle that inserted it and each bundle that patched it; a row this bundle writes names `@delo/bundle-local` there.
- **Loading.** The bundle declares no `engines.dsh` range and no upstream peer, so upstream's compatibility check never skips it after a version change; a profile whose bundle list names it and cannot resolve it reports the bundle as skipped.

## Rows

[`LOCAL_ROWS`](src/profile.ts) lists each row in which a Delo CLI profile differs from upstream's web profile: its id, whether the bundle changes an upstream row or adds one, and why. The list is empty.

## Tests

`node_modules/.bin/vitest run --config delo/vitest.config.ts delo/packages/bundle-local` runs [`composition.spec.ts`](tests/composition.spec.ts), which builds a Delo CLI profile under a temporary `DSH_HOME` and reads it through upstream's real `dsh --profile <name> --dump-config`:

- every bundle of the list loads and none is skipped;
- the dump prints every row under a label whose writers are bundles of the list, prints nothing before the first label and nothing on stderr, and lists exactly the rows of `LOCAL_ROWS` as written by this bundle;
- the composition equals upstream's `web` profile row for row, except the rows of `LOCAL_ROWS`, which are changed in place or added after upstream's rows as each entry says.

The specs import upstream's built packages, so they need `pnpm run build:artifacts`, which Delo's check runner starts when the build is missing.

## Limits

- The bundle list is a constant for `delorun` to write; no shipped upstream template names it, so the C16 parity replay does not mount this bundle.
- A profile created before a change to `DELO_PROFILE_BUNDLES` keeps the list it was created with.
