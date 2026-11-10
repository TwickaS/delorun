/**
 * The colours the look step's chips preview, one entry per choice. The browser page does not provide Delo's theme
 * package, so the ids and values are copied from the theme's own palettes and preview colours; a test compares them
 * with the theme and fails when the theme changes a palette or an accent preset.
 * @module @delo/plugin-onboarding/client/previews
 */

/** The theme's palette ids; a test compares the list with the theme's own. */
export type PaletteChoice = 'soft' | 't3-code' | 't3-chat' | 'grove' | 'ocean' | 'ember' | 'iris'

/** One colour scheme of a palette: the page, primary text and the accent. */
export interface SchemeColours {
  /** The page colour, as `rgb(r g b)`. */
  readonly page: string
  /** Primary text on the page. */
  readonly text: string
  /** The brand accent the palette gives. */
  readonly accent: string
}

/** A palette's colours in both schemes. */
export interface PalettePreview {
  readonly light: SchemeColours
  readonly dark: SchemeColours
}

/** The palettes the look step offers, in the order of Settings → Appearance. */
export const PALETTE_CHOICES: readonly PaletteChoice[] = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris']

/** Each palette's preview colours. */
export const PALETTE_PREVIEWS: Readonly<Record<PaletteChoice, PalettePreview>> = {
  'soft': {
    light: { page: 'rgb(253 253 251)', text: 'rgb(19 17 13)', accent: 'rgb(229 115 74)' },
    dark: { page: 'rgb(23 21 17)', text: 'rgb(251 250 248)', accent: 'rgb(229 115 74)' },
  },
  't3-code': {
    light: { page: 'rgb(252 252 255)', text: 'rgb(16 16 24)', accent: 'rgb(27 78 216)' },
    dark: { page: 'rgb(20 20 28)', text: 'rgb(249 249 253)', accent: 'rgb(50 106 245)' },
  },
  't3-chat': {
    light: { page: 'rgb(253 247 254)', text: 'rgb(23 12 25)', accent: 'rgb(219 39 119)' },
    dark: { page: 'rgb(28 16 29)', text: 'rgb(253 248 254)', accent: 'rgb(162 0 83)' },
  },
  'grove': {
    light: { page: 'rgb(242 247 245)', text: 'rgb(11 19 15)', accent: 'rgb(27 125 80)' },
    dark: { page: 'rgb(15 23 19)', text: 'rgb(247 251 249)', accent: 'rgb(122 211 161)' },
  },
  'ocean': {
    light: { page: 'rgb(244 247 250)', text: 'rgb(12 18 22)', accent: 'rgb(38 114 175)' },
    dark: { page: 'rgb(17 22 26)', text: 'rgb(248 250 252)', accent: 'rgb(110 183 249)' },
  },
  'ember': {
    light: { page: 'rgb(250 246 244)', text: 'rgb(21 16 12)', accent: 'rgb(174 85 42)' },
    dark: { page: 'rgb(26 20 17)', text: 'rgb(252 249 248)', accent: 'rgb(245 150 106)' },
  },
  'iris': {
    light: { page: 'rgb(248 246 251)', text: 'rgb(18 16 23)', accent: 'rgb(114 83 185)' },
    dark: { page: 'rgb(22 20 27)', text: 'rgb(250 249 253)', accent: 'rgb(156 128 234)' },
  },
}

/** The accent presets the look step offers while the Soft palette is chosen; a custom colour stays in Settings. */
export const ACCENT_PRESETS = ['peach', 'cobalt', 'moss', 'mono'] as const

/** One accent preset. */
export type AccentPreset = typeof ACCENT_PRESETS[number]

/** Each accent preset's fill in the light and the dark scheme. */
export const ACCENT_PREVIEWS: Readonly<Record<AccentPreset, { readonly light: string; readonly dark: string }>> = {
  peach: { light: 'rgb(229 115 74)', dark: 'rgb(229 115 74)' },
  cobalt: { light: 'rgb(58 94 232)', dark: 'rgb(58 94 232)' },
  moss: { light: 'rgb(63 122 79)', dark: 'rgb(63 122 79)' },
  mono: { light: 'rgb(27 26 24)', dark: 'rgb(230 228 226)' },
}
