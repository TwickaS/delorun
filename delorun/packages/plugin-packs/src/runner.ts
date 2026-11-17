/**
 * The runner of one queue item: download and verify a pack from the installed release, install it into the home, and
 * load it through the plugin manager. The download aborts with the item; every refusal the pack code raises becomes
 * a failure the person can read, and a missing connection is its own failure, `offline`.
 *
 * Downloads run as many at a time as the queue allows, but the plugin manager's install runs one pack at a time: it holds
 * the profile write lock while pnpm runs and the Host reloads, which takes up to minutes for a large pack, so a second
 * install would spend that time waiting for the lock and could run out of its wait. Putting a fetched pack into the
 * runtime store also runs one pack at a time, because it holds the store lock, which a second install would give up on
 * after 30 seconds.
 *
 * @module @delorun/plugin-packs/runner
 */
import { InstallRefusal, type InstallOutcome, type InstallProgress } from '@delorun/install-queue'
import { PackRefusal } from '@delorun/release-formats/packs/archive'
import { acquirePacks, fetchPack, installFetchedPack, packDownloadSize, readStoredPacks, requireRunningRelease, RuntimeStoreError, type InstalledRelease, type PackFiles } from '@delorun/runtime-store'
import type { PacksEnvironment } from './environment.ts'

/** The part of the plugin manager's `installBundle` the runner uses. */
export type InstallBundle = (spec: string, options: { readonly enabled: boolean, readonly requestId: string, readonly expected: { readonly name: string, readonly version: string } }) => Promise<{ readonly application: string, readonly error?: { readonly code?: string, readonly diagnostic?: string } }>

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
  if (error instanceof RuntimeStoreError && error.code === 'STORE_BUSY') return new InstallRefusal('failed', 'Another plugin is being added. Try again in a moment.')
  // Anything else carries paths and process ids; the Host's log keeps them ({@link RunnerDeps.logFailure}).
  return new InstallRefusal('failed', 'Delorun could not add this plugin. Try again, and see the Delorun log if it fails again.')
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
 * A turn that runs work one call at a time, in the order the calls came.
 * @returns the function that runs one call's work in its turn; a call whose signal aborts while it waits leaves the line
 *   with the signal's reason, and the next call still waits for the work before it.
 */
export function oneAtATime(): <T>(signal: AbortSignal, work: () => Promise<T>) => Promise<T> {
  let last: Promise<void> = Promise.resolve()
  return async (signal, work) => {
    signal.throwIfAborted()
    const before = last
    let done!: () => void
    last = new Promise((resolve) => { done = resolve })
    try {
      await new Promise<void>((resolve, reject) => {
        const leave = (): void => { reject(signal.reason) }
        signal.addEventListener('abort', leave, { once: true })
        void before.then(() => {
          signal.removeEventListener('abort', leave)
          resolve()
        })
      })
      signal.throwIfAborted()
      return await work()
    } finally {
      // After an abort the work before may still run, so the next turn starts when it ends.
      void before.then(done)
    }
  }
}

/**
 * Create the queue's runner.
 * @param deps - the environment and the plugin manager's install.
 * @returns the function the install queue calls for each item.
 */
export function createPackRunner(deps: RunnerDeps): (key: string, signal: AbortSignal, progress: InstallProgress) => Promise<InstallOutcome> {
  const installs = oneAtATime()
  // `installFetchedPack` holds `store.lock`, which gives up after 30 seconds; two packs landing together wait in this line
  // instead of failing with `STORE_BUSY` while the first fetches its external packages.
  const stores = oneAtATime()
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
      await stores(signal, () => installFetchedPack(release, fetched))
      signal.throwIfAborted()
      // The pack is linked through `packs/current`; after an update switched, that names another release.
      await requireRunningRelease(release.paths, release.version)
      const result = await installs(signal, () => deps.installBundle(`link:${release.paths.packLink(entry.name)}`, { enabled: true, requestId: deps.requestId(key), expected: { name: entry.name, version: entry.version } }))
      if (result.application === 'cancelled') throw new Error('cancelled')
      // The plugin manager's refusal, such as protection holding the add for review, keeps its own words.
      if (result.application === 'failed') throw new InstallRefusal('failed', result.error?.diagnostic ?? `The plugin manager could not load ${key}${result.error?.code === undefined ? '' : ` (${result.error.code})`}.`)
      return { reloadNeeded: result.application === 'restart-required' }
    } catch (error) {
      if (!signal.aborted) deps.logFailure(key, error)
      throw failureOf(error)
    }
  }
}
