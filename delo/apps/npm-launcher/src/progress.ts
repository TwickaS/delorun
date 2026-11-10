/**
 * The lines the launcher prints while it installs a release: one per step, each saying what finished and with what
 * outcome, and one warning when the release-log check did not run. They go to standard error, so the output of the
 * command the person runs next stays on standard output unmixed.
 *
 * @module @delo/npm-launcher/progress
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { InstallProgress } from '@delo/install'
import { uncheckedWarning } from '@delo/release-verify/start'

/** A step the launcher reports itself: the runtime store is about to publish the verified files. */
export type LauncherProgress = InstallProgress | { readonly step: 'installing', readonly version: RuntimeVersion }

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
export function progressLines(event: LauncherProgress): readonly string[] {
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
    case 'installing':
      return [`Installing release ${event.version}.\n`]
  }
}
