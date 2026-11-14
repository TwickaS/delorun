/**
 * The theme settings the host half prints into each page while Delorun's look is on, as the page global
 * {@link BOOT_SETTINGS_GLOBAL}, so the studio half applies the look, and provides `ctx.delorunStudio`, while the studio
 * boots instead of once the settings form answers. Without them the stock sidebar and texts show until that answer.
 * @module @delorun/plugin-theme/boot-settings
 */
import { ACCENT_CHOICES, CONTRAST, DENSITIES, EFFORT_DISPLAYS, PALETTES, TYPEFACES, type ThemeSettings } from './config.ts'

/** The `globalThis` property holding the settings the Host held when it served the page. */
export const BOOT_SETTINGS_GLOBAL = 'delorunThemeSettings'

/**
 * Whether a value is one of a fixed list of choices.
 * @param choices - the list.
 * @param value - the value.
 * @returns true when the list holds it.
 */
function oneOf<T extends string>(choices: readonly T[], value: unknown): value is T {
  return (choices as readonly unknown[]).includes(value)
}

/**
 * Validate printed settings: each field present with a value the host half's configuration accepts. The custom accent
 * is any string, because a colour that does not parse already falls back to Peach where the accent is drawn.
 * @param value - the printed value.
 * @returns the settings, or `undefined` when a field is missing or out of range.
 */
export function parseBootSettings(value: unknown): ThemeSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { accent, customAccent, typeface, density, studioAdditions, palette, contrast, effort } = value as Record<keyof ThemeSettings, unknown>
  if (!oneOf(ACCENT_CHOICES, accent) || typeof customAccent !== 'string' || !oneOf(TYPEFACES, typeface) || !oneOf(DENSITIES, density)) return undefined
  if (typeof studioAdditions !== 'boolean' || !oneOf(PALETTES, palette) || !oneOf(EFFORT_DISPLAYS, effort)) return undefined
  if (typeof contrast !== 'number' || !(contrast >= CONTRAST.min && contrast <= CONTRAST.max)) return undefined
  return { accent, customAccent, typeface, density, studioAdditions, palette, contrast, effort }
}

/**
 * Read the settings the host half printed into this page.
 * @param scope - the object holding the page global; `globalThis` by default.
 * @returns the settings; `undefined` when the page carries none, or, with a warning, carries a value that does not validate.
 */
export function readBootSettings(scope: object = globalThis): ThemeSettings | undefined {
  const value: unknown = Reflect.get(scope, BOOT_SETTINGS_GLOBAL)
  if (value === undefined) return undefined
  const settings = parseBootSettings(value)
  if (settings === undefined) console.warn(`delorun theme: the page's ${BOOT_SETTINGS_GLOBAL} is not valid theme settings, so the look waits for the settings form`)
  return settings
}
