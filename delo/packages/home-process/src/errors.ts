/**
 * The typed refusal every home-process operation raises: one of contract C19's error codes and a detail that names
 * the refused value or the reason, never a token or a secret. The update channel turns it into one failed response
 * line; an `UNAUTHENTICATED` line carries no detail.
 *
 * @module @delo/home-process/errors
 */
import type { HomeProcessErrorCode } from '@delo/contract-home-process'

/** A failed response line. */
export interface HomeProcessFailure {
  /** Always false. */
  readonly ok: false
  /** C19's error code. */
  readonly error: HomeProcessErrorCode
  /** The reason, for a person reading the line; absent on `UNAUTHENTICATED`. */
  readonly detail?: string
}

/** A refusal or failure with C19's error code (`delo/docs/contracts/c19-home-process.md`, "Errors"). */
export class HomeProcessError extends Error {
  /**
   * @param code - C19's error code.
   * @param detail - the refused value or the reason, never a token or a secret.
   */
  constructor(readonly code: HomeProcessErrorCode, readonly detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'HomeProcessError'
  }

  /**
   * The failed response line's fields.
   * @returns the failure, with `detail` when the error has one and is not `UNAUTHENTICATED`.
   */
  toFailure(): HomeProcessFailure {
    return this.detail === undefined || this.code === 'UNAUTHENTICATED' ? { ok: false, error: this.code } : { ok: false, error: this.code, detail: this.detail }
  }
}

/**
 * The codes of a rollback refused before any step, with nothing changed: C3's table refusing, the version to return
 * to being unusable, another user of the chat data, and a git the profile history cannot run.
 */
export const ROLLBACK_REFUSALS: ReadonlySet<HomeProcessErrorCode> = new Set(['ROLLBACK_NEEDS_DATA_COPY', 'ROLLBACK_TARGET_UNUSABLE', 'CHATS_RUNNING', 'GIT_UNAVAILABLE'])

/**
 * Whether an error is a rollback refused before any step.
 * @param error - the error.
 * @returns true for a {@link HomeProcessError} whose code is in {@link ROLLBACK_REFUSALS}.
 */
export function isRollbackRefusal(error: unknown): boolean {
  return error instanceof HomeProcessError && ROLLBACK_REFUSALS.has(error.code)
}
