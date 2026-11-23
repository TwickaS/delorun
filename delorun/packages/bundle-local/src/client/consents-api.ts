/**
 * Requests to the home's consent routes: the per-workspace full access of `@delorun/plugin-permission-defaults` and the
 * pending and accepted stdio MCP servers of `@delorun/plugin-mcp-consent`, through the same-origin requests of
 * [`./host-api.ts`](./host-api.ts). Each route but the waiting servers' names answers only the studio on the home's own
 * computer; a remote studio receives `LOOPBACK_REQUIRED`, and a profile whose consent switch is off, such as one set up
 * with "Ask less (like DeepSeek Harness)", mounts no route, so the request answers 404.
 * @module @delorun/bundle-local/client/consents-api
 */
import {
  MCP_CONSENT_ROUTES, SERVER_CHANGES, SERVER_STATES, type AcceptedServer, type EnvVariable, type AcceptServerAnswer, type PendingServer, type PendingServersAnswer,
  type RevokeServerAnswer, type ServerChange, type WaitingServer, type WaitingServersAnswer,
} from '@delorun/plugin-mcp-consent/wire'
import {
  PERMISSION_ROUTES, type EverywhereAnswer, type SetFullAccessAnswer, type WorkspaceAccess, type WorkspacesAnswer,
} from '@delorun/plugin-permission-defaults/wire'
import {
  AGENT_LEVELS, DELEGATION_CONSENT_ROUTES, type AllowWorkspaceAnswer, type GrantsAnswer, type GrantView, type LevelsAnswer, type RevokeAnswer,
} from '@delorun/plugin-delegation-consent/wire'
import { call, fields, hostFailureOf, isString, isTime, listOf, optional, orNull, type Check, type HostFetch } from './host-api.ts'

export type { LevelsAnswer, EverywhereAnswer, AcceptedServer, EnvVariable, GrantView, GrantsAnswer, PendingServer, PendingServersAnswer, ServerChange, WaitingServer, WorkspaceAccess, WorkspacesAnswer }

/** The preset whose switch needs the workspace's consent. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** The status a route answers when its plugin is not mounted. */
const NOT_MOUNTED = 404

const isWorkspaceAccess: Check = fields({
  workspace: isString,
  title: optional(isString),
  preset: value => value === 'workspace-write' || value === FULL_ACCESS_PRESET,
  grantedAt: orNull(isTime),
  reviewId: isString,
})
const isEverywhere: Check = fields({ on: value => typeof value === 'boolean', grantedAt: optional(isString), problem: optional(isString) })
const isWorkspaces: Check = fields({ workspaces: listOf(isWorkspaceAccess), everywhere: isEverywhere, storeProblem: optional(isString) })
const isReview: Check = fields({ access: isWorkspaceAccess })
const isChange: Check = fields({ access: isWorkspaceAccess, chats: isTime })
const isServerChange: Check = value => SERVER_CHANGES.some(change => change === value)
const isServerState: Check = value => SERVER_STATES.some(state => state === value)
const isEnv: Check = listOf(fields({ name: isString, value: optional(isString) }))
const isFiles: Check = listOf(fields({ argument: optional(value => Number.isSafeInteger(value) && Number(value) >= 0), path: isString, sha256: isString }))
const isPendingServers: Check = fields({
  servers: listOf(fields({
    serverName: isString, reviewId: isString, command: isString, args: listOf(isString), cwd: isString,
    resolvedCommand: isString, resolvedCwd: isString, resolvedShell: optional(isString), env: isEnv, files: isFiles, writableByChats: listOf(isString), reason: isString, change: isServerChange, changedVariables: listOf(isString), state: isServerState, reviewedAt: isTime,
  })),
  accepted: listOf(fields({
    acceptanceId: isString, serverName: isString, command: isString, args: listOf(isString), cwd: isString,
    resolvedCommand: isString, resolvedCwd: isString, resolvedShell: optional(isString), env: isEnv, files: isFiles,
    acceptedAt: isTime, configured: value => typeof value === 'boolean',
  })),
})
const isWaitingServers: Check = fields({ servers: listOf(fields({ serverName: isString, change: isServerChange })) })
const isAccepted: Check = fields({ started: isTime })
const isRevoked: Check = fields({ stopped: isTime })
const isDeclined: Check = fields({ declined: value => value === true })
const isGrant: Check = fields({ workspace: isString, provider: isString, agent: isString, grantedAt: isTime })
const isGrants: Check = fields({ grants: listOf(isGrant), storeProblem: optional(isString) })
const isLevels: Check = fields({
  levels: listOf(fields({
    provider: isString, agent: isString, level: value => AGENT_LEVELS.some(level => level === value),
    sandboxMissing: optional(fields({ tools: listOf(isString), installCommand: isString })),
  })),
})
const isAllowed: Check = fields({ grant: isGrant })
const isAgentRevoked: Check = fields({ revoked: value => typeof value === 'boolean' })

