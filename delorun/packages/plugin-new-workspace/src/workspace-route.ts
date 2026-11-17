/**
 * The {@link ADD_WORKSPACE_PATH} route, which holds an existing folder against the locations Delorun never adds as a
 * workspace and only then registers it through upstream's workspace registry. A refusal registers nothing. The Delorun home is resolved as `@delorun/home` resolves it for every
 * Delorun plugin; `delorun` gives the harness the same directory as `DSH_HOME` and `DELORUN_HOME`.
 * @module @delorun/plugin-new-workspace/workspace-route
 */
// Type-only: the ctx.workspaceRegistry merge.
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { folderKind } from './folder-kind.ts'
import { codeOf, locationProblem, type LocationDeps } from './location.ts'
import { readBody, reply } from './http.ts'
import { AddWorkspaceRequest, type AddWorkspaceAnswer, type FolderKind } from './wire.ts'

/** What the route needs from the harness. */
export interface AddWorkspaceDeps extends LocationDeps {
  /** Upstream's workspace registry, which keeps the workspaces. */
  readonly registry: Pick<WorkspaceRegistry, 'create'>
}

/**
 * Handle one request to add a folder: refuse a folder Delorun never adds, and register any other through the registry.
 * @param request - the `POST` request carrying {@link AddWorkspaceRequest}.
 * @param deps - the registry, the environment and the log.
 * @returns 200 `added` with the workspace's id, its canonical folder and the folder's kind, 422 `refused` with the problem, 400 for a request that cannot be read,
 * or 500 `failed` when the Delorun home cannot be resolved or the registry refuses the folder.
 */
export async function addWorkspace(request: Request, deps: AddWorkspaceDeps): Promise<Response> {
  const body = await readBody(request, AddWorkspaceRequest)
  if (body === undefined) return reply(400, { error: 'the request must be JSON with one path' })
  const outcome = await registerFolder(body.path, deps)
  switch (outcome.result) {
    case 'added': return reply(200, outcome)
    case 'refused': return reply(422, outcome)
    case 'failed': return reply(500, outcome)
    /* v8 ignore next 2 -- closed-union default only defends a future widening of AddWorkspaceAnswer */
    default: return assertNever(outcome)
  }
}

/**
 * Hold a folder against the locations Delorun never adds, then register it and read what it holds. The create and clone
 * routes add their new folder through this too.
 * @param path - the folder.
 * @param deps - the registry, the environment and the log.
 * @returns `added` with the workspace's id, canonical folder and kind, `refused` with the problem, or `failed`.
 */
export async function registerFolder(path: string, deps: AddWorkspaceDeps): Promise<AddWorkspaceAnswer> {
  const problem = await locationProblem(path, deps)
  if (problem === 'unresolved') return { result: 'failed' }
  if (problem !== undefined) return { result: 'refused', problem }
  try {
    const workspace = await deps.registry.create(path)
    const kind: FolderKind = await folderKind(workspace.path)
    return { result: 'added', workspaceId: workspace.id, path: workspace.path, kind }
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
