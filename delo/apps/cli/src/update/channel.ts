/**
 * The release channel `delorun update` fetches through: `@delo/install`'s `LauncherChannel`, the one implementation
 * of contract C2's client verification and contract C18's log check, walking from the release roots the launcher that
 * started this runtime ships ([trusted root](./trusted-root.ts)). The channel trusts the root this home stored only
 * when those roots lead to it, so the runtime trusts no root the launcher does not.
 *
 * The release log is the one the trusted root names, read through `@delo/release-verify`'s transport, as the
 * launcher reads it.
 *
 * @module @delo/cli/update/channel
 */
import { RUNTIME_PLATFORMS, type ReleaseChannel, type RuntimePlatform } from '@delo/contract-release-manifest'
import { Downloader, LauncherChannel, progressLines, type InstallProgress } from '@delo/install'
import { logEndpoints, tilesTransport } from '@delo/release-verify'
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
 * The release channel of this home.
 * @param home - the resolved Delo home, whose `trust/` holds the root and the chain an install verified.
 * @param platform - the runtime platform.
 * @param channel - the person's release channel.
 * @param shipped - the release roots the launcher that started this runtime ships, oldest first.
 * @param line - writes each line of the install's progress, the lines the launcher prints while it installs.
 * @returns the channel.
 */
export function homeReleaseChannel(home: string, platform: RuntimePlatform, channel: ReleaseChannel, shipped: readonly Uint8Array[], line: (text: string) => void): UpdateReleaseChannel {
  const fetch = globalThis.fetch.bind(globalThis)
  return new LauncherChannel({
    home, platform, roots: shipped, channel, log: trusted => tilesTransport({ fetch, ...logEndpoints(trusted) }), downloader: new Downloader(),
    progress: installLines(line),
  })
}
