---
description: "Design of Delo's release workflow: the CI workflow that builds a release, logs it and publishes it after the targets-key holder signs, the scheduled timestamp re-signing, the advisory check before signing, npm trusted publishing without a token, two of N rebuilds, Authenticode, and the install scripts."
---

# The release workflow

English

## Summary

[Contract C2](../contracts/c02-release-manifest.md) and [contract C18](../contracts/c18-release-log.md) state how a release is signed, logged and verified, and the commands that sign, timestamp, log and check a release exist in [`delo/apps/release`](../../apps/release/README.md). This page holds the rules Delo has adopted for the parts that run in CI or that a release ships beyond the npm launcher: a release workflow, a scheduled timestamp re-signing, the advisory check as a workflow step, npm publication without a token, two of N rebuilds once maintainers sign, Authenticode signatures, and the install scripts.

## Contents

- [What exists today](#what-exists-today)
- [The rules](#the-rules)
- [What this does not protect against](#what-this-does-not-protect-against)
- [Denial tests](#denial-tests)
- [What is built so far](#what-is-built-so-far)

## What exists today

- No workflow under `.github/workflows` builds, signs, logs or publishes a Delo release. Signing a release, signing a timestamp, writing a release-log entry, checking advisories and comparing a rebuild are commands a person runs: `sign-release.ts`, `sign-timestamp.ts`, `log-release.ts`, `check-advisories.ts` and `compare-rebuild.ts` under `delo/apps/release/src/`.
- The signing command refuses without a matching rebuild record made outside CI, refuses under `CI` or `GITHUB_ACTIONS`, and re-runs the advisory check before it signs. The timestamp command refuses to move a channel to a lower version than the previous timestamp names.
- An advisory acceptance is valid only when its approver is a CODEOWNERS owner of `delo/release/` by login. `.github/CODEOWNERS` names only a team, which the check does not count, so no acceptance is valid and any advisory fails the check.
- `delo/apps/npm-launcher/src/build.ts` packs the `delorun` npm package with the release roots it is given. No workflow publishes it, and no `install.sh` or `install.ps1` exists.
- The release manifest's `desktop` entries name no Delo desktop build: the desktop app is upstream's.
- The closure recipe compiles upstream's native system addon (`native/system`) from the tagged source for `linux-x64` and `linux-arm64` in a builder image pinned by base digest, Debian snapshot and exact package versions, with no network, and `prebuilt-pins.json` pins the binaries. It has no pinned toolchain for the macOS binaries and refuses the `darwin-x64` and `darwin-arm64` closures, so no release that includes them can be built, rebuilt or signed; every other native file in a closure is a prebuilt npm file the lockfile pins.

## The rules

1. **The release workflow.** A workflow of Delo's public repository builds each tagged release, publishes its files to the GitHub release only after the targets-key holder's signature and the release-log bundle verify, and holds no root or targets key.
2. **Timestamp re-signing.** A scheduled job of the release workflow re-signs `timestamp.json` every 24 hours with the online timestamp key, held in the workflow's protected environment, and signs it again when it publishes a release. No signing moves a channel to a lower version.
3. **The advisory check before signing.** The workflow runs the advisory check of [C2](../contracts/c02-release-manifest.md#dependency-advisory-check) before the targets-key holder signs, and the release stops on its failure. The release notes list every accepted advisory with its package, range, reason, approver, lapse release and date.
4. **npm publication.** `delorun` and `create-delorun` publish only through npm trusted publishing from the release workflow: the publish job requests an OIDC token (`permissions: id-token: write`), holds no npm token, and npm attaches a Sigstore-signed SLSA build attestation naming the repository, the workflow file and the commit.
5. **Two of N rebuilds.** Once maintainers hold keys, signing requires matching rebuild records from two of the N listed builders, at least one with `ci: false`.
6. **Authenticode.** Every PE file in a Windows closure and the desktop app carries an Authenticode signature, and the manifest records the signed files' digests.
7. **The install scripts.** `install.sh` and `install.ps1` verify the closure as [C2](../contracts/c02-release-manifest.md#client-verification) states before installing, and the release notes and the Trust page print their digests.

## What this does not protect against

- **The signer's machine.** A rebuild shows that the tagged source and the published recipe produce the release, not that the signer's machine and toolchain are uncompromised.
- **A malicious change in the tagged source or a pinned dependency.** The rebuild reproduces it and the signature covers it.
- **The builder image's packages.** The rebuild shows that the pinned Debian compiler, linker and C libraries give the same binaries on both machines, not that those packages are free of a backdoor; both builds take them from the same Debian snapshot.
- **The npm launcher before any Delo check.** `npx delorun` runs the launcher npm serves; the build attestation is what ties it to the release workflow.

## Denial tests

| Test | Proves |
| --- | --- |
| `c02-npm-publish-has-no-token` | A workflow lint fails when the npm publish job references an npm token or lacks `id-token: write`. |
| `c02-pe-files-signed` | `signtool verify /pa` passes on every PE file in the Windows closure. |
| `the workflow publishes nothing before the signature and log verify` | A workflow run whose manifest signature or log bundle does not verify publishes no file to the release. |
| `the scheduled timestamp never lowers a channel` | A scheduled run whose input names a lower version for a channel refuses to sign. |
| `two of N rebuilds are required once maintainers sign` | Signing with one rebuild record under a two-of-N root refuses. |

## What is built so far

The signing, timestamp, log, advisory and rebuild-comparison commands and their refusals are built, and C2 and C18 describe them. None of the rules above is built.
