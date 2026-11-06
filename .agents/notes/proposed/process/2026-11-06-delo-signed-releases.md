# Agent Note: Delo releases are signed offline, carry an SBOM and a public log entry, and match a rebuild

Status: proposed

English | [中文](2026-11-06-delo-signed-releases.zh.md)

## Problem

A person who installs Delo needs to check that a release came from the tagged source. An unsigned release gives no such check. A release signed by a key on a build runner can be signed by any code that runs in that pipeline, so the signature does not show that a maintainer approved the release. An npm publication made with a long-lived token does not record which source built it.

## Proposal

Delo releases would be signed with an offline key that the release signer holds, not with a key held on a CI runner. Each release would carry a software bill of materials (SBOM) and a public transparency-log entry.

A rebuild of the tagged source by the signer, on a machine outside CI, would have to reproduce the release artifacts. A release would be described as reproduced from the tagged source with the published recipe only after that rebuild matches.

npm releases would publish through trusted publishing, with an OIDC attestation for each publication. The desktop app's release signing would match the offline arrangement that the [desktop packaging decision](../../implemented/architecture/2026-08-25-electron-desktop-packaging-and-updates.md) describes for Windows, where the private key stays on a hardware token. That decision keeps ownership of release identity, signatures and update requirements, and this proposal would not change that ownership.

## Related

The [npm release sequences decision](../../implemented/process/2026-08-10-npm-release-sequences.md) governs upstream's three npm publication sequences, under the `@deepseek-ai` scope. It records token-based publication and states the conditions under which OIDC attestation applies. Delo's packages would use the Delo npm scope and trusted publishing, so the two decisions cover different packages.

The [generated third-party notices decision](../../implemented/process/2026-07-30-generated-third-party-notices.md) generates the licence disclosure file from manifests. That file is separate from the SBOM, which would describe the contents of each release.

## Alternatives considered

**Unsigned releases.** A person cannot check where a release came from, and a rebuild has nothing to compare against.

**A signing key held by CI.** Any code that runs in the release pipeline can use such a key, so the signature shows that the pipeline ran, not that a maintainer approved the release.

## Acceptance criteria

- Each release record includes an SBOM, the artifact digests, and a public transparency-log entry that a third party can check against the signature.
- The signer's rebuild on a machine outside CI reproduces every artifact digest from the tagged source and the published recipe.
- Each npm publication of a Delo package carries an OIDC attestation that names the tagged source and the publishing workflow.
- A review of the workflow configuration shows that no CI job holds the release signing key.

## Risks

The rebuild needs byte-identical output, and upstream's npm decision records that byte reproducibility is assumed and not measured, so no release can claim reproduction while the property is unmeasured.

Offline key handling needs a named signer and a procedure, which makes each release manual and dependent on that signer's availability.

Trusted publishing requires the package's `repository` field to name the repository that runs the publishing workflow, which constrains where Delo's repositories are hosted.
