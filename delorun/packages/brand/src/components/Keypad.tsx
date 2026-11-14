/**
 * A round digit keypad of real buttons, each 72px, so a phone can enter a PIN without its own keyboard.
 * @module @delorun/brand/components/Keypad
 */
import css from './Keypad.module.css'

/** The keys in reading order; the empty entry is the blank cell beside 0. */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const

/** The props of {@link Keypad}. */
export interface KeypadProps {
  /** Called with a digit, or `⌫` for delete. */
  readonly onKey: (key: string) => void
  /** The localized accessible name of the delete key. */
  readonly deleteLabel: string
  readonly disabled?: boolean
}

/**
 * Render the keypad.
 * @param props - see {@link KeypadProps}.
 * @returns the keypad.
 */
export function Keypad({ onKey, deleteLabel, disabled = false }: KeypadProps) {
  return (
    <div className={css.keypad}>
      {KEYS.map((key, index) => key === ''
        ? <span key={index} />
        : <button key={key} type="button" className={key === '⌫' ? `${css.key} ${css.erase}` : css.key} disabled={disabled} aria-label={key === '⌫' ? deleteLabel : key} onClick={() => { onKey(key) }}>{key}</button>)}
    </div>
  )
}
