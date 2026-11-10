/**
 * The typed failures of `@delo/logs`: an invalid profile name and a write or change that could not reach a log
 * file. A log directory or file that C1's refusal rule refuses fails with `@delo/home`'s `HomeLayoutError`.
 *
 * @module @delo/logs/errors
 */
import { HomeLayoutError } from '@delo/home'

/** Error codes `@delo/logs` raises: an invalid profile name and a failed write or change. */
export type LogsErrorCode = 'PROFILE_INVALID' | 'LOG_WRITE_FAILED'

/** A log operation that failed, with the path it concerns. */
export class LogsError extends Error {
  override readonly name = 'LogsError'

  /** What failed. */
  readonly code: LogsErrorCode
  /** The path concerned, when one is. */
  readonly path?: string | undefined

  /**
   * @param code - what failed.
   * @param message - the report, naming the path.
   * @param path - the path concerned, when one is.
   * @param options - the underlying failure.
   */
  constructor(
    code: LogsErrorCode,
    message: string,
    path?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.code = code
    this.path = path
  }
}

/** A failure a log operation reports: its own, or C1's refusal of a log directory or file. */
export type LogsFailure = LogsError | HomeLayoutError

/**
 * Whether a thrown value is a typed log failure.
 * @param error - the thrown value.
 * @returns whether it is a {@link LogsError} or a `HomeLayoutError`.
 */
export function isLogsFailure(error: unknown): error is LogsFailure {
  return error instanceof LogsError || error instanceof HomeLayoutError
}
