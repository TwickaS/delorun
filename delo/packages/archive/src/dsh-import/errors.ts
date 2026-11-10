/**
 * The refusals of the stock-home import (contract C8, "The stock-home
 * import"). A stock DeepSeek Harness home is a different source form from an
 * archive, so its refusals carry the closed set defined here. A refusal raised
 * before publication writes nothing into the Delo home, and one raised while
 * publishing is raised after every file the import placed was withdrawn. Every
 * message names a home-relative path, never an absolute host path and never a
 * credential value.
 *
 * @module @delo/archive/dsh-import/errors
 */

/** The codes a stock-home import refuses with. */
export const DSH_IMPORT_ERROR_CODES = [
  'DSH_IMPORT_SOURCE_UNUSABLE',
  'DSH_IMPORT_HOME_HAS_CHATS',
  'DSH_IMPORT_ID_COLLISION',
  'DSH_IMPORT_TOO_MANY_ENTRIES',
  'DSH_IMPORT_ENTRY_TOO_LARGE',
  'DSH_IMPORT_TOTAL_TOO_LARGE',
  'DSH_IMPORT_SOURCE_CHANGED',
  'DSH_IMPORT_TARGET_REFUSED',
  'DSH_IMPORT_REGISTRY_REFUSED',
  'DSH_IMPORT_CREDENTIALS_REFUSED',
  'DSH_IMPORT_STAGING_FAILED',
] as const

/** One code of {@link DSH_IMPORT_ERROR_CODES}. */
export type DshImportErrorCode = (typeof DSH_IMPORT_ERROR_CODES)[number]

/**
 * A refusal of the stock-home import. `subject` names the home-relative path
 * the refusal is about, or is `undefined` when it is about a home as a whole.
 */
export class DshImportError extends Error {
  /** The code that names this refusal. */
  readonly code: DshImportErrorCode

  /** The home-relative path this refusal names, or `undefined`. */
  readonly subject: string | undefined

  /**
   * @param code - the code that names the refusal.
   * @param message - what was refused and what the person can do, in one or two sentences.
   * @param subject - the home-relative path the refusal names.
   */
  constructor(code: DshImportErrorCode, message: string, subject?: string) {
    super(message)
    this.name = 'DshImportError'
    this.code = code
    this.subject = subject
  }
}

/**
 * Whether a value is a {@link DshImportError}.
 * @param error - the value to inspect.
 * @returns true when the value is a stock-home import refusal.
 */
export function isDshImportError(error: unknown): error is DshImportError {
  return error instanceof DshImportError
}

/**
 * The system error code a failure carries, for a message that names the reason without a host path.
 * @param error - the failure.
 * @returns its string `code`, or `unexpected error` when it carries none.
 */
export function systemCode(error: unknown): string {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'unexpected error'
}
