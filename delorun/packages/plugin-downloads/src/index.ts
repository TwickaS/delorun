/**
 * @delorun/plugin-downloads — the downloads panel is a studio feature; this harness half only names the plugin so the
 * plugin manager can install and list it. The panel's data comes from the install queue's remote actions, which
 * `@delorun/plugin-packs` provides.
 * @module @delorun/plugin-downloads
 */

/** The plugin's name in logs. */
export const name = 'delorun-downloads'

/** The harness half needs no services. */
export const inject: string[] = []

/** The harness half registers nothing. */
export function apply(): void {}
