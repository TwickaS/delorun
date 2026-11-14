/**
 * Error text for `studio-browser` reports.
 *
 * @module @delorun/tools/studio-browser/message
 */

/**
 * The text to report for a caught value.
 * @param error - the caught value.
 * @returns its message when it is an `Error`, else its string form.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
