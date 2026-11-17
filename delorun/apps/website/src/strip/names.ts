/**
 * The names the strip gives a look: the studio's own words for themes, accents and densities, from the Theme plugin's
 * Appearance dictionary.
 *
 * @module website/strip/names
 */
import type { Look } from '@design/looks.ts'
import { en as studio } from '../../../../packages/plugin-theme/src/client/locales.ts'
import { STRIP_COPY } from './copy.ts'
import { STOP_CONTRAST } from './model.ts'

/**
 * The name of a look's theme, with the accent for the custom theme.
 * @param look - the look.
 * @returns the name, such as "Ocean" or "Custom moss".
 */
export function themeName(look: Look): string {
  if (look.look !== 'custom') return studio[`palette.${look.look}`]
  return STRIP_COPY.customName(studio['palette.custom'], studio[`accent.${look.accent}`])
}

/**
 * The name of what sets one look apart from another: its theme, else its contrast, else its density.
 * @param look - the look to name.
 * @param other - the look it is set apart from.
 * @returns the name, such as "Soft", "contrast 100%" or "comfortable density".
 */
export function differenceName(look: Look, other: Look): string {
  if (look.look !== other.look || look.accent !== other.accent && look.look === 'custom') return themeName(look)
  if (look.look === 'custom' && look.contrast !== other.contrast) return STRIP_COPY.contrastName(STOP_CONTRAST[look.contrast])
  if (look.density !== other.density) return STRIP_COPY.densityName(studio[`density.${look.density}`])
  return themeName(look)
}
