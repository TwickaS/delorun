/**
 * The typed failure of every Changes operation: one closed code, the path or subject it concerns, and the detail the
 * person reads.
 *
 * @module @delo/changes/errors
 */

/**
 * Every code a {@link ChangesError} carries.
 *
 * - `RECORD_UNREADABLE`: a record of Changes exists but is not one Delo wrote (bad JSON, schema tag, field or mode),
 *   so nothing decides from it.
 * - `STORE_CORRUPT`: an object or version file in the store does not hold what its name says.
 * - `CHANGED_WHILE_READING`: a folder changed while it was read, so what was read is not one state of it.
 * - `CHANGED_SINCE_REVIEW`: the folder no longer holds the content the change id names.
 * - `UNKNOWN_CHANGE`: no change has the id.
 * - `NOT_ALLOWED`: the change's state does not allow the action, such as applying a discarded change.
 * - `NOT_AT_COMPUTER`: the action needs the person at their computer, and the caller is not a terminal or the
 *   loopback studio.
 * - `NOT_LINKED`: the plugin is not one the profile links from a folder.
 * - `WORK_SESSION_OPEN`: a work session is already open.
 * - `NO_WORK_SESSION`: no work session is open for the plugin.
 * - `RUNTIME_CHANGED`: the runtime in use differs from its signed file list under Block.
 */
export type ChangesCode =
  | 'RECORD_UNREADABLE'
  | 'STORE_CORRUPT'
  | 'CHANGED_WHILE_READING'
  | 'CHANGED_SINCE_REVIEW'
  | 'UNKNOWN_CHANGE'
  | 'NOT_ALLOWED'
  | 'NOT_AT_COMPUTER'
  | 'NOT_LINKED'
  | 'WORK_SESSION_OPEN'
  | 'NO_WORK_SESSION'
  | 'RUNTIME_CHANGED'

/** A refusal or failure of Changes. */
export class ChangesError extends Error {
  /**
   * @param code - the closed code.
   * @param subject - the path, plugin or change id it concerns.
   * @param detail - what the person reads.
   * @param options - the underlying error.
   */
  constructor(readonly code: ChangesCode, readonly subject: string, readonly detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'ChangesError'
  }
}

/**
 * @param error - any thrown value.
 * @returns whether it is a {@link ChangesError}.
 */
export function isChangesError(error: unknown): error is ChangesError {
  return error instanceof ChangesError
}
