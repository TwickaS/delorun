/**
 * The one rule that lets a production-channel launcher install a release the maintainer's PC built and signed.
 *
 * Until 1.0 the signing ceremony is deferred (A369), so a 0.x release is built and signed by `local-release.ts` on the
 * maintainer's PC, with no independent rebuild, and installs from the production channel (A506) under the one root file
 * the launcher pins by its digest (A616). A 1.0 release, or a release under any other root, has no such allowance.
 *
 * @module @delorun/install/local-builder
 */
import semver from 'semver'
import type { TrustedRoot } from '@delorun/release-formats/sign/verify'

/**
 * SHA-256 of the pinned preview root file, which the trust page publishes. It is a fixed trust anchor, not a setting.
 * It names `1.root.json`, which lists no log-entry keys, so no release verifies under it; the root rotation of the
 * release runbook replaces it with the digest of `2.root.json` in the same change as the trust page.
 */
export const PREVIEW_ROOT_SHA256 = 'e78c076567b1a2e104756409ad6f4a77c9b8caab95a3f38e857a94f82523b746'

/**
 * Whether a release whose manifest names the local release builder may install from the production channel.
 *
 * Contract: true only when both hold, and nothing else (signature, digest, threshold, log, freshness and path checks)
 * is relaxed by it, because the caller has already verified those.
 * - The release version is a semantic version written exactly as `semver` normalises it, with major 0, so `1.0.0` and `1.0.0-rc.1` (major 1) and
 *   anything that does not parse are refused.
 * - The verifying root is the pinned preview root: its file digest is one of `previewRoots`. Every other root file, of
 *   any version, is refused.
 * @param version - the release's version from its signed manifest.
 * @param root - the root that verified the release: the newest root of the chain the launcher walked.
 * @param previewRoots - the file digests accepted as the preview root; {@link PREVIEW_ROOT_SHA256} unless a spec
 *   supplies its own root.
 * @returns whether the local builder is allowed for this release under this root.
 */
export function localBuilderAllowed(version: string, root: TrustedRoot, previewRoots: readonly string[] = [PREVIEW_ROOT_SHA256]): boolean {
  const parsed = semver.parse(version)
  if (parsed === null || parsed.version !== version || parsed.major !== 0) return false
  return previewRoots.includes(root.sha256)
}
