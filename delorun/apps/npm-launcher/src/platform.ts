/**
 * The facts the launcher's build fixes: which runtime closure this machine installs, where its release channel is,
 * and which log shard its online check reads. The platform comes from Node's own identifiers, so the closure a release
 * publishes for this machine is the one it installs. The channel's origin and the log's origin are build constants
 * (contract C1, "Download"): a build passes them to the bundler, which replaces {@link BUILD_CONSTANTS}, and no
 * setting, argument or environment variable moves them afterwards. A build that passes neither gets the production
 * channel and reads the log the trusted root names: the root's `log.origin` is the log's host, and the log's address is
 * that host under {@link RELEASE_LOG_API_PREFIX}. The log is read under a host rule of its own, which names only that
 * host: contract C1's release-file list does not name the log, and the log's rule does not name a release host.
 *
 * @module @delorun/npm-launcher/platform
 */
import { RUNTIME_PLATFORMS, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { buildOrigin, RELEASE_SOURCE, RELEASE_HOSTS, type ChannelOrigins, type HostRule, type ReleaseSource } from '@delorun/install'

/**
 * The path below a Rekor v2 log's host that serves its checkpoint and tiles (`/api/v2/checkpoint`,
 * `/api/v2/tile/<L>/<N>`), which the public log's own reads confirm. The log's host is not a constant here: it is the
 * `log.origin` of the root the launcher trusts, so the address the check reads and the log the root names cannot differ.
 */
export const RELEASE_LOG_API_PREFIX = '/api/v2'

/**
 * The runtime platform of this machine, as contract C2 names it.
 * @param platform - Node's `process.platform`.
 * @param arch - Node's `process.arch`.
 * @returns the platform whose runtime closure this machine installs.
 * @throws {Error} when no release can publish a closure for the pair, naming it. Whether the current release lists the
 * platform is the channel's check, once the manifest verifies.
 */
export function platformOf(platform: string, arch: string): RuntimePlatform {
  const name = `${platform}-${arch}`
  const known = RUNTIME_PLATFORMS.find(candidate => candidate === name)
  if (known === undefined) {
    throw new Error(`Delorun has no runtime for ${name}; a release can publish one only for ${RUNTIME_PLATFORMS.join(', ')}, and its manifest lists the ones it does`)
  }
  return known
}

/** The guide section that explains how to run Delorun in WSL2; the refusals below link to it. */
export const WSL_GUIDE = 'https://docs.delorun.com/guide/get-started/install#windows-through-wsl2'

/**
 * Why this Delorun does not run on a host, before any download.
 * @param platform - Node's `process.platform`.
 * @param version - the launcher package's own version, or `undefined` when it does not read; the refusal then says "Delorun" alone.
 * @param arch - Node's `process.arch`, or `undefined` to leave the processor out of the decision. Releases publish a runtime for Linux x64 only, so Linux on arm64 is refused.
 * @returns the refusal for native Windows, macOS or Linux on arm64, naming the version, what works and the guide; `undefined` for every other host.
 */
export function hostRefusal(platform: string, version?: string, arch?: string): string | undefined {
  const name = version === undefined ? 'Delorun' : `Delorun ${version}`
  const works = `It runs on Linux (x64), and on Windows through WSL2: ${WSL_GUIDE}`
  switch (platform) {
    case 'win32':
      return `${name} runs in WSL2, not on native Windows. Nothing was downloaded. Open a WSL2 terminal and run it there: ${WSL_GUIDE}`
    case 'darwin':
      return `${name} does not run on macOS. Nothing was downloaded. ${works}`
    case 'linux':
      return arch === 'arm64' ? `${name} does not run on Linux on ARM (arm64). Nothing was downloaded. ${works}` : undefined
    default:
      return undefined
  }
}

/**
 * The origins a build may replace, the same fields a home's channel record holds. An absent field keeps the production
 * value.
 */
export type BuildConstants = ChannelOrigins

/** The bundler's replacement for the build's origins; `undefined` in a source run, which uses production values. */
declare const __DELORUN_LAUNCHER_BUILD__: BuildConstants | undefined

/** The origins this build was made with, or an empty object for the production channel and log. */
export const BUILD_CONSTANTS: BuildConstants = typeof __DELORUN_LAUNCHER_BUILD__ === 'undefined' ? {} : __DELORUN_LAUNCHER_BUILD__

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
  /** The log's tlog-tiles prefix. */
  readonly origin: string
  /** The hosts the check may reach, redirects included. */
  readonly hosts: readonly string[]
}

/**
 * The release log a trusted root names. A build for a local log passes the log's origin as a build constant, which wins;
 * every other build reads `https://<root.log.origin>` below {@link RELEASE_LOG_API_PREFIX}, so the log it asks is the log
 * the root names.
 * @param logOrigin - the root's `log.origin`: the log's host, with a port when it has one.
 * @param constants - the build's origins.
 * @returns the log's prefix and its one host.
 * @throws {Error} when the build's log origin breaks {@link buildOrigin}'s rule, or the root's `log.origin` is not a host.
 */
export function logPlan(logOrigin: string, constants: BuildConstants = BUILD_CONSTANTS): LogPlan {
  if (constants.logOrigin !== undefined) {
    const origin = buildOrigin(constants.logOrigin, 'log origin')
    return { origin, hosts: [new URL(origin).hostname] }
  }
  let url: URL
  try {
    url = new URL(`https://${logOrigin}`)
  } catch {
    // The URL constructor's own message names no origin, so the refusal below is the one reported.
    throw new Error(`the root names the log ${JSON.stringify(logOrigin)}, which is not a host`)
  }
  if (url.host !== logOrigin.toLowerCase() || url.username !== '' || url.password !== '') {
    throw new Error(`the root names the log ${JSON.stringify(logOrigin)}, which is not a host with an optional port`)
  }
  return { origin: `https://${url.host}${RELEASE_LOG_API_PREFIX}`, hosts: [url.hostname] }
}
