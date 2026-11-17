/**
 * Offers bundles through upstream's plugin manager: reads which are installed or available, and adds one only when
 * the person presses its button. Nothing here installs or enables anything on its own.
 * @module @delorun/plugin-onboarding/client/bundles
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { packView, type PackView, type PacksResult, type PacksSnapshot } from '@delorun/plugin-packs/wire'

type PluginManager = ClientRemote['pluginManager']
type BundleInfo = Extract<Awaited<ReturnType<PluginManager['listBundles']>>, { ok: true }>['value'][number]
type PluginEntryId = Parameters<PluginManager['setPluginEnabled']>[0]
type InstallOptions = NonNullable<Parameters<PluginManager['installBundle']>[1]>

/**
 * Where one offered bundle stands for this profile. `checking` is before the plugin manager answers; `available` is
 * the only state a button can add from; `unavailable` is a bundle this installation does not include or cannot
 * install, which is not an error; `failed` is a bundle the plugin manager cannot change, could not be asked, or failed
 * to add, which Plugins finishes.
 */
export type BundleState = 'checking' | 'available' | 'installing' | 'installed' | 'restart' | 'unavailable' | 'failed'

/** One offered bundle as the steps draw it. */
export interface BundleView {
  /** Where it stands. */
  readonly state: BundleState
  /** The package's own title, when the plugin manager lists one. */
  readonly title?: LocalizedText
  /** The package's own description, when the plugin manager lists one. */
  readonly description?: LocalizedText
  /** Why the bundle is `unavailable` on this platform, when the plugin manager says so. */
  readonly reason?: string
}

/** One offered bundled row as the steps draw it: a bundle view with the row's icon, when its package has one. */
export interface RowView extends BundleView {
  /** The package's icon as an image data URL. */
  readonly icon?: string
}

/** What the steps use to offer bundles. */
export interface BundleInstaller {
  /** Every offered bundle's view by package name; a name is absent until `refresh` names it. */
  readonly views: { getSnapshot(): Readonly<Record<string, BundleView>>; subscribe(listener: () => void): () => void }
  /**
   * Read where the named bundles stand. Never adds anything.
   * @param names - package names.
   */
  refresh(names: readonly string[]): void
  /**
   * Add and switch on a bundle the person chose. Only a bundle in the `available` state is added.
   * @param name - package name.
   * @returns when the attempt settled; it never rejects.
   */
  install(name: string): Promise<void>
  /** Every offered bundled row's view by row id; a row id is absent until `refreshRows` names it. */
  readonly rows: { getSnapshot(): Readonly<Record<string, RowView>>; subscribe(listener: () => void): () => void }
  /**
   * Read where the named rows of installed bundles stand. Never changes anything.
   * @param ids - row ids.
   */
  refreshRows(ids: readonly string[]): void
  /**
   * Turn on a row the person chose, through the plugin manager's `setPluginEnabled`, which keeps its checks of
   * protected and unaddressable rows. Only a row in the `available` state is changed.
   * @param id - row id.
   * @returns when the attempt settled; it never rejects.
   */
  enableRow(id: string): Promise<void>
  /** Open Plugins, where an addition that needs a decision is finished. */
  openPlugins(): void
}

/**
 * Where a listed bundle stands. A catalog entry the installation cannot install (no install target, or a target error
 * such as an unbuilt checkout or an unsupported platform) is `unavailable`, a normal state; `failed` is only a bundle
 * the profile holds but cannot change or read.
 * @param bundle - the plugin manager's row, or undefined when it lists none by that name.
 * @returns the state before any action.
 */
export function stateOf(bundle: BundleInfo | undefined, pack?: PackView): BundleState {
  // A plugin pack the release publishes is offered while the profile does not hold it; the install list says how far it is.
  if (pack !== undefined && (bundle === undefined || (bundle.availability === 'missing' && !bundle.installed))) {
    switch (pack.kind) {
      case 'available': return 'available'
      case 'working': return 'installing'
      case 'restart': return 'restart'
      case 'installed': return 'installed'
      case 'failed': return 'failed'
      case 'offline': case 'unavailable': return 'unavailable'
    }
  }
  if (bundle === undefined) return 'unavailable'
  if (bundle.availability === 'missing') {
    // A profile that records the dependency but lost its files is broken, not absent from the installation.
    if (bundle.installed) return 'failed'
    return bundle.installTarget === undefined || bundle.error !== undefined ? 'unavailable' : 'available'
  }
  // A shipped bundle that cannot run on this platform is not an error: it is unavailable here, with the manager's reason.
  if (bundle.error?.code === 'unsupported-platform') return 'unavailable'
  if (bundle.error !== undefined || bundle.readOnlyReason !== undefined) return 'failed'
  return bundle.enabled ? 'installed' : 'available'
}

