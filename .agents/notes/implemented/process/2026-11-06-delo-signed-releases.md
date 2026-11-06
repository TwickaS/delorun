# Agent Note: Delo releases are signed offline, carry an SBOM and a public log entry, and match a rebuild

Status: implemented

English | [中文](2026-11-06-delo-signed-releases.zh.md)

## Problem

A person who installs Delo needs to check that a release came from the tagged source. An unsigned release gives no such check. A release signed by a key on a build runner can be signed by any code that runs in that pipeline, so the signature does not show that a maintainer approved the release. An npm publication made with a long-lived token does not record which source built it.

## Decision

Delo releases are signed with an offline key that the release signer holds, not with a key held on a CI runner. Each release carries a software bill of materials (SBOM) and a public transparency-log entry.

A rebuild of the tagged source by the signer, on a machine outside CI, must reproduce the release artifacts. A release is described as reproduced from the tagged source with the published recipe only after that rebuild matches.

npm releases publish through trusted publishing with provenance. The desktop app's release signing matches the offline arrangement that the [desktop packaging decision](../architecture/2026-08-25-electron-desktop-packaging-and-updates.md) describes for Windows, where the private key stays on a hardware token. That decision keeps ownership of release identity, signatures and update requirements, and this decision does not change that ownership.

## Verification

The signer's rebuild compares the artifact digests with the release record, and a mismatch stops the release. Anyone can check a release's signature against its public transparency-log entry. npm records a provenance statement for each publication.

## Related

The [npm release sequences decision](../process/2026-08-10-npm-release-sequences.md) governs upstream's three npm publication sequences, under the `@deepseek-ai` scope. It records token-based publication and states the conditions under which OIDC attestation applies. Delo's packages use the Delo npm scope and trusted publishing, so the two decisions cover different packages.

The [generated third-party notices decision](../process/2026-07-30-generated-third-party-notices.md) generates the licence disclosure file from manifests. That file is separate from the SBOM, which describes the contents of each release.

## Alternatives considered

**Unsigned releases.** A person cannot check where a release came from, and a rebuild has nothing to compare against.

**A signing key held by CI.** Any code that runs in the release pipeline can use such a key, so the signature shows that the pipeline ran, not that a maintainer approved the release.

## Consequences

Each release needs the signer's offline key and a rebuild on a machine outside CI, so a release is not fully automated.

A rebuild must match, so the build's byte reproducibility has to be measured. The upstream npm decision records that byte reproducibility is assumed and not measured.

Trusted publishing requires the package's `repository` field to name the repository that runs the publishing workflow. The upstream npm decision records the same condition for OIDC attestation.
