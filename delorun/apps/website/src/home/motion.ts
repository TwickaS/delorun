/**
 * The page's timings and easing, from the brand's motion tokens (`tokens.ts` in `@delorun/brand`), for the code that
 * animates through the Web Animations API or timers. The stylesheet reads the same values as `--dl-*` custom properties.
 *
 * @module @delorun/website/home/motion
 */
import { BRAND_MOTION } from '@brand/tokens.ts'

/** The easing for everything that arrives. */
export const EASE = BRAND_MOTION.easing.out

/** The brand's durations in milliseconds: `scene` is for the explanatory moments (the zoom, the re-tile, the lightbox's grow). */
export const MS = BRAND_MOTION.durations
