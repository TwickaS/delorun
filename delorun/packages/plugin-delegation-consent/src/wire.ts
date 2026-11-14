/**
 * The studio's routes to the external-agent grants, the messages they carry, and the fields of the plugin's row that
 * Settings writes, free of Cordis and Node so the browser imports them.
 * @module @delorun/plugin-delegation-consent/wire
 */

/** The exact routes under `/api`; each answers only the studio on the home's own computer. */
export const DELEGATION_CONSENT_ROUTES = {
  /** `GET`: every recorded grant, as {@link GrantsAnswer}. */
  grants: '/api/delorunDelegationConsent.grants',
  /** `POST` {@link AllowWorkspaceRequest}: record a grant for an open chat's workspace, as {@link AllowWorkspaceAnswer}. */
  allow: '/api/delorunDelegationConsent.allow',
  /** `POST` {@link RevokeRequest}: remove one grant, as {@link RevokeAnswer}. */
  revoke: '/api/delorunDelegationConsent.revoke',
} as const

/** The row id `@delorun/bundle-local` inserts for the plugin, whose fields Settings → External agents writes. */
export const DELEGATION_CONSENT_ROW = 'delorun-delegation-consent'

/** The fields of the plugin's row that Settings → External agents writes. */
export interface DelegationConsentSettings {
  /** Whether the consent asks before each external agent run ([`Config`](./index.ts)). */
  readonly enabled: boolean
  /** How long one external agent run may take before it is stopped, in whole minutes; a change applies from the next run. */
  readonly runTimeoutMinutes: number
}

/** The run time limit's bounds and default, in whole minutes: one minute to one day. */
export const RUN_TIMEOUT_MINUTES = { min: 1, max: 24 * 60, default: 30 } as const

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
