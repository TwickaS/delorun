/**
 * The two session-scoped slots of a pane: its header and its body. The panel renders each inside a `SessionProvider` bound to the
 * pane's own chat reference, so the real chat components (and any plugin's contributions to them) work in a pane as they do in the
 * main view.
 * @module @delorun/plugin-multiview/panes/slots
 */
import type { PaneHeaderControls } from '../layout/index.ts'

/** What the panel gives a pane header besides the chat it is bound to. */
export interface PaneHeaderOwnerProps {
  /** The pane is the main chat's. */
  readonly isMain: boolean
  /** The pane holds keyboard focus. */
  readonly focused: boolean
  /** The header is a phone page's: no grip, menu or buttons, because the page's Open full chat and Stop sit above its reply box. */
  readonly page: boolean
  /** The grip, the layout actions and the list of places the pane can go. */
  readonly controls: PaneHeaderControls
  /** Open this chat in the main view; closes Multiview. */
  readonly onOpen: () => void
  /** Stop this chat's run. */
  readonly onStop: () => void
  /** Remove the pane and its pin. */
  readonly onClose: () => void
  /** Format an epoch-millisecond time of day. */
  readonly clock: (epochMs: number) => string
}

/** What the panel gives a pane body besides the chat it is bound to. */
export interface PaneBodyOwnerProps {
  /** Show the compact one-line reply box; false shows the full composer. */
  readonly compact: boolean
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** A Multiview pane's header for one chat: name, status badge, limits line and the pane's actions. */
    'multiview.pane.header': { kind: 'single'; scope: 'session'; owner: PaneHeaderOwnerProps }
    /** A Multiview pane's body for one chat: the shared Conversation content in its pane occurrence. */
    'multiview.pane.body': { kind: 'single'; scope: 'session'; owner: PaneBodyOwnerProps }
  }
}
