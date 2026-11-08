/**
 * The refusal type of the archive package. Every refusal carries one code from
 * contract C8's error table, and a message that is local: it names the entry
 * that was refused, never an absolute path outside the archive and never a
 * host directory.
 *
 * @module @delo/archive/errors
 */
import type { ArchiveErrorCode } from '@delo/contract-archive-and-trash'

/**
 * A refusal of the archive format v1. A refusal writes nothing: the import
 * raises it before the first staged file exists, so a caller never has to undo
 * a partial import.
 */
export class ArchiveError extends Error {
  /** The code of contract C8's error table that names this refusal. */
  readonly code: ArchiveErrorCode

  /**
   * @param code - the code of contract C8's error table.
   * @param message - what was refused, in one sentence.
   */
  constructor(code: ArchiveErrorCode, message: string) {
    super(message)
    this.name = 'ArchiveError'
    this.code = code
  }
}

/**
 * Whether a value is an {@link ArchiveError}.
 * @param error - the value to inspect.
 * @returns true when the value is an archive refusal.
 */
export function isArchiveError(error: unknown): error is ArchiveError {
  return error instanceof ArchiveError
}
