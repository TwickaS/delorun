/**
 * The theme's settings, shared by the host half that stores them and the
 * studio half that applies them: the palette (Soft or one of T3 Code's
 * themes), the accent preset or a custom colour, the contrast, the typeface,
 * the density, the reasoning-effort display, and the switch that turns Delorun's
 * look and every Delorun studio plugin on or back to the stock look.
 * @module @delorun/plugin-theme/config
 */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { DEFAULT_STORED_BRANDING, ICON_SOURCES, type StoredBranding } from '@delorun/brand/branding'

/** The Loader row id, which names the settings namespace the studio edits. */
export const THEME_ROW_ID = 'delorun-theme'

/** The accent choices: the presets, then a custom colour. */
export const ACCENT_CHOICES = ['peach', 'cobalt', 'moss', 'mono', 'custom'] as const

/** One accent choice. */
export type AccentChoice = typeof ACCENT_CHOICES[number]

/** The typefaces: Delorun's (Schibsted Grotesk and JetBrains Mono) or upstream's system stacks. */
export const TYPEFACES = ['delorun', 'system'] as const

/** One typeface choice. */
export type Typeface = typeof TYPEFACES[number]

/** How tightly the studio sets its rows and gaps. */
export const DENSITIES = ['compact', 'comfortable', 'spacious'] as const

/** One density choice. */
export type Density = typeof DENSITIES[number]

/** Each density's spacing scale, the value of `--dsh-density` that spacing rules multiply by. */
export const DENSITY_SCALE: Readonly<Record<Density, number>> = { compact: 0.8, comfortable: 1, spacious: 1.2 }

/** The palettes: Delorun's Soft, and T3 Code's six themes, each with its own accent. */
export const PALETTES = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'] as const

/** One palette choice. */
export type PaletteChoice = typeof PALETTES[number]

/** How reasoning effort shows in the composer's model picker: its name, or T3 Code's bars. */
export const EFFORT_DISPLAYS = ['label', 'bars'] as const

/** One effort display. */
export type EffortDisplay = typeof EFFORT_DISPLAYS[number]

/** The contrast slider, T3 Code's: quiet text and rules move towards the page below 100 and towards primary text above it. */
export const CONTRAST = { min: 50, max: 200, step: 5, default: 100 } as const

/** The accent a fresh studio shows, and the colour a custom pick starts from. */
export const DEFAULT_CUSTOM_ACCENT = '#E5734A'

/** The settings as the studio reads them. */
export interface ThemeSettings {
  /** The accent preset, or `custom` for {@link customAccent}. */
  accent: AccentChoice
  /** The custom accent as `#RRGGBB`; used when {@link accent} is `custom`. */
  customAccent: string
  /** Which typeface the studio uses. */
  typeface: Typeface
  /** How tightly rows and gaps are set. */
  density: Density
  /** Whether Delorun's look and Delorun's studio plugins are on; off is upstream's stock look. */
  studioAdditions: boolean
  /** The palette; a T3 Code theme brings its own accent in place of `accent`. */
  palette: PaletteChoice
  /** Contrast, `CONTRAST.min` to `CONTRAST.max`; 100 leaves the palette as generated. */
  contrast: number
  /** How reasoning effort shows in the model picker. */
  effort: EffortDisplay
  /** The person's own branding; every field is validated again where it is read. */
  branding: StoredBranding
}

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
    upload: z.string().default(''),
  }).default(DEFAULT_STORED_BRANDING).volatile(),
  contrast: z.number().min(CONTRAST.min).max(CONTRAST.max).step(CONTRAST.step).default(CONTRAST.default).volatile(),
})
