/**
 * The studio's routes to the stdio MCP servers the add-time consent holds stopped or has accepted, and their JSON
 * messages. Every route is an exact Connection Fetch route under `/api`, which upstream's connection serves to the
 * studio's owner session. A reach device may read only {@link MCP_CONSENT_ROUTES}`.waiting`, the names of the servers that
 * wait, so a phone says the answer is given at the computer; every other route is refused to it, and to any request
 * that did not arrive on the loopback listener, with `403 LOOPBACK_REQUIRED` before the body is read. A refusal is
 * `{ "error": "<CODE>", "message": "<sentence>" }`.
 *
 * Free of every import, so the studio's browser half inlines it.
 *
 * @module @delo/plugin-mcp-consent/wire
 */

/** The routes. The studio fetches each from the page's own origin. */
export const MCP_CONSENT_ROUTES = {
  /** `GET`: {@link PendingServersAnswer}, the servers waiting for the person's answer and the accepted ones. */
  pending: '/api/deloMcpConsent.pending',
  /** `GET`: {@link WaitingServersAnswer}, the names of the servers waiting for the person's answer; a reach device may read it. */
  waiting: '/api/deloMcpConsent.waiting',
  /** `POST` {@link AcceptServerRequest}: {@link AcceptServerAnswer}, after the review's start is accepted. */
  accept: '/api/deloMcpConsent.accept',
  /** `POST` {@link DeclineServerRequest}: {@link DeclineServerAnswer}, after the review is set aside. */
  decline: '/api/deloMcpConsent.decline',
  /** `POST` {@link RevokeServerRequest}: {@link RevokeServerAnswer}, after an acceptance is withdrawn. */
  revoke: '/api/deloMcpConsent.revoke',
} as const

/** The largest request body the routes read, in bytes. */
export const MAX_MCP_CONSENT_REQUEST_BYTES = 8192

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

/**
 * What a pending review asks about: a server the person never accepted (`new`), a start whose arguments, working
 * directory or environment differ from the one the person accepted, or a store that cannot be read, which counts no
 * acceptance (`unreadable`).
 */
export const SERVER_CHANGES = ['new', 'arguments', 'directory', 'environment', 'unreadable'] as const

/** One code of {@link SERVER_CHANGES}. */
export type ServerChange = typeof SERVER_CHANGES[number]

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
  /** What the review asks about, for a surface's own words. */
  readonly change: ServerChange
  /** When the start was reviewed, in milliseconds since the epoch. */
  readonly reviewedAt: number
}

/** One accepted server start, as the acceptance store holds it, with the server rows that use it. */
export interface AcceptedServer {
  /** The accepted executable, the store's key. */
  readonly command: string
  /** The accepted arguments, in order. */
  readonly args: readonly string[]
  /** The accepted working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The names of the accepted environment variables, sorted; their values are never shown or stored. */
  readonly envNames: readonly string[]
  /** When the person accepted it, in milliseconds since the epoch; a revoke names it. */
  readonly acceptedAt: number
  /** The names of the configured servers that start this command, sorted; empty when no row of this studio does. */
  readonly servers: readonly string[]
}

/** What `GET` {@link MCP_CONSENT_ROUTES}`.pending` answers. */
export interface PendingServersAnswer {
  /** The pending reviews, sorted by server name. */
  readonly servers: readonly PendingServer[]
  /** The accepted starts, sorted by command; empty while the store cannot be read. */
  readonly accepted: readonly AcceptedServer[]
}

/** One waiting server as a reach device sees it: its name and what the review asks about, without its start. */
export interface WaitingServer {
  readonly serverName: string
  readonly change: ServerChange
}

/** What `GET` {@link MCP_CONSENT_ROUTES}`.waiting` answers. */
export interface WaitingServersAnswer {
  /** The pending reviews' servers, sorted by server name. */
  readonly servers: readonly WaitingServer[]
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

/** What `POST` {@link MCP_CONSENT_ROUTES}`.revoke` takes. */
export interface RevokeServerRequest {
  /** The accepted command, as the list showed it. */
  readonly command: string
  /** The acceptance time the list showed; another time is a stale review. */
  readonly acceptedAt: number
  /** The person's answer: true only after the person chose to revoke. */
  readonly confirmed: boolean
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.revoke` answers. */
export interface RevokeServerAnswer {
  /** How many running server rows of the command were stopped; each waits for a new acceptance. */
  readonly stopped: number
}
