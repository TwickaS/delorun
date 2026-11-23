/**
 * The refusal of a write to a profile's files.
 *
 * @module @delorun/setup-apply/errors
 */

/**
 * A profile file this package reads or rewrites is not one it can use, or a write precondition does not hold. The
 * message names the command or route and the file, is complete as a sentence, and never holds a value read from a
 * secret. The `delorun` command reports it as it reports its own failures, with exit code 1; a route answers it as a
 * refusal.
 */
export class SetupApplyError extends Error {
  /** @param message - what went wrong and what to do. */
  constructor(message: string) {
    super(message)
    this.name = 'SetupApplyError'
  }
}
