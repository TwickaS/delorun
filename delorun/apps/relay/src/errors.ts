/**
 * The typed refusals of the relay data plane: the token, handshake, frame and stall codes of
 * C6's error table (`delorun/docs/contracts/c06-relay-protocol.md`), the HTTP status each token
 * refusal answers with, the WebSocket close code each tunnel refusal closes with, and the
 * relay's own configuration refusals. A refusal names the refused value or the reason and
 * never carries a token, a signature or a secret.
 *
 * @module @delorun/relay/errors
 */
import { RELAY_HTTP_ERRORS, TUNNEL_CLOSE_CODES } from '@delorun/contract-relay-protocol'

/** A token refusal code, the ones C6's error table answers on the token and tunnel paths. */
export type RelayHttpErrorCode = keyof typeof RELAY_HTTP_ERRORS

/** A tunnel refusal code, the ones C6's error table closes a tunnel with. */
export type RelayCloseErrorCode = keyof typeof TUNNEL_CLOSE_CODES

/**
 * Every code a refusal carries: C6's thirteen, the upgrade refusal C6 requires without naming
 * a code, and the relay's own start and configuration refusals.
 */
export type RelayErrorCode =
  | RelayHttpErrorCode
  | RelayCloseErrorCode
  | 'SUBPROTOCOL_MISSING'
  | 'CONFIG_INVALID'
  | 'CONFIG_UNREADABLE'
  | 'TOKEN_KEY_UNPROTECTED'

/** The WebSocket close code of each tunnel refusal; the others close no tunnel. */
const CLOSE_CODES: Readonly<Partial<Record<RelayErrorCode, number>>> = {
  PROTOCOL_ERROR: TUNNEL_CLOSE_CODES.PROTOCOL_ERROR,
  PROOF_INVALID: TUNNEL_CLOSE_CODES.PROOF_INVALID,
  HANDSHAKE_TIMEOUT: TUNNEL_CLOSE_CODES.HANDSHAKE_TIMEOUT,
  TUNNEL_ALREADY_LIVE: TUNNEL_CLOSE_CODES.TUNNEL_ALREADY_LIVE,
  REBOUND: TUNNEL_CLOSE_CODES.REBOUND,
  FRAME_TOO_LARGE: TUNNEL_CLOSE_CODES.FRAME_TOO_LARGE,
}

/**
 * A refusal of the relay, carrying its code and, when it has one, the reason a person reads.
 */
export class RelayError extends Error {
  /** The contract's code, or the relay's own for a start refusal. */
  readonly code: RelayErrorCode
  /** The refused value or the reason; never a token, a signature or a secret. */
  readonly detail: string | undefined

  /**
   * @param code - the contract's code, or the relay's own for a start refusal.
   * @param detail - the refused value or the reason, never a token, a signature or a secret.
   */
  constructor(code: RelayErrorCode, detail?: string) {
    super(detail === undefined ? code : `${code}: ${detail}`)
    this.name = 'RelayError'
    this.code = code
    this.detail = detail
  }
}

/**
 * Whether a value is a refusal of this module's type, as opposed to a programming error.
 * @param error - any thrown value.
 * @returns true for a {@link RelayError}.
 */
export function isRelayError(error: unknown): error is RelayError {
  return error instanceof RelayError
}

/**
 * The HTTP status a refusal answers with on a token or tunnel path.
 * @param code - the refusal code.
 * @returns C6's status, or `undefined` when the code refuses no HTTP request.
 */
export function httpStatusOf(code: RelayErrorCode): number | undefined {
  return code in RELAY_HTTP_ERRORS ? RELAY_HTTP_ERRORS[code as RelayHttpErrorCode] : undefined
}

/**
 * The WebSocket close code a refusal closes a tunnel with.
 * @param code - the refusal code.
 * @returns C6's close code, or `undefined` when the code closes no tunnel.
 */
export function closeCodeOf(code: RelayErrorCode): number | undefined {
  return CLOSE_CODES[code]
}
