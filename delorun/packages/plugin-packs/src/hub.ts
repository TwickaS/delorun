/**
 * The pack hub: the install queue wired to the installed release, the plugin manager and the chat gate, and the
 * snapshot every surface reads. It holds no Cordis; `index.ts` mounts it and `service.ts` exposes it.
 *
 * @module @delorun/plugin-packs/hub
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { InstallQueue, type InstallItem } from '@delorun/install-queue'
import { checkInstalledPack, packDownloadSize, packVariantFor, type InstalledRelease } from '@delorun/runtime-store'
import type { PacksEnvironment } from './environment.ts'
import { createPackRunner, packsOf, type InstallBundle } from './runner.ts'
import type { PackInfo, PacksResult, PacksSnapshot } from './wire.ts'

/** What the hub needs. */
export interface HubDeps {
  /** The installed release and channel, or the reason there is none. */
  readonly environment: PacksEnvironment | { readonly unsupported: string }
  /** The plugin manager's install. */
  readonly installBundle: InstallBundle
  /** How many chats run now (`ChatGate.running`). */
  readonly runningChats: () => number
  /** Reload the Host once so finished installs run. */
  readonly reload: () => Promise<void>
  /** Where the queue is persisted. */
  readonly file: string
  /** How many installs run at once. */
  readonly concurrency: number
  /** Makes a request id the plugin manager announces an install under. */
  readonly requestId: (key: string) => string
}

/** Read persisted items; a missing or unreadable file is an empty list. */
function loadItems(file: string): readonly InstallItem[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { items?: InstallItem[] }
    return Array.isArray(parsed.items) ? parsed.items : []
  } catch {
    // No queue file yet, or a file this version cannot read: the queue starts empty, and the next save replaces it.
    return []
  }
}

/** Write the items at mode 0600 by an atomic rename. */
function saveItems(file: string, items: readonly InstallItem[]): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ v: 1, items })}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}

/** The pack hub. */
export class PacksHub {
  private readonly queue: InstallQueue
  /** The collaborators this hub was made with. */
  readonly deps: HubDeps
  private release: InstalledRelease | undefined
  /** The names the release's packs file lists, once read. */
  private names: ReadonlySet<string> | undefined
  /** The packs whose files matched their signed list at the last snapshot. */
  private sealed: ReadonlySet<string> = new Set()

  /**
   * @param deps - the collaborators.
   * @throws Error when the concurrency is not a positive integer.
   */
  constructor(deps: HubDeps) {
    this.deps = deps
    const environment = deps.environment
    this.queue = new InstallQueue({
      concurrency: deps.concurrency,
      run: 'unsupported' in environment
        ? () => Promise.reject(new Error(environment.unsupported))
        : createPackRunner({ environment, installBundle: deps.installBundle, requestId: deps.requestId }),
      reload: deps.reload,
      runningChats: deps.runningChats,
      load: () => loadItems(deps.file),
      save: (items) => { saveItems(deps.file, items) },
    })
    this.queue.restore()
    // Read the packs file now, so a name the release lists is known to be a pack before anything asks for a target.
    void this.snapshot().catch(() => undefined)
  }

  /**
   * Follow every change of the install list.
   * @param listener - called with the whole snapshot.
   * @returns the unsubscribe function.
   */
  subscribe(listener: (snapshot: PacksSnapshot) => void): () => void {
    return this.queue.subscribe(() => {
      this.snapshot().then(listener, () => undefined)
    })
  }

  /** Tell the queue a chat ended, so a reload that waited for the chats can run. */
  chatsChanged(): void {
    this.queue.chatsChanged()
  }

