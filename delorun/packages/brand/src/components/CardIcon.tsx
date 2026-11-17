/**
 * The icon of a card, list row or sidebar item that has no artwork: a square tinted with one colour of a small fixed
 * palette and the first letter of the name. The colour comes from a stable hash of the name, so an agent, a plugin or a
 * workspace keeps its tint wherever it is listed.
 * @module @delorun/brand/components/CardIcon
 */
import type { CSSProperties } from 'react'
import '../badge-colors.css'
import css from './CardIcon.module.css'

/** The tints, in palette order: names of the `--delorun-badge-*` colours, which are readable in light and dark. */
export const CARD_ICON_TINTS = ['blue', 'green', 'amber', 'violet', 'red', 'pink', 'teal', 'slate'] as const

/** One of {@link CARD_ICON_TINTS}. */
export type CardIconTint = typeof CARD_ICON_TINTS[number]

/**
 * @param name - the name of the thing the icon stands for.
 * @returns the name's first letter or digit in upper case, or `·` for a name without one.
 */
export function cardIconLetter(name: string): string {
  return name.match(/[\p{L}\p{N}]/u)?.[0]?.toLocaleUpperCase() ?? '·'
}

/**
 * @param name - the name of the thing the icon stands for.
 * @returns the same tint for the same name, spread over {@link CARD_ICON_TINTS} by an FNV-1a hash of the lower-cased name.
 */
export function cardIconTint(name: string): CardIconTint {
  let hash = 0x811c9dc5
  for (const char of name.trim().toLocaleLowerCase()) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 0x01000193) >>> 0
  }
  hash = Math.imul(hash ^ (hash >>> 15), 0x2c1b3c6d) >>> 0
  hash = (hash ^ (hash >>> 13)) >>> 0
  return CARD_ICON_TINTS[hash % CARD_ICON_TINTS.length] ?? 'slate'
}

/** The props of {@link CardIcon}. */
export interface CardIconProps {
  /** The name the letter and the tint come from. */
  readonly name: string
  /** The letter to show instead of the name's first one. */
  readonly letter?: string | undefined
  /** The side of the square in pixels; 32 by default. */
  readonly size?: number | undefined
  readonly className?: string | undefined
}

/**
 * Render the tinted monogram. It is hidden from assistive technology because the name beside it says the same.
 * @param props - see {@link CardIconProps}.
 * @returns the square.
 */
export function CardIcon({ name, letter, size = 32, className }: CardIconProps) {
  const style = { '--card-icon-color': `var(--delorun-badge-${cardIconTint(name)})`, '--card-icon-size': `${String(size)}px` } as CSSProperties
  return (
    <span className={`${css.icon} ${className ?? ''}`.trim()} style={style} data-tint={cardIconTint(name)} aria-hidden="true">
      {letter ?? cardIconLetter(name)}
    </span>
  )
}
