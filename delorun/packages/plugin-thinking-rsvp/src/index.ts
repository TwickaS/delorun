/**
 * @delorun/plugin-thinking-rsvp — the Thinking tab, which is browser-only. This half mounts nothing; it exists because the
 * studio loads a package's `./client` module for the row that names the package.
 * @module @delorun/plugin-thinking-rsvp
 */

/** The plugin's name in logs. */
export const name = 'delorun-thinking-rsvp'

/** Mount nothing: the Thinking tab lives in the browser. */
export function apply(): void {}
