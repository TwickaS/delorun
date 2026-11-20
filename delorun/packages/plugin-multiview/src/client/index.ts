/**
 * Browser half of Multiview: the entry points (pin button, header button, popover footer, Layout menu, auto-pin and
 * reopen on return) and the `multiview` service. The panel lane adds the `main` panel keyed `multiview`, which reads that
 * service; the layout engine they build on is `../layout/index.ts`.
 * @module @delorun/plugin-multiview/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.sessions merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { registerEntry } from '../entry/register.ts'
import { browserStorage, localPersistence } from '../store/persist.ts'

export {
  EMPTY_CHAT_MULTIVIEW, MULTIVIEW_NS, MULTIVIEW_PANEL_ID,
  type ChatMultiview, type MultiviewPersistence, type MultiviewService, type PinRefusal, type PinResult,
} from './contract.ts'
export { Footer, HeaderButton, openOrClose, PinButton, type EntryInjected, type FooterProps, type HeaderButtonProps, type PinButtonProps } from '../entry/Entry.tsx'
export { en, zh, type MultiviewLocaleKey } from '../entry/locales.ts'
export { HEADER_ORDER, registerEntry, type RegisterOptions } from '../entry/register.ts'
export { limitsOf, MultiviewStore, type MultiviewStoreOptions } from '../entry/state.ts'
export { HandOffWatcher, type CatalogIdentity } from '../entry/watcher.ts'
export { catalogOf, mainChatOf, ownerOf, parentOf, runningAgentsOf } from '../entry/read.ts'
export { DEFAULT_MULTIVIEW_SETTINGS, MULTIVIEW_ROW_ID, type MultiviewSettings } from '../config.ts'
export { browserStorage, localPersistence, MULTIVIEW_INDEX_NAME, MULTIVIEW_PERSIST_NAME, type MultiviewStorage } from '../store/persist.ts'

/** The Loader row name. */
export const name = 'delorun-multiview'

/** Services every registration needs. */
export const inject = ['slots', 'locale', 'sessions', 'layout', 'configForms']

/**
 * Mount the entry points.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  registerEntry(ctx, {
    persistence: localPersistence(browserStorage, message => { console.warn(message) }),
    windowArea: () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
  })
}
