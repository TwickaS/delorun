/**
 * The page, card and text colours of the studio's default look (the Soft theme, peach accent) as hex, for a page the
 * studio's bundle does not style, such as the sign-in page: it shows the same warm greys a person sees once signed in.
 * `@delorun/plugin-theme`'s `tests/soft-surfaces.spec.ts` keeps each value equal to what the Soft palette generates, so
 * a change to Soft fails there until these follow. The studio itself reads its own `--dsw-*` roles and ignores this module.
 * @module @delorun/brand/soft-surfaces
 */

/** The colours of one scheme: the Soft palette role each is generated from is named in its comment. */
export interface SoftScheme {
  /** `--dsw-alias-bg-base`. */
  readonly page: string
  /** `--dsw-alias-bg-layer-1`. */
  readonly card: string
  /** `--dsw-specific-sidebar-fill`. */
  readonly well: string
  /** `--dsw-alias-border-l2`. */
  readonly border: string
  /** `--dsw-alias-label-primary`. */
  readonly text: string
  /** `--dsw-alias-label-secondary`. */
  readonly textMuted: string
  /** `--dsw-alias-link`, the text-safe accent. */
  readonly accentText: string
}

/** The Soft theme's surfaces in each scheme. */
export const SOFT_SURFACES = {
  light: { page: '#fdfdfb', card: '#ffffff', well: '#f5f4f2', border: 'rgba(0, 0, 0, 0.1)', text: '#13110d', textMuted: '#676560', accentText: '#be542c' },
  dark: { page: '#171511', card: '#25231f', well: '#1d1b17', border: 'rgba(255, 255, 255, 0.12)', text: '#fbfaf8', textMuted: '#d5d2cd', accentText: '#e69275' },
} as const satisfies Record<'light' | 'dark', SoftScheme>

/**
 * The `--dl-*` surface and text tokens set to the Soft theme's values, as a rule that follows `tokens.css`.
 * @returns the CSS text of a `:root` rule.
 */
export function softSurfacesCss(): string {
  const { light, dark } = SOFT_SURFACES
  const pair = (name: keyof SoftScheme): string => `light-dark(${light[name]}, ${dark[name]})`
  return `:root {
  --dl-surface: ${pair('page')};
  --dl-surface-raised: ${pair('card')};
  --dl-surface-sunken: ${pair('well')};
  --dl-border: ${pair('border')};
  --dl-text: ${pair('text')};
  --dl-text-muted: ${pair('textMuted')};
  --dl-accent-text: ${pair('accentText')};
}
`
}
