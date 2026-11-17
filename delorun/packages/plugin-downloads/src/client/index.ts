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
// Type-only: the 'shell.overlay' slot.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { en, NS, zh, type DownloadsLocaleKey, type Translate } from './locales.ts'
import { DownloadsSurface } from './Surface.tsx'
import { createRemoteDownloadsSource as createPacksSource, type PacksPanelRemote } from './remote.ts'
import { provideDownloadsSource, provideTranslate, type DownloadsSource } from './source.ts'

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
 * The source over the Host's `packs` remote. The remote is read when the panel first needs it, so a profile without
 * `@delorun/plugin-packs` shows an empty list.
 * @param ctx - the browser plugin context.
 * @returns the source the panel reads.
 */
export function createRemoteDownloadsSource(ctx: Context): DownloadsSource {
  const remote = (): PacksPanelRemote | undefined => ctx.get('remote.packs')
  const missing = (): Promise<never> => Promise.reject(new Error('This Host has no plugin packs.'))
  return createPacksSource({
    list: () => remote()?.list() ?? missing(),
    cancel: request => remote()?.cancel(request) ?? missing(),
    retry: request => remote()?.retry(request) ?? missing(),
    remove: request => remote()?.remove(request) ?? missing(),
  }, {
    pollMs: POLL_MS,
    follow: (refresh) => {
      const stops = [ctx.on('connection/reset', refresh), ctx.get('remote')?.$on('plugin-manager/install-state', refresh)]
      return () => { for (const stop of stops) stop?.() }
    },
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
  ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'delorun-downloads', locale: NS,
  }, DownloadsSurface)), 'delorun-downloads: the overlay entry')
}
