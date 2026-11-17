/**
 * Host half of Delorun's new-workspace flow. While upstream's workspace registry is present it serves the flow's exact
 * Connection Fetch routes: the places to start from ({@link PLACES_PATH}), a bounded folder search ({@link SEARCH_PATH}),
 * one folder's preview ({@link PREVIEW_PATH}), adding an existing folder ({@link ADD_WORKSPACE_PATH}), making a new folder
 * with Git optional ({@link CREATE_PATH}), cloning from Git with a branch optional ({@link CLONE_PATH},
 * {@link CLONE_STATUS_PATH}), and one workspace's defaults ({@link DEFAULTS_PATH}, {@link SET_DEFAULTS_PATH}). Every route
 * answers the computer, and a paired device only while it holds an unlock; every route refuses the folders Delorun never
 * adds. It also starts each new chat in a workspace on the workspace's model, through upstream's `model/selection`
 * event.
 * @module @delorun/plugin-new-workspace
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: the ctx.agents merge and the agent/created event.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: the ctx.llm merge.
import type {} from '@deepseek-ai/dsh-llm'
// The ctx.homeAuth merge, and the pathname the guard compares.
import { gateByUnlock, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { createCloneService, spawnGit } from './clone.ts'
import type { Config } from './config.ts'
import { createWorkspace } from './create.ts'
import { lastParent, readDefaultsRoute, rememberParent, seedWorkspaceModel, setDefaultsRoute } from './defaults.ts'
import { readBody, reply } from './http.ts'
import { previewFolder, readPlaces } from './places.ts'
import { searchFolders } from './search.ts'
import { addWorkspace } from './workspace-route.ts'
import {
  ADD_WORKSPACE_PATH, CLONE_PATH, CLONE_STATUS_PATH, CREATE_PATH, DEFAULTS_PATH, PLACES_PATH, PREVIEW_PATH, PreviewRequest,
  SEARCH_PATH, SearchRequest, SET_DEFAULTS_PATH,
} from './wire.ts'

export { Config, NEW_WORKSPACE_ROW_ID } from './config.ts'
export * from './wire.ts'
export { cloneArguments, cloneEnvironment, createCloneTemplate, failureOf, HARDENED_CONFIG, spawnGit, type GitOutcome, type GitRunner } from './clone.ts'
export { isBranchName, isCloneAddress, isFolderName, suggestedName } from './clone-address.ts'

/** The plugin's name in logs. */
export const name = 'delorun-new-workspace'

/** Required services: the Connection for the routes. */
export const inject = ['connection']

/**
 * Serve the flow's routes while the workspace registry is present, and seed new chats with their workspace's model.
 * @param ctx - the plugin context with the injected services.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const warn = (message: string): void => { ctx.logger.warn(`${name}: ${message}`) }
  // The process environment boundary: the Delorun home is resolved from it, as every Delorun plugin resolves it.
  const env = process.env
  const located = { env, warn }
  ctx.on('agent/created', async ({ agent, source }) => {
    await seedWorkspaceModel(agent, source, { ...located, providers: () => (ctx.get('llm')?.listProviders() ?? []).map(provider => provider.id) })
    return undefined
  }, { prepend: true })
  ctx.inject(['workspaceRegistry'], (child) => {
    const deps = { registry: child.workspaceRegistry, ...located }
    const remember = (parent: string): Promise<void> => rememberParent(parent, located)
    const clones = createCloneService({ ...deps, roots: config.roots, git: spawnGit, timeoutMs: config.cloneTimeoutMs, remember })
    child.effect(() => () => { clones.dispose() }, 'delorun-new-workspace: clones')
    // Before the body is read: only the computer or a reach device reaches these routes, and a device needs an unlock.
    const gated = new Set<string>([PLACES_PATH, SEARCH_PATH, PREVIEW_PATH, ADD_WORKSPACE_PATH, CREATE_PATH, CLONE_PATH, CLONE_STATUS_PATH, DEFAULTS_PATH, SET_DEFAULTS_PATH])
    child.on('connection/request', async (request, response, next) => {
      if (gated.has(routedPathname(request.url)) && !requireComputerOrDevice(request, response, child.get('homeAuth'), 'Setting up a workspace')) return
      await next()
    })
    const unlocked = (fetch: (request: Request) => Promise<Response>, options: { readonly renews: boolean }) => gateByUnlock(() => child.get('homeAuth'), fetch, { renews: options.renews })
    child.connection.fetch.register({
      path: PLACES_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...unlocked(async () => reply(200, await readPlaces({
        ...deps, roots: config.roots, suggested: config.suggested, firstParent: config.firstParent, lastParent: () => lastParent(located),
      })), { renews: false }),
    })
    child.connection.fetch.register({
      path: SEARCH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...unlocked(async (request) => {
        const body = await readBody(request, SearchRequest)
        if (body === undefined) return reply(400, { error: 'the request must be JSON with a query of 1 to 100 characters' })
        return reply(200, await searchFolders(body.query, { ...located, roots: config.roots, depth: config.searchDepth, folders: config.searchFolders, timeMs: config.searchTimeMs }))
      }, { renews: false }),
    })
    child.connection.fetch.register({
      path: PREVIEW_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...unlocked(async (request) => {
        const body = await readBody(request, PreviewRequest)
        if (body === undefined) return reply(400, { error: 'the request must be JSON with one path' })
        return reply(200, await previewFolder(body.path, { ...located, roots: config.roots, timeMs: config.searchTimeMs }))
      }, { renews: false }),
    })
    child.connection.fetch.register({ path: ADD_WORKSPACE_PATH, methods: ['POST'], requestBody: 'buffered', ...unlocked(request => addWorkspace(request, deps), { renews: true }) })
    child.connection.fetch.register({
      path: CREATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...unlocked(request => createWorkspace(request, { ...deps, roots: config.roots, git: spawnGit, timeoutMs: config.cloneTimeoutMs, remember }), { renews: true }),
    })
    child.connection.fetch.register({ path: CLONE_PATH, methods: ['POST'], requestBody: 'buffered', ...unlocked(request => clones.start(request), { renews: true }) })
    child.connection.fetch.register({ path: CLONE_STATUS_PATH, methods: ['POST'], requestBody: 'buffered', ...unlocked(request => clones.status(request), { renews: false }) })
    child.connection.fetch.register({ path: DEFAULTS_PATH, methods: ['POST'], requestBody: 'buffered', ...unlocked(request => readDefaultsRoute(request, located), { renews: false }) })
    child.connection.fetch.register({ path: SET_DEFAULTS_PATH, methods: ['POST'], requestBody: 'buffered', ...unlocked(request => setDefaultsRoute(request, located), { renews: true }) })
  })
}
