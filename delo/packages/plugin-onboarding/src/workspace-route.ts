/**
 * The host half of the guide's folder choice: the {@link ADD_WORKSPACE_PATH} route, which holds a folder against the
 * locations Delo never adds as a workspace and only then registers it through upstream's workspace registry. A refusal
 * registers nothing. The Delo home is resolved as `@delo/home` resolves it for every Delo plugin; `delorun` gives the
 * harness the same directory as `DSH_HOME` and `DELO_HOME`.
 * @module @delo/plugin-onboarding/workspace-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackHost, type HomeAuthService } from '@delo/home-auth'
import { resolveDeloHome, workspaceLocationHomes, workspaceLocationProblem, type WorkspaceLocationProblem } from '@delo/home'
// Type-only: the ctx.workspaceRegistry merge.
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { folderKind } from './folder-kind.ts'
import { AddWorkspaceRequest, MAX_ADD_BODY_BYTES, type AddWorkspaceAnswer, type FolderKind } from './wire.ts'

/** The code of the refusal a request that did not arrive on the loopback listener is answered with. */
export const LOOPBACK_ONLY_CODE = 'LOOPBACK_ONLY'

/** The sentence that refusal carries. */
const LOOPBACK_ONLY_SENTENCE = 'Add a workspace on the home\'s own computer, at the loopback listener, or through SSH port forwarding to it; this route answers no other address'

/**
 * Refuse a request to add a workspace that did not arrive on the loopback listener under a loopback `Host`, before its
 * body is read: what a workspace holds is what the model may write, so only the person at the computer chooses it. A
 * mounted `homeAuth` service says which listener admitted the request, as the device routes ask it; without the
 * service, which fails closed the same way before it starts, nothing is known and the request is refused.
 * @param request - the request the Connection received.
 * @param response - the response, answered 403 with {@link LOOPBACK_ONLY_CODE} when the arrival is not loopback.
 * @param homeAuth - the mounted `homeAuth` service, read when the request arrives; `undefined` while none is mounted.
 * @returns whether the request may go on to the route.
 */
export function arrivedOnLoopback(request: IncomingMessage, response: ServerResponse, homeAuth: Pick<HomeAuthService, 'arrivalOf'> | undefined): boolean {
  if (homeAuth?.arrivalOf(request).listener === 'loopback' && isLoopbackHost(request.headers.host)) return true
  response.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: LOOPBACK_ONLY_CODE, message: LOOPBACK_ONLY_SENTENCE }))
  return false
}

/** What the route needs from the harness. */
export interface AddWorkspaceDeps {
  /** Upstream's workspace registry, which keeps the workspaces. */
  readonly registry: Pick<WorkspaceRegistry, 'create'>
  /** The environment the Delo home is resolved from. */
  readonly env: Readonly<Record<string, string | undefined>>
  /**
   * Write one line to the harness's log.
   * @param message - the line, which names no path.
   */
  readonly warn: (message: string) => void
}

/**
 * Answer one JSON message with its status.
 * @param status - the HTTP status.
 * @param answer - the message.
 * @returns the response, never cached.
 */
function reply(status: number, answer: AddWorkspaceAnswer | { readonly error: string }): Response {
  return new Response(JSON.stringify(answer), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Read the request's folder, refusing a body over {@link MAX_ADD_BODY_BYTES} and anything that is not one path.
 * @param request - the request.
 * @returns the path, or undefined when the request cannot be read.
 */
async function requestedPath(request: Request): Promise<string | undefined> {
  const bytes = await request.arrayBuffer()
  if (bytes.byteLength > MAX_ADD_BODY_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    // The parser's message quotes the body, so the request is only refused.
    return undefined
  }
  const body = AddWorkspaceRequest.safeParse(parsed)
  return body.success ? body.data.path : undefined
}

/**
 * Handle one request to add a folder: refuse a folder Delo never adds, and register any other through the registry.
 * @param request - the `POST` request carrying {@link AddWorkspaceRequest}.
 * @param deps - the registry, the environment and the log.
 * @returns 200 `added` with the workspace's id and the folder's kind, 422 `refused` with the problem, 400 for a request that cannot be read,
 * or 500 `failed` when the Delo home cannot be resolved or the registry refuses the folder.
 */
export async function addWorkspace(request: Request, deps: AddWorkspaceDeps): Promise<Response> {
  const path = await requestedPath(request)
  if (path === undefined) return reply(400, { error: 'the request must be JSON with one path' })
  const outcome = await registerFolder(path, deps)
  switch (outcome.result) {
    case 'added': return reply(200, outcome)
    case 'refused': return reply(422, outcome)
    case 'failed': return reply(500, outcome)
    /* v8 ignore next 2 -- closed-union default only defends a future widening of AddWorkspaceAnswer */
    default: return assertNever(outcome)
  }
}

/**
 * Where a folder Delo never adds would be: the problem `@delo/home` names for the path, against the Delo home the
 * environment resolves.
 * @param path - the folder.
 * @param deps - the environment and the log.
 * @returns the problem, `undefined` for a folder that may be a workspace, or `unresolved` when the Delo home cannot be resolved.
 */
export async function locationProblem(path: string, deps: Pick<AddWorkspaceDeps, 'env' | 'warn'>): Promise<WorkspaceLocationProblem | 'unresolved' | undefined> {
  try {
    return await workspaceLocationProblem(path, workspaceLocationHomes((await resolveDeloHome(deps.env)).path))
  } catch (error) {
    deps.warn(`the Delo home could not be resolved, so no folder is added: ${codeOf(error)}`)
    return 'unresolved'
  }
}

/**
 * Hold a folder against the locations Delo never adds, then register it and read what it holds. The clone route adds
 * its new folder through this too.
 * @param path - the folder.
 * @param deps - the registry, the environment and the log.
 * @returns `added` with the workspace's id and the folder's kind, `refused` with the problem, or `failed`.
 */
export async function registerFolder(path: string, deps: AddWorkspaceDeps): Promise<AddWorkspaceAnswer> {
  const problem = await locationProblem(path, deps)
  if (problem === 'unresolved') return { result: 'failed' }
  if (problem !== undefined) return { result: 'refused', problem }
  try {
    const workspace = await deps.registry.create(path)
    const kind: FolderKind = await folderKind(path)
    return { result: 'added', workspaceId: workspace.id, kind }
  } catch (error) {
    // The registry's message names the path, so the log keeps only its code.
    deps.warn(`the folder could not be added as a workspace: ${codeOf(error)}`)
    return { result: 'failed' }
  }
}

/**
 * Close a union the compiler has narrowed to nothing.
 * @param value - the value that cannot occur.
 * @returns never.
 * @throws always.
 */
/* v8 ignore next 3 -- reached only when AddWorkspaceAnswer widens without its switch */
function assertNever(value: never): never {
  throw new Error(`unhandled add-workspace outcome ${JSON.stringify(value)}`)
}

/**
 * The code a failure gives without naming a path: its system or layout code, or its name.
 * @param error - the failure.
 * @returns the code.
 */
function codeOf(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') return error.code
  return error instanceof Error ? error.name : 'unexpected failure'
}
