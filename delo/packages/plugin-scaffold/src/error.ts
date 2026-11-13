/**
 * The refusal of a scaffold: `usage` for a name or kind the caller can correct, `failed` for a folder, installation or
 * write the caller cannot.
 *
 * @module @delo/plugin-scaffold/error
 */

/** Which kind of refusal a {@link ScaffoldError} is. */
export type ScaffoldErrorKind = 'usage' | 'failed'

/** A scaffold that was refused or failed; the message names the cause and the correction, without a command prefix. */
export class ScaffoldError extends Error {
  readonly kind: ScaffoldErrorKind

  /**
   * @param kind - the refusal's kind.
   * @param message - what is wrong and what to do.
   */
  constructor(kind: ScaffoldErrorKind, message: string) {
    super(message)
    this.kind = kind
    this.name = 'ScaffoldError'
  }
}
