/**
 * The chip radio group every appearance choice shares (theme, accent, studio look, colour scheme): one chip style, one
 * selected state, 44px touch targets and radio-group keyboard behaviour. The chips take their text and decoration as
 * props, so the group runs in Settings and in onboarding without either one's dictionaries.
 * @module @delorun/plugin-theme/client/controls/ChipGroup
 */
import { useId } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import css from './controls.module.css'

/** One chip of a {@link ChipGroup}. */
export interface ChipOption<Value extends string> {
  /** Unique within the group; passed to `onChange`. */
  readonly value: Value
  /** The chip's name for assistive technology and its text. */
  readonly label: string
  /** Decoration before the text, hidden from assistive technology. */
  readonly mark?: ReactNode
}

/** The props of {@link ChipGroup}. */
export interface ChipGroupProps<Value extends string> {
  /** The group's visible heading. */
  readonly label: string
  /** The chosen value. */
  readonly value: Value
  /** The chips in display order. */
  readonly options: readonly ChipOption<Value>[]
  /** Called with a chip that is not the chosen one, by click, Space, Enter or (unless `manual`) an arrow key. */
  readonly onChange: (next: Value) => void
  /** Whether every chip refuses a choice. */
  readonly disabled?: boolean
  /** Whether the arrow keys only move focus and Space or Enter chooses; for a choice with a large effect. */
  readonly manual?: boolean
  /** Whether the heading is hidden visually but still names the group. */
  readonly hideLabel?: boolean
}

/** How each key moves within the group: a step, wrapping, or to the first or last chip. */
const MOVES: Readonly<Record<string, -1 | 1 | 'first' | 'last'>> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last',
}

/**
 * Render the group: one tab stop on the chosen chip, and the arrow keys, Home and End move to a chip and choose it.
 * @param props - see {@link ChipGroupProps}.
 * @returns the labelled radio group.
 */
export function ChipGroup<Value extends string>({ label, value, options, onChange, disabled = false, manual = false, hideLabel = false }: ChipGroupProps<Value>) {
  const id = useId()
  const stop = options.find(option => option.value === value) ?? options[0]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = MOVES[event.key]
    if (move === undefined) return
    const radios = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')]
    const from = radios.indexOf(event.target as HTMLButtonElement)
    if (from < 0) return
    event.preventDefault()
    const to = move === 'first' ? 0 : move === 'last' ? radios.length - 1 : (from + move + radios.length) % radios.length
    const radio = radios[to] as HTMLButtonElement
    radio.focus()
    if (!manual && radio.getAttribute('aria-checked') !== 'true') radio.click()
  }
  return (
    <div className={css.field}>
      <span id={id} className={hideLabel ? css.srOnly : css.label}>{label}</span>
      <div className={css.chips} role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map(option => (
          <button key={option.value} type="button" role="radio" aria-checked={option.value === value} disabled={disabled}
            tabIndex={option === stop ? 0 : -1}
            className={css.chip} onClick={() => { if (option.value !== value) onChange(option.value) }}>
            {option.mark === undefined ? null : <span className={css.mark} aria-hidden="true">{option.mark}</span>}
            {option.label}
          </button>
        ))}
      </div>
    </div>
  )
}
