/**
 * The batch tool's typed failure: a refusal before anything changes, a git step that failed, a state file that cannot be
 * read, or an argument that would let a commit reach the trunk without the merge tier.
 *
 * @module @delorun/tools/batch/errors
 */

/** What stopped the batch tool. */
export type BatchErrorCode =
  /** The command line is malformed. */
  | 'usage'
  /** The integrator worktree has uncommitted or untracked changes. */
  | 'dirty-tree'
  /** HEAD is detached and the batch did not detach it. */
  | 'detached'
  /** A lane branch names no commit. */
  | 'unknown-lane'
  /** The candidate branch of a new batch already exists. */
  | 'branch-exists'
  /** `--resume` names a batch with no readable state. */
  | 'state'
  /** A git command the batch depends on failed. */
  | 'git'
  /** A process would have received an argument or variable that bypasses the merge tier. */
  | 'forbidden-argument'
  /** The pre-push hook or its configuration is missing, or a variable would bypass it. */
  | 'hooks-bypassed'

/** A failure the batch tool reports as `delorun batch: <message>` and exit status 2. */
export class BatchError extends Error {
  /** Which failure this is. */
  readonly code: BatchErrorCode

  /**
   * @param code - which failure this is.
   * @param message - what happened and what to do, for the integrator.
   */
  constructor(code: BatchErrorCode, message: string) {
    super(message)
    this.name = 'BatchError'
    this.code = code
  }
}
