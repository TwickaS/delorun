/**
 * Host entry of Delorun's Settings layout. The layout is browser-only; this half
 * mounts nothing, and exists because the studio loads a package's `./client`
 * module for the Loader row that names the package.
 * @module @delorun/plugin-settings-layout
 */

/** Mount nothing: the layout lives in the browser. */
export function apply(): void {}
