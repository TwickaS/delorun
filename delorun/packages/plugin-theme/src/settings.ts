/**
 * The theme's settings without a schema library: the ids, ranges and types of every setting, and the rule that turns a
 * change made with a control into the keys the studio writes. The studio's Appearance controls and the website's setup
 * strip both call {@link writesFor}, so the entry the website shows is the one the studio writes. `config.ts` adds the
 * defaults and the validated `Config` schema and re-exports this module.
 * @module @delorun/plugin-theme/settings
 */
import type { StoredBranding } from '@delorun/brand/branding'

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

/** The preset palettes: Delorun's Soft, and T3 Code's six themes. Each fixes its own accent and colours. */
export const PRESET_PALETTES = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'] as const

/** The palettes: the presets, then `custom`, the only palette that reads {@link ThemeSettings.accent}, {@link ThemeSettings.customAccent} and {@link ThemeSettings.contrast}. */
export const PALETTES = [...PRESET_PALETTES, 'custom'] as const

/** One palette choice. */
export type PaletteChoice = typeof PALETTES[number]

/** One preset palette. */
export type PresetPalette = typeof PRESET_PALETTES[number]

/** How reasoning effort shows in the composer's model picker: its name, or T3 Code's bars. */
export const EFFORT_DISPLAYS = ['label', 'bars'] as const

/** One effort display. */
export type EffortDisplay = typeof EFFORT_DISPLAYS[number]

/** Where toasts stack, in the order the Toast position control draws its zones: the top row, then the bottom row. */
export const TOAST_POSITIONS = ['top-left', 'top-centre', 'top-right', 'bottom-left', 'bottom-centre', 'bottom-right'] as const

/** One toast position. */
export type ToastPosition = typeof TOAST_POSITIONS[number]

/** The root attribute that carries the position; the studio's toast area reads it, and a phone width pins toasts to the top whatever it says. */
export const TOAST_POSITION_ATTRIBUTE = 'data-toast-position'

/** The contrast slider, T3 Code's: quiet text and rules move towards the page below 100 and towards primary text above it. */
export const CONTRAST = { min: 50, max: 200, step: 5, default: 100 } as const

/** The settings as the studio reads them. */
export interface ThemeSettings {
  /** The accent preset, or `custom` for {@link customAccent}. Read only with the `custom` palette. */
  accent: AccentChoice
  /** The custom accent as `#RRGGBB`; used when {@link accent} is `custom`. */
  customAccent: string
  /** Which typeface the studio uses. */
  typeface: Typeface
  /** How tightly rows and gaps are set. */
  density: Density
  /** Whether Delorun's look and Delorun's studio plugins are on; off is upstream's stock look. */
  studioAdditions: boolean
  /** The palette: a preset, which fixes its own accent and colours, or `custom`, which uses `accent`, `customAccent` and `contrast`. */
  palette: PaletteChoice
  /** Contrast, `CONTRAST.min` to `CONTRAST.max`; 100 leaves the palette as generated. Read only with the `custom` palette. */
  contrast: number
  /** How reasoning effort shows in the model picker. */
  effort: EffortDisplay
  /** Where toasts stack on a screen wider than a phone. */
  toastPosition: ToastPosition
  /** The person's own branding; every field is validated again where it is read. */
  branding: StoredBranding
}

/**
 * The settings keys in the order of the `Config` schema's fields. The settings service rewrites a stored row's keys in
 * this order before it adds the keys a change writes for the first time; `tests/settings.spec.ts` keeps it equal to the
 * schema.
 */
export const SETTING_KEYS = ['accent', 'customAccent', 'typeface', 'density', 'studioAdditions', 'palette', 'effort', 'toastPosition', 'branding', 'contrast'] as const satisfies readonly (keyof ThemeSettings)[]

/** The values the custom theme holds; the rest of the settings belong to no palette. */
export type CustomValues = Pick<ThemeSettings, 'accent' | 'customAccent' | 'contrast'>

/** The settings that decide the colours: the palette and the custom theme's values. */
export type LookValues = Pick<ThemeSettings, 'palette' | 'accent' | 'customAccent' | 'contrast'>

/**
 * Each T3 Code preset's accent in the light scheme as `#RRGGBB`, the colour the custom theme starts from after that
 * preset. `tests/settings.spec.ts` keeps each equal to the accent the palette generator draws.
 */
export const PRESET_ACCENT_HEX: Readonly<Record<Exclude<PresetPalette, 'soft'>, string>> = {
  't3-code': '#1B4ED8',
  't3-chat': '#DB2777',
  grove: '#1B7D50',
  ocean: '#2672AF',
  ember: '#AE552A',
  iris: '#7253B9',
}

/**
 * The values to start the custom theme from, taken from the preset the person had last.
 * @param settings - the settings with a preset palette; a custom palette returns its own values.
 * @returns the accent, custom colour and contrast to write with the `custom` palette.
 */
