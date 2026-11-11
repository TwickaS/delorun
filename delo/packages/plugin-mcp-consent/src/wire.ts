/**
 * The studio's routes to the stdio MCP servers the add-time consent holds stopped, and their JSON messages. Every route
 * is an exact Connection Fetch route under `/api`, which upstream's connection serves only to the studio's own owner
 * session; this plugin also answers each only to a request that arrived on the loopback listener, and a reach device is
 * refused with `403 LOOPBACK_REQUIRED` before the body is read. A refusal is
 * `{ "error": "<CODE>", "message": "<sentence>" }`.
 *
 * Free of every import, so the studio's browser half inlines it.
 *
 * @module @delo/plugin-mcp-consent/wire
 */

/** The routes. The studio fetches each from the page's own origin. */
export const MCP_CONSENT_ROUTES = {
  /** `GET`: {@link PendingServersAnswer}, the servers waiting for the person's answer. */
  pending: '/api/deloMcpConsent.pending',
  /** `POST` {@link AcceptServerRequest}: {@link AcceptServerAnswer}, after the review's start is accepted. */
  accept: '/api/deloMcpConsent.accept',
  /** `POST` {@link DeclineServerRequest}: {@link DeclineServerAnswer}, after the review is set aside. */
  decline: '/api/deloMcpConsent.decline',
} as const

/** The largest request body the routes read, in bytes. */
export const MAX_MCP_CONSENT_REQUEST_BYTES = 1024

/** A server name as the mcp-client's configuration admits it. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * The refusal codes of the routes besides `LOOPBACK_REQUIRED`:
 *
 * - `INVALID_REQUEST`: the body is not the route's JSON message (400).
 * - `UNCONFIRMED`: an acceptance without `confirmed: true`, which the person's answer sets (400).
 * - `STALE_REVIEW`: the server has no pending review with that id: its start was reviewed again since, accepted or set
 *   aside, so the answer was given to a screen that no longer shows it (409).
 * - `STORE_REFUSED`: the acceptance store cannot be read or written, so nothing is accepted (500).
 */
export const MCP_CONSENT_REFUSAL_CODES = ['INVALID_REQUEST', 'UNCONFIRMED', 'STALE_REVIEW', 'STORE_REFUSED'] as const

/** One code of {@link MCP_CONSENT_REFUSAL_CODES}. */
export type McpConsentRefusalCode = typeof MCP_CONSENT_REFUSAL_CODES[number]

/** One stdio server whose start the consent refused, as a surface shows it before the person answers. */
export interface PendingServer {
  /** The server's configured name. */
  readonly serverName: string
  /** The id an answer to this review carries; a new review of the server's start gets a new id. */
  readonly reviewId: string
  /** The configured executable. */
  readonly command: string
  /** The configured arguments, in order. */
  readonly args: readonly string[]
  /** The configured working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The names of the configured environment variables, sorted; their values are never shown. */
  readonly envNames: readonly string[]
  /** Why the consent refused the start: no acceptance, or what changed since the last one. */
  readonly reason: string
  /** When the start was reviewed, in milliseconds since the epoch. */
  readonly reviewedAt: number
}

/** What `GET` {@link MCP_CONSENT_ROUTES}`.pending` answers. */
export interface PendingServersAnswer {
  /** The pending reviews, sorted by server name. */
  readonly servers: readonly PendingServer[]
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.accept` takes. */
export interface AcceptServerRequest {
  readonly serverName: string
  /** The review id the start was shown with. */
  readonly reviewId: string
  /** The person's answer: true only after the person confirmed the start. */
  readonly confirmed: boolean
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.accept` answers. */
export interface AcceptServerAnswer {
  /** How many stopped server rows started again with the acceptance; 0 when none could, and the next start runs them. */
  readonly started: number
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.decline` takes. */
export interface DeclineServerRequest {
  readonly serverName: string
  /** The review id the start was shown with. */
  readonly reviewId: string
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.decline` answers. */
export interface DeclineServerAnswer {
  readonly declined: true
}
