/**
 * The Look model: a preset palette fixes its own accent and colours, and only the `custom` palette reads the accent and
 * the contrast. Settings stored before that split could hold a preset beside a changed accent or contrast; {@link lookOf}
 * reads them as the custom theme they drew, and `customSeed`, defined in `settings.ts`, gives the values a person starts
 * the custom theme from.
 * @module @delorun/plugin-theme/palette/migrate
 */
import { CONTRAST, DEFAULT_CUSTOM_ACCENT } from '../config.ts'
import { PRESET_ACCENT_HEX, type ThemeSettings } from '../settings.ts'

export { customSeed, type CustomValues } from '../settings.ts'

/**
 * Read stored settings as the Look model: a preset beside a changed accent or contrast becomes the custom theme seeded
 * from that preset. A T3 Code preset keeps only its accent colour in the custom theme, because the custom theme's
 * surfaces are Soft's.
 * @param settings - the stored settings.
 * @returns the settings with a palette that matches what they hold; the same object when nothing changes.
 */
export function lookOf(settings: ThemeSettings): ThemeSettings {
  if (settings.palette === 'custom') return settings
  const changedContrast = settings.contrast !== CONTRAST.default
  if (settings.palette === 'soft') {
    if (settings.accent === 'peach' && !changedContrast) return settings
    return { ...settings, palette: 'custom' }
  }
  if (!changedContrast) return settings
  return { ...settings, palette: 'custom', accent: 'custom', customAccent: PRESET_ACCENT_HEX[settings.palette] }
}

/** The custom colour a fresh custom theme shows before any pick. */
export const FALLBACK_CUSTOM_ACCENT = DEFAULT_CUSTOM_ACCENT
