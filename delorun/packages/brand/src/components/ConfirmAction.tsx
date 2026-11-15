/**
 * A destructive action that asks one inline confirmation before it runs. The caller owns the `confirming` state.
 * @module @delorun/brand/components/ConfirmAction
 */
import { Button } from './Button.tsx'
import css from './ConfirmAction.module.css'

/** The props of {@link ConfirmAction}. */
export interface ConfirmActionProps {
  readonly confirming: boolean
  readonly onAsk: () => void
  readonly onConfirm: () => void
  readonly onCancel: () => void
  /** The action's label; it also names the confirmation group. */
  readonly label: string
  readonly question: string
  readonly yes: string
  readonly no: string
  readonly disabled?: boolean
  /** A `data-confirm` value on the confirmation, which tests may select. */
  readonly confirmAttribute?: string | undefined
}

/**
 * Render the action, or its confirmation.
 * @param props - see {@link ConfirmActionProps}.
 * @returns the button, or the question with its two buttons.
 */
export function ConfirmAction({ confirming, onAsk, onConfirm, onCancel, label, question, yes, no, disabled = false, confirmAttribute }: ConfirmActionProps) {
  if (!confirming) return <div><Button variant="destructive" size="sm" disabled={disabled} onClick={onAsk}>{label}</Button></div>
  return (
    <div className={css.confirm} role="group" aria-label={label} data-confirm={confirmAttribute}>
      <p className={css.question}>{question}</p>
      <div className={css.actions}>
        <Button variant="destructive" size="sm" disabled={disabled} onClick={onConfirm}>{yes}</Button>
        <Button variant="secondary" size="sm" disabled={disabled} onClick={onCancel}>{no}</Button>
      </div>
    </div>
  )
}
