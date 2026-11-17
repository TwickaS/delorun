/**
 * The notice of a {@link Gate}: the unlock prompt with its minutes and Unlock button, or the line that says the action is
 * done on the computer and why.
 */
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Gate, GateTranslate } from './gate.ts'
import { gateOf, unlockSentence } from './gate.ts'
import { useGateUnlock } from './gate-unlock.ts'

/** Props of {@link GateNotice}. */
export interface GateNoticeProps {
  /** The state to show. */
  readonly gate: Gate
  /** The section's translate function; its dictionary merges the gate copy. */
  readonly t: GateTranslate
  /** The configured unlock length in minutes, when the unlock store has read it. */
  readonly minutes?: number | undefined
  /** Open the unlock dialog; absent hides the Unlock button. */
  readonly onUnlock?: (() => void) | undefined
  /** Why the action is done on the computer; the sentence of the `computer` state. */
  readonly reason: string
}

/**
 * Render the notice.
 * @param props - the state, the copy and the unlock.
 * @returns the unlock prompt for `unlock`, the reason line for `computer`.
 */
export function GateNotice({ gate, t, minutes, onUnlock, reason }: GateNoticeProps): ReactNode {
  if (gate.kind === 'computer') return <p role="status" data-gate="computer">{t('gate.computer', { reason })}</p>
  return <div role="status" data-gate="unlock">
    <p>{unlockSentence(t, minutes)}</p>
    {onUnlock === undefined ? null : <Button variant="primary" size="sm" onClick={onUnlock}>{t('gate.unlockButton')}</Button>}
  </div>
}

/**
 * A failed request's line: the unlock prompt (with the minutes and an Unlock button) when the device only needs to unlock,
 * otherwise the failure's own sentence as an alert.
 * @param props - the copy, the caught error, its sentence and the alert's class.
 * @returns the prompt or the alert.
 */
export function GateFailure({ t, error, text, className }: { readonly t: GateTranslate; readonly error: unknown; readonly text: string; readonly className?: string | undefined }): ReactNode {
  const { minutes, open } = useGateUnlock()
  if (gateOf(error)?.kind === 'unlock') return <GateNotice gate={{ kind: 'unlock' }} t={t} minutes={minutes} onUnlock={open} reason="" />
  return <p className={className} role="alert">{text}</p>
}
