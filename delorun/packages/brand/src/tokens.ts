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
  /** The fallback ink on a peach fill, for a page without a studio; 6.19:1, because white on peach reaches only 3.05:1. */
  onPeach: '#111110',
  /** The mark's nut on a light page. */
  ink: '#111110',
  /** The mark's nut on a dark page. */
  paper: '#EBEBEB',
} as const

/** The page background in each scheme, which a page also names to the browser as its `theme-color`. */
export const BRAND_SURFACE = { light: '#FCFCFC', dark: '#111110' } as const

/** The typefaces: Schibsted Grotesk for text and JetBrains Mono for code, with the system fallbacks. */
export const BRAND_FONTS = {
  sans: "'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
} as const

/** The radii, in pixels. */
export const BRAND_RADII = { xs: 4, sm: 8, md: 12, lg: 16 } as const

/** The spacing steps, in pixels, `--dl-space-1` to `--dl-space-6`. */
export const BRAND_SPACE = [4, 8, 12, 16, 24, 32] as const

/**
 * The motion tokens: one easing family and the durations, in milliseconds. `--dl-duration-*` in `tokens.css` time
 * colour and opacity changes; `--dl-motion-*` time transform and clip-path changes and become 0ms under reduced motion.
 * `leave` is shorter than every arrival, and nothing but `explain` (the theme change) runs over 300 ms.
 */
export const BRAND_MOTION = {
  /** The easing curves: `out` for arrivals, `inOut` for movement across the screen, `plain` for colour. There is no ease-in. */
  easing: { out: 'cubic-bezier(0.23, 1, 0.32, 1)', inOut: 'cubic-bezier(0.77, 0, 0.175, 1)', plain: 'ease' },
  /** The durations: a press, a tab or tile change, a movement across the screen, the theme change, a scene (an explanatory zoom or re-tile on a marketing page), and leaving. */
  durations: { press: 120, quick: 180, move: 260, explain: 360, scene: 760, leave: 100 },
  /** The scale of a pressed control, and the scale things arrive from. */
  scale: { pressed: 0.97, enter: 0.95 },
} as const