export function customSeed(settings: LookValues): CustomValues {
  if (settings.palette === 'custom') return { accent: settings.accent, customAccent: settings.customAccent, contrast: settings.contrast }
  if (settings.palette === 'soft') return { accent: 'peach', customAccent: settings.customAccent, contrast: CONTRAST.default }
  return { accent: 'custom', customAccent: PRESET_ACCENT_HEX[settings.palette], contrast: CONTRAST.default }
}

/**
 * Read stored settings as the Look model: a preset beside a changed accent or contrast becomes the custom theme seeded
 * from that preset. A T3 Code preset keeps only its accent colour in the custom theme, because the custom theme's
 * surfaces are Soft's. Settings written by {@link writesFor} always read as what was chosen; older settings could hold a
 * preset beside a changed accent or contrast.
 * @param settings - the stored settings.
 * @returns the settings with a palette that matches what they hold; the same object when nothing changes.
 */
export function lookOf<Settings extends LookValues>(settings: Settings): Settings {
  if (settings.palette === 'custom') return settings
  const changedContrast = settings.contrast !== CONTRAST.default
  if (settings.palette === 'soft') {
    if (settings.accent === 'peach' && !changedContrast) return settings
    return { ...settings, palette: 'custom' }
  }
  if (!changedContrast) return settings
  return { ...settings, palette: 'custom', accent: 'custom', customAccent: PRESET_ACCENT_HEX[settings.palette] }
}

/** One change made with a look control. */
export type ThemeChange =
  /** A theme tile: a preset, which also resets what {@link lookOf} would read as Custom, or `custom`, which starts the custom theme from the current colours. */
  | { readonly kind: 'palette'; readonly palette: PaletteChoice }
  /** A value of the custom theme, such as its accent or contrast; the rest start from the current colours. */
  | { readonly kind: 'custom'; readonly values: Partial<CustomValues> }
  /** A density tile. */
  | { readonly kind: 'density'; readonly density: Density }

/** The keys a {@link ThemeChange} writes. */
export type WrittenKey = 'palette' | 'accent' | 'customAccent' | 'contrast' | 'density'

/** One key a change writes: a settings form `set` operation on a top-level field. */
export interface SettingWrite {
  /** Always `set`: a look change never removes a key. */
  readonly op: 'set'
  /** The field. */
  readonly path: [WrittenKey]
  /** Its new value. */
  readonly value: string | number
}

/**
 * The keys the studio writes for one change, in the order it writes them. A preset or a density writes its one key. The
 * custom theme is written whole in one atomic change, its palette last, so settings stored as a preset beside a changed
 * accent become the custom theme they drew.
 * @param change - the change a control reports.
 * @param current - the colours shown now, read through `lookOf`.
 * @returns the writes, for one `ConfigForm.mutate` call.
 */
export function writesFor(change: ThemeChange, current: LookValues): readonly SettingWrite[] {
  switch (change.kind) {
    case 'palette':
      return change.palette === 'custom' ? customWrites(current, {}) : presetWrites(change.palette, current)
    case 'custom':
      return customWrites(current, change.values)
    case 'density':
      return [{ op: 'set', path: ['density'], value: change.density }]
    default: {
      const unknown: never = change
      return unknown
    }
  }
}

/**
 * A preset written so that it reads back as that preset: Soft also takes Peach back, and every preset takes the default
 * contrast back, each only when the current value differs. The custom values are lost to nothing a person sees, because
 * {@link customSeed} starts the custom theme afresh after any preset.
 * @param palette - the preset.
 * @param current - the colours shown now.
 * @returns the writes, the palette last.
 */
function presetWrites(palette: PresetPalette, current: LookValues): readonly SettingWrite[] {
  const writes: SettingWrite[] = []
  if (palette === 'soft' && current.accent !== 'peach') writes.push({ op: 'set', path: ['accent'], value: 'peach' })
  if (current.contrast !== CONTRAST.default) writes.push({ op: 'set', path: ['contrast'], value: CONTRAST.default })
  writes.push({ op: 'set', path: ['palette'], value: palette })
  return writes
}

/**
 * The custom theme written whole: its values from the current colours with the change over them, then the palette.
 * @param current - the colours shown now.
 * @param values - the values the change sets.
 * @returns the four writes.
 */
function customWrites(current: LookValues, values: Partial<CustomValues>): readonly SettingWrite[] {
  const next = { ...customSeed(current), ...values }
  return [
    { op: 'set', path: ['accent'], value: next.accent },
    { op: 'set', path: ['customAccent'], value: next.customAccent },
    { op: 'set', path: ['contrast'], value: next.contrast },
    { op: 'set', path: ['palette'], value: 'custom' },
  ]
}
