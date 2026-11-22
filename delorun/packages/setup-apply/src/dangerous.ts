/**
 * Whether dangerous mode is refused to this process: it runs as root.
 *
 * @module @delorun/setup-apply/dangerous
 */

/**
 * Whether this process runs as the root user.
 * @returns true when the effective user id is 0; false on a platform without user ids.
 */
export function runsAsRoot(): boolean {
  return process.getuid?.() === 0
}
