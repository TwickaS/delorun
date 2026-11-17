/**
 * Each workspace's defaults in use: the {@link DEFAULTS_PATH} and {@link SET_DEFAULTS_PATH} routes over the defaults store,
 * the last folder a new folder or clone went in, and the seed that starts a new chat in a workspace on the workspace's
 * model. The seed appends upstream's `model/selection` event through the agent's own model writer, so the chat's log
 * records the model it starts on; it never touches a resumed, forked or delegated chat, or one that already records a
 * model.
 * @module @delorun/plugin-new-workspace/defaults
 */
import { resolveDelorunHome } from '@delorun/home'
import { workspaceKey } from '@delorun/plugin-permission-defaults/workspace'
import type { ModelSelection, SessionStartSource } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm/brand'
import type { Session } from '@deepseek-ai/dsh-session'
import { changeDefaultsStore, defaultsStorePath, readDefaultsStore } from './defaults-store.ts'
import { readBody, reply } from './http.ts'
import { codeOf, locationProblem, type LocationDeps } from './location.ts'
import { DefaultsRequest, SetDefaultsRequest, type DefaultsAnswer, type WorkspaceDefaults } from './wire.ts'

/** What the defaults need from the harness. */
export type DefaultsDeps = LocationDeps

/**
 * The defaults store's path in the Delorun home the environment resolves.
 * @param deps - the environment and the log.
 * @returns the path, or undefined when the home cannot be resolved.
 */
export async function storePath(deps: DefaultsDeps): Promise<string | undefined> {
  try {
    return defaultsStorePath((await resolveDelorunHome(deps.env)).path)
  } catch (error) {
    deps.warn(`the Delorun home could not be resolved, so no workspace default is read or kept: ${codeOf(error)}`)
    return undefined
  }
}

/**
 * Handle a request for one workspace's defaults.
 * @param request - the `POST` request carrying {@link DefaultsRequest}.
 * @param deps - the environment and the log.
 * @returns 200 `defaults` (empty for a workspace without any), 422 `refused` for a folder Delorun never adds, 400 for a
 * request that cannot be read, or 500 `failed` when the store cannot be read.
 */
export async function readDefaultsRoute(request: Request, deps: DefaultsDeps): Promise<Response> {
  const body = await readBody(request, DefaultsRequest)
  if (body === undefined) return reply(400, { error: 'the request must be JSON with one path' })
  const problem = await locationProblem(body.path, deps)
  if (problem === 'unresolved') return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  if (problem !== undefined) return reply(422, { result: 'refused', problem } satisfies DefaultsAnswer)
  const path = await storePath(deps)
  if (path === undefined) return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  try {
    const content = await readDefaultsStore(path)
    return reply(200, { result: 'defaults', defaults: content.workspaces[workspaceKey(body.path)] ?? {} } satisfies DefaultsAnswer)
  } catch (error) {
    deps.warn(`the workspace defaults were not read: ${codeOf(error)}`)
    return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  }
}

/**
 * Handle a request to record one workspace's defaults, which replace what it held.
 * @param request - the `POST` request carrying {@link SetDefaultsRequest}.
 * @param deps - the environment and the log.
 * @returns 200 `defaults` with what is now recorded, 422 `refused`, 400, or 500 `failed` when the store cannot be changed.
 */
export async function setDefaultsRoute(request: Request, deps: DefaultsDeps): Promise<Response> {
  const body = await readBody(request, SetDefaultsRequest)
  if (body === undefined) return reply(400, { error: 'the request must be JSON with path and defaults' })
  const problem = await locationProblem(body.path, deps)
  if (problem === 'unresolved') return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  if (problem !== undefined) return reply(422, { result: 'refused', problem } satisfies DefaultsAnswer)
  const path = await storePath(deps)
  if (path === undefined) return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  const key = workspaceKey(body.path)
  try {
    await changeDefaultsStore(path, content => ({ ...content, workspaces: { ...content.workspaces, [key]: body.defaults } }))
    return reply(200, { result: 'defaults', defaults: body.defaults } satisfies DefaultsAnswer)
  } catch (error) {
    deps.warn(`the workspace defaults were not kept: ${codeOf(error)}`)
    return reply(500, { result: 'failed' } satisfies DefaultsAnswer)
  }
}

