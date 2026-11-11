/**
 * The update channel's consent operations (contract C19): `permission.reload` after `delorun workspace full-access`
 * changed the per-workspace permission store, and `mcp.list`, `mcp.accept` and `mcp.decline`, through which
 * `delorun mcp` answers the stdio MCP servers the running Host's add-time consent holds stopped.
 *
 * - **The caller rule.** `mcp.accept` and `mcp.decline` are accepted only with the person's token; the Host's token,
 *   which acts for studio sessions on every listener, reach sessions included, is refused with `LOOPBACK_REQUIRED`
 *   before anything is read. `permission.reload` and `mcp.list` change no consent and accept both.
 * - **The review id.** An answer names the review `mcp.list` showed; a server whose start was reviewed again since is
 *   refused with `STALE_REVIEW` and nothing is recorded.
 *
 * @module @delo/home-process/consents
 */
import type { McpAcceptRequest, McpDeclineRequest } from '@delo/contract-home-process'
import type { ChannelCaller } from './devices-approve.ts'
import { HomeProcessError } from './errors.ts'

/** One pending stdio MCP server review, as `delorun mcp` shows it; no field holds an environment value. */
export interface PendingMcpServer {
  readonly serverName: string
  readonly reviewId: string
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly envNames: readonly string[]
  readonly reason: string
  readonly reviewedAt: number
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
 * @returns the pending reviews.
 * @throws {HomeProcessError} `CONSENT_UNAVAILABLE` without a Host or the MCP add-time consent.
 */
export function listServers(consents: LocalConsents | undefined): Readonly<Record<string, unknown>> {
  const servers = consents?.pendingServers()
  if (servers === undefined) throw unavailable('MCP add-time consent')
  return { servers }
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
