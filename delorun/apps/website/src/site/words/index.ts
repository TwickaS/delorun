/**
 * The site's per-language dictionaries. English is the only one filled; a Chinese page adds `zh.ts` typed as
 * {@link Words}, so the compiler names every string it still lacks.
 *
 * @module @delorun/website/words
 */
import { EN } from './en.ts'

/** A dictionary's value types with the English literals widened: the same keys and functions, any wording. */
type Widen<T> = T extends string
  ? string
  : T extends (...args: infer A) => infer R
    ? (...args: A) => Widen<R>
    : T extends readonly (infer E)[]
      ? readonly Widen<E>[]
      : { readonly [K in keyof T]: Widen<T[K]> }

/** Every string the site shows, in one language. */
export type Words = Widen<typeof EN>

/** The dictionaries by language. */
export const DICTIONARIES = { en: EN } as const satisfies Readonly<Record<string, Words>>

/** A language the site has a dictionary for. */
export type Language = keyof typeof DICTIONARIES