/**
 * Run a request whose route a profile may not mount.
 * @param request - the request.
 * @returns the answer, or undefined when the route answered 404 because its plugin is not mounted.
 * @throws {HostRequestError} for any other refusal, an unreachable Host or an unreadable answer.
 */
async function mounted<T>(request: Promise<T>): Promise<T | undefined> {
  try {
    return await request
  } catch (error) {
    const failure = hostFailureOf(error)
    if (failure.kind !== 'unreachable' && failure.status === NOT_MOUNTED) return undefined
    throw error
  }
}

/**
 * Read every workspace the home knows with its full access.
 * @param fetch - the request function.
 * @returns the workspaces, or undefined when the profile mounts no per-workspace full access.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` on a remote studio), an unreachable Host or an
 *   unreadable answer.
 */
export function readWorkspaces(fetch: HostFetch): Promise<WorkspacesAnswer | undefined> {
  return mounted(call<WorkspacesAnswer>(fetch, PERMISSION_ROUTES.workspaces, isWorkspaces))
}

/** The window event that tells other surfaces, such as the sidebar badge, that Settings turned dangerous mode off. */
export const EVERYWHERE_CHANGED = 'delorun-dangerous-mode-changed'

/**
 * Read dangerous mode, failing when it cannot be read: the security overview must not take an unread state for off.
 * @param fetch - the request function.
 * @returns whether dangerous mode is on, since when, and any problem the Host reports.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function readEverywhereStrict(fetch: HostFetch): Promise<EverywhereAnswer> {
  return call<EverywhereAnswer>(fetch, PERMISSION_ROUTES.everywhere, isEverywhere)
}

/**
 * Read whether dangerous mode is on. A refusal (a locked device), a profile without the route and an unreachable Host
 * all read as off, the direction that asks.
 * @param fetch - the request function.
 * @returns the state; `{ on: false }` when it cannot be read.
 */
export async function readEverywhere(fetch: HostFetch): Promise<EverywhereAnswer> {
  try {
    return await readEverywhereStrict(fetch)
  } catch (_unreadable) {
    // Any failure leaves dangerous mode off, so every consent asks as it does without it.
    return { on: false }
  }
}

/**
 * Turn dangerous mode off by removing its grant file; the computer and a device that confirms with Face ID or its PIN may call it.
 * @param fetch - the request function.
 * @returns the state after the change.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function turnEverywhereOff(fetch: HostFetch): Promise<EverywhereAnswer> {
  const answer = await call<EverywhereAnswer>(fetch, PERMISSION_ROUTES.everywhereOff, isEverywhere, {})
  window.dispatchEvent(new Event(EVERYWHERE_CHANGED))
  return answer
}

/**
 * Read the full access of one open chat's workspace.
 * @param fetch - the request function.
 * @param sessionId - the chat.
 * @returns the workspace's full access, or undefined when the profile mounts no per-workspace full access.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `UNKNOWN_CHAT`, `NO_WORKSPACE`), an unreachable Host
 *   or an unreadable answer.
 */
export async function reviewChat(fetch: HostFetch, sessionId: string): Promise<WorkspaceAccess | undefined> {
  return (await mounted(call<{ access: WorkspaceAccess }>(fetch, PERMISSION_ROUTES.review, isReview, { sessionId })))?.access
}

/**
 * Turn one workspace's full access on or off, with the person's answer.
 * @param fetch - the request function.
 * @param access - the workspace as the consent showed it.
 * @param on - on, which records the grant, or off, which withdraws it.
 * @param chat - the open chat the consent was asked from, which turning on also switches to full access.
 * @returns the workspace after the change and how many open chats changed preset.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `STALE_REVIEW`, `STORE_REFUSED` among them), an
 *   unreachable Host or an unreadable answer.
 */
export function setFullAccess(fetch: HostFetch, access: WorkspaceAccess, on: boolean, chat?: string): Promise<SetFullAccessAnswer> {
  return call<SetFullAccessAnswer>(fetch, PERMISSION_ROUTES.setFullAccess, isChange, {
    workspace: access.workspace, reviewId: access.reviewId, on, confirmed: true, ...chat === undefined ? {} : { chat },
  })
}

/**
 * Read the stdio MCP servers waiting for the person's answer and the accepted starts.
 * @param fetch - the request function.
 * @returns the pending and accepted servers, or undefined when the profile mounts no MCP add-time consent.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` on a remote studio), an unreachable Host or an
 *   unreadable answer.
 */
