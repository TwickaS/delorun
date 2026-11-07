/**
 * The typed refusal every supervisor operation raises: one of contract C9's error codes and a detail that names
 * the refused value, never a secret. The server turns it into one failed response line.
 *
 * @module @delo/supervisor/errors
 */
import type { SupervisorErrorCode, SupervisorFailure } from '@delo/contract-runtime-supervisor'

/** A refusal or failure with C9's error code (`delo/docs/contracts/c09-runtime-supervisor.md`, "Errors"). */
export class SupervisorError extends Error {
  /**
   * @param code - C9's error code.
   * @param detail - the refused value or the reason, never a secret, token, credential or environment value.
   */
  constructor(readonly code: SupervisorErrorCode, readonly detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'SupervisorError'
  }

  /**
   * The failed response line's fields.
   * @returns the failure, with `detail` when the error has one.
   */
  toFailure(): SupervisorFailure {
    return this.detail === undefined ? { ok: false, error: this.code } : { ok: false, error: this.code, detail: this.detail }
  }
}
