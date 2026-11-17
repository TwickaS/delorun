/**
 * The looks the two sites offer and the way one travels between them. A look is a studio palette id, or `custom` with one
 * accent preset. `looks.css` carries the colours; this module carries the names and the validation of a look that arrives
 * in a link.
 *
 * @module @delorun/site-design/looks
 */

/** The palette ids, in the studio's order. */
export const KNOWN_LOOKS = ['soft', 't3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris', 'custom'] as const

/** One palette id. */
export type LookId = (typeof KNOWN_LOOKS)[number]

/** The accent presets a custom look takes. */
export const KNOWN_ACCENTS = ['peach', 'cobalt', 'moss', 'mono'] as const

/** One accent preset. */
export type AccentId = (typeof KNOWN_ACCENTS)[number]

/** The densities. */
export const KNOWN_DENSITIES = ['compact', 'comfortable', 'spacious'] as const

/** One density. */
export type DensityId = (typeof KNOWN_DENSITIES)[number]

/** The names the studio shows on its theme tiles; `tests/looks.spec.ts` keeps them equal to the studio's dictionary. */
export const LOOK_NAMES: Readonly<Record<LookId, string>> = {
  soft: 'Soft',
  't3-code': 'Slate',
  't3-chat': 'Berry',
  grove: 'Grove',
  ocean: 'Ocean',
  ember: 'Ember',
  iris: 'Iris',
  custom: 'Custom',
}

/**
 * The name of a look.
 * @param id - the palette id.
 * @returns the studio's tile name.
 */
export function lookName(id: LookId): string {
  return LOOK_NAMES[id]
}

/** The contrast stops: quiet text and rules as designed, or stronger. `looks.css` gives each its value. */
export const KNOWN_CONTRASTS = ['default', 'high', 'highest'] as const

/** One contrast stop. */
export type ContrastId = (typeof KNOWN_CONTRASTS)[number]

/** The colour schemes the control offers. */
export const KNOWN_SCHEMES = ['light', 'dark'] as const

/** One colour scheme. */
export type SchemeId = (typeof KNOWN_SCHEMES)[number]

/** A look as a visitor chose it; a missing scheme follows the device. */
export interface Look {
  /** The theme. */
  readonly look: LookId
  /** The accent preset; read only when `look` is `custom`. */
  readonly accent: AccentId
  /** How tightly the page is spaced. */
  readonly density: DensityId
  /** Quiet text and rules. */
  readonly contrast: ContrastId
  /** Light or dark; undefined follows the device. */
  readonly scheme?: SchemeId | undefined
}

/** The look a visitor starts from. */
export const DEFAULT_LOOK: Look = { look: 'soft', accent: 'peach', density: 'comfortable', contrast: 'default' }

/** The query parameters a link carries, in the order they are written. */
export const LOOK_PARAMS = ['look', 'accent', 'density', 'contrast', 'scheme'] as const

function oneOf<T extends string>(known: readonly T[], value: string | null): T | undefined {
  return known.find(each => each === value)
}

/**
 * Reads a look from a link's query. An unknown value is ignored and the default stands in its place.
 * @param params - the query.
 * @returns the look, or undefined when the query names no look parameter at all.
 */
export function parseLook(params: URLSearchParams): Look | undefined {
  if (!LOOK_PARAMS.some(name => params.has(name))) return undefined
  const look = oneOf(KNOWN_LOOKS, params.get('look')) ?? DEFAULT_LOOK.look
  return {
    look,
    accent: look === 'custom' ? oneOf(KNOWN_ACCENTS, params.get('accent')) ?? DEFAULT_LOOK.accent : DEFAULT_LOOK.accent,
    density: oneOf(KNOWN_DENSITIES, params.get('density')) ?? DEFAULT_LOOK.density,
    contrast: look === 'custom' ? oneOf(KNOWN_CONTRASTS, params.get('contrast')) ?? DEFAULT_LOOK.contrast : DEFAULT_LOOK.contrast,
    scheme: oneOf(KNOWN_SCHEMES, params.get('scheme')),
  }
}

/**
 * Writes a look into a query: only what differs from the default.
 * @param look - the look.
 * @returns the query without the leading question mark; empty for the default look.
 */
export function lookQuery(look: Look): string {
  const params = new URLSearchParams()
  if (look.look !== DEFAULT_LOOK.look) params.set('look', look.look)
  if (look.look === 'custom' && look.accent !== DEFAULT_LOOK.accent) params.set('accent', look.accent)
  if (look.density !== DEFAULT_LOOK.density) params.set('density', look.density)
  if (look.look === 'custom' && look.contrast !== DEFAULT_LOOK.contrast) params.set('contrast', look.contrast)
  if (look.scheme !== undefined) params.set('scheme', look.scheme)
  return params.toString()
}

/**
 * A link to the other site that carries the look.
 * @param href - the link, absolute or site-relative.
 * @param look - the visitor's current look.
 * @returns the link with the look in its query, replacing any look already there.
 */
export function withLook(href: string, look: Look): string {
  const url = new URL(href, 'https://look.invalid')
  for (const name of LOOK_PARAMS) url.searchParams.delete(name)
  for (const [name, value] of new URLSearchParams(lookQuery(look))) url.searchParams.set(name, value)
  const relative = !/^[a-z][a-z0-9+.-]*:/i.test(href)
  return relative ? `${url.pathname}${url.search}${url.hash}` : url.toString()
}

/** The root element's attributes, written and read by {@link applyLook} and {@link currentLook}. */
export interface LookRoot {
  readonly dataset: DOMStringMap
  readonly classList: { toggle(name: string, force?: boolean): boolean; contains(name: string): boolean }
}

/**
 * Applies a look to the page's root: the theme, accent, density and contrast attributes, and the dark class when the
 * scheme is chosen. A scheme left undefined is not touched, so the device's setting stands.
 * @param root - the root element.
 * @param look - the look.
 */
export function applyLook(root: LookRoot, look: Look): void {
  root.dataset['look'] = look.look
  if (look.look === 'custom') root.dataset['accent'] = look.accent
  else delete root.dataset['accent']
  root.dataset['density'] = look.density
  root.dataset['contrast'] = look.contrast
  if (look.scheme !== undefined) root.classList.toggle('dark', look.scheme === 'dark')
}

/**
 * The look the page's root shows now.
 * @param root - the root element.
 * @returns the look, validated; an attribute that names nothing known reads as the default.
 */
export function currentLook(root: LookRoot): Look {
  const data = root.dataset
  return {
    look: oneOf(KNOWN_LOOKS, data['look'] ?? null) ?? DEFAULT_LOOK.look,
    accent: oneOf(KNOWN_ACCENTS, data['accent'] ?? null) ?? DEFAULT_LOOK.accent,
    density: oneOf(KNOWN_DENSITIES, data['density'] ?? null) ?? DEFAULT_LOOK.density,
    contrast: oneOf(KNOWN_CONTRASTS, data['contrast'] ?? null) ?? DEFAULT_LOOK.contrast,
    scheme: root.classList.contains('dark') ? 'dark' : 'light',
  }
}
