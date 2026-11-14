/**
 * What the changelog commands print to, and how they describe a failure.
 *
 * @module @delorun/release/changelog/output
 */

/** Where a command writes its lines. */
export interface Output {
  /** Prints a line to standard output. */
  readonly log: (line: string) => void
  /** Prints a line to standard error. */
  readonly error: (line: string) => void
}

/**
 * A caught value as one line of text.
 * @param error - the caught value.
 * @returns the message of an Error, otherwise the value as text; an Error's cause follows after a colon.
 */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause === undefined ? error.message : `${error.message}: ${messageOf(error.cause)}`
}
