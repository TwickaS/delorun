/**
 * Exclusive choices that need a picture, as a radio group of preview tiles:
 * each tile draws its preview above its label and a radio mark.
 * @module @delorun/settings-controls/TileGroup
 */
import type { ReactNode } from 'react'
import css from './TileGroup.module.css'

/** One tile of a {@link TileGroup}. */
export interface Tile<Value extends string> {
  /** The value the owner receives when the tile is chosen. */
  readonly value: Value
  /** The localized label under the preview. */
  readonly label: string
  /** The preview; the tile hides it from assistive technology. */
  readonly preview: ReactNode
}

/** The props of {@link TileGroup}. */
export interface TileGroupProps<Value extends string> {
  /** The id of the element that names the group. */
  readonly labelledBy: string
  /** The class that lays the tiles out. */
  readonly className: string | undefined
  /** The chosen value. */
  readonly value: Value
  /** The tiles in display order. */
  readonly tiles: readonly Tile<Value>[]
  /** Whether every tile refuses a choice. */
  readonly disabled: boolean
  /** Called with the value of a tile that is not the chosen one. */
  readonly onChange: (next: Value) => void
}

/**
 * Render the radio group.
 * @param props - see {@link TileGroupProps}.
 * @returns the group.
 */
export function TileGroup<Value extends string>({ labelledBy, className, value, tiles, disabled, onChange }: TileGroupProps<Value>) {
  return (
    <div className={className === undefined ? css.tiles : `${css.tiles} ${className}`} role="radiogroup" aria-labelledby={labelledBy}>
      {tiles.map(tile => (
        <button key={tile.value} type="button" role="radio" aria-checked={tile.value === value} className={css.tile} disabled={disabled}
          onClick={() => { if (tile.value !== value) onChange(tile.value) }}>
          <span className={css.preview} aria-hidden="true">{tile.preview}</span>
          <span className={css.foot}>
            <span className={css.label}>{tile.label}</span>
            <span className={css.radio} aria-hidden="true" />
          </span>
        </button>
      ))}
    </div>
  )
}
