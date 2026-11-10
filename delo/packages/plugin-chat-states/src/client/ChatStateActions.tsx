/**
 * The chat states in the sidebar's rows: a settle button among a row's hover
 * buttons, and a notice when a change could not be saved. A chat's menu
 * entries are data contributions registered in `index.ts`, not components.
 * An archived chat offers neither the button nor the menu entries.
 */
import { useSyncExternalStore } from 'react'
import { IconCheckCircleFillRegular, IconCheckCircleOutlineRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatState, ChatStateRequest } from '../wire.ts'
import css from './ChatStateActions.module.css'

/** What the settle button and the failure notice read and do. */
export interface ChatStatesInjected {
  /** Each chat's state, by session id. */
  readonly states: HostObservable<Readonly<Record<string, ChatState>>>
  /** Whether the last change failed. */
  readonly failed: HostObservable<boolean>
  /** Ask for a change. */
  readonly change: (request: ChatStateRequest) => void
  /** Clear the failure notice. */
  readonly dismiss: () => void
}

/** What the hover button reads: its chat, the archived chats, and the services. */
export type ChatStateRowProps = Pick<PropsRuntime<'sidebar.workspaces.session.row.action'>, 'sessionId' | 'useWorkspaces'>
  & PropsLocale<'deloChatStates'> & InjectFace<ChatStatesInjected>

/**
 * Hover button: settle the chat, or return a settled one to the list.
 * @param props - the row's chat and the services.
 * @returns the button, or nothing for an archived chat.
 */
export function SettleRowButton({ sessionId, useWorkspaces, states, change, t }: ChatStateRowProps) {
  const archived = useWorkspaces(state => state.archivedSessionIds.includes(sessionId))
  const settled = useSyncExternalStore(listener => states.subscribe(listener), () => states.getSnapshot()[sessionId]?.settledAt !== undefined)
  if (archived) return null
  const label = t(settled ? 'settle.undo' : 'settle')
  return (
    <Tooltip label={label} side="bottom" align="end" delayMs={500} portal>
      <button type="button" className={css.iconButton} aria-label={label}
        onClick={() => { change({ action: settled ? 'unsettle' : 'settle', session: sessionId }) }}>
        {settled ? <IconCheckCircleFillRegular size={14} /> : <IconCheckCircleOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}

/**
 * The notice that a change could not be saved.
 * @param props - the services and the copy.
 * @returns the notice while the last change failed.
 */
export function ChatStateFailure({ failed, dismiss, t }: PropsLocale<'deloChatStates'> & InjectFace<Pick<ChatStatesInjected, 'failed' | 'dismiss'>>) {
  const shown = useSyncExternalStore(listener => failed.subscribe(listener), () => failed.getSnapshot())
  return shown ? <Toast text={t('failed')} onDone={dismiss} /> : null
}
