/**
 * The update channel's consent operations (contract C19): `permission.reload`, which makes the Host read the
 * per-workspace permission store again, and `mcp.list`, `mcp.accept`, `mcp.decline` and `mcp.revoke`, through which
 * `delorun mcp` answers the stdio MCP servers the running Host's add-time consent holds stopped and withdraws the
 * acceptances it holds.
 *
 * - **The caller rule.** `mcp.accept`, `mcp.decline` and `mcp.revoke` are accepted only with the person's token; the
 *   Host's token, which acts for studio sessions on every listener, reach sessions included, is refused with
 *   `LOOPBACK_REQUIRED` before anything is read. `permission.reload` and `mcp.list` change no consent and accept both.
 * - **The shown state.** An answer names the review `mcp.list` showed, and a revoke the acceptance id it showed; a
 *   server whose start was reviewed again since, or an acceptance replaced or revoked since, is refused with
 *   `STALE_REVIEW` and nothing is recorded.
 *
 * @module @delorun/home-process/consents
 */
import type { McpAcceptRequest, McpDeclineRequest, McpRevokeRequest } from '@delorun/contract-home-process'
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'

/**
 * What a pending review asks about: a server never accepted (`new`), a start whose command, arguments, working
 * directory or environment differ from the server's acceptance, a start configured as accepted whose command or
 * working directory now resolves to another executable, directory or command shell (`resolved`), a start whose
 * executable or a file an argument names changed since the acceptance or cannot be read (`contents`), or an acceptance
 * store that cannot be read (`unreadable`).
 */
export type McpServerChange = 'new' | 'command' | 'arguments' | 'directory' | 'environment' | 'resolved' | 'contents' | 'unreadable'

/** Where a pending review stands: waiting for an answer, or set aside by a decline or a revoke until its start changes. */
export type McpServerState = 'waiting' | 'declined' | 'revoked'

/**
 * One configured environment variable as `delorun mcp` shows it: the value only of a variable that changes what runs
 * (`NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `PATH`, `PYTHONPATH`, `DYLD_*`).
 */
export interface McpEnvVariable {
  readonly name: string
  readonly value?: string
}

/** One file a server start runs, by its canonical path and the digest of its contents. */
export interface McpPinnedFile {
  /** The index of the argument that names the file; absent for the executable. */
  readonly argument?: number
  readonly path: string
  /** `sha256:` and the hexadecimal digest. */
  readonly sha256: string
}

/** One pending stdio MCP server review, as `delorun mcp` shows it. */
export interface PendingMcpServer {
  readonly serverName: string
  readonly reviewId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The absolute executable the start resolved to, which is the file that runs. */
  readonly resolvedCommand: string
  /** The canonical working directory the start resolved to. */
  readonly resolvedCwd: string
  /** On Windows, the canonical command shell that runs a batch file; absent otherwise. */
  readonly resolvedShell?: string
  /** The configured environment variables, sorted by name. */
  readonly env: readonly McpEnvVariable[]
  /** The files the start runs as the review pinned them; empty when one could not be read. */
  readonly files: readonly McpPinnedFile[]
  /** The working directory and pinned files that lie in a workspace or a temporary directory chats can write. */
  readonly writableByChats: readonly string[]
  readonly reason: string
  /** What changed since the person's acceptance. */
  readonly change: McpServerChange
  /** The variables added, removed or changed, sorted; empty unless the change is `environment`. */
  readonly changedVariables: readonly string[]
  readonly state: McpServerState
  readonly reviewedAt: number
}

/** One accepted stdio MCP server start, one per configured server name, as `delorun mcp` shows it. */
export interface AcceptedMcpServer {
  /** The id a revoke names. */
  readonly acceptanceId: string
  /** The server name the start was accepted for. */
  readonly serverName: string
  readonly command: string
  readonly args: readonly string[]
  /** The accepted working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The absolute executable the accepted start resolved to. */
  readonly resolvedCommand: string
  /** The canonical working directory the accepted start resolved to. */
  readonly resolvedCwd: string
  /** On Windows, the canonical command shell accepted to run a batch file; absent otherwise. */
  readonly resolvedShell?: string
  /** The accepted environment variables, sorted by name. */
  readonly env: readonly McpEnvVariable[]
  /** The files the accepted start runs, pinned when it was accepted. */
  readonly files: readonly McpPinnedFile[]
  /** When the person accepted it, in milliseconds since the epoch. */
  readonly acceptedAt: number
  /** Whether a configured server row has the server name. */
  readonly configured: boolean
}

/**
 * The Host's half of the consent operations: the running services of `@delorun/plugin-permission-defaults` and
 * `@delorun/plugin-mcp-consent`, each read when an operation arrives.
 */
