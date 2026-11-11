/**
 * The update channel's consent operations (contract C19): `permission.reload` after `delorun workspace full-access`
 * changed the per-workspace permission store, and `mcp.list`, `mcp.accept`, `mcp.decline` and `mcp.revoke`, through
 * which `delorun mcp` answers the stdio MCP servers the running Host's add-time consent holds stopped and withdraws the
 * acceptances it holds.
 *
 * - **The caller rule.** `mcp.accept`, `mcp.decline` and `mcp.revoke` are accepted only with the person's token; the
 *   Host's token, which acts for studio sessions on every listener, reach sessions included, is refused with
 *   `LOOPBACK_REQUIRED` before anything is read. `permission.reload` and `mcp.list` change no consent and accept both.
 * - **The shown state.** An answer names the review `mcp.list` showed, and a revoke the acceptance time it showed; a
 *   server whose start was reviewed again since, or a command accepted again or revoked since, is refused with
 *   `STALE_REVIEW` and nothing is recorded.
 *
 * @module @delo/home-process/consents
 */
import type { McpAcceptRequest, McpDeclineRequest, McpRevokeRequest } from '@delo/contract-home-process'
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'

/**
 * What a pending review asks about: a server never accepted (`new`), a start whose arguments, working directory or
 * environment differ from the accepted one, or an acceptance store that cannot be read (`unreadable`).
 */
export type McpServerChange = 'new' | 'arguments' | 'directory' | 'environment' | 'unreadable'

/** One pending stdio MCP server review, as `delorun mcp` shows it; no field holds an environment value. */
export interface PendingMcpServer {
  readonly serverName: string
  readonly reviewId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly envNames: readonly string[]
  readonly reason: string
  /** What changed since the person's acceptance. */
  readonly change: McpServerChange
  readonly reviewedAt: number
}

/** One accepted stdio MCP server start, as `delorun mcp` shows it; no field holds an environment value. */
export interface AcceptedMcpServer {
  /** The accepted executable; a revoke names it. */
  readonly command: string
  readonly args: readonly string[]
  /** The accepted working directory; the empty string is the Host's working directory. */
  readonly cwd: string
  /** The names of the accepted environment variables, sorted. */
  readonly envNames: readonly string[]
  /** When the person accepted it, in milliseconds since the epoch; a revoke names it. */
  readonly acceptedAt: number
  /** The configured servers that start this command, sorted. */
  readonly servers: readonly string[]
}

/**
 * The Host's half of the consent operations: the running services of `@delo/plugin-permission-defaults` and
 * `@delo/plugin-mcp-consent`, each read when an operation arrives.
 */
export interface LocalConsents {
  /**
   * Read the per-workspace permission store again.
   * @returns the digest of the entries the Host now holds and the store's problem, or undefined when the profile
   *   mounts no per-workspace permission defaults.
   */
  reloadPermissions(): Promise<{ readonly digest: string, readonly storeProblem?: string } | undefined>
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
   * Set one pending review aside.
   * @param serverName - the server.
   * @param reviewId - the review shown.
   * @returns false without the consent.
   * @throws an error with a `code` property, `STALE_REVIEW`, for a refused answer.
   */
  declineServer(serverName: string, reviewId: string): boolean
  /**
   * Withdraw one acceptance and stop the running servers that start its command.
   * @param command - the accepted command.
   * @param acceptedAt - the acceptance time shown.
   * @returns how many running rows stopped, or undefined without the consent.
   * @throws an error with a `code` property, `STALE_REVIEW` or `STORE_REFUSED`, for a refused answer.
   */
  revokeServer(command: string, acceptedAt: number): Promise<{ readonly stopped: number } | undefined>
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
export function declineServer(request: McpDeclineRequest, caller: ChannelCaller, consents: LocalConsents | undefined): Readonly<Record<string, unknown>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'declining an MCP server needs you at your computer: run delorun mcp decline there')
  }
  let declined: boolean | undefined
  try {
    declined = consents?.declineServer(request.args.serverName, request.args.reviewId)
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
 *   `STALE_REVIEW` for an acceptance that changed; `CONSENT_FAILED` naming the Host's code for any other refusal.
 */
export async function revokeServer(request: McpRevokeRequest, caller: ChannelCaller, consents: LocalConsents | undefined): Promise<Readonly<Record<string, unknown>>> {
  if (caller !== 'person') {
    throw new HomeProcessError('LOOPBACK_REQUIRED', 'revoking an MCP server needs you at your computer: run delorun mcp revoke there')
  }
  let revoked: { readonly stopped: number } | undefined
  try {
    revoked = await consents?.revokeServer(request.args.command, request.args.acceptedAt)
  } catch (error) {
    throw consentRefusal(error)
  }
  if (revoked === undefined) throw unavailable('MCP add-time consent')
  return revoked
}
