/**
 * The Toast position control: a small screen-shaped rectangle in six clickable zones, the four corners and the top and
 * bottom centre. A click, Enter or Space on a zone chooses it, and the chosen zone shows a toast bar in its place. The
 * zones are one radio group: Tab reaches the chosen zone, and the arrow keys move between the zones, wrapping in the
 * grid's two rows and three columns.
 * @module @delorun/plugin-theme/client/ToastPositionPicker
 */
import { useRef, type KeyboardEvent } from 'react'
import { TOAST_POSITIONS, type ToastPosition } from '../config.ts'
import css from './ToastPositionPicker.module.css'

/** The columns of the zone grid. */
const COLUMNS = 3

/** The props of {@link ToastPositionPicker}. */
export interface ToastPositionPickerProps {
  /** The chosen position. */
  readonly value: ToastPosition
  /** The localised name of the group. */
  readonly label: string
  /** The localised name of each zone, for screen readers and the hover title. */
  readonly names: Readonly<Record<ToastPosition, string>>
  /** Whether a write is in flight or the settings have not loaded. */
  readonly disabled: boolean
  /** Called with the zone the person chose. */
  readonly onChange: (position: ToastPosition) => void
}

/**
 * The zone an arrow key moves to; the zones wrap in their row and column.
 * @param index - the focused zone.
 * @param key - the arrow key.
 * @returns the target index, or `undefined` for any other key.
 */
export function arrowTarget(index: number, key: string): number | undefined {
  const rows = TOAST_POSITIONS.length / COLUMNS
  const row = Math.floor(index / COLUMNS)
  const column = index % COLUMNS
  switch (key) {
    case 'ArrowLeft': return row * COLUMNS + (column + COLUMNS - 1) % COLUMNS
    case 'ArrowRight': return row * COLUMNS + (column + 1) % COLUMNS
    case 'ArrowUp': return ((row + rows - 1) % rows) * COLUMNS + column
    case 'ArrowDown': return ((row + 1) % rows) * COLUMNS + column
    default: return undefined
  }
}

/**
 * Render the control.
 * @param props - see {@link ToastPositionPickerProps}.
 * @returns the zones in a screen-shaped rectangle.
 */
export function ToastPositionPicker({ value, label, names, disabled, onChange }: ToastPositionPickerProps) {
  const zones = useRef<(HTMLButtonElement | null)[]>([])
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    const target = arrowTarget(index, event.key)
    if (target === undefined) return
    event.preventDefault()
    zones.current[target]?.focus()
  }
  return (
    <div className={css.screen} role="radiogroup" aria-label={label}>
      {TOAST_POSITIONS.map((position, index) => {
        const chosen = position === value
        return (
          <button key={position} ref={(node) => { zones.current[index] = node }} type="button" role="radio" aria-checked={chosen}
            aria-label={names[position]} title={names[position]} disabled={disabled} tabIndex={chosen ? 0 : -1}
            className={css.zone} data-position={position} data-chosen={chosen ? '' : undefined}
            onKeyDown={(event) => { onKeyDown(event, index) }} onFocus={() => { if (!chosen) zones.current[index]?.scrollIntoView?.({ block: 'nearest' }) }}
            onClick={() => { if (!chosen) onChange(position) }}>
            <span className={css.bar} aria-hidden="true" />
          </button>
        )
      })}
    </div>
  )
}
