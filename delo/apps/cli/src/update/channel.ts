/**
 * The release channel `delorun update` fetches through: `@delo/install`'s `LauncherChannel`, the one implementation
 * of contract C2's client verification and contract C18's log check, anchored on the root chain this home stored when
 * the launcher installed its runtime. The launcher checked that chain against the roots it ships before it started
 * this runtime, so the runtime trusts no root the launcher did not.
 *
 * The release log is the one the trusted root names, read through `@delo/release-verify`'s transport, as the
 * launcher reads it.
 *
 * @module @delo/cli/update/channel
 */
import { RUNTIME_PLATFORMS, type ReleaseChannel, type RuntimePlatform } from '@delo/contract-release-manifest'
import { Downloader, LauncherChannel, progressLines, readStoredRootBytes, readStoredRootChain, type InstallProgress } from '@delo/install'
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
 * @param home - the resolved Delo home, whose `trust/` holds the root chain an install verified.
 * @param platform - the runtime platform.
 * @param channel - the person's release channel.
 * @param line - writes each line of the install's progress, the lines the launcher prints while it installs.
 * @returns the channel.
 * @throws {Error} when the home stores no verified root, so nothing anchors an update.
 */
export async function homeReleaseChannel(home: string, platform: RuntimePlatform, channel: ReleaseChannel, line: (text: string) => void): Promise<UpdateReleaseChannel> {
  const chain = await readStoredRootChain(home)
  const root = await readStoredRootBytes(home)
  const roots = chain.length > 0 ? chain : root === undefined ? [] : [root]
  if (roots.length === 0) throw new Error('this home stores no verified release root, so no update can be verified; reinstall Delo with its launcher')
  const fetch = globalThis.fetch.bind(globalThis)
  return new LauncherChannel({
    home, platform, roots, channel, log: trusted => tilesTransport({ fetch, ...logEndpoints(trusted) }), downloader: new Downloader(),
    progress: installLines(line),
  })
}
