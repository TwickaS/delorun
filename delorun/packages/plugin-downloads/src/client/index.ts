/**
 * The downloads panel's studio half: one `shell.overlay` entry that shows every plugin being installed. On a computer it
 * is a floating card at the bottom right; on a phone it is a header icon with a count badge that opens a bottom sheet,
 * and the setup guide draws {@link OnboardingDownloadsRow} in its footer instead.
 * @module @delorun/plugin-downloads/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.locale merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.slots merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `remote/call-denied` event.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: the Plugins page's 'plugins.bundle.action' slot.
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
// Type-only: the 'shell.overlay' slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { en, NS, zh, type DownloadsLocaleKey, type Translate } from './locales.ts'
import { packNotLoading, packToAdd, PackAddAction, PackNotLoadingAction } from './Action.tsx'
import { DownloadsSurface } from './Surface.tsx'
import { createPacksClient } from '@delorun/plugin-packs/client'
import { createRemoteDownloadsSource as createPacksSource } from './remote.ts'
import { provideDownloadsSource, provideTranslate, provideUninstall, type DownloadsSource } from './source.ts'

export { createFakeDownloadsSource, type DownloadItem, type DownloadState, type DownloadsSource, type FakeDownloadsSource } from './source.ts'
export { OnboardingDownloadsRow, type OnboardingDownloadsRowProps } from './Phone.tsx'
export { claimOnboardingRow, provideDownloadsSource } from './source.ts'
export { en, NS, zh, type DownloadsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The downloads panel's copy. */
    'delorunDownloads': DownloadsLocaleKey
  }
}

/** Required services. */
export const inject = ['slots', 'locale']

/** Milliseconds between install-list reads while something is queued or working. */
const POLL_MS = 1500

/**
 * The source over the Host's packs routes. A refusal that asks for an unlock opens the studio's unlock dialog the way a
 * refused Remote call does, through `remote/call-denied`.
 * @param ctx - the browser plugin context.
 * @returns the source the panel reads.
 */
export function createRemoteDownloadsSource(ctx: Context): DownloadsSource {
  return createPacksSource(createPacksClient(), {
    pollMs: POLL_MS,
    follow: (refresh) => {
      const stops = [ctx.on('connection/reset', refresh), ctx.get('remote')?.$on('plugin-manager/install-state', refresh)]
      return () => { for (const stop of stops) stop?.() }
    },
    unlockNeeded: (action, reason) => { ctx.emit('remote/call-denied', { endpoint: `packs/${action}`, reason }) },
  })
}

/**
 * Register the copy and the overlay entry, and provide the source every surface reads.
 * @param ctx - the browser plugin context.
 * @param source - the source; the remote adapter when absent.
 */
export function apply(ctx: Context, source: DownloadsSource = createRemoteDownloadsSource(ctx)): void {
  // The spacing tokens exist only while the Delorun look is on, as with every row of the studio bundle.
  ctx.inject(['delorunStudio'], inner => { applyStudio(inner, source) })
}

/**
 * Everything the plugin registers while the Delorun look provides `delorunStudio`.
 * @param ctx - the browser plugin context, holding `delorunStudio`.
 * @param source - the source every surface reads.
 */
export function applyStudio(ctx: Context, source: DownloadsSource): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'delorun-downloads: dictionaries')
  ctx.effect(() => provideDownloadsSource(source), 'delorun-downloads: the source')
  const bound: Translate = (key: DownloadsLocaleKey, params) => ctx.locale.bind(NS)(key, params)
  ctx.effect(() => provideTranslate(bound), 'delorun-downloads: the standalone row\'s copy')
  ctx.effect(() => provideUninstall(async (name) => {
    const manager = ctx.get('remote.pluginManager')
    if (manager === undefined) throw new Error('no plugin manager is mounted')
    const removed = await manager.removeBundle(name)
    if (!removed.ok || removed.value.application === 'failed' || removed.value.application === 'cancelled') throw new Error(`${name} was not removed`)
  }), 'delorun-downloads: the uninstall of a pack that does not load')
  ctx.effect(() => ctx.slots.inject('plugins.bundle.action', () => ctx.slots.register({
    name: 'plugins.bundle.action', select: owner => packToAdd(owner.subject), locale: NS,
  }, PackAddAction)), 'delorun-downloads: the Add action of a pack on the Plugins page')
  ctx.effect(() => ctx.slots.inject('plugins.bundle.action', () => ctx.slots.register({
    name: 'plugins.bundle.action', select: owner => packNotLoading(owner.subject), locale: NS,
  }, PackNotLoadingAction)), 'delorun-downloads: the not-loading state of an installed pack on the Plugins page')
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delorun-downloads', locale: NS,
  }, DownloadsSurface)), 'delorun-downloads: the overlay entry')
}
