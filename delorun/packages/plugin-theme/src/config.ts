/**
 * The theme's settings, shared by the host half that stores them and the
 * studio half that applies them: the palette (Soft or one of T3 Code's
 * themes), the accent preset or a custom colour, the contrast, the typeface,
 * the density, the reasoning-effort display, and the switch that turns Delorun's
 * look and every Delorun studio plugin on or back to the stock look. The ids, ranges and types live in `settings.ts`,
 * which needs no schema library; this module adds the defaults and the validated schema.
 * @module @delorun/plugin-theme/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_STORED_BRANDING, ICON_SOURCES, type StoredBranding } from '@delorun/brand/branding'
import {
  ACCENT_CHOICES, CONTRAST, DENSITIES, EFFORT_DISPLAYS, PALETTES, TYPEFACES,
  type AccentChoice, type Density, type EffortDisplay, type PaletteChoice, type ThemeSettings, type Typeface,
} from './settings.ts'

export {
  ACCENT_CHOICES, CONTRAST, DENSITIES, DENSITY_SCALE, EFFORT_DISPLAYS, PALETTES, PRESET_PALETTES, THEME_ROW_ID, TYPEFACES,
  type AccentChoice, type Density, type EffortDisplay, type PaletteChoice, type PresetPalette, type ThemeSettings, type Typeface,
} from './settings.ts'

/** The accent a fresh studio shows, and the colour a custom pick starts from. */
export const DEFAULT_CUSTOM_ACCENT = '#E5734A'

/** The settings the Appearance section shows before the stored ones arrive, and the `Config` defaults. */
export const DEFAULT_SETTINGS: ThemeSettings = {
  accent: 'peach', customAccent: DEFAULT_CUSTOM_ACCENT, typeface: 'delorun', density: 'comfortable', studioAdditions: false, palette: 'soft', contrast: CONTRAST.default, effort: 'label', branding: DEFAULT_STORED_BRANDING,
}

/** The host half's live configuration: one field per setting. */
export interface Config {
  /** The accent preset or `custom`. */
  accent: Volatile<AccentChoice>
  /** The custom accent colour. */
  customAccent: Volatile<string>
  /** The typeface. */
  typeface: Volatile<Typeface>
  /** The density. */
  density: Volatile<Density>
  /** C16 switch `studio_additions`: on, Delorun's look and every Delorun studio plugin; off, the parity value, upstream's stock look. */
  studioAdditions: Volatile<boolean>
  /** The palette. */
  palette: Volatile<PaletteChoice>
  /** The contrast setting. */
  contrast: Volatile<number>
  /** How reasoning effort shows. */
  effort: Volatile<EffortDisplay>
  /** The own branding: mark, name, icon and greeting. */
  branding: Volatile<StoredBranding>
}

/** The configuration schema: each field validated, defaulted, and changeable while the studio runs. */
export const Config = z.object({
  accent: z.union([...ACCENT_CHOICES]).default(DEFAULT_SETTINGS.accent).volatile(),
  customAccent: z.string().pattern(/^#[0-9a-fA-F]{6}$/).default(DEFAULT_CUSTOM_ACCENT).volatile(),
  typeface: z.union([...TYPEFACES]).default(DEFAULT_SETTINGS.typeface).volatile(),
  density: z.union([...DENSITIES]).default(DEFAULT_SETTINGS.density).volatile(),
  studioAdditions: z.boolean().volatile().default(false),
  palette: z.union([...PALETTES]).default(DEFAULT_SETTINGS.palette).volatile(),
  effort: z.union([...EFFORT_DISPLAYS]).default(DEFAULT_SETTINGS.effort).volatile(),
  // Lenient on purpose: a stored value that fails the branding checks shows the defaults with a notice instead of failing the load.
  branding: z.object({
    showMark: z.boolean().default(true),
    name: z.string().default(''),
    greeting: z.string().default(''),
    icon: z.union([...ICON_SOURCES]).default('mark'),
    pickedIcon: z.string().default(''),
    uploadHash: z.string().default(''),
    upload: z.string().default(''),
  }).default(DEFAULT_STORED_BRANDING).volatile(),
  contrast: z.number().min(CONTRAST.min).max(CONTRAST.max).step(CONTRAST.step).default(CONTRAST.default).volatile(),
})
