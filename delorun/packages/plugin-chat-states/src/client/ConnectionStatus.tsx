/**
 * A polite live region that says when the studio loses and regains Delorun. Upstream's connection indicator in the
 * sidebar's foot is a button, so a screen reader reads "Reconnecting" only when it reaches the button; this region,
 * always on the page and visually hidden, announces each change as it happens.
 */
import { useState } from 'react'
import type { ConnectionState, ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatStatesLocaleKey } from './locales.ts'
import css from './ConnectionStatus.module.css'

/** What the overlay entry injects: the page's connection state. */
export interface ConnectionStatusInjected {
  /** The page's connection state, `undefined` before the first attempt has an outcome. */
  readonly hooks: { readonly connectionState: ConnectionStateSource }
}

/** Props of the `shell.overlay` entry. */
export type ConnectionStatusProps = PropsLocale<'delorunChatStates'> & InjectFace<ConnectionStatusInjected>

/**
 * The announcement for a change of the connection state.
 * @param previous - the state before the change.
 * @param next - the state after it.
 * @returns the dictionary key to announce, or `undefined` when the change says nothing to the person: the first
 * connection, or no outcome yet.
 */
export function connectionAnnouncement(previous: ConnectionState | undefined, next: ConnectionState | undefined): ChatStatesLocaleKey | undefined {
  switch (next) {
    case 'connecting': return 'connection.reconnecting'
    case 'disconnected': return 'connection.offline'
    case 'connected': return previous === 'connecting' || previous === 'disconnected' ? 'connection.back' : undefined
    case undefined: return undefined
  }
}

/**
 * Render the live region with the latest announcement.
 * @param props - the connection state's hook and the dictionary.
 * @returns the visually hidden status region.
 */
export function ConnectionStatus({ useConnectionState, t }: ConnectionStatusProps) {
  const state = useConnectionState(current => current)
  const [seen, setSeen] = useState<{ readonly state: ConnectionState | undefined; readonly key: ChatStatesLocaleKey | undefined }>({ state, key: undefined })
  if (seen.state !== state) setSeen({ state, key: connectionAnnouncement(seen.state, state) })
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className={css.visuallyHidden}>
      {seen.key === undefined ? '' : t(seen.key)}
    </div>
  )
}
