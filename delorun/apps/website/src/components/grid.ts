/**
 * The page grid every section of the home page sits on.
 *
 * @module @delorun/website/grid
 */

/** Four columns on a phone and twelve from 1024 px, with the outer margin equal to the gutter: 16 px on a phone, 24 px from 640 px. */
export const GRID = 'mx-auto grid w-full max-w-[1440px] grid-cols-4 gap-x-(--grid-gap) px-(--grid-gap) [--grid-gap:16px] sm:[--grid-gap:24px] lg:grid-cols-12'

/** The three sizes of space above a section: 48, 64 and 80 px on a phone, 64, 96 and 128 px from 1024 px. */
export const SPACE = { near: 'pt-12 lg:pt-16', normal: 'pt-16 lg:pt-24', far: 'pt-20 lg:pt-32' } as const
