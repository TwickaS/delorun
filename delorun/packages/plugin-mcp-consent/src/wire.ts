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
 * @module @delorun/plugin-mcp-consent/wire
 */

/** The routes. The studio fetches each from the page's own origin. */
export const MCP_CONSENT_ROUTES = {
  /** `GET`: {@link PendingServersAnswer}, the servers waiting for the person's answer and the accepted ones. */
  pending: '/api/delorunMcpConsent.pending',
  /** `GET`: {@link WaitingServersAnswer}, the names of the servers waiting for the person's answer; a reach device may read it. */
  waiting: '/api/delorunMcpConsent.waiting',
  /** `POST` {@link AcceptServerRequest}: {@link AcceptServerAnswer}, after the review's start is accepted. */
  accept: '/api/delorunMcpConsent.accept',
  /** `POST` {@link DeclineServerRequest}: {@link DeclineServerAnswer}, after the review is set aside. */
  decline: '/api/delorunMcpConsent.decline',
  /** `POST` {@link RevokeServerRequest}: {@link RevokeServerAnswer}, after an acceptance is withdrawn. */
  revoke: '/api/delorunMcpConsent.revoke',
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
 * - `STALE_REVIEW`: the server has no pending review with that id: its start was reviewed again since or accepted, or
 *   its command or working directory now resolves to other paths than the review showed; or no acceptance has the
 *   revoked acceptance id: it was revoked or replaced since. The answer was given to a screen that no longer shows it
 *   (409).
 * - `STORE_REFUSED`: the acceptance store cannot be read or written, or the shown start holds a resolved path that is
 *   not absolute, so nothing is accepted (500).
 */
export const MCP_CONSENT_REFUSAL_CODES = ['INVALID_REQUEST', 'UNCONFIRMED', 'STALE_REVIEW', 'STORE_REFUSED'] as const

/** One code of {@link MCP_CONSENT_REFUSAL_CODES}. */
export type McpConsentRefusalCode = typeof MCP_CONSENT_REFUSAL_CODES[number]

/**
 * What a pending review asks about: a server the person never accepted (`new`), a start whose command, arguments,
 * working directory or environment differ from the one the person accepted for the server (`command`, `arguments`,
 * `directory`, `environment`, the first that differs in this order), a start configured as accepted whose command
 * now resolves to another executable, whose working directory resolves to another directory, or whose batch file runs
 * through another command shell (`resolved`), a start whose executable or a file an argument names was rewritten,
 * points elsewhere through a symbolic link, now exists or no longer exists, or could not be read (`contents`), a
 * store that cannot be read, which counts no acceptance (`unreadable`).
 */
export const SERVER_CHANGES = ['new', 'command', 'arguments', 'directory', 'environment', 'resolved', 'contents', 'unreadable'] as const

/** One code of {@link SERVER_CHANGES}. */
export type ServerChange = typeof SERVER_CHANGES[number]

/**
 * Where a pending review stands: it waits for the person's answer (`waiting`), the person declined it (`declined`), or
 * the person revoked the server's acceptance (`revoked`). A declined or revoked review stays listed, its server stays
 * stopped, and it holds until the server's start changes, which makes the next review `waiting`, or the person accepts
 * it. Only a `waiting` review is shown to a reach device.
 */
export const SERVER_STATES = ['waiting', 'declined', 'revoked'] as const

/** One code of {@link SERVER_STATES}. */
export type ServerState = typeof SERVER_STATES[number]

/** One configured environment variable as a surface shows it. */
export interface EnvVariable {
  /** The variable's name. */
  readonly name: string
  /** The variable's value, present only when `showsEnvValue` of `review.ts` holds for the name. */
  readonly value?: string
}

/**
 * One file a server start runs, pinned by its canonical path and the digest of its contents: the executable, or a file
 * an argument names.
 */
export interface PinnedFile {
  /** The index of the argument that names the file; absent for the executable. */
  readonly argument?: number
  /** The file's canonical path, every symbolic link resolved. */
  readonly path: string
  /** `sha256:` and the hexadecimal digest of the file's contents. */
  readonly sha256: string
}

/**
 * Where a server's definition lives (A631), judged from the plugins that mounted the server's mcp-client, never from the
 * server's name or command:
 * - `profile`: a row of the profile's own configuration (the person's config file, or a row the person's setup wrote);
 * - `settings`: the MCP manager's server list, which the person edits in Settings;
 * - `pack`: mounted by a plugin of one of Delorun's own packs ({@link ServerOrigin} names the pack and the plugin);
 * - `plugin`: mounted by any other plugin, named by its module;
 * - `chat`: mounted by one chat's own setup, which an editor's ACP session uses for the servers it brings;
 * - `unknown`: no Loader row owns the mount.
 */
export type ServerOrigin =
  | { readonly kind: 'profile' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'pack'; readonly pack: string; readonly plugin: string }
  | { readonly kind: 'plugin'; readonly plugin: string }
  | { readonly kind: 'chat' }
  | { readonly kind: 'unknown' }

/**
 * Which servers wait for the person before they start, the Settings choice stored as the consent row's `ask`:
 * `outside` asks only for servers from outside the person's own configuration and Delorun's packs (the default),
 * `always` asks for every stdio server, `never` asks for none.
 */
export type McpAskMode = 'outside' | 'always' | 'never'

/** The ask modes, in the order Settings offers them. */
export const MCP_ASK_MODES: readonly McpAskMode[] = ['outside', 'always', 'never']

/**
 * Whether a start from an origin waits for the person's acceptance under an ask mode.
 * @param origin - where the server's definition lives.
 * @param mode - the ask mode.
 * @returns true when the start needs an acceptance that covers it.
 */
export function asksFor(origin: ServerOrigin, mode: McpAskMode): boolean {
  if (mode === 'never') return false
  if (mode === 'always') return true
  return origin.kind === 'plugin' || origin.kind === 'chat' || origin.kind === 'unknown'
}

/**
 * The key an acceptance records its origin under, so an acceptance covers a server name from that origin only.
 * @param origin - the origin.
 * @returns `profile`, `settings`, `chat`, `unknown`, or `pack:<plugin>` / `plugin:<plugin>` with the mounting module.
 */
export function originKey(origin: ServerOrigin): string {
  switch (origin.kind) {
    case 'pack':
    case 'plugin':
      return `${origin.kind}:${origin.plugin}`
    case 'profile':
    case 'settings':
    case 'chat':
    case 'unknown':
      return origin.kind
  }
}

/** One stdio server whose start the consent refused, as a surface shows it before the person answers. */
export interface PendingServer {
  /** The server's configured name. */
  readonly serverName: string
  /** The id an answer to this review carries; a new review of the server's start gets a new id. */
  readonly reviewId: string
  /** Where the server's definition lives; a surface says it in plain words ("from plugin …", "from your editor"). */
  readonly origin: ServerOrigin
  /** The configured executable. */
  readonly command: string
  /** The configured arguments, in order. */
  readonly args: readonly string[]
  /** The configured working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /**
   * The absolute path of the executable the server would run: the configured command as the mcp-client resolved it, a bare command
   * found on the server's `PATH`. A surface shows it, because it is the file that runs.
   */
  readonly resolvedCommand: string
  /** The canonical working directory the server would run in: the configured one resolved against the Host's working directory. */
  readonly resolvedCwd: string
  /** On Windows, the canonical command shell (`COMSPEC`) that runs a `.cmd` or `.bat` executable; absent otherwise. */
  readonly resolvedShell?: string
  /** The configured environment variables, sorted by name; a value only where `showsEnvValue` of `review.ts` allows it. */
  readonly env: readonly EnvVariable[]
  /**
   * The files the start runs, as the review pinned them: the executable first, then each argument that names a regular
   * file; empty when a file could not be read. An acceptance covers these contents. The executable's pinned path is the
   * file the server is spawned with; a surface says the command links to it when it differs from `resolvedCommand`.
   */
  readonly files: readonly PinnedFile[]
  /**
   * The canonical working directory and the pinned files that lie inside a place this profile's chats can write: one
   * of its workspaces or a temporary directory. A chat can rewrite such a file or a module loaded from such a
   * directory, so a surface warns before the person accepts; empty when none does. A chat with full access can write
   * elsewhere too, which this list does not cover.
   */
  readonly writableByChats: readonly string[]
  /** Why the consent refused the start: no acceptance, or what changed since the last one. */
  readonly reason: string
  /** What the review asks about, for a surface's own words. */
  readonly change: ServerChange
  /**
   * The names of the variables added, removed or given another value since the server's acceptance, sorted; empty
   * unless {@link change} is `environment`.
   */
  readonly changedVariables: readonly string[]
  /** Whether the review waits for an answer or the person set the server aside. */
  readonly state: ServerState
  /** When the start was reviewed, in milliseconds since the epoch. */
  readonly reviewedAt: number
}

/** One accepted server start, as the acceptance store holds it for one configured server name. */
export interface AcceptedServer {
  /** The id a revoke names: a digest of the server name and the whole accepted start. */
  readonly acceptanceId: string
  /** The server name the start was accepted for; only that server's start is allowed by it. */
  readonly serverName: string
  /** The accepted executable. */
  readonly command: string
  /** The accepted arguments, in order. */
  readonly args: readonly string[]
  /** The accepted working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /**
   * The absolute path of the executable the person accepted: the configured command as the mcp-client resolved it, a bare command
   * found on the server's `PATH`. A surface shows it, because it is the file that runs.
   */
  readonly resolvedCommand: string
  /** The canonical working directory the person accepted the server to run in: the configured one resolved against the Host's working directory. */
  readonly resolvedCwd: string
  /** On Windows, the canonical command shell (`COMSPEC`) that runs a `.cmd` or `.bat` executable; absent otherwise. */
  readonly resolvedShell?: string
  /**
   * The accepted environment variables, sorted by name; a value only where `showsEnvValue` of `review.ts` allows it and the
   * server's configured row still sets that value, since the store keeps digests only.
   */
  readonly env: readonly EnvVariable[]
  /** The files the accepted start runs, pinned when the person accepted it: the executable first, then each file an argument names. */
  readonly files: readonly PinnedFile[]
  /** When the person accepted it, in milliseconds since the epoch. */
  readonly acceptedAt: number
  /** Whether a configured server row of this studio has the server name. */
  readonly configured: boolean
}

/** What `GET` {@link MCP_CONSENT_ROUTES}`.pending` answers. */
export interface PendingServersAnswer {
  /** The pending reviews, sorted by server name. */
  readonly servers: readonly PendingServer[]
  /** The accepted starts, sorted by server name; empty while the store cannot be read. */
  readonly accepted: readonly AcceptedServer[]
}

/** One waiting server as a reach device sees it: its name and what the review asks about, without its start. */
export interface WaitingServer {
  readonly serverName: string
  readonly change: ServerChange
}

/** What `GET` {@link MCP_CONSENT_ROUTES}`.waiting` answers. */
export interface WaitingServersAnswer {
  /** The servers of the pending reviews in state `waiting`, sorted by server name. */
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
  /** The acceptance id the list showed; an id no acceptance has is a stale review. */
  readonly acceptanceId: string
  /** The person's answer: true only after the person chose to revoke. */
  readonly confirmed: boolean
}

/** What `POST` {@link MCP_CONSENT_ROUTES}`.revoke` answers. */
export interface RevokeServerAnswer {
  /** How many running rows of the server were stopped; each waits for a new acceptance. */
  readonly stopped: number
}
