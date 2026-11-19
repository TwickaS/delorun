/**
 * The notice of a {@link Gate}: the line that says the action needs Face ID or the PIN each time, the unlock prompt with
 * its minutes and Unlock button, or the line that says the action is done on the computer and why.
 */
import { useEffect, useRef } from 'react'
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
 * @returns the Face ID line for `face`, the unlock prompt for `unlock`, the reason line for `computer`.
 */
export function GateNotice({ gate, t, minutes, onUnlock, reason }: GateNoticeProps): ReactNode {
  if (gate.kind === 'computer') return <p role="status" data-gate="computer">{t('gate.computer', { reason })}</p>
  if (gate.kind === 'face') return <p role="status" data-gate="face">{t('gate.face')}</p>
  return <div role="status" data-gate="unlock">
    <p>{unlockSentence(t, minutes)}</p>
    {onUnlock === undefined ? null : <Button variant="primary" size="sm" onClick={onUnlock}>{t('gate.unlockButton')}</Button>}
  </div>
}

/**
 * A failed request's line: the unlock prompt (with the minutes and an Unlock button) when the device only needs to unlock,
 * otherwise the failure's own sentence as an alert.
 * When the device becomes unlocked while the prompt shows, `retry` runs once, so the person does not repeat the action.
 * @param props - the copy, the caught error, its sentence, the alert's class and the retry.
 * @returns the prompt or the alert.
 */
export function GateFailure({ t, error, text, className, retry }: { readonly t: GateTranslate; readonly error: unknown; readonly text: string; readonly className?: string | undefined; readonly retry?: (() => void) | undefined }): ReactNode {
  const { minutes, open, unlocked } = useGateUnlock()
  useRetryOnUnlock(gateOf(error)?.kind === 'unlock', unlocked, retry)
  const gate = gateOf(error)
  if (gate?.kind === 'face') return <GateNotice gate={gate} t={t} reason="" />
  if (gate?.kind === 'unlock') return <GateNotice gate={gate} t={t} minutes={minutes} onUnlock={open} reason="" />
  return <p className={className} role="alert">{text}</p>
}

/**
 * Run a retry once when the device turns from locked to unlocked while an unlock prompt shows.
 * @param prompting - whether an unlock prompt shows.
 * @param unlocked - whether the device holds an unlock.
 * @param retry - what repeats the refused action.
 */
export function useRetryOnUnlock(prompting: boolean, unlocked: boolean, retry: (() => void) | undefined): void {
  const was = useRef(unlocked)
  useEffect(() => {
    if (prompting && unlocked && !was.current) retry?.()
    was.current = unlocked
  }, [prompting, unlocked, retry])
}
