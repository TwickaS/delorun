/**
 * @delorun/plugin-multiview — Multiview, which is browser-only. This half mounts nothing; it exists because the
 * studio loads a package's `./client` module for the row that names the package.
 * @module @delorun/plugin-multiview
 */

/** The plugin's name in logs. */
export const name = 'delorun-multiview'

/** Mount nothing: Multiview lives in the browser. */
export function apply(): void {}
