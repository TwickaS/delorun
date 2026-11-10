/**
 * T3 Code's six themes as Delo palettes. Each palette's seeds are read from
 * the colours in `t3-themes.ts` (T3 Code, MIT, © 2026 T3 Tools Inc.): the
 * tint of its greys, the lightness of its light page and sidebar, and its
 * accent in both schemes. The rest of each scheme is generated from these
 * seeds as the Soft palette is, so every upstream token follows and the
 * quiet-text floors hold.
 * @module @delo/plugin-theme/palette/t3
 */
import { toOklch, type Oklch } from './color.ts'
import { parseHex, SOFT, type AccentSpec, type PaletteSpec } from './soft.ts'
import { T3_THEMES } from './t3-themes.ts'

/** A T3 Code theme's id. */
export type T3ThemeId = keyof typeof T3_THEMES

/** The themes in T3 Code's order. */
export const T3_THEME_IDS = Object.keys(T3_THEMES) as readonly T3ThemeId[]

/** The light-scheme colour role each theme's grey tint is read from; every other theme reads its sidebar. */
const NEUTRAL_ROLE: Readonly<Partial<Record<T3ThemeId, string>>> = {
  // T3 Code's own sidebar is a flat grey; its zinc tint is in its quiet text.
  't3-code': 'textMuted',
}

const OKLCH_COLOR = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/

/**
 * Read one of T3 Code's colours.
 * @param value - `#RRGGBB` or `oklch(L C H)`, the two forms its themes use.
 * @returns the colour in OKLCH.
 * @throws Error when the value is in neither form.
 */
function oklchOf(value: string): Oklch {
  const hex = parseHex(value)
  if (hex !== undefined) return toOklch(hex)
  const match = OKLCH_COLOR.exec(value)
  if (match === null) throw new Error(`T3 Code colour ${value} is neither #RRGGBB nor oklch(L C H)`)
  return { l: Number(match[1]), c: Number(match[2]), h: Number(match[3]), alpha: 1 }
}

/** One scheme's colour of a theme, by T3 Code's role name. */
function role(id: T3ThemeId, scheme: 'light' | 'dark', name: string): Oklch {
  const value = (T3_THEMES[id][scheme] as Readonly<Record<string, string>>)[name]
  if (value === undefined) throw new Error(`T3 Code theme ${id} has no ${scheme} ${name} colour`)
  return oklchOf(value)
}

/** A T3 Code theme as a palette with its own accent. */
export interface T3Palette {
  /** Its greys, page and sidebar, with Soft's quiet-text floors and state roles. */
  readonly palette: PaletteSpec
  /** Its accent. */
  readonly accent: AccentSpec
}

/**
 * A T3 Code theme's palette: its greys, page and sidebar, with Soft's quiet-text floors and state roles.
 * @param id - the theme.
 * @returns the palette and its accent.
 */
export function t3Palette(id: T3ThemeId): T3Palette {
  const tint = role(id, 'light', NEUTRAL_ROLE[id] ?? 'sidebar')
  const accent = role(id, 'light', 'accent')
  return {
    palette: {
      neutral: { hue: tint.h, chroma: tint.c },
      lightSurfaces: { '--dsw-alias-bg-base': role(id, 'light', 'canvas').l, '--dsw-specific-sidebar-fill': role(id, 'light', 'sidebar').l },
      quietText: SOFT.quietText,
      states: SOFT.states,
    },
    accent: { hue: accent.h, chroma: accent.c, fill: { light: accent.l, dark: role(id, 'dark', 'accent').l } },
  }
}
