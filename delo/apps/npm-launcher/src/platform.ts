/**
 * The two facts the launcher's build fixes: which runtime closure this machine installs, and which log shard its
 * online check reads. The platform comes from Node's own identifiers, so the closure a release publishes for this
 * machine is the one it installs. The log's origin is the one host the online check asks; the root metadata names the
 * log's identity, so a client never takes a new log from the network.
 *
 * @module @delo/npm-launcher/platform
 */
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delo/contract-release-manifest'

/**
 * The public Rekor host the online check reads its checkpoint and consistency proof from (contract C18). The root
 * metadata names the log's origin and verifier key, so this host can answer only for the log the root names.
 */
export const RELEASE_LOG_TILES_ORIGIN = 'https://rekor.sigstore.dev'

/**
 * The runtime platform of this machine, as contract C2 names it.
 * @param platform - Node's `process.platform`.
 * @param arch - Node's `process.arch`.
 * @returns the platform whose runtime closure this machine installs.
 * @throws {Error} when Delo publishes no closure for the pair, naming it.
 */
export function platformOf(platform: string, arch: string): RuntimePlatform {
  const name = `${platform}-${arch}`
  const known = RUNTIME_PLATFORMS.find(candidate => candidate === name)
  if (known === undefined) {
    throw new Error(`Delo publishes a runtime for ${RUNTIME_PLATFORMS.join(', ')}, not for ${name}`)
  }
  return known
}
