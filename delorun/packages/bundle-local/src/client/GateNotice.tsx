/**
 * The notice of a {@link Gate}: the line that says the action needs Face ID or the PIN each time, or the line that says
 * the action is done on the computer and why.
 */
import type { ReactNode } from 'react'
import type { Gate, GateTranslate } from './gate.ts'
import { gateOf } from './gate.ts'

/** Props of {@link GateNotice}. */
export interface GateNoticeProps {
  /** The state to show. */
  readonly gate: Gate
  /** The section's translate function; its dictionary merges the gate copy. */
  readonly t: GateTranslate
  /** Why the action is done on the computer; the sentence of the `computer` state. */
  readonly reason: string
}

/**
 * Render the notice.
 * @param props - the state and the copy.
 * @returns the Face ID line for `face`, the reason line for `computer`.
 */
export function GateNotice({ gate, t, reason }: GateNoticeProps): ReactNode {
  if (gate.kind === 'computer') return <p role="status" data-gate="computer">{t('gate.computer', { reason })}</p>
  return <p role="status" data-gate="face">{t('gate.face')}</p>
}

/**
 * A failed request's line: the Face ID line when the person only has to confirm, otherwise the failure's own sentence as
 * an alert.
 * @param props - the copy, the caught error, its sentence and the alert's class.
 * @returns the notice or the alert.
 */
export function GateFailure({ t, error, text, className }: { readonly t: GateTranslate; readonly error: unknown; readonly text: string; readonly className?: string | undefined }): ReactNode {
  const gate = gateOf(error)
  if (gate?.kind === 'face') return <GateNotice gate={gate} t={t} reason="" />
  return <p className={className} role="alert">{text}</p>
}