export function readServers(fetch: HostFetch): Promise<PendingServersAnswer | undefined> {
  return mounted(call<PendingServersAnswer>(fetch, MCP_CONSENT_ROUTES.pending, isPendingServers))
}

/**
 * Read the names of the stdio MCP servers waiting for the person's answer, which a remote studio may read too.
 * @param fetch - the request function.
 * @returns the waiting servers, or undefined when the profile mounts no MCP add-time consent.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export async function readWaitingServers(fetch: HostFetch): Promise<readonly WaitingServer[] | undefined> {
  return (await mounted(call<WaitingServersAnswer>(fetch, MCP_CONSENT_ROUTES.waiting, isWaitingServers)))?.servers
}

/**
 * Revoke one accepted start; every running server that starts it stops until the person allows it again.
 * @param fetch - the request function.
 * @param accepted - the accepted start as the section showed it.
 * @returns how many running servers stopped.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `STALE_REVIEW`, `STORE_REFUSED` among them), an
 *   unreachable Host or an unreadable answer.
 */
export function revokeServer(fetch: HostFetch, accepted: AcceptedServer): Promise<RevokeServerAnswer> {
  return call<RevokeServerAnswer>(fetch, MCP_CONSENT_ROUTES.revoke, isRevoked, { acceptanceId: accepted.acceptanceId, confirmed: true })
}

/**
 * Accept one pending server's start, with the person's answer.
 * @param fetch - the request function.
 * @param server - the server as the section showed it.
 * @returns how many stopped server rows started again.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `STALE_REVIEW`, `STORE_REFUSED` among them), an
 *   unreachable Host or an unreadable answer.
 */
export function acceptServer(fetch: HostFetch, server: PendingServer): Promise<AcceptServerAnswer> {
  return call<AcceptServerAnswer>(fetch, MCP_CONSENT_ROUTES.accept, isAccepted, {
    serverName: server.serverName, reviewId: server.reviewId, confirmed: true,
  })
}

/**
 * Set one pending server's review aside; the server stays stopped.
 * @param fetch - the request function.
 * @param server - the server as the section showed it.
 * @returns when the review is set aside.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `STALE_REVIEW`), an unreachable Host or an unreadable
 *   answer.
 */
export async function declineServer(fetch: HostFetch, server: PendingServer): Promise<void> {
  await call<{ declined: true }>(fetch, MCP_CONSENT_ROUTES.decline, isDeclined, { serverName: server.serverName, reviewId: server.reviewId })
}

/**
 * Read the external agents allowed per workspace.
 * @param fetch - the request function.
 * @returns the grants, or undefined when the profile mounts no external-agent consent.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED` on a remote studio), an unreachable Host or an
 *   unreadable answer.
 */
export function readAgentGrants(fetch: HostFetch): Promise<GrantsAnswer | undefined> {
  return mounted(call<GrantsAnswer>(fetch, DELEGATION_CONSENT_ROUTES.grants, isGrants))
}

/**
 * Read each external agent's level and what its sandbox lacks here. Any approved device may read it; the live agent
 * chat and the agent lists show the level as a chip from this answer.
 * @param fetch - the request function.
 * @returns the levels, or undefined when the consent is off and mounts no route.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function readAgentLevels(fetch: HostFetch): Promise<LevelsAnswer | undefined> {
  return mounted(call<LevelsAnswer>(fetch, DELEGATION_CONSENT_ROUTES.levels, isLevels))
}

/**
 * Let an external agent start without asking in an open chat's workspace, with the person's answer.
 * @param fetch - the request function.
 * @param sessionId - the chat the approval card belongs to.
 * @param provider - the agent's provider name.
 * @returns the recorded grant.
 * @throws {HostRequestError} for a refusal (`LOOPBACK_REQUIRED`, `NO_WORKSPACE`, `UNKNOWN_WORKSPACE`, `STORE_REFUSED`
 *   among them), an unreachable Host or an unreadable answer.
 */
export function allowAgentForWorkspace(fetch: HostFetch, sessionId: string, provider: string): Promise<AllowWorkspaceAnswer> {
  return call<AllowWorkspaceAnswer>(fetch, DELEGATION_CONSENT_ROUTES.allow, isAllowed, { sessionId, provider, confirmed: true })
}

/**
 * Revoke one external agent's grant; it asks again at its next start there.
 * @param fetch - the request function.
 * @param grant - the grant as the section showed it.
 * @returns whether a grant was removed.
 * @throws {HostRequestError} for a refusal, an unreachable Host or an unreadable answer.
 */
export function revokeAgentGrant(fetch: HostFetch, grant: GrantView): Promise<RevokeAnswer> {
  return call<RevokeAnswer>(fetch, DELEGATION_CONSENT_ROUTES.revoke, isAgentRevoked, { workspace: grant.workspace, provider: grant.provider })
}