/** The part of the `packs` remote the guide uses. */
interface PacksRemote {
  list(): Promise<PacksSnapshot>
  enqueue(request: { readonly names: readonly string[] }): Promise<PacksResult>
}

/**
 * The words that say why a pack is not available to add.
 * @param pack - the pack's view.
 * @returns the reason, for an offline or unavailable pack.
 */
export function packReason(pack: PackView | undefined): string | undefined {
  if (pack?.kind === 'offline') return pack.message
  return pack?.kind === 'unavailable' ? pack.reason : undefined
}

/**
 * The plugin manager's remote namespace. Upstream provides each remote namespace as its own service,
 * `remote.pluginManager`, and `ctx.remote.pluginManager` reaches it only for a plugin that injects it; onboarding reads
 * the service from the store when it needs it, so a profile without a plugin manager still opens the guide.
 * @param ctx - the studio context.
 * @returns the namespace, or `undefined` where no plugin manager is mounted.
 */
function pluginManager(ctx: Context): ClientRemote['pluginManager'] | undefined {
  const namespace: ClientRemote['pluginManager'] | undefined = ctx.get('remote.pluginManager')
  return namespace
}

/**
 * Create the installer over the plugin manager's remote.
 * @param ctx - the studio context; `remote.pluginManager` and `pluginNavigation` are read when needed, so a profile without them shows `failed`.
 * @returns the installer.
 */
