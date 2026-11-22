/**
 * What an install reports while it runs, as typed events. The install path itself never writes to a terminal and reports
 * only what a check has already decided; {@link InstallRenderer} (`./render.ts`) turns the events into the checklist a
 * person reads, in the launcher, in `delorun update` and in `delorun repair` alike.
 *
 * @module @delorun/install/progress
 */
import type { RuntimeVersion } from '@delorun/contract-home-layout'
import type { ReleaseChannel, SemanticVersion } from '@delorun/contract-release-manifest'

/**
 * One step of an install, in the order the steps run:
 *
 * - `resolving`: the install starts to read the channel's timestamp.
 * - `resolved`: the verified timestamp names this release for the channel.
 * - `signature-checked`: the release's manifest verified under the trusted root, and its release-log bundle verified.
 * - `log-checked`: contract C18's online check found the release `verified`, or could not run (`unchecked`, with the
 *   reason). A check that failed refuses the install and reports no event.
 * - `downloading`: the runtime archive named by the signed manifest starts to download; `bytes` is its signed length.
 * - `download-bytes`: `received` of `total` bytes of the archive have arrived. Sent at most about ten times a second.
 * - `downloaded`: the archive's bytes are all on disk; they have not been checked against the signed hash yet.
 * - `download-verified`: the archive's length and SHA-256 match the signed manifest.
 * - `unpacking`: the signed file list verified and the extraction starts; `files` is the number of files it names.
 * - `unpack-files`: `written` of `total` files are written. Sent at most about ten times a second.
 * - `origin-skipped`: an origin failed to serve a file (network or HTTP failure, or bytes that did not match the signed
 *   reference) and the next origin was tried; `served` names the origin whose bytes were then used.
 */
export type InstallProgress =
  | { readonly step: 'resolving', readonly channel: ReleaseChannel }
  | { readonly step: 'resolved', readonly channel: ReleaseChannel, readonly version: SemanticVersion }
  | { readonly step: 'signature-checked', readonly version: SemanticVersion, readonly rootVersion: number }
  | { readonly step: 'log-checked', readonly version: SemanticVersion, readonly state: 'verified' | 'unchecked', readonly detail?: string }
  | { readonly step: 'downloading', readonly name: string, readonly bytes: number }
  | { readonly step: 'download-bytes', readonly name: string, readonly received: number, readonly total: number }
  | { readonly step: 'downloaded', readonly name: string, readonly bytes: number }
  | { readonly step: 'download-verified', readonly name: string }
  | { readonly step: 'unpacking', readonly files: number }
  | { readonly step: 'unpack-files', readonly written: number, readonly total: number }
  | { readonly step: 'origin-skipped', readonly name: string, readonly failed: string, readonly reason: string, readonly served: string }

/**
 * An install step or a step its caller reports itself: the runtime store is about to publish the verified files
 * (`installing`), the store published them and the release's log check is recorded (`installed`), the caller goes on
 * to start the program (`starting`), or the install stopped and the caller prints the error's own text (`failed`).
 *
 * A plugin pack's own download and install report `pack-downloading` (the pack's name and the size of what it fetches),
 * `pack-bytes`, `pack-installing` (the download is complete; `bytes` is its size) and `pack-installed`.
 */
export type InstallerProgress =
  | InstallProgress
  | { readonly step: 'installing', readonly version: RuntimeVersion }
  | { readonly step: 'installed', readonly version: RuntimeVersion }
  | { readonly step: 'starting' }
  | { readonly step: 'failed' }
  | { readonly step: 'pack-downloading', readonly name: string, readonly bytes: number }
  | { readonly step: 'pack-bytes', readonly name: string, readonly received: number, readonly total: number }
  | { readonly step: 'pack-installing', readonly name: string, readonly bytes: number }
  | { readonly step: 'pack-installed', readonly name: string }

/** The `step` names of {@link InstallerProgress}, for reading an event from a process boundary. */
const STEPS: ReadonlySet<string> = new Set([
  'resolving', 'resolved', 'signature-checked', 'log-checked', 'downloading', 'download-bytes', 'downloaded', 'download-verified',
  'unpacking', 'unpack-files', 'origin-skipped', 'installing', 'installed', 'starting', 'failed',
  'pack-downloading', 'pack-bytes', 'pack-installing', 'pack-installed',
])

/**
 * Whether a value that crossed a process boundary names an install step. Only the step's name is checked: the renderer
 * shows what the event carries and never decides anything from it, so a malformed field can at worst print a wrong word.
 * @param value - the value read from the wire.
 * @returns true when it is an object whose `step` is one of {@link InstallerProgress}'s.
 */
export function isInstallerProgress(value: unknown): value is InstallerProgress {
  return typeof value === 'object' && value !== null && 'step' in value && typeof value.step === 'string' && STEPS.has(value.step)
}

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
 * A speed for a person.
 * @param bytesPerSecond - the speed.
 * @returns the speed with {@link formatSize}'s unit, per second.
 */
export function formatSpeed(bytesPerSecond: number): string {
  return `${formatSize(bytesPerSecond)}/s`
}

/**
 * A length of time for a person.
 * @param ms - the time in milliseconds.
 * @returns tenths of a second below ten seconds, whole seconds below a minute, then minutes and seconds.
 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, ms) / 1000
  if (seconds < 10) return `${seconds.toFixed(1)}s`
  const whole = Math.round(seconds)
  if (whole < 60) return `${String(whole)}s`
  return `${String(Math.floor(whole / 60))}m ${String(whole % 60).padStart(2, '0')}s`
}
