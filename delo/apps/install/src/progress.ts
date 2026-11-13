/**
 * What an install reports while it runs, as typed events, and the lines a person reads for each: the launcher prints
 * them while it installs a release, and `delorun update` prints the same lines while the home process installs the
 * update's target. The install path itself never writes to a terminal, and reports only what a check has already
 * decided.
 *
 * @module @delo/install/progress
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { ReleaseChannel, SemanticVersion } from '@delo/contract-release-manifest'
import { uncheckedWarning } from '@delo/release-verify/start'

/**
 * One step of an install that finished, in the order the steps run:
 *
 * - `resolved`: the verified timestamp names this release for the channel.
 * - `signature-checked`: the release's manifest verified under the trusted root, and its release-log bundle verified.
 * - `log-checked`: contract C18's online check found the release `verified`, or could not run (`unchecked`, with the
 *   reason). A check that failed refuses the install and reports no event.
 * - `downloading`: the runtime archive named by the signed manifest starts to download.
 * - `origin-skipped`: an origin failed to serve a file (network or HTTP failure, or bytes that did not match the signed
 *   reference) and the next origin was tried; `served` names the origin whose bytes were then used.
 */
export type InstallProgress =
  | { readonly step: 'resolved', readonly channel: ReleaseChannel, readonly version: SemanticVersion }
  | { readonly step: 'signature-checked', readonly version: SemanticVersion, readonly rootVersion: number }
  | { readonly step: 'log-checked', readonly version: SemanticVersion, readonly state: 'verified' | 'unchecked', readonly detail?: string }
  | { readonly step: 'downloading', readonly name: string, readonly bytes: number }
  | { readonly step: 'origin-skipped', readonly name: string, readonly failed: string, readonly reason: string, readonly served: string }

/** An install step or the step its caller reports itself: the runtime store is about to publish the verified files. */
export type InstallerProgress = InstallProgress | { readonly step: 'installing', readonly version: RuntimeVersion }

/** Bytes in a megabyte as the line states sizes: decimal, as download tools do. */
const MEGABYTE = 1_000_000

/**
 * A download size for a person.
 * @param bytes - the size.
 * @returns the size in kB, MB or GB, with one decimal from a megabyte up.
 */
export function formatSize(bytes: number): string {
  if (bytes < MEGABYTE) return `${String(Math.max(1, Math.round(bytes / 1000)))} kB`
  if (bytes < 1000 * MEGABYTE) return `${(bytes / MEGABYTE).toFixed(1)} MB`
  return `${(bytes / (1000 * MEGABYTE)).toFixed(1)} GB`
}

/**
 * The lines to print for a finished step.
 * @param event - the step.
 * @returns one line, or two when the log check did not run; each ends with a newline.
 */
export function progressLines(event: InstallerProgress): readonly string[] {
  switch (event.step) {
    case 'resolved':
      return [`Resolving the release: the ${event.channel} channel names ${event.version}.\n`]
    case 'signature-checked':
      return [`Checking the signature: ${event.version} is signed under release root ${String(event.rootVersion)}.\n`]
    case 'log-checked':
      if (event.state === 'verified') return ['Checking the release log: verified.\n']
      return [
        `Checking the release log: not checked (${event.detail ?? 'the check did not run'}).\n`,
        `Warning: ${uncheckedWarning(event.version)}\n`,
      ]
    case 'downloading':
      return [`Downloading ${event.name} (${formatSize(event.bytes)}).\n`]
    case 'origin-skipped':
      return [`${event.failed} did not serve ${event.name} (${event.reason}); ${event.served} served it, and its bytes verified.\n`]
    case 'installing':
      return [`Installing release ${event.version}.\n`]
  }
}