export function createBundleInstaller(ctx: Context): BundleInstaller {
  const views = createSnapshotStore<Readonly<Record<string, BundleView>>>({})
  const known = new Map<string, BundleInfo>()
  const rows = createSnapshotStore<Readonly<Record<string, RowView>>>({})
  const knownRows = new Map<string, PluginEntryId>()
  const setRow = (id: string, view: RowView): void => { rows.set({ ...rows.getSnapshot(), [id]: view }) }
  const setAllRows = (ids: readonly string[], state: BundleState): void => {
    rows.set({ ...rows.getSnapshot(), ...Object.fromEntries(ids.map(id => [id, { state }])) })
  }
  const readRows = async (ids: readonly string[]): Promise<void> => {
    const remote = pluginManager(ctx)
    if (remote === undefined) {
      setAllRows(ids, 'failed')
      return
    }
    const [listed, live] = await Promise.all([remote.listBundles(), remote.listPlugins()])
    if (!listed.ok || !live.ok) {
      setAllRows(ids, 'failed')
      return
    }
    for (const id of ids) {
      const found = listed.value.flatMap(bundle => bundle.rows.filter(each => each.rowId === id).map(each => ({ bundle, each })))[0]
      const plugin = found?.each.entryId === undefined ? undefined : live.value.find(each => each.entryId === found.each.entryId)
      if (found?.each.entryId === undefined || plugin === undefined) {
        knownRows.delete(id)
        setRow(id, { state: found === undefined || !found.bundle.enabled ? 'unavailable' : 'failed' })
        continue
      }
      knownRows.set(id, found.each.entryId)
      const meta = found.each.meta
      setRow(id, {
        state: plugin.enabled ? 'installed' : plugin.readOnlyReason === undefined ? 'available' : 'failed',
        ...meta?.title === undefined ? {} : { title: meta.title },
        ...meta?.description === undefined ? {} : { description: meta.description },
        ...meta?.icon === undefined ? {} : { icon: meta.icon },
      })
    }
  }
  const set = (name: string, view: BundleView): void => { views.set({ ...views.getSnapshot(), [name]: view }) }
  const setAll = (names: readonly string[], state: BundleState): void => {
    views.set({ ...views.getSnapshot(), ...Object.fromEntries(names.map(name => [name, { state }])) })
  }
  const packViews = new Map<string, PackView>()
  const readPacks = async (names: readonly string[]): Promise<void> => {
    const remote: PacksRemote | undefined = ctx.get('remote.packs')
    packViews.clear()
    if (remote === undefined) return
    try {
      const snapshot = await remote.list()
      for (const name of names) {
        const pack = snapshot.packs.find(each => each.name === name)
        if (pack !== undefined) packViews.set(name, packView(pack, snapshot.queue.find(item => item.key === name)))
      }
    } catch (error) {
      console.warn('delorun onboarding: the plugin packs were not read', error)
    }
  }
  const read = async (names: readonly string[]): Promise<void> => {
    await readPacks(names)
    const remote = pluginManager(ctx)
    if (remote === undefined) {
      setAll(names, 'failed')
      return
    }
    const listed = await remote.listBundles()
    if (!listed.ok) {
      setAll(names, 'failed')
      return
    }
    for (const name of names) {
      const bundle = listed.value.find(each => each.name === name)
      if (bundle === undefined) known.delete(name)
      else known.set(name, bundle)
      const pack = packViews.get(name)
      set(name, {
        state: stateOf(bundle, pack),
        ...packReason(pack) === undefined ? {} : { reason: packReason(pack) },
        ...bundle?.meta?.title === undefined ? {} : { title: bundle.meta.title },
        ...bundle?.meta?.description === undefined ? {} : { description: bundle.meta.description },
        ...bundle?.error?.code === 'unsupported-platform' && bundle.error.diagnostic !== undefined ? { reason: bundle.error.diagnostic } : {},
      })
    }
  }
  return {
    views,
    refresh: (names) => {
      setAll(names, 'checking')
      read(names).catch((error: unknown) => {
        console.warn('delorun onboarding: the plugins were not read', error)
        setAll(names, 'failed')
      })
    },
    install: async (name) => {
      const bundle = known.get(name)
      const remote = pluginManager(ctx)
      const before = views.getSnapshot()[name]
      const pack = packViews.get(name)
      if (before?.state === 'available' && pack?.kind === 'available') {
        const packs: PacksRemote | undefined = ctx.get('remote.packs')
        if (packs === undefined) return
        set(name, { ...before, state: 'installing' })
        try {
          const queued = await packs.enqueue({ names: [name] })
          set(name, { ...before, state: queued.ok ? 'installing' : 'failed' })
        } catch (error) {
          console.warn('delorun onboarding: the plugin pack was not queued', error)
          set(name, { ...before, state: 'failed' })
        }
        return
      }
      if (before?.state !== 'available' || bundle === undefined || remote === undefined) return
      set(name, { ...before, state: 'installing' })
      try {
        const target = bundle.availability === 'missing' ? bundle.installTarget : undefined
        const result = target === undefined
          ? await remote.setBundleEnabled(name, true)
          : await remote.installBundle(target.spec, {
            enabled: true,
            requestId: randomUUID() as NonNullable<InstallOptions['requestId']>,
            registry: null,
            ...target.spec.startsWith('link:') ? {} : { saveExact: true },
          })
        const application = result.ok ? result.value.application : 'failed'
        set(name, { ...before, state: application === 'applied' ? 'installed' : application === 'restart-required' ? 'restart' : 'failed' })
      } catch (error) {
        // The outcome is unknown here; Plugins shows what the profile holds and can finish it.
        console.warn('delorun onboarding: the plugin was not added', error)
        set(name, { ...before, state: 'failed' })
      }
    },
    rows,
    refreshRows: (ids) => {
      setAllRows(ids, 'checking')
      readRows(ids).catch((error: unknown) => {
        console.warn('delorun onboarding: the optional plugins were not read', error)
        setAllRows(ids, 'failed')
      })
    },
    enableRow: async (id) => {
      const entry = knownRows.get(id)
      const remote = pluginManager(ctx)
      const before = rows.getSnapshot()[id]
      if (before?.state !== 'available' || entry === undefined || remote === undefined) return
      setRow(id, { ...before, state: 'installing' })
      try {
        const result = await remote.setPluginEnabled(entry, true)
        const application = result.ok ? result.value.application : 'failed'
        setRow(id, { ...before, state: application === 'applied' ? 'installed' : application === 'restart-required' ? 'restart' : 'failed' })
      } catch (error) {
        // The outcome is unknown here; Plugins shows what the profile holds and can finish it.
        console.warn('delorun onboarding: the optional plugin was not turned on', error)
        setRow(id, { ...before, state: 'failed' })
      }
    },
    openPlugins: () => { ctx.get('pluginNavigation')?.openList() },
  }
}
