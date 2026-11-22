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
import { currentDownloadsSource, startPageDownload, type PageDownload } from '@delorun/plugin-downloads/row'
import { createPacksClient } from '@delorun/plugin-packs/client'
import { packView, type PackView, type PacksResult, type PacksSnapshot } from '@delorun/plugin-packs/wire'

type PluginManager = ClientRemote['pluginManager']
type BundleInfo = Extract<Awaited<ReturnType<PluginManager['listBundles']>>, { ok: true }>['value'][number]
type PluginEntryId = Parameters<PluginManager['setPluginEnabled']>[0]
type InstallOptions = NonNullable<Parameters<PluginManager['installBundle']>[1]>

/**
 * Where one offered bundle stands for this profile. `checking` is before the plugin manager answers; `available` is
 * the only state a button can add from; `unavailable` is a bundle this installation does not include or cannot
 * install, which is not an error; `failed` is a bundle the plugin manager cannot change, could not be asked, or failed
 * to add, which Plugins finishes. `slow` is an add still running after the wait the settings allow; it ends when the
 * plugin manager reports the outcome. `offline` is a plugin pack that needs a connection to download; `unavailable`
 * is one this kind of computer cannot run.
 */
export type BundleState = 'checking' | 'available' | 'installing' | 'slow' | 'installed' | 'restart' | 'unavailable' | 'offline' | 'failed'

/** One offered bundle as the steps draw it. */
export interface BundleView {
  /** Where it stands. */
  readonly state: BundleState
  /** The package's own title, when the plugin manager lists one. */
  readonly title?: LocalizedText
  /** The package's own description, when the plugin manager lists one. */
  readonly description?: LocalizedText
  /** Why the bundle is `failed` (the plugin manager's own words) or `unavailable` or `offline` (the platform or pack reason). */
  readonly reason?: string
  /** Whether the bundle is in the home but turned off, which only the person does (in Plugins); a bundle never added is not held. */
  readonly held?: true
  /** For an `unavailable` bundle: why this Host has no plugin packs to offer (a build from source, for one), which the card says instead of blaming the computer. */
  readonly packsReason?: string
}

/** One offered bundled row as the steps draw it: a bundle view with the row's icon, when its package has one. */
export interface RowView extends BundleView {
  /** The package's icon as an image data URL. */
  readonly icon?: string
}

