/**
 * The runner of one queue item: download and verify a pack from the installed release, install it into the home, and
 * load it through the plugin manager. The download aborts with the item; every refusal the pack code raises becomes
 * a failure the person can read, and a missing connection is its own failure, `offline`.
 *
 * @module @delorun/plugin-packs/runner
 */
import { InstallRefusal, type InstallOutcome, type InstallProgress } from '@delorun/install-queue'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import { acquirePacks, fetchPack, installFetchedPack, packDownloadSize, readStoredPacks, requireRunningRelease, type InstalledRelease, type PackFiles } from '@delorun/runtime-store'
import type { PacksEnvironment } from './environment.ts'

/** The part of the plugin manager's `installBundle` the runner uses. */
export type InstallBundle = (spec: string, options: { readonly enabled: boolean, readonly requestId: string, readonly expected: { readonly name: string, readonly version: string } }) => Promise<{ readonly application: string, readonly error?: { readonly code?: string } }>

/** What the runner needs. */
export interface RunnerDeps {
  /** The installed release and channel. */
  readonly environment: PacksEnvironment
  /** The plugin manager's install. */
  readonly installBundle: InstallBundle
  /** Makes the request id a pack's install is announced under, so `plugin-manager/install-state` follows it. */
  readonly requestId: (key: string) => string
  /** Report why an install failed, with its cause and address, where the Host logs. */
  readonly logFailure: (key: string, error: unknown) => void
}

/**
 * The words a refusal reads as.
 * @param error - what the pack code or the file system raised.
 * @returns the typed failure the queue stores.
 */
export function failureOf(error: unknown): InstallRefusal {
  if (error instanceof InstallRefusal) return error
  if (error instanceof PackRefusal) {
    if (error.code === 'OFFLINE') return new InstallRefusal('offline', 'This plugin needs a connection to download the first time. Connect and try again.')
    return new InstallRefusal('failed', error.message)
  }
  return new InstallRefusal('failed', error instanceof Error ? error.message : String(error))
}

/**
 * The packs of the installed release: the stored, re-verified file, or the one fetched now.
 * @param release - the installed release.
 * @param files - the channel.
 * @returns the packs file's content, or `undefined` when the release publishes none.
 */
export async function packsOf(release: InstalledRelease, files: PackFiles): ReturnType<typeof readStoredPacks> {
  return await readStoredPacks(release) ?? await acquirePacks(release, files)
}

/**
 * Create the queue's runner.
 * @param deps - the environment and the plugin manager's install.
 * @returns the function the install queue calls for each item.
 */
export function createPackRunner(deps: RunnerDeps): (key: string, signal: AbortSignal, progress: InstallProgress) => Promise<InstallOutcome> {
  return async (key, signal, progress) => {
    try {
      progress.stage('downloading')
      const release = await deps.environment.release()
      const packs = await packsOf(release, deps.environment.files)
      const entry = packs?.packs.find(each => each.name === key)
      if (entry === undefined) throw new InstallRefusal('failed', `This release has no plugin pack ${key}.`)
      const total = packDownloadSize(entry, release.paths.platform)
      progress.bytes(0, total)
      const fetched = await fetchPack(release, key, deps.environment.files, { signal, onBytes: (received) => { progress.bytes(received, total) } })
      signal.throwIfAborted()
      progress.stage('verifying')
      progress.stage('installing')
      await installFetchedPack(release, fetched)
      signal.throwIfAborted()
      // The pack is linked through `packs/current`; after an update switched, that names another release.
      await requireRunningRelease(release.paths, release.version)
      const result = await deps.installBundle(`link:${release.paths.packLink(entry.name)}`, { enabled: true, requestId: deps.requestId(key), expected: { name: entry.name, version: entry.version } })
      if (result.application === 'cancelled') throw new Error('cancelled')
      if (result.application === 'failed') throw new InstallRefusal('failed', `The plugin manager could not load ${key}${result.error?.code === undefined ? '' : ` (${result.error.code})`}.`)
      return { reloadNeeded: result.application === 'restart-required' }
    } catch (error) {
      if (!signal.aborted) deps.logFailure(key, error)
      throw failureOf(error)
    }
  }
}
