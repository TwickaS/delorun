/**
 * The focus command: one keyboard command that switches the main view's chat between Multiview and the main chat alone. Closing
 * keeps the pins and the layout, so switching back shows the same panes. It ships unbound; the person sets its keys in the
 * studio's keyboard settings.
 * @module @delorun/plugin-multiview/entry/focus
 */
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ShortcutCatalogEntry, ShortcutCommandId, Shortcuts } from '@deepseek-ai/dsh-client-shortcuts/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MultiviewService } from '../client/contract.ts'
import { openOrClose } from './Entry.tsx'
import { mainChatOf, runningAgentsOf } from './read.ts'

/** The command's id in the keyboard settings. */
export const FOCUS_COMMAND_ID = 'multiview.toggle' as ShortcutCommandId

/** The copy the command shows. */
export interface FocusCopy {
  /** The command's name in the keyboard settings. */
  readonly label: () => string
  /** Why it does nothing: no chat is open, the open chat is an agent's own, or there is nothing to show. */
  readonly blocked: (reason: 'no-chat' | 'agent-chat' | 'nothing') => string
}

/**
 * Register the focus command.
 * @param shortcuts - the studio's keyboard registry.
 * @param multiview - the service.
 * @param sessions - reads the session list now.
 * @param copy - the command's name and refusals.
 * @returns the disposer.
 */
export function registerFocusCommand(
  shortcuts: Pick<Shortcuts, 'register'>, multiview: MultiviewService, sessions: () => SessionListState, copy: FocusCopy,
): () => void {
  return shortcuts.register({
    id: FOCUS_COMMAND_ID,
    label: copy.label,
    aliases: ['multiview', 'main chat', 'focus', 'panes'],
    defaults: {},
    regions: ['page', 'editable', 'terminal'],
    modals: [],
    resolve: () => {
      const state = sessions()
      const chat = mainChatOf(state)
      if (chat === undefined) return { status: 'blocked', reason: copy.blocked('no-chat') }
      if (state.byId[chat]?.origin === 'subagent') return { status: 'blocked', reason: copy.blocked('agent-chat') }
      const { pins, open } = multiview.of(chat).getSnapshot()
      const running = runningAgentsOf(state, chat).filter(agent => !pins.includes(agent))
      if (!open && pins.length === 0 && running.length === 0) return { status: 'blocked', reason: copy.blocked('nothing') }
      return { status: 'handled', run: () => { switchView(multiview, chat, running) } }
    },
  })
}

/**
 * Switch a chat between Multiview and the main chat alone, reading the open state when the command runs.
 * @param multiview - the service.
 * @param chat - the chat.
 * @param running - the running agents that were not pinned when the command resolved.
 */
function switchView(multiview: MultiviewService, chat: SessionId, running: readonly SessionId[]): void {
  openOrClose(multiview, chat, multiview.of(chat).getSnapshot().open, running)
}

/**
 * The keys bound to the focus command, as an observable that changes identity only when they change.
 * @param catalog - the studio's command catalog.
 * @returns the keys, empty while the command is unbound or not listed.
 */
export function focusKeysOf(catalog: HostObservable<readonly ShortcutCatalogEntry[]>): HostObservable<readonly string[]> {
  let last: readonly string[] = []
  return {
    getSnapshot: () => {
      const entry = catalog.getSnapshot().find(row => row.id === FOCUS_COMMAND_ID)
      const keys = entry === undefined || entry.binding === null ? [] : entry.keys
      if (keys.length !== last.length || keys.some((key, index) => key !== last[index])) last = keys
      return last
    },
    subscribe: listener => catalog.subscribe(listener),
  }
}
