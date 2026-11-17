/**
 * Names of the review pass's pictures and the sets they come in. A picture's file name carries its page, section, width,
 * look and state, so a reviewer can read all five from the name, and two runs of the same build produce the same names.
 *
 * @module @delorun/website/review/naming
 */

/** The widths of the full picture set, in CSS pixels. */
export const WIDTHS = [390, 768, 1440, 1920] as const

/** The two widths used for the extra looks and states. */
export const PAIR_WIDTHS = [390, 1440] as const

/** The sections of the home page, in page order, with the headings and landmarks that find each one. */
export const SECTIONS = [
  { key: 'hero', find: 'hero' },
  { key: 'claims', find: 'after:make-it-yours' },
  { key: 'make-it-yours', find: 'heading:make it yours' },
  { key: 'plugins', find: 'heading:made of parts|plugin' },
  { key: 'replays', find: 'heading:watch it change' },
  { key: 'phone', find: 'heading:from your phone' },
  { key: 'whats-new', find: "heading:what.s new" },
  { key: 'next-and-teams', find: 'heading:what comes next|teams' },
  { key: 'sign-up', find: 'heading:release news|sign up|updates|subscribe' },
  { key: 'footer', find: 'footer' },
] as const

/** A section's key. */
export type SectionKey = (typeof SECTIONS)[number]['key'] | 'page'

/** The default look and the six other themes, as the `look` link parameter spells them. */
export const DEFAULT_LOOK = 'soft'
export const OTHER_LOOKS = ['t3-code', 't3-chat', 'grove', 'ocean', 'ember', 'iris'] as const

/** The colour schemes. */
export const SCHEMES = ['light', 'dark'] as const

/** A colour scheme. */
export type Scheme = (typeof SCHEMES)[number]

/** The states a picture can be taken in. `default` is the plain page. */
export type PictureState = 'default' | 'reduced-motion' | 'scripts-off' | `k-${string}` | `chapter-${string}` | `worst-${string}`

/** What one picture shows. */
export interface PictureSpec {
  /** The page: `home`, `404`, `privacy`, `notices` or a worst-case name. */
  readonly page: string
  /** The section, or `page` for the whole page. */
  readonly section: SectionKey | string
  readonly width: number
  /** The look id, such as `soft` or `ember`. */
  readonly look: string
  readonly scheme: Scheme
  readonly state: PictureState
}

/**
 * The file name for a picture.
 * @param spec - what the picture shows.
 * @returns a name of the form `page__section__w1440__soft-dark__default.png`.
 */
export function pictureName(spec: PictureSpec): string {
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return `${slug(spec.page)}__${slug(spec.section)}__w${String(spec.width)}__${slug(spec.look)}-${spec.scheme}__${slug(spec.state)}.png`
}

/**
 * Reads a picture name back.
 * @param name - a file name made by {@link pictureName}.
 * @returns the parts, or `undefined` when the name does not follow the scheme.
 */
export function parsePictureName(name: string): PictureSpec | undefined {
  const match = /^([a-z0-9-]+)__([a-z0-9-]+)__w(\d+)__([a-z0-9-]+)-(light|dark)__([a-z0-9-]+)\.png$/.exec(name)
  if (match === null) return undefined
  const [, page, section, width, look, scheme, state] = match
  return { page: page ?? '', section: section ?? '', width: Number(width), look: look ?? '', scheme: scheme as Scheme, state: (state ?? '') as PictureState }
}

/**
 * The pass folder for a pass number.
 * @param root - the release folder, such as `~/delorun-rc-release`.
 * @param pass - the pass number, from 1.
 * @returns the folder path.
 */
export function passFolder(root: string, pass: number): string {
  if (!Number.isInteger(pass) || pass < 1) throw new Error(`the pass number must be a whole number from 1, got ${String(pass)}`)
  return `${root.replace(/\/$/, '')}/site-pass-${String(pass)}`
}
