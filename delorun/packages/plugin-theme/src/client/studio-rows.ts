/**
 * The studio plugins a person turns on from the Plugins screen. `@delorun/bundle-studio` inserts each of these rows
 * `disabled: true`, so a new profile mounts nothing of it until someone finds the row under Components on the bundle's
 * own page. The bundle's card is where a person looking for cost tracking or the Thinking tab actually looks, so these
 * rows are listed there with their own switches.
 *
 * The list is the bundle's own `optionalRows` setting, which `@delorun/plugin-onboarding` already offers as the plugins
 * a person may add, and which `@delorun/home-auth` already admits to an approved device. One list, three readers: a row
 * that joins or leaves it needs no change here.
 *
 * Only rows the bundle inserts disabled belong here. The studio's own parts — the theme, the sidebar, chat states,
 * onboarding, the downloads panel, the preview flags and the new-workspace flow — are on by default and are the studio
 * itself; turning one off from a card would unload part of the studio a person did not mean to touch.
 * @module @delorun/plugin-theme/client/studio-rows
 */

/** The bundle whose card lists them. */
export const STUDIO_BUNDLE = '@delorun/bundle-studio'

/**
 * The rows of `@delorun/bundle-studio` a person turns on, in the order the bundle's card lists them.
 *
 * The bundle's patch inserts these two rows `disabled: true`; the bundle's `optionalRows` setting names the same two,
 * and `REACH_SHIPPED_ROWS` in `@delorun/home-auth` admits them to an approved device. A spec holds the three together.
 */
export const STUDIO_ROWS: readonly string[] = ['delorun-cost-meter', 'delorun-thinking-rsvp']

/**
 * Whether a row is one of the studio plugins this surface lists.
 * @param rowId - the row id as the bundle's patch declares it.
 * @returns whether the row is listed.
 */
export function isStudioRow(rowId: string): boolean {
  return STUDIO_ROWS.includes(rowId)
}
