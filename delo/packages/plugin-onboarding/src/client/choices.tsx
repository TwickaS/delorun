/**
 * The guide's chip groups: a labelled set of chips as one radio group, and a palette's light and dark swatch.
 */
import { useId } from 'react'
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react'
import type { SchemeColours } from './previews.ts'
import css from './Onboarding.module.css'

/** One choice of a set of chips. */
export interface ChipOption {
  /** Unique within the set. */
  readonly key: string
  /** Whether it is the chosen one. */
  readonly checked: boolean
  /** Whether it cannot be chosen now. */
  readonly disabled?: boolean
  /** Choose it. */
  readonly onSelect: () => void
  /** What the chip shows; its text is its name. */
  readonly content: ReactNode
}

/** How each key moves within a radio group: a step forward or back, wrapping, or to the first or last choice. */
const RADIO_KEYS: Readonly<Record<string, -1 | 1 | 'first' | 'last'>> = {
  ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: 'first', End: 'last',
}

/**
 * A labelled set of chips as one radio group: one tab stop, on the chosen chip or else the first that can be chosen,
 * and the arrow keys, Home and End move to a chip and choose it, skipping chips that cannot be chosen. A group whose
 * choice has a large effect, such as leaving Delo's look, is `manual`: the keys only move focus, and Space or Enter
 * chooses.
 * @param props - the group's label, its choices and whether moving focus leaves the choice alone.
 * @returns the group.
 */
export function Choices({ label, options, manual = false }: { readonly label: string; readonly options: readonly ChipOption[]; readonly manual?: boolean }): ReactNode {
  const id = useId()
  const enabled = options.filter(option => option.disabled !== true)
  const stop = enabled.find(option => option.checked) ?? enabled[0]
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const move = RADIO_KEYS[event.key]
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
      <span id={id} className={css.label}>{label}</span>
      <div className={css.chips} role="radiogroup" aria-labelledby={id} onKeyDown={onKeyDown}>
        {options.map(option => (
          <button key={option.key} type="button" role="radio" aria-checked={option.checked} disabled={option.disabled}
            tabIndex={option === stop ? 0 : -1} className={css.chip} onClick={option.onSelect}>
            {option.content}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A palette's two schemes side by side, each with a line in its text colour and a dot in its accent. */
export function PaletteSwatch({ light, dark }: { readonly light: SchemeColours; readonly dark: SchemeColours }): ReactNode {
  const half = (colours: SchemeColours): CSSProperties => (
    { '--half-page': colours.page, '--half-text': colours.text, '--half-accent': colours.accent } as CSSProperties
  )
  return (
    <span className={css.swatch} aria-hidden="true">
      <span className={css.half} style={half(light)}><span className={css.line} /><span className={css.dot} /></span>
      <span className={css.half} style={half(dark)}><span className={css.line} /><span className={css.dot} /></span>
    </span>
  )
}
