/**
 * The typed failures of `@delo/logs`: a log path refused by C1's refusal rule, an invalid profile name, and a write
 * that could not reach the log file.
 *
 * @module @delo/logs/errors
 */
import type { HomeLayoutErrorCode } from '@delo/contract-home-layout'

/** Error codes `@delo/logs` raises: C1's two mode refusals, an invalid profile name and a failed write. */
export type LogsErrorCode = Extract<HomeLayoutErrorCode, 'HOME_MODE' | 'SECRET_FILE_MODE'> | 'PROFILE_INVALID' | 'LOG_WRITE_FAILED'

/** A log operation that failed, with the path it concerns and, for a mode refusal, the command that fixes it. */
export class LogsError extends Error {
  override readonly name = 'LogsError'

  /**
   * @param code - what failed.
   * @param message - the report, naming the path.
   * @param path - the path concerned, when one is.
   * @param fix - the command that fixes a refused path, such as `chmod 600 <path>`.
   * @param options - the underlying failure.
   */
  constructor(
    readonly code: LogsErrorCode,
    message: string,
    readonly path?: string,
    readonly fix?: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}
