/**
 * The Look model: a preset palette fixes its own accent and colours, and only the `custom` palette reads the accent and
 * the contrast. Settings stored before that split could hold a preset beside a changed accent or contrast; {@link lookOf}
 * reads them as the custom theme they drew, and {@link customSeed} gives the values a person starts the custom theme from.
 * @module @delorun/plugin-theme/palette/migrate
 */
import { CONTRAST, DEFAULT_CUSTOM_ACCENT, type ThemeSettings } from '../config.ts'
import { fromOklch } from './color.ts'
import { t3Palette, type T3ThemeId } from './t3.ts'

/** The values the custom theme holds; the rest of the settings belong to no palette. */
export type CustomValues = Pick<ThemeSettings, 'accent' | 'customAccent' | 'contrast'>

/**
 * A T3 Code theme's accent as `#RRGGBB` in the light scheme.
 * @param id - the theme.
 * @returns the colour.
 */
function t3AccentHex(id: T3ThemeId): string {
  const accent = t3Palette(id).accent
  const rgb = fromOklch({ l: accent.fill.light, c: accent.chroma, h: accent.hue, alpha: 1 })
  const channel = (value: number): string => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`.toUpperCase()
}

/**
 * The values to start the custom theme from, taken from the preset the person had last.
 * @param settings - the settings with a preset palette; a custom palette returns its own values.
 * @returns the accent, custom colour and contrast to write with the `custom` palette.
 */
export function customSeed(settings: ThemeSettings): CustomValues {
  if (settings.palette === 'custom') return { accent: settings.accent, customAccent: settings.customAccent, contrast: settings.contrast }
  if (settings.palette === 'soft') return { accent: 'peach', customAccent: settings.customAccent, contrast: CONTRAST.default }
  return { accent: 'custom', customAccent: t3AccentHex(settings.palette), contrast: CONTRAST.default }
}

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
  return { ...settings, palette: 'custom', accent: 'custom', customAccent: t3AccentHex(settings.palette) }
}

/** The custom colour a fresh custom theme shows before any pick. */
export const FALLBACK_CUSTOM_ACCENT = DEFAULT_CUSTOM_ACCENT
