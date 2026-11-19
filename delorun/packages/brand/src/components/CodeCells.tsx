/**
 * A PIN or one-time code as large cells over one real input. The input takes the typing, paste, autofill, selection and
 * screen-reader focus; the cells only draw its value, so backspace, arrow keys and a pasted code behave as in any field.
 * The cells share the container's width, so the entry fills a phone screen and a wide dialog alike.
 * @module @delorun/brand/components/CodeCells
 */
import { useId, useRef, useState } from 'react'
import type { ChangeEvent, CSSProperties, SyntheticEvent } from 'react'
import css from './CodeCells.module.css'

/** The most characters an open-ended entry takes. */
const OPEN_ENDED_MAX = 128

/** The props of {@link CodeCells}. */
export interface CodeCellsProps {
  /** The localized accessible name of the input; it is also the visible label when `showLabel` is set. */
  readonly label: string
  /** Whether the label is drawn above the cells; otherwise it is only the accessible name. */
  readonly showLabel?: boolean
  /** The entered characters. */
  readonly value: string
  /** Called with the new value, already reduced to digits when `digitsOnly` is set. */
  readonly onChange: (next: string) => void
  /** The cells always shown: the code's length, or the fewest digits of a PIN. */
  readonly length: number
  /** Whether more characters than `length` are accepted, as a PIN of any length is; otherwise `length` is the maximum. */
  readonly open?: boolean
  /** Called once when a fixed-length entry reaches `length` characters. */
  readonly onComplete?: (value: string) => void
  /** Whether filled cells show a dot instead of the character, as a PIN does. */
  readonly mask?: boolean
  /** Whether only digits are accepted; the default. */
  readonly digitsOnly?: boolean
  /** Whether the last answer was wrong; the cells turn to the error colour. */
  readonly error?: boolean
  /** Whether the cells shake; defaults to `error`. A caller that knows the person asked for less motion passes false. */
  readonly shake?: boolean
  /** A value that changes with each wrong answer, so the cells shake again; reduced motion removes the movement. */
  readonly shakeKey?: unknown
  readonly disabled?: boolean
  /** The `autocomplete` token; `one-time-code` lets the phone offer a code it received. */
  readonly autoComplete?: 'one-time-code' | 'new-password' | 'current-password' | 'off'
  readonly autoFocus?: boolean
  readonly name?: string
  /** The id of the element that describes the entry, such as a hint or an error message. */
  readonly describedBy?: string
  /** The attribute for a test or a script to find the input. */
  readonly inputProps?: Readonly<Record<`data-${string}`, string | boolean | undefined>>
}

/**
 * Render the entry.
 * @param props - see {@link CodeCellsProps}.
 * @returns the label, the cells and the input.
 */
export function CodeCells({
  label, showLabel = false, value, onChange, length, open = false, onComplete, mask = false, digitsOnly = true, error = false, shake = error, shakeKey,
  disabled = false, autoComplete = 'off', autoFocus = false, name, describedBy, inputProps,
}: CodeCellsProps) {
  const id = useId()
  const ref = useRef<HTMLInputElement>(null)
  const [focused, setFocused] = useState(false)
  const [selection, setSelection] = useState<readonly [number, number]>([0, 0])
  const characters = [...value]
  const cells = open ? Math.max(length, characters.length) : length
  const readSelection = (event: SyntheticEvent<HTMLInputElement>): void => {
    const { selectionStart, selectionEnd } = event.currentTarget
    setSelection([selectionStart ?? 0, selectionEnd ?? 0])
  }
  const change = (event: ChangeEvent<HTMLInputElement>): void => {
    const typed = digitsOnly ? event.target.value.replace(/\D/gu, '') : event.target.value
    const next = open ? typed.slice(0, OPEN_ENDED_MAX) : typed.slice(0, length)
    onChange(next)
    readSelection(event)
    if (!open && next.length === length && value.length !== length) onComplete?.(next)
  }
  const [from, to] = selection
  const caret = Math.min(from, characters.length)
  return (
    <div className={css.root} data-error={error ? '' : undefined} data-disabled={disabled ? '' : undefined}>
      {showLabel ? <label htmlFor={id} className={css.label}>{label}</label> : null}
      <div className={css.group} style={{ '--cells': cells } as CSSProperties}>
        <div key={String(shakeKey)} className={css.cells} aria-hidden="true" data-cells={characters.length} data-shake={shake ? '' : undefined}>
          {Array.from({ length: cells }, (_, index) => {
            const filled = index < characters.length
            const selected = filled && focused && from !== to && index >= from && index < to
            return (
              <span key={index} className={css.cell} data-filled={filled ? '' : undefined} data-active={focused && from === to && index === caret ? '' : undefined}
                data-selected={selected ? '' : undefined}>
                {filled ? (mask ? <span className={css.dot} /> : characters[index]) : null}
              </span>
            )
          })}
        </div>
        <input ref={ref} id={id} className={css.input} name={name} type={mask ? 'password' : 'text'} inputMode={digitsOnly ? 'numeric' : 'text'}
          pattern={digitsOnly ? '[0-9]*' : undefined} autoComplete={autoComplete} autoCorrect="off" autoCapitalize="off" spellCheck={false}
          autoFocus={autoFocus} enterKeyHint="go" disabled={disabled} aria-label={showLabel ? undefined : label} aria-invalid={error ? true : undefined}
          aria-describedby={describedBy} maxLength={open ? OPEN_ENDED_MAX : length} value={value}
          onChange={change} onSelect={readSelection} onKeyUp={readSelection} onFocus={(event) => { setFocused(true); readSelection(event) }}
          onBlur={() => { setFocused(false) }} {...inputProps} />
      </div>
    </div>
  )
}