export interface LocalConsents {
  /**
   * Read the per-workspace permission store again.
   * @returns the digest of the entries the Host now holds, how many workspaces gained and lost a grant, and the store's
   *   problem, or undefined when the profile mounts no per-workspace permission defaults.
   */
  reloadPermissions(): Promise<{ readonly digest: string, readonly added?: number, readonly lost?: number, readonly storeProblem?: string } | undefined>
  /**
   * The pending MCP server reviews.
   * @returns the reviews, or undefined when the profile mounts no MCP add-time consent.
   */
  pendingServers(): readonly PendingMcpServer[] | undefined
  /**
   * The accepted MCP server starts.
   * @returns the accepted starts, empty while the acceptance store cannot be read, or undefined when the profile mounts
   *   no MCP add-time consent.
   */
  acceptedServers(): Promise<readonly AcceptedMcpServer[] | undefined>
  /**
   * Accept one pending review.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @returns how many refused rows started again, or undefined without the consent.
   * @throws an error with a `code` property, `STALE_REVIEW` or `STORE_REFUSED`, for a refused answer.
   */
  acceptServer(serverName: string, reviewId: string): Promise<{ readonly started: number } | undefined>
  /**
   * Set one pending review aside as declined.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @returns false without the consent.
   * @throws an error with a `code` property, `STALE_REVIEW`, for a refused answer.
   */
  declineServer(serverName: string, reviewId: string): Promise<boolean>
  /**
   * Withdraw one server's acceptance and stop that server's running rows.
   * @param acceptanceId - the acceptance id shown.
   * @returns how many running rows stopped, or undefined without the consent.
   * @throws an error with a `code` property, `STALE_REVIEW` or `STORE_REFUSED`, for a refused answer.
   */
  revokeServer(acceptanceId: string): Promise<{ readonly stopped: number } | undefined>
}

/**
 * The refusal of a profile that does not mount the consent an operation needs.
 * @param what - the consent, as the detail names it.
 * @returns the refusal.
 */
function unavailable(what: string): HomeProcessError {
  return new HomeProcessError('CONSENT_UNAVAILABLE', `the running profile mounts no ${what}`)
}

/**
 * The refusal an answer the Host refused reads as: `STALE_REVIEW` for a review that changed, `CONSENT_FAILED` naming
 * the Host's code and sentence for any other.
 * @param error - what the Host threw.
 * @returns the refusal.
 */
function consentRefusal(error: unknown): HomeProcessError {
  const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR'
  const sentence = error instanceof Error ? error.message : 'the answer was not recorded'
  return new HomeProcessError(code === 'STALE_REVIEW' ? 'STALE_REVIEW' : 'CONSENT_FAILED', code === 'STALE_REVIEW' ? sentence : `${code}: ${sentence}`)
}

/**
 * Run `permission.reload`.
 * @param consents - the Host's consents, or undefined without a booted Host.
 * @returns the digest of the entries the Host holds, and the store's problem when it cannot be read.
 * @throws {HomeProcessError} `CONSENT_UNAVAILABLE` without a Host or the per-workspace permission defaults.
 */
export async function reloadPermissions(consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  const reloaded = await consents?.reloadPermissions()
  if (reloaded === undefined) throw unavailable('per-workspace permission defaults')
  return reloaded
}

/**
 * Run `mcp.list`.
 * @param consents - the Host's consents, or undefined without a booted Host.
 * @returns `servers`, the pending reviews, and `accepted`, the accepted starts.
 * @throws {HomeProcessError} `CONSENT_UNAVAILABLE` without a Host or the MCP add-time consent.
 */
export async function listServers(consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  const servers = consents?.pendingServers()
  const accepted = await consents?.acceptedServers()
  if (servers === undefined || accepted === undefined) throw unavailable('MCP add-time consent')
  return { servers, accepted }
}

/**
 * Run `mcp.accept`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param consents - the Host's consents, or undefined without a booted Host.
 * @returns how many refused server rows started again.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `CONSENT_UNAVAILABLE` without the consent;
 *   `STALE_REVIEW` for a review that changed; `CONSENT_FAILED` naming the Host's code for any other refusal.
 */
export async function acceptServer(request: McpAcceptRequest, caller: ChannelCaller, consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'accepting an MCP server needs you at your computer: run delorun mcp accept there')
  }
  let accepted: { readonly started: number } | undefined
  try {
    accepted = await consents?.acceptServer(request.args.serverName, request.args.reviewId)
  } catch (error) {
    throw consentRefusal(error)
  }
  if (accepted === undefined) throw unavailable('MCP add-time consent')
  return accepted
}

/**
 * Run `mcp.decline`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param consents - the Host's consents, or undefined without a booted Host.
 * @returns `declined`.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `CONSENT_UNAVAILABLE` without the consent;
 *   `STALE_REVIEW` for a review that changed.
 */
export async function declineServer(request: McpDeclineRequest, caller: ChannelCaller, consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'declining an MCP server needs you at your computer: run delorun mcp decline there')
  }
  let declined: boolean | undefined
  try {
    declined = await consents?.declineServer(request.args.serverName, request.args.reviewId)
  } catch (error) {
    throw consentRefusal(error)
  }
  if (declined !== true) throw unavailable('MCP add-time consent')
  return { declined: true }
}

/**
 * Run `mcp.revoke`.
 * @param request - the request.
 * @param caller - the credential it carried.
 * @param consents - the Host's consents, or undefined without a booted Host.
 * @returns how many running server rows stopped.
 * @throws {HomeProcessError} `LOOPBACK_REQUIRED` for the Host's token; `CONSENT_UNAVAILABLE` without the consent;
 *   `STALE_REVIEW` for an acceptance that was replaced or revoked; `CONSENT_FAILED` naming the Host's code for any other refusal.
 */
export async function revokeServer(request: McpRevokeRequest, caller: ChannelCaller, consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'revoking an MCP server needs you at your computer: run delorun mcp revoke there')
  }
  let revoked: { readonly stopped: number } | undefined
  try {
    revoked = await consents?.revokeServer(request.args.acceptanceId)
  } catch (error) {
    throw consentRefusal(error)
  }
  if (revoked === undefined) throw unavailable('MCP add-time consent')
  return revoked
}
