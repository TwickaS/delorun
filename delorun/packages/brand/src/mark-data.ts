/**
 * The Delorun mark's drawing as data, without React: a page that is served before any studio bundle loads, such as the
 * sign-in page, reads the path from here. `Mark` in {@link file://./mark.tsx} renders the same drawing.
 * @module @delorun/brand/mark-data
 */

/** The mark's drawing in a 32 by 32 box: the nut with its hole (even-odd fill) and the plug's circle. */
export const MARK = {
  nut: 'M16 2.5L27.7 9.25V22.75L16 29.5L4.3 22.75V9.25Z M22.6 16A6.6 6.6 0 1 0 9.4 16A6.6 6.6 0 1 0 22.6 16Z',
  plug: { cx: 16, cy: 16, r: 3.6 },
} as const
