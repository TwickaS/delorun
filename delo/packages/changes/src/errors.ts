/**
 * The typed failure of every Changes operation: one closed code, the path or subject it concerns, and the detail the
 * person reads.
 *
 * @module @delo/changes/errors
 */
import { codedReason, profileOption, refusalDescriber, type RefusalDescriber } from '@delo/home'

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
 * - `NOT_AT_COMPUTER`: the action needs the person at their computer, and the caller is not a terminal.
 * - `NOT_LINKED`: the plugin is not one the profile links from a folder, or the name is not a package name.
 * - `WORK_SESSION_OPEN`: a work session is already open.
 * - `NO_WORK_SESSION`: no work session is open for the plugin.
 * - `RUNTIME_CHANGED`: the runtime in use differs from its signed file list under Block.
 * - `INVALID_REQUEST`: an agent's plugin request names no spec pnpm accepts, or no plugin of the profile to remove; or a
 *   harness path names no runtime version or no file under the runtime's `app/` directory.
 * - `OPERATION_FAILED`: upstream's plugin operation for an applied plugin request failed; nothing was applied.
 * - `CONTENT_TOO_LARGE`: a folder, with the installed packages it links, holds more than a content version may
 *   ([tree](./tree.ts)), so Changes does not copy it.
 * - `LOAD_REFUSED`: what the profile would load is not what Changes keeps (a link or an active directory differs), so a
 *   start or a reload does not load it.
 * - `HARNESS_CHANGED`: the composed tree a start runs, the signed release with the person's approved harness files in
 *   place, holds a file that is not the signed or the approved one, so the start does not run it.
 * - `HARNESS_CHANGES_PENDING`: changes to the running runtime's harness wait for review in its writable copy, so an
 *   update, which would leave them behind in that runtime's copy, does not apply.
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
  | 'INVALID_REQUEST'
  | 'OPERATION_FAILED'
  | 'CONTENT_TOO_LARGE'
  | 'LOAD_REFUSED'
  | 'HARNESS_CHANGED'
  | 'HARNESS_CHANGES_PENDING'

/** A refusal or failure of Changes. */
export class ChangesError extends Error {
  /** The closed code. */
  readonly code: ChangesCode
  /** The path, plugin or change id it concerns. */
  readonly subject: string
  /** What the person reads. */
  readonly detail: string

  /**
   * @param code - the closed code.
   * @param subject - the path, plugin or change id it concerns.
   * @param detail - what the person reads.
   * @param options - the underlying error.
   */
  constructor(code: ChangesCode, subject: string, detail: string, options?: ErrorOptions) {
    super(detail, options)
    this.name = 'ChangesError'
    this.code = code
    this.subject = subject
    this.detail = detail
  }
}

/**
 * @param error - any thrown value.
 * @returns whether it is a {@link ChangesError}.
 */
export function isChangesError(error: unknown): error is ChangesError {
  return error instanceof ChangesError
}

/**
 * How `delorun` prints a {@link ChangesError}: nothing was changed, the code and the detail, and the command that shows
 * the current state of the changes.
 */
export const changesDescriber: RefusalDescriber<ChangesError> = refusalDescriber(ChangesError, (error, context) => ({
  lead: 'Delo did not change what your harness runs.',
  reason: codedReason(error.code, error.detail),
  remedies: [`See your changes: delorun changes list${profileOption(context)}`],
}))
