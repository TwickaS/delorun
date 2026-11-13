/**
 * @delo/plugin-thinking-rsvp — the Thinking tab, which is browser-only. This half mounts nothing; it exists because the
 * studio loads a package's `./client` module for the row that names the package.
 * @module @delo/plugin-thinking-rsvp
 */

/** The plugin's name in logs. */
export const name = 'delo-thinking-rsvp'

/** Mount nothing: the Thinking tab lives in the browser. */
export function apply(): void {}
