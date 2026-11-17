/**
 * The approval card's action for a request to start an external agent, such as Claude Code or Codex. At the home's own
 * computer it offers "Allow for this workspace": the grant is recorded first, then the card is answered as allowed, so
 * this run starts and later runs in the workspace start without asking until the person revokes the grant in
 * External agents. A failed grant leaves the card unanswered with the reason under the button. Once the card answered, is
 * sending an answer or no longer accepts one, the action is disabled and a click records nothing: the card's
 * `canAnswer` is read when the click starts, and again after the grant, before the card is answered. On a remote
 * studio, whose grant the home refuses, the action says to approve at the computer instead of offering a button; the
 * card's own Allow is refused there too. Every other card shows nothing.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalActionOwnerProps } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAgentForWorkspace, readAgentGrants } from './consents-api.ts'
import { consentFailureOf, ConsentFailureLine, type ConsentFailure } from './FullAccessConsent.tsx'
import { isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** What the plugin supplies the action for one chat. */
export interface ExternalAgentActionInjected {
  /** The chat the card belongs to. */
  sessionId: string
  /** Sends the action's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
}

/** Props the renderer binds for the action. */
export type ExternalAgentActionProps = ApprovalActionOwnerProps & PropsLocale<'delorunConsents'> & InjectFace<ExternalAgentActionInjected>

/** What the action offers: nothing (yet), the button, or the remote line. */
type Offer = 'none' | 'allow' | 'remote'

/**
 * Read what the action offers: the button where the home answers its grants route, the remote line where it refuses
 * the arrival, and nothing where the profile mounts no external-agent consent or the home cannot be read.
 * @param fetch - the request function.
 * @returns the offer.
 */
export async function agentOfferFor(fetch: HostFetch): Promise<Offer> {
  try {
    return await readAgentGrants(fetch) === undefined ? 'none' : 'allow'
  } catch (error) {
    return isRefused(error, LOOPBACK_REQUIRED) ? 'remote' : 'none'
  }
}

/**
 * Render the action.
 * @param props - the card's request, its answer, the chat and the copy.
 * @returns the button, the remote line, or nothing.
 */
export function ExternalAgentAction({ grants, toolName, allow, answered, canAnswer, sessionId, fetch, t }: ExternalAgentActionProps): ReactNode {
  const [offer, setOffer] = useState<Offer>('none')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<ConsentFailure | undefined>()
  const asks = grants === 'external-agent' && toolName !== undefined
  useEffect(() => {
    if (!asks) return
    let current = true
    void agentOfferFor(fetch).then((next) => { if (current) setOffer(next) })
    return () => { current = false }
  }, [asks, fetch])
  if (!asks || offer === 'none') return null
  if (offer === 'remote') return <p className={css.line} role="status" data-external-agent-action="remote">{t('action.atComputer')}</p>
  const run = async (): Promise<void> => {
    if (!canAnswer()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await allowAgentForWorkspace(fetch, sessionId, toolName)
      // The person may have answered the card, or its request ended, while the grant was recorded.
      if (canAnswer()) await allow()
    } catch (error) {
      setFailure(consentFailureOf(error))
    } finally {
      setBusy(false)
    }
  }
  return <div className={css.action} data-external-agent-action="allow">
    <Button variant="outline" size="sm" disabled={busy || answered || !canAnswer()} onClick={() => { void run() }}>{t('action.allowAgent')}</Button>
    {failure === undefined ? null : <ConsentFailureLine t={t} failure={failure} action="action.changeAgent" />}
  </div>
}
