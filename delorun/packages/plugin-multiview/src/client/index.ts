/**
 * Browser half of Multiview: the entry points (pin button, the toggle in the agents action, popover footer with the layout row,
 * focus command, auto-pin and auto-open), the `multiview` service, and the layer in the main Conversation's content that shows
 * the pinned agents' chats in panes (or, on a phone, pages); the layout engine they build on is `../layout/index.ts`.
 * @module @delorun/plugin-multiview/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.sessions merge.
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import { localHint } from '../entry/hint.ts'
import { registerEntry } from '../entry/register.ts'
import { registerLayer } from '../panel/register.ts'
import { browserStorage, localPersistence } from '../store/persist.ts'

export {
  EMPTY_CHAT_MULTIVIEW, MULTIVIEW_LAYER_ID, MULTIVIEW_NS,
  type ChatMultiview, type MultiviewPersistence, type MultiviewService, type PinRefusal, type PinResult,
} from './contract.ts'
export { registerLayer, type LayerOptions } from '../panel/register.ts'
export { MultiviewLayer, type LayerInjected, type LayerProps } from '../panel/Layer.tsx'
export { PaneHeader, type PaneHeaderProps } from '../panes/PaneHeader.tsx'
export { PaneBody, type PaneBodyProps } from '../panes/PaneBody.tsx'
export { PaneReferences, usePaneReferences, type PaneSessions } from '../panes/references.ts'
export { en as panesEn, PANES_NS, zh as panesZh, type PanesLocaleKey } from '../panes/locales.ts'
export { Footer, MultiviewToggle, openOrClose, PinButton, type EntryInjected, type FooterProps, type PinButtonProps, type ToggleProps } from '../entry/Entry.tsx'
export { FOCUS_COMMAND_ID, focusKeysOf, registerFocusCommand, type FocusCopy } from '../entry/focus.ts'
export { localHint, MULTIVIEW_HINT_NAME, type HintPreference } from '../entry/hint.ts'
export { en, zh, type MultiviewLocaleKey } from '../entry/locales.ts'
export { registerEntry, type RegisterOptions } from '../entry/register.ts'
export { limitsOf, MultiviewStore, type MultiviewStoreOptions } from '../entry/state.ts'
export { HandOffWatcher, type CatalogIdentity } from '../entry/watcher.ts'
export { catalogOf, mainChatOf, ownerOf, parentOf, runningAgentsOf } from '../entry/read.ts'
export { DEFAULT_MULTIVIEW_SETTINGS, MULTIVIEW_ROW_ID, type MultiviewSettings } from '../config.ts'
export { browserStorage, localPersistence, MULTIVIEW_INDEX_NAME, MULTIVIEW_PERSIST_NAME, type MultiviewStorage } from '../store/persist.ts'

/** The Loader row name. */
export const name = 'delorun-multiview'

/** Services every registration needs. */
export const inject = ['slots', 'locale', 'sessions', 'configForms', 'uiWorkspace']

/**
 * Mount the entry points.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  const multiview = registerEntry(ctx, {
    persistence: localPersistence(browserStorage, message => { console.warn(message) }),
    windowArea: () => ({ width: globalThis.innerWidth, height: globalThis.innerHeight }),
    hint: localHint(browserStorage),
  })
  const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
  registerLayer(ctx, { multiview, clock: epochMs => time.format(epochMs) })
}
