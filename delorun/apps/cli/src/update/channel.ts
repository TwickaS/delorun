/**
 * The release channel `delorun update` fetches through: `@delorun/install`'s `LauncherChannel`, the one implementation
 * of contract C2's client verification and contract C18's log check, walking from the release roots the launcher that
 * started this runtime ships ([trusted root](./trusted-root.ts)). The channel trusts the root this home stored only
 * when those roots lead to it, so the runtime trusts no root the launcher does not.
 *
 * The channel's origins are the ones the launcher that installed the runtime recorded in `trust/channel.json`, and
 * the release log is the one the trusted root names unless that record names another, each read through the
 * launcher's own `channelPlan` and `logPlan`, so an update fetches from where the installation did.
 * The update check opens the same channel, from the same roots and record, with its own deadline
 * ({@link homeCheckChannel}).
 *
 * @module @delorun/cli/update/channel
 */
import { RUNTIME_PLATFORMS, type ReleaseChannel, type RootMetadata, type RuntimePlatform } from '@delorun/contract-release-manifest'
import { Downloader, LauncherChannel, readChannelRecord, RELEASE_TIMINGS, type ChannelOrigins, type HostRule, type ReleaseSource } from '@delorun/install'
import { channelPlan, logPlan } from '@delorun/npm-launcher'
import { tilesTransport, type Fetch, type ReleaseLogTransport } from '@delorun/release-verify'
import type { UpdateInstallEvent, UpdateReleaseChannel } from '@delorun/runtime-store'

/**
 * The runtime platform of this machine, as contract C2 names it.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the platform.
 * @throws {Error} when contract C2 publishes no runtime for it.
 */
export function runtimePlatformOf(platform: string, arch: string): RuntimePlatform {
  const name = `${platform}-${arch}`
  const known = RUNTIME_PLATFORMS.find(candidate => candidate === name)
  if (known === undefined) throw new Error(`Delorun publishes no runtime for ${name}`)
  return known
}

/**
 * The release log of a trusted root as this home reads it: the log origin the installing launcher recorded, or the one
 * the root names when the record names none, through the launcher's own `logPlan`.
 * @param origins - the home's channel record; an empty object for the production channel.
 * @param root - the trusted root.
 * @param fetch - the fetch the transport reads through.
 * @returns the transport.
 * @throws {Error} the launcher's refusal of an origin that breaks its rule.
 */
export function recordedLogTransport(origins: ChannelOrigins, root: RootMetadata, fetch: Fetch): ReleaseLogTransport {
  const log = logPlan(root.log.origin, origins)
  return tilesTransport({ fetch, checkpoint: `${log.origin}/checkpoint`, tiles: log.origin })
}

/**
 * The release channel of this home: the one its installation recorded. The origins come from `trust/channel.json`,
 * which Delorun writes only from the launcher that installed the runtime; no environment variable or setting is read for
 * them. `trust/` lies under the home at mode 0700, which the sandbox keeps confined commands from writing; an
 * unconfined process of the same user, a Host plugin included, can write the record as it can any file of the home, so
 * the record decides only where releases are fetched from: a release installs only when it verifies under the stored
 * roots.
 * @param home - the resolved Delorun home, whose `trust/` holds the root, the chain an install verified and the channel record.
 * @param platform - the runtime platform.
 * @param channel - the person's release channel.
 * @param shipped - the root files the launcher that started this runtime ships, oldest first.
 * @param report - told of each step of the install, which the CLI draws as the launcher does.
 * @returns the channel.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the channel record does not read; the launcher's refusal of a
 *   recorded origin that breaks its rule.
 */
export async function homeReleaseChannel(home: string, platform: RuntimePlatform, channel: ReleaseChannel, shipped: readonly Uint8Array[], report: (event: UpdateInstallEvent) => void): Promise<UpdateReleaseChannel> {
  const origins = await readChannelRecord(home) ?? {}
  const plan = channelPlan(origins)
  const fetch = globalThis.fetch.bind(globalThis)
  return new LauncherChannel({
    home, platform, roots: shipped, channel,
    log: trusted => recordedLogTransport(origins, trusted, fetch),
    source: plan.source,
    downloader: new Downloader({ hosts: plan.rule }),
    progress: report,
  })
}

/** What {@link homeCheckChannel} needs besides the home. */
export interface CheckChannelOptions {
  /** The runtime platform. */
  readonly platform: RuntimePlatform
  /** The channel the running release names. */
  readonly channel: ReleaseChannel
  /** The root files the launcher that started this runtime ships, oldest first. */
  readonly shipped: readonly Uint8Array[]
  /** The fetch every request goes through; it carries the check's deadline. */
  readonly fetch: typeof globalThis.fetch
  /** How long one request may take, in milliseconds. */
  readonly timeoutMs: number
  /** The clock, in milliseconds. */
  readonly now: () => number
  /** Where the files are published and the hosts they may come from; the installation's recorded channel by default. */
  readonly publication?: Publication
}

/** Where release files are published, and the download rule for their hosts. */
export interface Publication {
  /** The metadata host and the release files' URLs. */
  readonly source: ReleaseSource
  /** The hosts, scheme and redirects a download may use. */
  readonly hosts: HostRule
}

/**
 * The release channel of this home as the update check opens it: the channel {@link homeReleaseChannel} opens, from
 * the same launcher roots and the same channel record, whose every request is held to the check's timeout. The check
 * calls only `LauncherChannel.newest`, which runs no online log check, so the log transport is never asked.
 * @param home - the resolved Delorun home.
 * @param options - the platform, the channel, the launcher's roots, the fetch, the timeout, the clock and the publication.
 * @returns the channel.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the channel record does not read; the launcher's refusal of a
 *   recorded origin that breaks its rule.
 */
export async function homeCheckChannel(home: string, options: CheckChannelOptions): Promise<LauncherChannel> {
  const origins = await readChannelRecord(home) ?? {}
  const plan = channelPlan(origins)
  const publication = options.publication ?? { source: plan.source, hosts: plan.rule }
  const timings = { connectMs: Math.min(options.timeoutMs, RELEASE_TIMINGS.connectMs), stallMs: Math.min(options.timeoutMs, RELEASE_TIMINGS.stallMs), totalMs: options.timeoutMs }
  return new LauncherChannel({
    home, platform: options.platform, roots: options.shipped, channel: options.channel,
    log: trusted => recordedLogTransport(origins, trusted, options.fetch),
    source: publication.source,
    downloader: new Downloader({ fetch: options.fetch, timings, hosts: publication.hosts }),
    now: options.now,
  })
}
