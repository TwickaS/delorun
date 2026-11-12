/**
 * The approval card's action for a request that asks for full access, so the request is never a dead end. At the
 * home's own computer it offers "Allow full access for this workspace": the click reads the workspace's full access
 * again, so it answers what the home holds then; a workspace without a grant shows the consent first, then the grant is
 * recorded, the chat switches to full access so it stops asking, and the card is answered as
 * allowed. A workspace that already holds a grant is not asked again. Once the card answered, is sending an answer or
 * no longer accepts one, the action is disabled, and a click already under way records nothing more: the card's
 * `canAnswer` is read before the review, before the grant and again when the person confirms the consent. On a remote
 * studio, whose review the home refuses, the action says to approve at the computer instead of offering a button. A chat without a workspace folder,
 * a profile without per-workspace full access, and the consent's own card (`permission`) show nothing.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ApprovalActionOwnerProps } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { reviewChat, setFullAccess, type WorkspaceAccess } from './consents-api.ts'
import { consentFailureOf, consentFailureText, type FullAccessConsentSource } from './FullAccessConsent.tsx'
import { isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The tool name of the approval the consent itself asks through, whose own Allow records the grant. */
const CONSENT_TOOL = 'permission'

/** What the plugin supplies the action for one chat. */
export interface FullAccessActionInjected {
  /** The chat the card belongs to. */
  sessionId: string
  /** Sends the action's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Shows the consent and waits for the person's answer. */
  ask: FullAccessConsentSource['ask']
}

/** Props the renderer binds for the action. */
export type FullAccessActionProps = ApprovalActionOwnerProps & PropsLocale<'deloConsents'> & InjectFace<FullAccessActionInjected>

/** What the action offers: nothing yet or at all, the button with the workspace, or the remote line. */
type Offer =
  | { readonly kind: 'none' }
  | { readonly kind: 'allow'; readonly access: WorkspaceAccess }
  | { readonly kind: 'remote' }

/**
 * Read what the action offers for one chat.
 * @param fetch - the request function.
 * @param sessionId - the chat.
 * @returns the offer; none when the home cannot review the chat.
 */
export async function offerFor(fetch: HostFetch, sessionId: string): Promise<Offer> {
  try {
    const access = await reviewChat(fetch, sessionId)
    return access === undefined ? { kind: 'none' } : { kind: 'allow', access }
  } catch (error) {
    // NO_WORKSPACE, UNKNOWN_CHAT and an unreachable home leave the card as it is.
    return isRefused(error, LOOPBACK_REQUIRED) ? { kind: 'remote' } : { kind: 'none' }
  }
}

/**
 * Render the action.
 * @param props - the card's request, its answer, the chat and the copy.
 * @returns the button, the remote line, or nothing.
 */
export function FullAccessAction({ grants, toolName, allow, answered, canAnswer, sessionId, fetch, ask, t }: FullAccessActionProps): ReactNode {
  const [offer, setOffer] = useState<Offer>({ kind: 'none' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const asks = grants === 'full-access'
  useEffect(() => {
    if (!asks) return
    let current = true
    void offerFor(fetch, sessionId).then((next) => { if (current) setOffer(next) })
    return () => { current = false }
  }, [asks, fetch, sessionId])
  if (!asks) return null
  if (offer.kind === 'remote') return <p className={css.line} role="status" data-full-access-action="remote">{t('action.atComputer')}</p>
  if (offer.kind === 'none' || toolName === CONSENT_TOOL) return null
  const run = async (): Promise<void> => {
    if (!canAnswer()) return
    setBusy(true)
    setFailure(undefined)
    try {
      // The review shown at mount may be out of date: another surface may have granted or withdrawn since.
      const access = await reviewChat(fetch, sessionId)
      // The person may have answered the card, or its request ended, while the review was read.
      if (access === undefined || !canAnswer()) return
      const granted = access.grantedAt === null
        ? await ask(access, sessionId, canAnswer)
        : (await setFullAccess(fetch, access, true, sessionId), true)
      if (granted) await allow()
    } catch (error) {
      setFailure(consentFailureText(t, consentFailureOf(error)))
    } finally {
      setBusy(false)
    }
  }
  return <div className={css.action} data-full-access-action="allow">
    <Button variant="outline" size="sm" disabled={busy || answered} onClick={() => { void run() }}>{t('action.allowFullAccess')}</Button>
    {failure === undefined ? null : <p className={css.failed} role="alert">{failure}</p>}
  </div>
}
