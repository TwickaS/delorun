/**
 * The release channel `delorun update` fetches through: `@delo/install`'s `LauncherChannel`, the one implementation
 * of contract C2's client verification and contract C18's log check, walking from the release roots the launcher that
 * started this runtime ships ([trusted root](./trusted-root.ts)). The channel trusts the root this home stored only
 * when those roots lead to it, so the runtime trusts no root the launcher does not.
 *
 * The channel's origins are the ones the launcher that installed the runtime recorded in `trust/channel.json`, and
 * the release log is the one the trusted root names unless that record names another, each read through the
 * launcher's own `channelPlan` and `logPlan`, so an update fetches from where the installation did.
 *
 * @module @delo/cli/update/channel
 */
import { RUNTIME_PLATFORMS, type ReleaseChannel, type RootMetadata, type RuntimePlatform } from '@delo/contract-release-manifest'
import { Downloader, LauncherChannel, progressLines, readChannelRecord, type ChannelOrigins, type InstallProgress } from '@delo/install'
import { channelPlan, logPlan } from '@delo/npm-launcher'
import { tilesTransport, type Fetch, type ReleaseLogTransport } from '@delo/release-verify'
import type { UpdateReleaseChannel } from '@delo/runtime-store'

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
  if (known === undefined) throw new Error(`Delo publishes no runtime for ${name}`)
  return known
}

/**
 * The launcher's install lines for each step of an install, written one by one.
 * @param line - writes one line.
 * @returns the channel's progress listener.
 */
export function installLines(line: (text: string) => void): (event: InstallProgress) => void {
  return (event) => {
    for (const text of progressLines(event)) line(text)
  }
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
 * which Delo writes only from the launcher that installed the runtime; no environment variable or setting is read for
 * them. `trust/` lies under the home at mode 0700, which the sandbox keeps confined commands from writing; an
 * unconfined process of the same user, a Host plugin included, can write the record as it can any file of the home, so
 * the record decides only where releases are fetched from: a release installs only when it verifies under the stored
 * roots.
 * @param home - the resolved Delo home, whose `trust/` holds the root, the chain an install verified and the channel record.
 * @param platform - the runtime platform.
 * @param channel - the person's release channel.
 * @param shipped - the root files the launcher that started this runtime ships, oldest first.
 * @param line - writes each line of the install's progress, the lines the launcher prints while it installs.
 * @returns the channel.
 * @throws {InstallError} `TRUST_STATE_INVALID` when the channel record does not read; the launcher's refusal of a
 *   recorded origin that breaks its rule.
 */
export async function homeReleaseChannel(home: string, platform: RuntimePlatform, channel: ReleaseChannel, shipped: readonly Uint8Array[], line: (text: string) => void): Promise<UpdateReleaseChannel> {
  const origins = await readChannelRecord(home) ?? {}
  const plan = channelPlan(origins)
  const fetch = globalThis.fetch.bind(globalThis)
  return new LauncherChannel({
    home, platform, roots: shipped, channel,
    log: trusted => recordedLogTransport(origins, trusted, fetch),
    source: plan.source,
    downloader: new Downloader({ hosts: plan.rule }),
    progress: installLines(line),
  })
}
