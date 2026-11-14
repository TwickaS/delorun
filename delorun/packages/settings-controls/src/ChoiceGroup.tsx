/**
 * A few exclusive choices as one row of segments, drawn as upstream's segmented
 * control and exposed as a radio group: the choices are options of one setting,
 * not tabs of panels.
 * @module @delorun/settings-controls/ChoiceGroup
 */
import type { CSSProperties, KeyboardEvent } from 'react'
import css from './ChoiceGroup.module.css'

/** One choice of a {@link ChoiceGroup}. */
export interface Choice<Value extends string> {
  /** The value the owner receives when the choice is made. */
  readonly value: Value
  /** The localized text of the segment. */
  readonly label: string
}

/** The props of {@link ChoiceGroup}. */
export interface ChoiceGroupProps<Value extends string> {
  /** The localized accessible name of the group. */
  readonly label: string
  /** The chosen value; the group is controlled. */
  readonly value: Value
  /** The choices in display order. */
  readonly options: readonly Choice<Value>[]
  /** Called with the value a click or an arrow key chooses, never with the chosen one. */
  readonly onChange: (next: Value) => void
  /** Whether every segment refuses a choice. */
  readonly disabled: boolean
}

/** Index offsets of the keys that move the choice, wrapping at the ends. */
const STEP: Readonly<Record<string, 1 | -1>> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }

/**
 * Render the radio group.
 * @param props - see {@link ChoiceGroupProps}.
 * @returns the group; the chosen segment is the one tab stop, and an arrow key moves the focus and the choice.
 */
export function ChoiceGroup<Value extends string>({ label, value, options, onChange, disabled }: ChoiceGroupProps<Value>) {
  const chosen = options.findIndex(option => option.value === value)
  const choose = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const step = STEP[event.key]
    if (step === undefined) return
    event.preventDefault()
    const next = (index + step + options.length) % options.length
    // The radios are the group's children, and `next` indexes them as it indexes the options.
    const radios = (event.currentTarget.parentElement as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')
    const radio = radios[next] as HTMLButtonElement
    radio.focus()
    const target = options[next] as Choice<Value>
    if (target.value !== value) onChange(target.value)
  }
  const track = { '--choice-count': String(options.length), '--choice-index': String(chosen) } as CSSProperties
  return (
    <div role="radiogroup" aria-label={label} className={css.group} style={track}>
      <span aria-hidden="true" className={css.indicator} />
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={index === chosen}
          tabIndex={index === chosen ? 0 : -1}
          disabled={disabled}
          className={css.segment}
          onClick={() => { if (index !== chosen) onChange(option.value) }}
          onKeyDown={(event) => { choose(event, index) }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
