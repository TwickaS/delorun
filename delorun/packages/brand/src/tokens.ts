/**
 * Delorun's brand values as data: the one brand colour, the typefaces, the radii and spacing steps, and the contrast
 * the text-safe peach reaches. {@link file://./tokens.css} holds the same values as custom properties; the two are kept
 * equal by `tests/tokens.spec.ts`.
 * @module @delorun/brand/tokens
 */

/** The brand colours, as six-digit hex. */
export const BRAND_COLOURS = {
  /** Peach, the one brand colour: fills, focus rings and the mark's plug. */
  peach: '#E5734A',
  /** Peach darkened for text and links on a light page; 5.21:1 on white and 5.07:1 on #FCFCFC, above WCAG AA's 4.5:1. */
  peachText: '#B84A1B',
  /** The text colour on a peach fill; 6.19:1, because white on peach reaches only 3.05:1. */
  onPeach: '#111110',
  /** The mark's nut on a light page. */
  ink: '#111110',
  /** The mark's nut on a dark page. */
  paper: '#EBEBEB',
} as const

/** The typefaces: Schibsted Grotesk for text and JetBrains Mono for code, with the system fallbacks. */
export const BRAND_FONTS = {
  sans: "'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const

/** The radii, in pixels. */
export const BRAND_RADII = { xs: 4, sm: 8, md: 12, lg: 16 } as const

/** The spacing steps, in pixels, `--dl-space-1` to `--dl-space-6`. */
export const BRAND_SPACE = [4, 8, 12, 16, 24, 32] as const
