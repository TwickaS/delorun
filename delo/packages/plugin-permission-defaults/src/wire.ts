/**
 * The studio's routes to the per-workspace full access, and their JSON messages. Every route is an exact Connection
 * Fetch route under `/api`, which upstream's connection serves only to the studio's own owner session; this plugin also
 * answers each only to a request that arrived on the loopback listener, and a reach device is refused with
 * `403 LOOPBACK_REQUIRED` before the body is read. A refusal is `{ "error": "<CODE>", "message": "<sentence>" }`.
 *
 * Free of every import, so the studio's browser half inlines it.
 *
 * @module @delo/plugin-permission-defaults/wire
 */

/** The routes. The studio fetches each from the page's own origin. */
export const PERMISSION_ROUTES = {
  /** `GET`: {@link WorkspacesAnswer}, every workspace the studio knows with its full access. */
  workspaces: '/api/deloPermission.workspaces',
  /** `POST` {@link ReviewRequest}: {@link ReviewAnswer}, the full access of one chat's workspace. */
  review: '/api/deloPermission.review',
  /** `POST` {@link SetFullAccessRequest}: {@link SetFullAccessAnswer}, after the workspace's full access is turned on or off. */
  setFullAccess: '/api/deloPermission.setFullAccess',
} as const

/** The largest request body the routes read, in bytes: a path of 4096 characters, JSON-escaped, and the other fields. */
export const MAX_PERMISSION_REQUEST_BYTES = 6 * 4096 + 256

/**
 * The refusal codes of the routes besides `LOOPBACK_REQUIRED`:
 *
 * - `INVALID_REQUEST`: the body is not the route's JSON message (400).
 * - `UNCONFIRMED`: a change without `confirmed: true`, the field the studio's consent sets when the person confirms it
 *   (400). The Host cannot tell who set the field; what it enforces is where the request came from (see
 *   {@link SetFullAccessRequest.confirmed}).
 * - `UNKNOWN_CHAT`: no open chat has the session id (404).
 * - `NO_WORKSPACE`: the chat has no workspace folder, so it has no per-workspace permission (422).
 * - `UNKNOWN_WORKSPACE`: the workspace is neither registered, recorded nor the folder of an open chat (404).
 * - `STALE_REVIEW`: the workspace's full access changed after the consent was shown (409).
 * - `STORE_REFUSED`: the permission store cannot be read or written, so nothing is recorded (500).
 */
export const PERMISSION_REFUSAL_CODES = [
  'INVALID_REQUEST', 'UNCONFIRMED', 'UNKNOWN_CHAT', 'NO_WORKSPACE', 'UNKNOWN_WORKSPACE', 'STALE_REVIEW', 'STORE_REFUSED',
] as const

/** One code of {@link PERMISSION_REFUSAL_CODES}. */
export type PermissionRefusalCode = typeof PERMISSION_REFUSAL_CODES[number]

/** One workspace's full access as a surface shows it. */
export interface WorkspaceAccess {
  /** The workspace key: the canonical directory the grant covers. */
  readonly workspace: string
  /** The title of the registered workspace at that directory, when one is registered. */
  readonly title?: string
  /** The preset new chats in the workspace start with. */
  readonly preset: 'workspace-write' | 'danger-full-access'
  /** When the person granted full access for the workspace, in milliseconds since the epoch, or null. */
  readonly grantedAt: number | null
  /** The id a change of this workspace's full access carries; it changes when the workspace's full access changes. */
  readonly reviewId: string
}

/** What `GET` {@link PERMISSION_ROUTES}`.workspaces` answers. */
export interface WorkspacesAnswer {
  /** Every workspace the studio knows, sorted by key: registered, recorded in the store, or the folder of an open chat. */
  readonly workspaces: readonly WorkspaceAccess[]
  /** Why the permission store cannot be read, when it cannot: no grant counts until the person fixes it. */
  readonly storeProblem?: string
}

/** What `POST` {@link PERMISSION_ROUTES}`.review` takes. */
export interface ReviewRequest {
  /** The open chat whose workspace the consent covers. */
  readonly sessionId: string
}

/** What `POST` {@link PERMISSION_ROUTES}`.review` answers. */
export interface ReviewAnswer {
  readonly access: WorkspaceAccess
}

/** What `POST` {@link PERMISSION_ROUTES}`.setFullAccess` takes. */
export interface SetFullAccessRequest {
  /** The workspace key the consent named. */
  readonly workspace: string
  /** The review id the consent was shown with. */
  readonly reviewId: string
  /** Turn full access on, which records the grant, or off, which withdraws it. */
  readonly on: boolean
  /**
   * `true` when the studio's consent sends the person's confirmation. The Host cannot verify that a person set it: a
   * change is accepted only from a request on the loopback listener under a loopback `Host` (`@delo/home-auth`'s
   * `requireComputer`), which upstream's Connection admitted as the studio's owner session and passed through its
   * `Origin` and `Sec-Fetch-Site` check of a cross-site browser request. Any program running as the person on the home's
   * computer can make that request, as it can run `delorun workspace full-access`.
   */
  readonly confirmed: boolean
  /**
   * The open chat the consent was asked from, which turning on also switches to full access; it must be in the
   * workspace. Absent, no open chat changes when full access is turned on.
   */
  readonly chat?: string | undefined
}

/** What `POST` {@link PERMISSION_ROUTES}`.setFullAccess` answers. */
export interface SetFullAccessAnswer {
  /** The workspace's full access after the change. */
  readonly access: WorkspaceAccess
  /**
   * How many open chats in the workspace changed: set back to the safer preset when full access was turned off, or the
   * request's `chat` switched to full access when it was turned on.
   */
  readonly chats: number
  /**
   * The other running profiles whose studio did not read a withdrawal, sorted; their open chats keep their permission
   * until they read the store. Empty when full access was turned on.
   */
  readonly unread: readonly string[]
}
