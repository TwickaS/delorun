/**
 * The facts the launcher's build fixes: which runtime closure this machine installs, where its release channel is,
 * and which log shard its online check reads. The platform comes from Node's own identifiers, so the closure a release
 * publishes for this machine is the one it installs. The channel's origin and the log's origin are build constants
 * (contract C1, "Download"): a build passes them to the bundler, which replaces {@link BUILD_CONSTANTS}, and no
 * setting, argument or environment variable moves them afterwards. A build that passes neither gets the production
 * channel and the public log. The log's origin and the distributor's are the hosts the online check asks, under a
 * host list of their own: contract C1's release-file list does not name the log, and the log's list does not name a
 * release host. The root metadata names the log's identity, so a client never takes a new log from the network.
 *
 * @module @delo/npm-launcher/platform
 */
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delo/contract-release-manifest'
import { RELEASE_SOURCE, RELEASE_HOSTS, type HostRule, type ReleaseSource } from '@delo/install'

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

/**
 * The origins a build may replace. An absent field keeps the production value.
 */
export interface BuildConstants {
  /** The origin that serves `timestamp.json`, `root/<n>.root.json` and `releases/download/v<version>/<file>`. */
  readonly channelOrigin?: string
  /** The log shard's `tlog-tiles` origin, which answers `/checkpoint` and `/proof/consistency`. */
  readonly logOrigin?: string
}

/** The bundler's replacement for the build's origins; `undefined` in a source run, which uses production values. */
declare const __DELO_LAUNCHER_BUILD__: BuildConstants | undefined

/** The origins this build was made with, or an empty object for the production channel and log. */
export const BUILD_CONSTANTS: BuildConstants = typeof __DELO_LAUNCHER_BUILD__ === 'undefined' ? {} : __DELO_LAUNCHER_BUILD__

/** The hosts an `http:` build origin may name: this machine only. */
const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '[::1]']

/**
 * Check a build origin: an origin with no path, query or fragment, over `https:`, or over `http:` for this machine's
 * loopback address so a local channel and log can serve a build.
 * @param origin - the origin a build passes.
 * @param what - what the origin is, for the refusal.
 * @returns the origin without a trailing slash.
 * @throws {Error} naming the origin and the rule it breaks.
 */
export function buildOrigin(origin: string, what: string): string {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    // The URL constructor's own message names no origin, so the refusal below is the one reported.
    throw new Error(`the ${what} ${JSON.stringify(origin)} is not a URL`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`the ${what} ${origin} must be an origin: a scheme, a host and a port, with no path, query, fragment or credentials`)
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) {
    throw new Error(`the ${what} ${origin} must use https, or http on this machine's loopback address`)
  }
  return url.origin
}

/** Where a build's release files are fetched from, and the download rule that covers it. */
export interface ChannelPlan {
  /** Where the files are published. */
  readonly source: ReleaseSource
  /** The hosts and redirects the release-file downloader allows. */
  readonly rule: HostRule
}

/**
 * The release channel of a build. The production build keeps contract C2's publication and contract C1's host list.
 * A build with another channel origin fetches everything below that origin, with the same file layout GitHub
 * Releases gives (`releases/download/v<version>/<file>`), and allows that origin's host and no other.
 * @param constants - the build's origins.
 * @returns the source and the download rule.
 * @throws {Error} when the channel origin breaks {@link buildOrigin}'s rule.
 */
export function channelPlan(constants: BuildConstants = BUILD_CONSTANTS): ChannelPlan {
  if (constants.channelOrigin === undefined) return { source: RELEASE_SOURCE, rule: RELEASE_HOSTS }
  const origin = buildOrigin(constants.channelOrigin, 'channel origin')
  const url = new URL(origin)
  return {
    source: { metadata: origin, files: (version, name) => `${origin}/releases/download/v${version}/${name}` },
    rule: { scheme: url.protocol, hosts: [url.hostname], maxRedirects: RELEASE_HOSTS.maxRedirects },
  }
}

/** Where a build's release-log check reads, and the hosts it may reach. */
export interface LogPlan {
  /** The log shard's `tlog-tiles` origin. */
  readonly origin: string
  /** The hosts the check may reach, redirects included. */
  readonly hosts: readonly string[]
}

/**
 * The release log of a build: the public log and its witness distributor, or the one origin the build names.
 * @param constants - the build's origins.
 * @returns the origin and its host list.
 * @throws {Error} when the log origin breaks {@link buildOrigin}'s rule.
 */
export function logPlan(constants: BuildConstants = BUILD_CONSTANTS): LogPlan {
  if (constants.logOrigin === undefined) return { origin: RELEASE_LOG_TILES_ORIGIN, hosts: RELEASE_LOG_HOSTS }
  const origin = buildOrigin(constants.logOrigin, 'log origin')
  return { origin, hosts: [new URL(origin).hostname] }
}
