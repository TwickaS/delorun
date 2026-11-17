/**
 * The ideas the Ready step offers, one set per kind of folder the first chat opens in. Their text is in the dictionary
 * as `starter.<set>.<n>.label` and `.prompt`.
 */

/** The ideas of a set, by the number their copy is keyed with. */
export const STARTERS = [1, 2, 3] as const

/** The idea sets: one per folder kind, and `general` where the folder's kind is not known. */
export const STARTER_SETS = ['general', 'empty', 'code', 'files'] as const

/** One of {@link STARTER_SETS}. */
export type StarterSet = typeof STARTER_SETS[number]

/**
 * @param folder - what the chosen folder holds, or empty.
 * @returns the set of ideas that fits it.
 */
export function starterSet(folder: string): StarterSet {
  return (STARTER_SETS as readonly string[]).includes(folder) ? folder as StarterSet : 'general'
}
