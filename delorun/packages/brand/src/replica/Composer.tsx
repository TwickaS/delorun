/**
 * A chat composer drawn as a picture: a field-looking box that shows a value, with a caret while it is being typed,
 * and a send button. The box is read-only; the owner of the picture decides what it shows.
 * @module @delorun/brand/replica/Composer
 */
import { Button } from '../components/Button.tsx'
import css from './Composer.module.css'

/** The props of {@link Composer}. */
export interface ComposerProps {
  /** The localised accessible name of the box. */
  readonly label: string
  /** Shown in the muted colour while `value` is empty. */
  readonly placeholder: string
  readonly value: string
  /** The localised text of the send button. */
  readonly sendLabel: string
  /** Show a blinking caret after the value. */
  readonly typing?: boolean | undefined
  readonly className?: string | undefined
}

/**
 * Render a composer.
 * @param props - see {@link ComposerProps}.
 * @returns the composer; its send button is disabled while `value` is empty.
 */
export function Composer({ label, placeholder, value, sendLabel, typing = false, className }: ComposerProps) {
  return (
    <div className={`${css.composer} ${className ?? ''}`.trim()} data-typing={typing ? 'true' : undefined}>
      <div className={css.field} role="textbox" aria-label={label} aria-readonly="true" aria-multiline="true">
        {value === '' ? <span className={css.placeholder}>{placeholder}</span> : value}
        {value !== '' && typing ? <span className={css.caret} aria-hidden="true" data-caret /> : null}
      </div>
      <Button variant="primary" type="button" disabled={value === ''}>{sendLabel}</Button>
    </div>
  )
}
