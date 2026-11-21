/**
 * How a failure's text names the Delorun home: an answer and a recorded failure say {@link HOME_IN_ANSWERS} where the
 * text holds the home's path, in each spelling the path has.
 *
 * @module @delorun/plugin-changes/home-words
 */
import { realpathSync } from 'node:fs'

/** What a recorded failure's text in an answer says in place of the Delorun home's path. */
export const HOME_IN_ANSWERS = '<Delorun home>'

/**
 * @param home - the Delorun home the Host names.
 * @returns the home as the Host names it and, when that differs, its real path, the longer spelling first so one that contains the other is replaced whole.
 */
export function homeSpellings(home: string): readonly string[] {
  let real: string | undefined
  try {
    real = realpathSync(home)
  } catch (_unresolved) {
    // A home that does not resolve has only the spelling the Host names, which every failure under it carries.
    real = undefined
  }
  return real === undefined || real === home ? [home] : [home, real].sort((a, b) => b.length - a.length)
}

/**
 * @param text - a failure's text.
 * @param homes - the home's spellings.
 * @returns the text with every spelling replaced by {@link HOME_IN_ANSWERS}.
 */
export function withHomePlaceholder(text: string, homes: readonly string[]): string {
  return homes.reduce((replaced, home) => replaced.replaceAll(home, HOME_IN_ANSWERS), text)
}
