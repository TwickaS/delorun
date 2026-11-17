/**
 * The typed failures the Claude Code driver throws, each with a fixed code and a sentence for the person's view.
 * @module @delorun/agent-claude-code/errors
 */

/** Why the driver refused a call. */
export type ClaudeCodeDriverErrorCode =
  /** The SDK could not be found in upstream's Claude Code package, or failed to load. */
  | 'sdk-missing'
  /** The SDK found is not the version this driver was tested with. */
  | 'sdk-version'
  /** `send(…, 'start')` while a turn runs. */
  | 'turn-running'
  /** `send(…, 'steer')` while no turn runs. */
  | 'no-turn'
  /** The session was closed. */
  | 'closed'
  /** The open request carried harness tools, which this driver does not offer yet. */
  | 'harness-tools'

/** A typed failure of the Claude Code driver. */
export class ClaudeCodeDriverError extends Error {
  /** Why the call was refused. */
  readonly code: ClaudeCodeDriverErrorCode

  /**
   * @param code - why the call was refused.
   * @param message - the sentence for the person's view; it names no credential.
   * @param options - the underlying cause, if any.
   */
  constructor(code: ClaudeCodeDriverErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeCodeDriverError'
    this.code = code
  }
}