/**
 * Record the folder a new folder or clone went in, so the next one starts there. A failure is logged and changes nothing else.
 * @param parent - the folder.
 * @param deps - the environment and the log.
 */
export async function rememberParent(parent: string, deps: DefaultsDeps): Promise<void> {
  const path = await storePath(deps)
  if (path === undefined) return
  try {
    await changeDefaultsStore(path, content => ({ ...content, lastParent: parent }))
  } catch (error) {
    deps.warn(`the last folder used was not kept: ${codeOf(error)}`)
  }
}

/**
 * The last folder a new folder or clone went in.
 * @param deps - the environment and the log.
 * @returns the folder, or undefined when none is recorded or the store cannot be read.
 */
export async function lastParent(deps: DefaultsDeps): Promise<string | undefined> {
  const path = await storePath(deps)
  if (path === undefined) return undefined
  try {
    return (await readDefaultsStore(path)).lastParent
  } catch (error) {
    deps.warn(`the last folder used was not read: ${codeOf(error)}`)
    return undefined
  }
}

/** What the seed reads of a new agent. */
export interface SeededAgent {
  readonly session: Pick<Session, 'header' | 'ownEvents'>
  readonly model: { select(selection: Readonly<ModelSelection>): void }
}

/** What the seed needs from the harness. */
export interface SeedDeps extends DefaultsDeps {
  /** The provider routes the harness has, by id. */
  readonly providers: () => readonly string[]
}

/**
 * Whether a new agent's chat is one the workspace's model applies to: a top-level chat just created (not resumed,
 * forked or delegated) in a folder, whose log records no model yet.
 * @param agent - the new agent.
 * @param source - why its lifecycle began.
 * @returns the chat's folder, or undefined when the seed leaves it alone.
 */
function seedable(agent: SeededAgent, source: SessionStartSource): string | undefined {
  const header = agent.session.header
  if (source !== 'startup' || header.isSeeded || header.origin === 'subagent' || header.parentSession !== undefined) return undefined
  if (header.cwd === undefined || header.cwd.trim() === '') return undefined
  if (agent.session.ownEvents().some(event => event.type === 'model/selection' || event.type === 'request/header')) return undefined
  return header.cwd
}

/**
 * Start a new chat on its workspace's model: append `model/selection` when the workspace records a model whose provider
 * route the harness has. A chat in a workspace without a model, or whose provider is gone, starts on the home's
 * default as before; a store that cannot be read is logged and the chat opens all the same.
 * @param agent - the new agent.
 * @param source - why its lifecycle began.
 * @param deps - the providers, the environment and the log.
 * @returns the selection appended, or undefined.
 */
export async function seedWorkspaceModel(agent: SeededAgent, source: SessionStartSource, deps: SeedDeps): Promise<WorkspaceDefaults['model']> {
  const cwd = seedable(agent, source)
  if (cwd === undefined) return undefined
  const path = await storePath(deps)
  if (path === undefined) return undefined
  let model: WorkspaceDefaults['model']
  try {
    model = (await readDefaultsStore(path)).workspaces[workspaceKey(cwd)]?.model
  } catch (error) {
    deps.warn(`a new chat starts on the home's model, because the workspace defaults were not read: ${codeOf(error)}`)
    return undefined
  }
  if (model === undefined) return undefined
  if (!deps.providers().includes(model.provider)) {
    deps.warn('a new chat starts on the home\'s model, because its workspace\'s model route is not available')
    return undefined
  }
  agent.model.select({
    provider: model.provider,
    model: model.model,
    ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(model.reasoningEffort) }),
  })
  return model
}
