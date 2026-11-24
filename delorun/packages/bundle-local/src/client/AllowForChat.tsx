/**
 * The approval card's "Allow for this chat" choice for a sandbox escalation. The click switches the chat's permission
 * preset to the mode the request asked for, through the same `/permission <preset>` command the composer sends, so the
 * switch is logged and announced to the model as any other, and then answers the card as allowed; later commands in the
 * chat run in that mode without asking, until the person lowers it in the composer. A request for `workspace-write`
 * switches at once. A request for `danger-full-access` first shows the one full-access dialog of
 * [`FullAccessConsent.tsx`](./FullAccessConsent.tsx) for this chat, which records the workspace's grant when it holds
 * none; cancelling it leaves the card waiting. A chat already at or above the requested mode is not offered the choice,
 * and a chat raised to that mode after the card rendered is answered as Allow once, with no dialog or switch. On a remote
 * studio, whose full-access review the home refuses, the choice is not offered for full access: the full-access line of
 * [`FullAccessAction.tsx`](./FullAccessAction.tsx) says to approve at the computer. A refused
 * switch leaves the card unanswered with the refusal under the button. Once the card answered, is sending an answer or no
 * longer accepts one, the button is disabled, and a click already under way records and switches nothing more: the
 * card's `canAnswer` is read at the click, when the person confirms the dialog, before the switch and after it. A card
 * that stops accepting an answer while the switch is under way is not answered; the switched preset stays, since the
 * person asked for it.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@delorun/brand'
import type { ApprovalChoiceOwnerProps } from '@deepseek-ai/dsh-client-ui-approval/client'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { FULL_ACCESS_PRESET } from './consents-api.ts'
import { isRemoteStudio } from './FullAccessAction.tsx'
import { confirmPermissionSwitch, consentFailureOf, consentFailureText, type FullAccessConsentSource } from './FullAccessConsent.tsx'
import type { HostFetch } from './host-api.ts'
import css from './ConsentSections.module.css'

/** The preset of a request that escalates to the workspace-write sandbox mode. */
const WORKSPACE_WRITE_PRESET = 'workspace-write'

/** The home's refusal of a preset switch, worded by the home. */
export class ChatSwitchRefused extends Error {}

/** What the plugin supplies the choice for one chat. */
export interface AllowForChatInjected {
  /** The chat the card belongs to. */
  sessionId: string
  /** Sends the choice's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** The full-access dialog's questions. */
  consent: Pick<FullAccessConsentSource, 'ask' | 'askSwitch'>
  /** The chat's current permission preset, or undefined while the chat is not materialized or has no permission control. */
  currentPreset: () => string | undefined
  /**
   * Switch the chat to a preset as the composer does.
   * @param preset - the preset.
   * @throws {ChatSwitchRefused} with the home's sentence when the switch is refused.
   */
  switchTo: (preset: string) => Promise<void>
}

/** Props the renderer binds for the choice. */
export type AllowForChatProps = ApprovalChoiceOwnerProps & PropsLocale<'delorunConsents'> & InjectFace<AllowForChatInjected>

/**
 * How far a preset reaches; a preset outside the two escalation targets, such as read-only, auto-review or a custom
 * mix, is below both.
 * @param preset - the preset id.
 * @returns the rank: 2 for full access, 1 for workspace-write, otherwise 0.
 */
function rankOf(preset: string | undefined): number {
  if (preset === FULL_ACCESS_PRESET) return 2
  return preset === WORKSPACE_WRITE_PRESET ? 1 : 0
}

/**
 * Render the choice.
 * @param props - the card's request and answer, the chat and the copy.
 * @returns the button with a failure after it, or nothing.
 */
export function AllowForChat({ escalatesTo, allow, answered, canAnswer, offer, sessionId, fetch, consent, currentPreset, switchTo, t }: AllowForChatProps): ReactNode {
  const fullAccess = escalatesTo === FULL_ACCESS_PRESET
  // Full access waits for the review that tells a remote studio apart; workspace-write needs none.
  const [remote, setRemote] = useState<boolean | undefined>(fullAccess ? undefined : false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  useEffect(() => {
    if (!fullAccess) return
    let current = true
    void isRemoteStudio(fetch, sessionId).then((next) => { if (current) setRemote(next) })
    return () => { current = false }
  }, [fullAccess, fetch, sessionId])
  // A chat that already reaches the requested mode needs no switch; a click that finds it so answers the card as Allow once.
  const atRequestedMode = (): boolean => rankOf(currentPreset()) >= rankOf(escalatesTo)
  const shown = remote === false && !atRequestedMode()
  useEffect(() => {
    offer(shown)
    return () => { offer(false) }
  }, [shown, offer])
  if (!shown) return null
  const run = async (): Promise<void> => {
    if (!canAnswer()) return
    setBusy(true)
    setFailure(undefined)
    try {
      if (!atRequestedMode()) {
        const answer = fullAccess ? await confirmPermissionSwitch(fetch, consent, sessionId, FULL_ACCESS_PRESET, canAnswer) : 'submit'
        if (answer === 'cancelled') return
        // The person may have answered the card, or its request ended, while the dialog was open.
        if (!canAnswer()) return
        // A grant that switched the chat needs no second switch, which a device would confirm again. The chat may also
        // have been raised while the dialog was open, so the mode is checked again right before the switch.
        if (answer === 'submit' && !atRequestedMode()) await switchTo(escalatesTo)
      }
      // The raised permission stays when the card was answered elsewhere, or its request ended, during the switch.
      if (!canAnswer()) return
      await allow()
    } catch (error) {
      setFailure(error instanceof ChatSwitchRefused ? error.message : consentFailureText(t, consentFailureOf(error)))
    } finally {
      setBusy(false)
    }
  }
  // The two elements are items of the card's decision row; the failure takes a line of its own under the buttons.
  return <>
    <Button variant="primary" data-allow-for-chat={escalatesTo} disabled={busy || answered || !canAnswer()} onClick={() => { void run() }}>{t('action.allowForChat')}</Button>
    {failure === undefined ? null : <p className={`${css.failed} ${css.choiceFailure}`} role="alert">{failure}</p>}
  </>
}
