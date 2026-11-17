/**
 * The names the strip gives a look: the studio's own words for themes, accents and densities, from the Theme plugin's
 * Appearance dictionary.
 *
 * @module website/strip/names
 */
import { KNOWN_LOOKS, type Look } from '@design/looks.ts'
import { en as studio } from '../../../../packages/plugin-theme/src/client/locales.ts'
import { STRIP_COPY } from './copy.ts'
import { STOP_CONTRAST, storedPalette, type EntryConfig } from './model.ts'

const copy = STRIP_COPY.en

/**
 * The name of a look's theme, with the accent for the custom theme.
 * @param look - the look.
 * @returns the name, such as "Ocean" or "Custom moss".
 */
export function themeName(look: Look): string {
  if (look.look !== 'custom') return studio[`palette.${look.look}`]
  return copy.customName(studio['palette.custom'], studio[`accent.${look.accent}`])
}

/**
 * The name of what sets one look apart from another: its theme, else its contrast, else its density.
 * @param look - the look to name.
 * @param other - the look it is set apart from.
 * @returns the name, such as "Soft", "contrast 100%" or "comfortable density".
 */
export function differenceName(look: Look, other: Look): string {
  if (look.look !== other.look || look.accent !== other.accent && look.look === 'custom') return themeName(look)
  if (look.look === 'custom' && look.contrast !== other.contrast) return copy.contrastName(STOP_CONTRAST[look.contrast])
  if (look.density !== other.density) return copy.densityName(studio[`density.${look.density}`])
  return themeName(look)
}

/**
 * The line that says an entry stores its theme under an id other than the theme's name, so the entry and the marked tile
 * read as one choice.
 * @param entry - the entry's config.
 * @returns the line, such as "Berry is written as t3-chat in the file.", or undefined when the id is the name or no theme is stored.
 */
export function storedAsLine(entry: EntryConfig): string | undefined {
  const id = storedPalette(entry)
  const look = KNOWN_LOOKS.find(each => each === id)
  if (look === undefined) return undefined
  const name = studio[`palette.${look}`]
  return name.toLowerCase() === look ? undefined : copy.storedAs(name, look)
}
