/**
 * The one rule that lets a production-channel launcher install a release the maintainer's PC built and signed.
 *
 * Until 1.0 the signing ceremony is deferred (A369), so a 0.x release is built and signed by `local-release.ts` on the
 * maintainer's PC, with no independent rebuild, and installs from the production channel (A506). The launcher pins the
 * preview root by the digest of its file and accepts it, and every later root that chains from it under the rotation
 * rules, while the verifying root keeps the pinned root's active targets key (L196). A 1.x release, a chain without the
 * pinned root and a root with another active targets key have no such allowance, so the allowance ends by itself when
 * the 1.0 ceremony's root names a new targets key.
 *
 * @module @delorun/install/local-builder
 */
import semver from 'semver'
import type { RootMetadata } from '@delorun/contract-release-manifest'
import type { TrustedRoot } from '@delorun/release-formats/sign/verify'

/**
 * SHA-256 of the pinned preview root file, which the trust page publishes. It is a fixed trust anchor, not a setting.
 * It names `1.root.json`, which lists no log-entry keys, so no release verifies under it; the root rotation of the
 * release runbook replaces it with the digest of `2.root.json` in the same change as the trust page.
 */
export const PREVIEW_ROOT_SHA256 = 'e78c076567b1a2e104756409ad6f4a77c9b8caab95a3f38e857a94f82523b746'

/**
 * The key ids of a root's `active` targets keys, sorted.
 * @param root - the root.
 * @returns the key ids.
 */
function activeTargets(root: RootMetadata): readonly string[] {
  return root.roles.targets.keys.filter(key => key.status === 'active').map(key => key.keyid).sort()
}

/**
 * Whether a release whose manifest names the local release builder may install from the production channel.
 *
 * Contract: true only when all of these hold, and nothing else (signature, digest, threshold, log, freshness and path
 * checks) is relaxed by it, because the caller has already verified those.
 * - The release version is a semantic version written exactly as `semver` normalises it, with major 0, so `1.0.0` and
 *   `1.0.0-rc.1` (major 1) and anything that does not parse are refused.
 * - The chain holds the pinned root: a root whose file digest, of the exact bytes the launcher walked, is one of
 *   `previewRoots`. A root of the same version with another digest, a root fetched from a channel that the walk did not
 *   reach from the launcher's own roots, and a root version alone pin nothing.
 * - The verifying root, the chain's last, has exactly the pinned root's `active` targets keys.
 * @param version - the release's version from its signed manifest.
 * @param chain - the root chain that verified the release, oldest first, as `walkRootChain` returned it for the bytes
 *   the launcher walked from its shipped roots: each root after the first verified under its predecessor's root
 *   threshold and its own. Its last root verified the release.
 * @param previewRoots - the file digests accepted as the pinned root; {@link PREVIEW_ROOT_SHA256} unless a spec
 *   supplies its own root.
 * @returns whether the local builder is allowed for this release under this chain.
 */
export function localBuilderAllowed(version: string, chain: readonly TrustedRoot[], previewRoots: readonly string[] = [PREVIEW_ROOT_SHA256]): boolean {
  const parsed = semver.parse(version)
  if (parsed === null || parsed.version !== version || parsed.major !== 0) return false
  const pinned = chain.find(root => previewRoots.includes(root.sha256))
  const verifying = chain.at(-1)
  if (pinned === undefined || verifying === undefined) return false
  const [anchor, newest] = [activeTargets(pinned.metadata), activeTargets(verifying.metadata)]
  return anchor.length > 0 && anchor.length === newest.length && anchor.every((keyid, index) => keyid === newest[index])
}