/** What the installer needs besides the plugin manager. */
export interface BundleInstallerOptions {
  /** How long an add may run before the card says it is still working, in milliseconds; read when an add starts. */
  readonly addWaitMs: () => number
  /** How often a slow add re-reads the plugin manager's state, in milliseconds. */
  readonly pollMs: number
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
 * The words of a refused remote call.
 * @param error - the plugin manager's refusal or the remote's own failure.
 * @returns the `reason` field: the diagnostic, else the code.
 */
function reasonOfFailure(error: { readonly code: string; readonly diagnostic?: string | undefined } | { readonly code: string }): { readonly reason: string } {
  const diagnostic = 'diagnostic' in error ? error.diagnostic : undefined
  return { reason: diagnostic ?? error.code }
}

/**
 * The plugin manager's own words for why a bundle failed.
 * @param bundle - the plugin manager's row.
 * @returns its diagnostic, else its code or read-only reason; undefined when it reports none.
 */
export function reasonOf(bundle: BundleInfo | undefined): string | undefined {
  const error = bundle?.error
  if (error === undefined) return bundle?.readOnlyReason
  return error.diagnostic ?? error.code
}

/**
 * Where a listed bundle stands. A catalog entry the installation cannot install (no install target, or a target error
 * such as an unbuilt checkout or an unsupported platform) is `unavailable`, a normal state; `failed` is only a bundle
 * the profile holds but cannot change or read.
 * @param bundle - the plugin manager's row, or undefined when it lists none by that name.
 * @param pack - how the release's plugin pack of that name stands, when the release publishes one.
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
      case 'offline': return 'offline'
      case 'unavailable': return 'unavailable'
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
  retry(request: { readonly name: string }): Promise<PacksResult>
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
 * A package's own title in English, for the downloads panel's row of an install this page runs.
 * @param title - the title the plugin manager lists, if any.
 * @returns the text, or undefined.
 */
function textOf(title: LocalizedText | undefined): string | undefined {
  return title === undefined ? undefined : typeof title === 'string' ? title : title.en
}

/**
 * End the downloads panel's row of an install this page ran, as its card ended.
 * @param shown - the row.
 * @param view - how the card ended.
 */
function endShown(shown: PageDownload, view: { readonly state: BundleState, readonly reason?: string | undefined }): void {
  if (view.state === 'installed') shown.done()
  else if (view.state === 'restart') shown.done(true)
  else shown.failed(view.reason)
}

/**
 * Create the installer over the plugin manager's remote.
 * @param ctx - the studio context; `remote.pluginManager` and `pluginNavigation` are read when needed, so a profile without them shows `failed`.
 * @param options - the wait and the poll.
 * @returns the installer.
 */
export function createBundleInstaller(ctx: Context, options: BundleInstallerOptions): BundleInstaller {
  const views = createSnapshotStore<Readonly<Record<string, BundleView>>>({})
  const known = new Map<string, BundleInfo>()
  const rows = createSnapshotStore<Readonly<Record<string, RowView>>>({})
  const knownRows = new Map<string, PluginEntryId>()
  const setRow = (id: string, view: RowView): void => { rows.set({ ...rows.getSnapshot(), [id]: view }) }
  // An add in flight keeps its own "installing" card: a re-read of the list must not reset it, or its Add would show again and be pressed twice.
  const inflight = new Set<string>()
  const inflightRows = new Set<string>()
  const setAllRows = (ids: readonly string[], state: BundleState): void => {
    rows.set({ ...rows.getSnapshot(), ...Object.fromEntries(ids.filter(id => !inflightRows.has(id)).map(id => [id, { state }])) })
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
      if (inflightRows.has(id)) continue
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
  // `held` describes a bundle that is turned off, which only the `available` state can be.
  const set = (name: string, view: BundleView): void => {
    const { held: _held, ...rest } = view
    views.set({ ...views.getSnapshot(), [name]: view.state === 'available' ? view : rest })
  }
  const setAll = (names: readonly string[], state: BundleState): void => {
    views.set({ ...views.getSnapshot(), ...Object.fromEntries(names.filter(name => !inflight.has(name)).map(name => [name, { state }])) })
  }
  const packViews = new Map<string, PackView>()
  // The Host's packs routes; a Host without plugin packs answers 404, which reads as no packs.
  const packsClient = createPacksClient()
  let packsUnsupported: string | undefined
  const readPacks = async (names: readonly string[]): Promise<void> => {
    const remote: PacksRemote = packsClient
    packViews.clear()
    packsUnsupported = undefined
    try {
      const snapshot = await remote.list()
      if (!snapshot.supported) packsUnsupported = snapshot.reason
      for (const name of names) {
        const pack = snapshot.packs.find(each => each.name === name)
        if (pack !== undefined) packViews.set(name, packView(pack, snapshot.queue.find(item => item.key === name)))
      }
    } catch (error) {
      console.warn('delorun onboarding: the plugin packs were not read', error)
    }
  }
  const read = async (names: readonly string[]): Promise<void> => {
    // The packs read runs beside the plugin manager's, so a slow packs answer holds back only the cards that need it.
    const packsRead = readPacks(names)
    const remote = pluginManager(ctx)
    if (remote === undefined) {
      await packsRead
      setAll(names, 'failed')
      return
    }
    const listed = await remote.listBundles()
    if (!listed.ok) {
      await packsRead
      setAll(names, 'failed')
      return
    }
    const show = (name: string, packsKnown: boolean): void => {
      if (inflight.has(name)) return
      const bundle = listed.value.find(each => each.name === name)
      if (bundle === undefined) known.delete(name)
      else known.set(name, bundle)
      // A bundle the profile does not hold may be a pack the release publishes, which only the packs answer settles.
      if (!packsKnown && (bundle === undefined || (bundle.availability === 'missing' && !bundle.installed))) return
      const pack = packViews.get(name)
      // A bundle that is not in the profile can only come from a plugin pack; a Host with no packs would try an install that never finishes.
      const needsPack = bundle?.availability === 'missing' && !bundle.installed && pack === undefined && packsUnsupported !== undefined
      const state = needsPack ? 'unavailable' : stateOf(bundle, pack)
      const reason = state === 'failed' ? reasonOf(bundle) : packReason(pack)
      const platformLimit = bundle?.error?.code === 'unsupported-platform' || pack?.kind === 'unavailable'
      if (state === 'installing') void followPack(name)
      set(name, {
        state,
        ...reason === undefined ? {} : { reason },
        ...state === 'unavailable' && !platformLimit && packsUnsupported !== undefined ? { packsReason: packsUnsupported } : {},
        ...state === 'available' && bundle !== undefined && bundle.availability !== 'missing' && !bundle.enabled ? { held: true as const } : {},
        ...bundle?.meta?.title === undefined ? {} : { title: bundle.meta.title },
        ...bundle?.meta?.description === undefined ? {} : { description: bundle.meta.description },
        ...bundle?.error?.code === 'unsupported-platform' && bundle.error.diagnostic !== undefined ? { reason: bundle.error.diagnostic } : {},
      })
    }
    for (const name of names) show(name, false)
    await packsRead
    for (const name of names) show(name, true)
  }
  // The install list says how a queued pack ends; the card follows it, so it never stays on "Adding…" after a failure.
  // One loop per pack runs while the card shows an install, whoever started it and across the card being re-read.
  const following = new Set<string>()
  // The loops end with the plugin: disposal aborts this controller and a waiting loop leaves at its next tick.
  const disposed = new AbortController()
  ctx.effect(() => () => { disposed.abort() }, 'delorun-onboarding: the pack install loops end with the plugin')
  const followPack = async (name: string): Promise<void> => {
    if (following.has(name)) return
    following.add(name)
    const packs: PacksRemote = packsClient
    const checkingSince = { at: 0 }
    try {
      for (;;) {
        await new Promise<void>((resolve) => { setTimeout(resolve, options.pollMs) })
        if (disposed.signal.aborted) return
        const now = views.getSnapshot()[name]
        // A card being re-read shows "checking" for a moment; the loop waits it out, for as long as an add may run, and reads the outcome after.
        if (now?.state === 'checking') {
          if (checkingSince.at === 0) checkingSince.at = Date.now()
          if (Date.now() - checkingSince.at > options.addWaitMs()) return
          continue
        }
        checkingSince.at = 0
        if (now?.state !== 'installing' && now?.state !== 'slow') return
        let snapshot: PacksSnapshot
        try {
          snapshot = await packs.list()
        } catch (error) {
          console.warn('delorun onboarding: the plugin pack install was not followed', error)
          continue
        }
        const pack = snapshot.packs.find(each => each.name === name)
        const view = pack === undefined ? undefined : packView(pack, snapshot.queue.find(item => item.key === name))
        if (view?.kind === 'working') continue
        const latest = views.getSnapshot()[name]
        if (latest?.state !== 'installing' && latest?.state !== 'slow') return
        const { reason: _reason, packsReason: _packsReason, state: _state, ...base } = latest
        if (view === undefined) {
          set(name, { ...base, state: 'failed' })
          return
        }
        packViews.set(name, view)
        set(name, { ...base, state: stateOf(known.get(name), view), ...view.kind === 'failed' ? { reason: view.failure.message } : {} })
        return
      }
    } finally {
      following.delete(name)
    }
  }
  const runInstall = async (name: string): Promise<void> => {
    const bundle = known.get(name)
    const remote = pluginManager(ctx)
    const before = views.getSnapshot()[name]
    const pack = packViews.get(name)
    // A pack the profile does not hold, whose last install failed, starts again through the queue's retry, whatever
    // the last read of the install list said: that read can be older than the failure.
    const packOnly = pack !== undefined && (bundle === undefined || (bundle.availability === 'missing' && !bundle.installed))
    if (before !== undefined && ((before.state === 'available' && pack?.kind === 'available') || (before.state === 'failed' && packOnly))) {
      const packs: PacksRemote = packsClient
      const { reason: _failure, ...fresh } = before
      set(name, { ...fresh, state: 'installing' })
      try {
        const queued = before.state === 'failed' ? await packs.retry({ name }) : await packs.enqueue({ names: [name] })
        set(name, { ...fresh, state: queued.ok ? 'installing' : 'failed' })
        // The downloads panel reads the same install list; asking it to read now shows this add at once.
        if (queued.ok) { currentDownloadsSource().refresh(); void followPack(name) }
      } catch (error) {
        console.warn('delorun onboarding: the plugin pack was not queued', error)
        set(name, { ...fresh, state: 'failed' })
      }
      return
    }
    if (before?.state !== 'available' || bundle === undefined || remote === undefined) return
    set(name, { ...before, state: 'installing' })
    // The plugin manager's own install is not in the Host's install queue; the downloads panel shows it from this page.
    const shown = startPageDownload(name, { title: textOf(before.title) })
    let done = false
    const finish = (view: BundleView): void => {
      if (done) return
      done = true
      clearTimeout(slowTimer)
      clearInterval(pollTimer)
      set(name, view)
      endShown(shown, view)
    }
    // After the wait the card says the add is still working, and the plugin manager's own state is read until it reports an outcome.
    const slowTimer = setTimeout(() => { if (!done) set(name, { ...before, state: 'slow' }) }, options.addWaitMs())
    const pollTimer = setInterval(() => {
      if (done || views.getSnapshot()[name]?.state !== 'slow') return
      void remote.listBundles().then((listed) => {
        const now = listed.ok ? listed.value.find(each => each.name === name) : undefined
        const state = stateOf(now)
        if (state === 'installed') finish({ ...before, state })
      }, () => undefined)
    }, options.pollMs)
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
      if (!result.ok) {
        // The plugin manager's refusal, in its own words, so the card says what happened.
        finish({ ...before, state: 'failed', ...reasonOfFailure(result.error) })
      } else if (result.value.application === 'applied' || result.value.application === 'restart-required') {
        finish({ ...before, state: result.value.application === 'applied' ? 'installed' : 'restart' })
      } else {
        const error = result.value.error
        finish({ ...before, state: 'failed', ...error === undefined ? {} : { reason: error.diagnostic ?? error.code } })
      }
    } catch (error) {
      // The outcome is unknown here; Plugins shows what the profile holds and can finish it.
      console.warn('delorun onboarding: the plugin was not added', error)
      finish({ ...before, state: 'failed' })
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
      inflight.add(name)
      try { await runInstall(name) } finally { inflight.delete(name) }
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
      const shown = startPageDownload(id, { title: textOf(before.title) })
      inflightRows.add(id)
      try {
        const result = await remote.setPluginEnabled(entry, true)
        const application = result.ok ? result.value.application : 'failed'
        const state = application === 'applied' ? 'installed' : application === 'restart-required' ? 'restart' : 'failed'
        setRow(id, { ...before, state })
        endShown(shown, { state })
      } catch (error) {
        // The outcome is unknown here; Plugins shows what the profile holds and can finish it.
        console.warn('delorun onboarding: the optional plugin was not turned on', error)
        setRow(id, { ...before, state: 'failed' })
        endShown(shown, { state: 'failed' })
      } finally { inflightRows.delete(id) }
    },
    openPlugins: () => { ctx.get('pluginNavigation')?.openList() },
  }
}
