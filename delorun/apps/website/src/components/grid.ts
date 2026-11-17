/**
 * The page grid every section of the home page sits on.
 *
 * @module @delorun/website/grid
 */

/** Four columns on a phone and twelve from 1024 px, with the outer margin equal to the gutter: 16 px on a phone, 24 px from 640 px. */
export const GRID = 'mx-auto grid w-full max-w-[1440px] grid-cols-4 gap-x-(--grid-gap) px-(--grid-gap) [--grid-gap:16px] sm:[--grid-gap:24px] lg:grid-cols-12'

/** The three sizes of space above a section. */
export const SPACE = { near: 'pt-16 lg:pt-24', normal: 'pt-24 lg:pt-36', far: 'pt-32 lg:pt-48' } as const
