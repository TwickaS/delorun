/**
 * The Look model: a preset palette fixes its own accent and colours, and only the `custom` palette reads the accent and
 * the contrast. Settings stored before that split could hold a preset beside a changed accent or contrast; `lookOf` reads
 * them as the custom theme they drew, and `customSeed` gives the values a person starts the custom theme from. Both are
 * defined in `settings.ts`, which the website also loads.
 * @module @delorun/plugin-theme/palette/migrate
 */
import { DEFAULT_CUSTOM_ACCENT } from '../config.ts'

export { customSeed, lookOf, type CustomValues } from '../settings.ts'

/** The custom colour a fresh custom theme shows before any pick. */
export const FALLBACK_CUSTOM_ACCENT = DEFAULT_CUSTOM_ACCENT
