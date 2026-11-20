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
// Type-only: the ctx.browserUseAdmission merge and the browser-use/admission-changed event.
import type {} from '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: the ctx.agents merge and the agent/created event.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: the ctx.llm merge.
import type {} from '@deepseek-ai/dsh-llm'
// The ctx.homeAuth merge, and the pathname the guard compares.
import { admitApprovedDevice, gateByClass, PICKER_HOLD_ID, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
import { createBrowserAdmission } from './browser-admission.ts'
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
 * Serve the flow's routes while the workspace registry is present, seed new chats with their workspace's model, and
 * provide `browserUseAdmission`, which keeps the isolated browser from chats in a workspace that chose no browser.
 * @param ctx - the plugin context with the injected services.
 * @param config - the row's configuration.
 * @returns once the stored browser choices are read and the admission is provided.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const warn = (message: string): void => { ctx.logger.warn(`${name}: ${message}`) }
  // The process environment boundary: the Delorun home is resolved from it, as every Delorun plugin resolves it.
  const env = process.env
  const located = { env, warn }
  ctx.on('agent/created', async ({ agent, source }) => {
    await seedWorkspaceModel(agent, source, { ...located, providers: () => (ctx.get('llm')?.listProviders() ?? []).map(provider => provider.id) })
    return undefined
  }, { prepend: true })
  // Read before it is provided, so no chat starts while the choices are unknown.
  const browserAdmission = await createBrowserAdmission(located, session => ctx.parallel('browser-use/admission-changed', session))
  ctx.provide('browserUseAdmission', { admitted: agent => browserAdmission.admitted(agent) })
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
    const row = (expression: string): string => `route:plugin-new-workspace/src/index.ts#${expression}`
    // A `face` route: Face ID for the call (or, with no passkey, an unlock). One Face ID opens the folder picker
    // for the three reads that name the computer's paths; a live hold on `PICKER_HOLD_ID` admits the rest of that picker's reads.
    const faced = (expression: string, action: string, fetch: (request: Request) => Promise<Response>, options: { readonly renews: boolean, readonly picker?: true }) => gateByClass(() => child.get('homeAuth'), fetch, {
      row: row(expression), action: `plugin-new-workspace/${action}`, legacy: { renews: options.renews },
      ...options.picker === true ? { hold: { feature: 'picker' as const, idOf: () => PICKER_HOLD_ID, opens: true } } : {},
    })
    // A `free` route: any approved device, no prompt.
    const free = (fetch: (request: Request) => Promise<Response>) => ({ admitPeer: admitApprovedDevice(), fetch })
    child.connection.fetch.register({
      path: PLACES_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...faced('PLACES_PATH', 'places', async () => reply(200, await readPlaces({
        ...deps, roots: config.roots, suggested: config.suggested, firstParent: config.firstParent, lastParent: () => lastParent(located),
      })), { renews: false, picker: true }),
    })
    child.connection.fetch.register({
      path: SEARCH_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...faced('SEARCH_PATH', 'search', async (request) => {
        const body = await readBody(request, SearchRequest)
        if (body === undefined) return reply(400, { error: 'the request must be JSON with a query of 1 to 100 characters' })
        return reply(200, await searchFolders(body.query, { ...located, roots: config.roots, depth: config.searchDepth, folders: config.searchFolders, timeMs: config.searchTimeMs }))
      }, { renews: false, picker: true }),
    })
    child.connection.fetch.register({
      path: PREVIEW_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...faced('PREVIEW_PATH', 'preview', async (request) => {
        const body = await readBody(request, PreviewRequest)
        if (body === undefined) return reply(400, { error: 'the request must be JSON with one path' })
        return reply(200, await previewFolder(body.path, { ...located, roots: config.roots, timeMs: config.searchTimeMs }))
      }, { renews: false, picker: true }),
    })
    child.connection.fetch.register({ path: ADD_WORKSPACE_PATH, methods: ['POST'], requestBody: 'buffered', ...faced('ADD_WORKSPACE_PATH', 'add', request => addWorkspace(request, deps), { renews: true }) })
    child.connection.fetch.register({
      path: CREATE_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      ...faced('CREATE_PATH', 'create', request => createWorkspace(request, { ...deps, roots: config.roots, git: spawnGit, timeoutMs: config.cloneTimeoutMs, remember }), { renews: true }),
    })
    child.connection.fetch.register({ path: CLONE_PATH, methods: ['POST'], requestBody: 'buffered', ...faced('CLONE_PATH', 'clone', request => clones.start(request), { renews: true }) })
    child.connection.fetch.register({ path: CLONE_STATUS_PATH, methods: ['POST'], requestBody: 'buffered', ...free(request => clones.status(request)) })
    child.connection.fetch.register({ path: DEFAULTS_PATH, methods: ['POST'], requestBody: 'buffered', ...free(request => readDefaultsRoute(request, located, child.workspaceRegistry)) })
    child.connection.fetch.register({ path: SET_DEFAULTS_PATH, methods: ['POST'], requestBody: 'buffered', ...faced('SET_DEFAULTS_PATH', 'set-defaults', async (request) => {
      const response = await setDefaultsRoute(request, located)
      if (response.ok) await browserAdmission.refresh()
      return response
    }, { renews: true }) })
  })
}