  /**
   * The packs, their availability and the install list.
   * @returns the snapshot; `supported: false` with a reason when this process has no installed release.
   */
  async snapshot(): Promise<PacksSnapshot> {
    const queue = this.queue.snapshot()
    const environment = this.deps.environment
    if ('unsupported' in environment) return { supported: false, reason: environment.unsupported, packs: [], queue }
    try {
      const release = this.release ?? await environment.release()
      this.release = release
      const packs = await packsOf(release, environment.files)
      if (packs === undefined) return { supported: false, reason: 'This release publishes no plugin packs.', release: release.version, packs: [], queue }
      const infos: PackInfo[] = []
      const sealed = new Set<string>()
      this.names = new Set(packs.packs.map(entry => entry.name))
      for (const entry of packs.packs) {
        const base = { name: entry.name, version: entry.version, experimental: entry.experimental }
        try {
          packVariantFor(entry, release.paths.platform)
          const installed = await checkInstalledPack(release.paths, release.version, entry, release.paths.platform).then(() => true, () => false)
          if (installed) sealed.add(entry.name)
          infos.push({ ...base, downloadBytes: packDownloadSize(entry, release.paths.platform), availability: installed ? 'installed' : 'available' })
        } catch (error) {
          infos.push({ ...base, downloadBytes: 0, availability: 'unavailable', reason: error instanceof Error ? error.message : String(error) })
        }
      }
      this.sealed = sealed
      return { supported: true, release: release.version, packs: infos, queue }
    } catch (error) {
      return { supported: false, reason: error instanceof Error ? error.message : String(error), packs: [], queue }
    }
  }

  /**
   * The spec the plugin manager installs for a pack already in the home, for Plugins' official installs.
   * @param name - the package name.
   * @param version - the running Delorun version.
   * @returns the `link:` spec through `packs/current`, or `undefined` unless the pack's files matched their signed list at the last snapshot.
   */
  installedTarget(name: string, version: string): { readonly spec: string, readonly version: string } | undefined {
    const release = this.release
    if (release === undefined || !this.sealed.has(name)) return undefined
    return { spec: `link:${release.paths.packLink(name)}`, version }
  }

  /**
   * The only spec through which the plugin manager may install a pack.
   * @param name - the package name.
   * @returns the `link:` spec through `packs/current`, or `undefined` before the release is known.
   */
  linkSpec(name: string): string | undefined {
    return this.release === undefined ? undefined : `link:${this.release.paths.packLink(name)}`
  }

  /**
   * Whether the release's packs file lists a package, as far as it is known now.
   * @param name - the package name.
   * @returns `true` or `false` once the packs file was read, `undefined` before.
   */
  listed(name: string): boolean | undefined {
    return this.names?.has(name)
  }

  /**
   * Whether the release's packs file lists a package, waiting for the file to be read.
   * @param name - the package name.
   * @returns `true` for a pack; `false` for any other package and when this process has no installed release.
   */
  async isPack(name: string): Promise<boolean> {
    await this.snapshot().catch(() => undefined)
    return this.names?.has(name) ?? false
  }

  /**
   * Add packs to the install list.
   * @param names - package names.
   * @returns the new snapshot, or why nothing was added.
   */
  async enqueue(names: readonly string[]): Promise<PacksResult> {
    const before = await this.snapshot()
    if (!before.supported) return { ok: false, error: { code: 'unsupported', message: before.reason ?? 'This Host has no plugin packs.' } }
    for (const name of names) {
      const pack = before.packs.find(each => each.name === name)
      if (pack === undefined) return { ok: false, error: { code: 'unknown-pack', message: `This release has no plugin pack ${name}.` } }
      if (pack.availability === 'unavailable') return { ok: false, error: { code: 'unavailable-pack', message: pack.reason ?? `${name} is not published for this computer.` } }
    }
    for (const name of names) this.queue.enqueue(name)
    return { ok: true, value: await this.snapshot() }
  }

  /**
   * Cancel a queued or working item.
   * @param name - the package name.
   * @returns the new snapshot.
   */
  async cancel(name: string): Promise<PacksResult> {
    this.queue.cancel(name)
    return { ok: true, value: await this.snapshot() }
  }

  /**
   * Remove a finished, failed or cancelled item from the list.
   * @param name - the package name.
   * @returns the new snapshot.
   */
  async remove(name: string): Promise<PacksResult> {
    this.queue.remove(name)
    return { ok: true, value: await this.snapshot() }
  }

  /**
   * Clear a failed or cancelled item from the list. It only clears a queue record and never touches installed files.
   * @param name - the package name.
   * @returns the new snapshot.
   */
  async dismiss(name: string): Promise<PacksResult> {
    this.queue.dismiss(name)
    return { ok: true, value: await this.snapshot() }
  }

  /**
   * Start a failed or cancelled item again.
   * @param name - the package name.
   * @returns the new snapshot, or why nothing happened.
   */
  async retry(name: string): Promise<PacksResult> {
    return this.enqueue([name])
  }
}
