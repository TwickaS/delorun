/**
 * A labelled text field: upstream's `Input` with a visible label, a help line and an error line wired to it. The error
 * is announced when it appears.
 * @module @delorun/brand/components/TextField
 */
import { forwardRef, useId, type InputHTMLAttributes } from 'react'
import { Input } from '#upstream'
import css from './TextField.module.css'

/** The props of {@link TextField}: a native input's, plus the label, the help and the error. */
export type TextFieldProps = {
  /** The localized label, always visible. */
  readonly label: string
  /** One short localized sentence under the field. */
  readonly help?: string | undefined
  /** A localized error; when set, the field is invalid and the sentence replaces the help. */
  readonly error?: string | undefined
} & Omit<InputHTMLAttributes<HTMLInputElement>, 'id'>

/**
 * Render a labelled field.
 * @param props - see {@link TextFieldProps}.
 * @param ref - the native input.
 * @returns the field.
 */
export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField({ label, help, error, className, ...rest }, ref) {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? help
  return (
    <div className={`${css.field} ${className ?? ''}`.trim()}>
      <label htmlFor={id} className={css.label}>{label}</label>
      <Input ref={ref} id={id} aria-invalid={error === undefined ? undefined : true} aria-describedby={note === undefined ? undefined : noteId} {...rest} />
      {note === undefined ? null : <p id={noteId} className={error === undefined ? css.help : css.error} role={error === undefined ? undefined : 'alert'}>{note}</p>}
    </div>
  )
})
