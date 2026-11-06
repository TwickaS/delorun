/**
 * The typed failure every home-layout check raises, carrying contract C1's
 * error code, the path it concerns and, where one exists, the command that
 * fixes it.
 *
 * @module @delo/cli/home/errors
 */
import type { HomeLayoutErrorCode } from '@delo/contract-home-layout'

/** A refusal or failure defined by contract C1 (`delo/docs/contracts/c01-home-layout.md`). */
export class HomeLayoutError extends Error {
  /**
   * @param code - C1's error code.
   * @param path - the absolute path the failure concerns.
   * @param message - what is wrong with the path, without the fix.
   * @param fix - the shell command that fixes it, such as `chmod 600 <path>`, when one exists.
   */
  constructor(
    readonly code: HomeLayoutErrorCode,
    readonly path: string,
    message: string,
    readonly fix?: string,
  ) {
    super(`${code}: ${message}${fix === undefined ? '' : `; fix it with: ${fix}`}`)
    this.name = 'HomeLayoutError'
  }
}

/**
 * Quote a path for a POSIX shell command when it holds characters the shell would split or expand.
 * @param path - the path.
 * @returns the path, single-quoted when needed.
 */
export function shellPath(path: string): string {
  return /^[\w@%+=:,./-]+$/.test(path) ? path : `'${path.replaceAll('\'', '\'\\\'\'')}'`
}
