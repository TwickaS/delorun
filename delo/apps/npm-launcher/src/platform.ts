/**
 * The two facts the launcher's build fixes: which runtime closure this machine installs, and which log shard its
 * online check reads. The platform comes from Node's own identifiers, so the closure a release publishes for this
 * machine is the one it installs. The log's origin and the distributor's are the hosts the online check asks, under a
 * host list of their own: contract C1's release-file list does not name the log, and the log's list does not name a
 * release host. The root metadata names the log's identity, so a client never takes a new log from the network.
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
 * The witness network's checkpoint distributor, which publishes the latest witnessed checkpoint (contract C18, step 1).
 * The launcher reads the checkpoint from the log's own origin, whose note carries the witness cosignatures, and asks the
 * distributor for nothing else; its host is in {@link RELEASE_LOG_HOSTS} so that a checkpoint a distributor answers is
 * read under the log's rule rather than refused for a host contract C1's release-file list does not name.
 */
export const RELEASE_LOG_DISTRIBUTOR_ORIGIN = 'https://witness.sigstore.dev'

/**
 * The host of an origin, as a host rule names it.
 * @param origin - the origin.
 * @returns the lowercase host name, without a port.
 */
function hostOf(origin: string): string {
  return new URL(origin).hostname.toLowerCase()
}

/**
 * The only hosts the release-log check may reach (contract C18): the log's origin and the checkpoint distributor's.
 * This list is the log's own, and contract C1's `RELEASE_DOWNLOAD_HOSTS` is the release files' own: no install can pass
 * the online check when the log's host is missing from the rule the log is read under.
 */
export const RELEASE_LOG_HOSTS = [hostOf(RELEASE_LOG_TILES_ORIGIN), hostOf(RELEASE_LOG_DISTRIBUTOR_ORIGIN)] as const

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
