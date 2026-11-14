/**
 * Load-time check of the `optionalRows` setting: each row id must name a row of the running profile, so a typo or a
 * bundle that is not part of the profile stops the plugin instead of leaving an offer that never works.
 * @module @delorun/plugin-onboarding/rows
 */

/**
 * The part of the Loader this check reads: the rows it holds, enabled or not. A row's `options.id` is the id its profile
 * writes; the entry's own `id` is prefixed with the ids of the groups it sits in, so it is not what a row list names.
 */
export interface RowSource {
  entries(): Iterable<{ readonly options: { readonly id: string } }>
}

/**
 * Refuse a row id that the profile does not hold.
 * @param rows - the row ids the setting lists.
 * @param loader - the Loader, or undefined where none is mounted.
 * @throws when rows are listed and there is no Loader to check them against, or one of them is not a row of the profile.
 */
export function assertRowsExist(rows: readonly string[], loader: RowSource | undefined): void {
  if (rows.length === 0) return
  if (loader === undefined) throw new Error('delorun-onboarding: optionalRows is set, but there is no Loader to check the rows against')
  const held = new Set([...loader.entries()].map(entry => entry.options.id))
  const unknown = rows.filter(row => !held.has(row))
  if (unknown.length > 0) throw new Error(`delorun-onboarding: optionalRows names ${unknown.map(row => `"${row}"`).join(', ')}, which the profile has no row for`)
}
