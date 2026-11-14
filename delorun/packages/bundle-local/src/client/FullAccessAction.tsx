/**
 * The approval card's line for a request that asks for full access when the studio is remote. The home refuses the
 * workspace review off its own computer, so the line says to approve at the computer; the "Allow for this chat" choice
 * of [`AllowForChat.tsx`](./AllowForChat.tsx) shows no button there. At the home's own computer and for a request
 * without full access, the action shows nothing.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { ApprovalActionOwnerProps } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { readEverywhere, reviewChat } from './consents-api.ts'
import { isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** What the plugin supplies the action for one chat. */
export interface FullAccessActionInjected {
  /** The chat the card belongs to. */
  sessionId: string
  /** Sends the action's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the action. */
export type FullAccessActionProps = ApprovalActionOwnerProps & PropsLocale<'delorunConsents'> & InjectFace<FullAccessActionInjected>

/**
 * Whether the home refuses the workspace review of one chat because the studio is remote.
 * @param fetch - the request function.
 * @param sessionId - the chat.
 * @returns true on a remote studio while dangerous mode is off; false at the home's own computer, for a chat the home cannot review and when the
 *   home is unreachable.
 */
export async function isRemoteStudio(fetch: HostFetch, sessionId: string): Promise<boolean> {
  // While dangerous mode is on, a remote studio switches without the computer, so nothing there says to approve elsewhere.
  if ((await readEverywhere(fetch)).on) return false
  try {
    await reviewChat(fetch, sessionId)
    return false
  } catch (error) {
    // NO_WORKSPACE, UNKNOWN_CHAT and an unreachable home leave the card as it is.
    return isRefused(error, LOOPBACK_REQUIRED)
  }
}

/**
 * Render the line.
 * @param props - the card's request and the copy.
 * @returns the line on a remote studio, or nothing.
 */
export function FullAccessAction({ grants, sessionId, fetch, t }: FullAccessActionProps): ReactNode {
  const [remote, setRemote] = useState(false)
  const asks = grants === 'full-access'
  useEffect(() => {
    if (!asks) return
    let current = true
    void isRemoteStudio(fetch, sessionId).then((next) => { if (current) setRemote(next) })
    return () => { current = false }
  }, [asks, fetch, sessionId])
  if (!asks || !remote) return null
  return <p className={css.line} role="status" data-full-access-action="remote">{t('action.atComputer')}</p>
}
