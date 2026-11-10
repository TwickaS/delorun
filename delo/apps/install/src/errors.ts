/**
 * The typed failure of every step of the install path: contract C1's `DOWNLOAD_REFUSED` and
 * `INSTALL_VERIFY_FAILED`, and the codes this package adds where the contracts name none. A caller stops the install
 * on any of them; none of them leaves a file under `~/.delo/runtimes/`.
 *
 * @module @delo/install/errors
 */
import type { HomeLayoutErrorCode } from '@delo/contract-home-layout'

/** The C1 codes the install path raises. */
export type InstallLayoutCode = Extract<HomeLayoutErrorCode, 'DOWNLOAD_REFUSED' | 'INSTALL_VERIFY_FAILED'>

/**
 * Every code an {@link InstallError} carries.
 *
 * - C1's `DOWNLOAD_REFUSED`: a URL that is not HTTPS, names a host outside contract C1's list, or redirects to one.
 * - C1's `INSTALL_VERIFY_FAILED`: a signature, digest or length check of contract C2 failed.
 * - `DOWNLOAD_FAILED`: a connection that did not open or stalled, a response other than 200, a file above its limit,
 *   or a file that cannot be created, written to completion or closed.
 * - `ARCHIVE_REFUSED`: the archive holds an entry its format forbids or its signed file list does not name.
 * - `RELEASE_LOG_FAILED`: contract C18's bundle or online check failed verifiably. An online check that could not run
 *   is not an error: the install warns and records it.
 * - `RELEASE_NOT_OFFERED`: the requested version is not the release the fresh timestamp names for the channel.
 * - `RELEASE_METADATA_INVALID`: a release file does not read at all, such as a timestamp that is not JSON.
 * - `TRUST_STATE_INVALID`: a stored root, timestamp or log checkpoint under `trust/` does not read.
 * - `NO_TRUSTED_ROOT`: the caller supplied no root to trust, so nothing can be verified.
 */
export type InstallErrorCode =
  | InstallLayoutCode
  | 'DOWNLOAD_FAILED'
  | 'ARCHIVE_REFUSED'
  | 'RELEASE_LOG_FAILED'
  | 'RELEASE_NOT_OFFERED'
  | 'RELEASE_METADATA_INVALID'
  | 'TRUST_STATE_INVALID'
  | 'NO_TRUSTED_ROOT'

/** A refusal or failure of one step of an install. */
export class InstallError extends Error {
  override readonly name = 'InstallError'

  /**
   * @param code - the failure's code.
   * @param source - the URL or path the failure concerns.
   * @param detail - what is wrong, naming the host, file or version; the message is the code and this.
   * @param options - the underlying error.
   */
  constructor(
    readonly code: InstallErrorCode,
    readonly source: string,
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${detail}`, options)
  }
}

/**
 * Whether a value is an {@link InstallError} with one of the given codes.
 * @param error - the value.
 * @param codes - the codes; none matches any {@link InstallError}.
 * @returns true when it is one.
 */
export function isInstallError(error: unknown, ...codes: readonly InstallErrorCode[]): error is InstallError {
  return error instanceof InstallError && (codes.length === 0 || codes.includes(error.code))
}

/**
 * The message of an unknown failure, for a detail that names what happened.
 * @param error - the value thrown.
 * @returns its message, or its text.
 */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
