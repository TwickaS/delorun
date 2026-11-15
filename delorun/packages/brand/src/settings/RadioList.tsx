/**
 * Exclusive choices that are whole lines of text, as a vertical radio list: each row is a radio mark and its label, and
 * the last row may carry a field that belongs to that choice.
 * @module @delorun/settings-controls/RadioList
 */
import type { KeyboardEvent, ReactNode } from 'react'
import css from './RadioList.module.css'

/** One row of a {@link RadioList}. */
export interface RadioRow<Value extends string> {
  /** The value passed to `onChange`. */
  readonly value: Value
  /** The localized text of the row. */
  readonly label: string
  /** Content shown under the row's label while the row is chosen, such as the field for an own line. */
  readonly detail?: ReactNode
}

/** The props of {@link RadioList}. */
export interface RadioListProps<Value extends string> {
  /** The localized accessible name of the list. */
  readonly label: string
  /** The chosen value; the list is controlled. */
  readonly value: Value
  /** The rows in display order. */
  readonly rows: readonly RadioRow<Value>[]
  /** Called with the row a click or an arrow key chooses, never with the chosen one. */
  readonly onChange: (next: Value) => void
  /** Whether every row refuses a choice. */
  readonly disabled: boolean
}

/** Index offsets of the keys that move the choice, wrapping at the ends. */
const STEP: Readonly<Record<string, 1 | -1>> = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }

/**
 * Render the radio list.
 * @param props - see {@link RadioListProps}.
 * @returns the list; the chosen row is the one tab stop, and an arrow key moves the focus and the choice.
 */
export function RadioList<Value extends string>({ label, value, rows, onChange, disabled }: RadioListProps<Value>) {
  const chosen = rows.findIndex(row => row.value === value)
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = STEP[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = (index + step + rows.length) % rows.length
    const radios = (event.currentTarget.closest('[role="radiogroup"]') as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')
    ;(radios[next] as HTMLButtonElement).focus()
    const target = rows[next] as RadioRow<Value>
    if (target.value !== value) onChange(target.value)
  }
  return (
    <div role="radiogroup" aria-label={label} className={css.list}>
      {rows.map((row, index) => (
        <div key={row.value} className={css.item}>
          <button type="button" role="radio" aria-checked={index === chosen} tabIndex={index === chosen || (chosen < 0 && index === 0) ? 0 : -1}
            disabled={disabled} className={css.row} onClick={() => { if (index !== chosen) onChange(row.value) }} onKeyDown={(event) => { move(event, index) }}>
            <span className={css.radio} aria-hidden="true" />
            <span className={css.text}>{row.label}</span>
          </button>
          {index === chosen && row.detail !== undefined && <div className={css.detail}>{row.detail}</div>}
        </div>
      ))}
    </div>
  )
}
