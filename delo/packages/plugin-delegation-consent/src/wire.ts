/**
 * The studio's routes to the external-agent grants and the messages they carry, free of Cordis and Node so the
 * browser imports them.
 * @module @delo/plugin-delegation-consent/wire
 */

/** The exact routes under `/api`; each answers only the studio on the home's own computer. */
export const DELEGATION_CONSENT_ROUTES = {
  /** `GET`: every recorded grant, as {@link GrantsAnswer}. */
  grants: '/api/deloDelegationConsent.grants',
  /** `POST` {@link AllowWorkspaceRequest}: record a grant for an open chat's workspace, as {@link AllowWorkspaceAnswer}. */
  allow: '/api/deloDelegationConsent.allow',
  /** `POST` {@link RevokeRequest}: remove one grant, as {@link RevokeAnswer}. */
  revoke: '/api/deloDelegationConsent.revoke',
} as const

/** The largest request body a route reads, in bytes. */
export const MAX_DELEGATION_REQUEST_BYTES = 16_384

/** One recorded grant as a surface shows it. */
export interface GrantView {
  /** The workspace key. */
  readonly workspace: string
  /** The provider name, such as `claude-code`. */
  readonly provider: string
  /** The name a person knows the agent by, such as `Claude Code`. */
  readonly agent: string
  /** When the person allowed it, in milliseconds since the epoch. */
  readonly grantedAt: number
}

/** The answer of the grants route. */
export interface GrantsAnswer {
  /** The grants, sorted by workspace and provider; none while the file cannot be read. */
  readonly grants: readonly GrantView[]
  /** The problem of a grants file that cannot be read, when it cannot. */
  readonly storeProblem?: string
}

/** The request of the allow route: the chat whose workspace the grant covers. */
export interface AllowWorkspaceRequest {
  /** The open chat the approval card belongs to. */
  readonly sessionId: string
  /** The external provider the card asks about. */
  readonly provider: string
  /** The person confirmed; the route records nothing without it. */
  readonly confirmed: boolean
}

/** The answer of the allow route. */
export interface AllowWorkspaceAnswer {
  /** The recorded grant. */
  readonly grant: GrantView
}

/** The request of the revoke route. */
export interface RevokeRequest {
  /** The workspace key. */
  readonly workspace: string
  /** The provider name. */
  readonly provider: string
}

/** The answer of the revoke route. */
export interface RevokeAnswer {
  /** Whether a grant was removed; false when none was recorded. */
  readonly revoked: boolean
}

/** Why a surface call recorded nothing. */
export type DelegationRefusalCode =
  | 'INVALID_REQUEST'
  | 'UNCONFIRMED'
  | 'UNKNOWN_CHAT'
  | 'UNKNOWN_AGENT'
  | 'NO_WORKSPACE'
  | 'UNKNOWN_WORKSPACE'
  | 'STORE_REFUSED'
