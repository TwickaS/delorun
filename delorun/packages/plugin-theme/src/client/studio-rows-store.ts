/**
 * The studio plugins' switches on the Plugins screen: the Loader entry each of `@delorun/bundle-studio`'s optional rows
 * writes through, its title in the active language, and the write that turns one on or off.
 *
 * Whether a row runs is not kept here: the page hands the entry the row's own live state in its subject, so the switch
 * reads that and cannot drift from the bundle's page. This store holds only what the subject does not carry — the entry
 * id the write needs, and the plugin's own words — read from the Host's `listBundles` and `listPlugins`, the two calls
 * the bundle's page makes.
 *
 * A write goes through `pluginManager/setPluginEnabled` with the row's Loader entry id, which is the call the bundle's
 * page makes: the profile's own patch records `disabled: false` for the row, so the change survives a reload and the
 * next start.
 * @module @delorun/plugin-theme/client/studio-rows-store
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.remote merge.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { STUDIO_BUNDLE, STUDIO_ROWS } from './studio-rows.ts'

/** The Loader entry id a row's switch writes through, as the Host's plugin manager takes it. */
export type StudioEntryId = Parameters<ClientRemote['pluginManager']['setPluginEnabled']>[0]

/** One studio plugin as the card lists it. */
export interface StudioRowView {
  /** The row id as the bundle's patch declares it. */
  readonly rowId: string
  /** The plugin's own title in the active language, or the row id while the Host reports none. */
  readonly title: string
  /** The Loader entry the switch writes through; absent while the bundle is off, so the switch is locked. */
  readonly entryId?: StudioEntryId
  /** Why the Host refuses the switch, when it does. */
  readonly readOnlyReason?: string
}

/** What the card's line reads. */
export interface StudioRowsState {
  /** The listed rows, in the bundle's order; empty until the Host answers or while the bundle is not installed. */
  readonly rows: readonly StudioRowView[]
  /** The row a write is in flight for, if any. */
  readonly busy?: string | undefined
  /** The row whose last write failed, if any. */
  readonly failed?: string | undefined
}

/** The face the entry reads and writes. */
export interface StudioRowsFace {
  /** The rows and the write state, as the entry's bound `useRows` selector hook. */
  readonly hooks: { readonly rows: HostObservable<StudioRowsState> }
  /**
   * Turn one studio plugin on or off.
   * @param rowId - the row id as the bundle's patch declares it.
   * @param enabled - whether the row should run.
   */
  readonly setEnabled: (rowId: string, enabled: boolean) => void
}

/**
 * Read the studio plugins and write their switches.
 * @param ctx - the studio context; `remote.pluginManager` is read when needed, so a profile without one lists nothing.
 * @param resolveText - the active language's reading of a package's own text.
 * @returns the face the entry reads.
 */
export function createStudioRows(ctx: Context, resolveText: (text: LocalizedText) => string): StudioRowsFace {
  const store = createSnapshotStore<StudioRowsState>({ rows: [] })
  const manager = (): ClientRemote['pluginManager'] | undefined => ctx.get('remote.pluginManager')
  const read = async (): Promise<void> => {
    const remote = manager()
    if (remote === undefined) {
      store.set({ rows: [] })
      return
    }
    const [listed, live] = await Promise.all([remote.listBundles(), remote.listPlugins()])
    if (!listed.ok || !live.ok) return
    const bundle = listed.value.find(each => each.name === STUDIO_BUNDLE)
    if (bundle === undefined || !bundle.installed) {
      store.set({ rows: [] })
      return
    }
    const rows = STUDIO_ROWS.flatMap((rowId): StudioRowView[] => {
      const row = bundle.rows.find(each => each.rowId === rowId)
      if (row === undefined) return []
      const plugin = row.entryId === undefined ? undefined : live.value.find(each => each.entryId === row.entryId)
      return [{
        rowId,
        title: row.meta?.title === undefined ? rowId : resolveText(row.meta.title),
        ...row.entryId === undefined ? {} : { entryId: row.entryId },
        ...plugin?.readOnlyReason === undefined ? {} : { readOnlyReason: plugin.readOnlyReason },
      }]
    })
    // A write in flight keeps its own state: a read it triggered must not clear the row's busy mark before it settles.
    const { busy, failed } = store.getSnapshot()
    store.set({ rows, ...busy === undefined ? {} : { busy }, ...failed === undefined ? {} : { failed } })
  }
  // The Host announces every change to the profile's rows, including the one this surface writes.
  ctx.effect(() => {
    const stop = ctx.get('remote')?.$on('plugin-manager/changed', () => { void read() })
    return () => { stop?.() }
  }, 'delorun-theme: the studio plugins follow the profile')
  void read()
  return {
    hooks: { rows: store },
    setEnabled: (rowId, enabled) => {
      const remote = manager()
      const row = store.getSnapshot().rows.find(each => each.rowId === rowId)
      const entryId = row?.entryId
      if (remote === undefined || entryId === undefined) return
      // A write clears the last failure and marks its row busy; the read that follows settles both.
      store.set({ rows: store.getSnapshot().rows, busy: rowId })
      void (async () => {
        try {
          const result = await remote.setPluginEnabled(entryId, enabled)
          const applied = result.ok && result.value.application !== 'failed' && result.value.application !== 'cancelled'
          store.set({ rows: store.getSnapshot().rows, ...applied ? {} : { failed: rowId } })
        } catch (error) {
          // The outcome is unknown here; the card says the write failed and the next read shows what the profile holds.
          console.warn('delorun theme: the studio plugin was not switched', error)
          store.set({ rows: store.getSnapshot().rows, failed: rowId })
        }
        await read()
      })()
    },
  }
}
