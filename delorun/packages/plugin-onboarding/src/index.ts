/**
 * Host entry of Delorun's onboarding. The flow is browser-only; this half keeps the row's configuration (progress and
 * the recommended packages and rows) as live settings and serves the guide's exact Connection Fetch routes: what the terminal
 * setup recorded ({@link SETUP_RECORD_PATH}), so onboarding can leave out what the terminal covered; this computer's
 * readiness ({@link READINESS_PATH}); the key test ({@link KEY_TEST_PATH}); which connections the recommended plugins
 * are for ({@link RECOMMEND_PATH}); and, while upstream's workspace registry is present, adding a folder
 * ({@link ADD_WORKSPACE_PATH}) or cloning one from Git ({@link CLONE_PATH}, {@link CLONE_STATUS_PATH}) as a workspace,
 * which refuse the folders Delorun never adds and answer only the loopback listener.
 * @module @delorun/plugin-onboarding
 */
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.profileContext merge.
import type {} from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
// The ctx.homeAuth merge, and the pathname the guard compares.
import { admitApprovedDevice, admitKeyDevice, routedPathname } from '@delorun/home-auth'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
import { brandString } from '@deepseek-ai/dsh-brand'
// The ctx.credentials merge and the credential reference's brand.
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.llm merge.
import type {} from '@deepseek-ai/dsh-llm'
import { modelListingURL, PUBLIC_BASE_URL, requestModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { systemTailscale } from '@delorun/reach'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE } from '@delorun/contract-setup-answers'
import { readSetupRecord } from './answers.ts'
import { createCloneService, spawnGit } from './clone.ts'
import type { Config } from './config.ts'
import { listingResult, testKeys, type KeyTestDeps } from './key-test.ts'
import { assertRowsExist, type RowSource } from './rows.ts'
import { processReadinessEnvironment, readReadiness } from './readiness.ts'
import { installedReader, recommend, registryReader } from './recommend.ts'
import {
  ADD_WORKSPACE_PATH, CLONE_PATH, CLONE_STATUS_PATH, KEY_TEST_PATH, MAX_SET_ASIDE, READINESS_PATH, RECOMMEND_PATH, RecommendRequest, SETUP_RECORD_PATH, WORKSPACE_NOTICE_PATH,
  type WorkspaceNoticeAnswer,
} from './wire.ts'
import { addWorkspace, arrivedOnLoopback } from './workspace-route.ts'

export { SETUP_ANSWERS_FILENAME, MAX_ANSWERS_BYTES, readSetupRecord } from './answers.ts'
export { Config, DEFAULT_SETTINGS, ONBOARDING_ROW_ID, PACKAGE_NAME, RECOMMENDED_LIMIT, ROW_ID, type OnboardingSettings } from './config.ts'
export {
  ADD_WORKSPACE_PATH, AddWorkspaceAnswer, AddWorkspaceRequest, CLONE_FAILURES, CLONE_PATH, CLONE_PROBLEMS, CLONE_STATUS_PATH, CloneRequest, CloneStart, CloneStatus,
  CONNECTION_ID, FOLDER_KINDS, KEY_RESULTS, KEY_TEST_PATH, KeyTestAnswer, LOCATION_PROBLEMS, MAX_ADD_BODY_BYTES, MAX_PATH_LENGTH, MAX_SECTIONS, NO_RECORD, READINESS_PATH, Readiness,
  MAX_SET_ASIDE, RECOMMEND_PATH, RecommendAnswer, SECTION_NAME, SETUP_RECORD_PATH, SetupRecord, WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer,
  type CloneFailure, type CloneProblem, type FolderKind, type KeyResult, type LocationProblem,
} from './wire.ts'
export { cloneEnvironment, failureOf, type GitOutcome, type GitRunner } from './clone.ts'
export { isCloneAddress, isFolderName, suggestedName } from './clone-address.ts'
export { declaredConnections } from './recommend.ts'
export { assertRowsExist, type RowSource } from './rows.ts'

/** The plugin's name in logs. */
export const name = 'delorun-onboarding'

/** Required services: the Connection for the routes. */
export const inject = ['connection']

/**
 * Answer a JSON message, never cached.
 * @param body - the message.
 * @returns the response.
 */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
}

/**
 * Keep the row's settings, serve the setup record, this computer's readiness, the key test and the recommendations, and
 * add or clone workspaces while the registry is present.
 * @param ctx - the plugin context with the injected services.
 * @param config - the row's configuration.
 * @throws when `optionalRows` names a row the profile does not hold.
 */
export function apply(ctx: Context, config: Config): void {
  const loader: RowSource | undefined = ctx.get('loader')
  assertRowsExist(config.optionalRows.get(), loader)
  const warn = (message: string): void => { ctx.logger.warn(`${name}: ${message}`) }
  // Onboarding edits its own settings in the studio, so the settings service builds no form for them.
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // Without the registry the routes are absent and the studio's requests fail, which its folder choice reports.
  ctx.inject(['workspaceRegistry'], (child) => {
    // The process environment boundary: the Delorun home is resolved from it, as every Delorun plugin resolves it.
    const deps = { registry: child.workspaceRegistry, env: process.env, warn }
    const clones = createCloneService({ ...deps, git: spawnGit, timeoutMs: config.cloneTimeoutMs })
    child.effect(() => () => { clones.dispose() }, 'delorun-onboarding: clones')
    // Before the body is read: a reach or remote session never adds or clones a workspace.
    const loopbackOnly = new Set<string>([ADD_WORKSPACE_PATH, CLONE_PATH, CLONE_STATUS_PATH])
    child.on('connection/request', async (request, response, next) => {
      if (loopbackOnly.has(routedPathname(request.url)) && !arrivedOnLoopback(request, response, child.get('homeAuth'))) return
      await next()
    })
    child.connection.fetch.register({
      path: WORKSPACE_NOTICE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: () => Promise.resolve(json({ setAside: child.workspaceRegistry.quarantined.slice(-MAX_SET_ASIDE).map(file => basename(file)) } satisfies WorkspaceNoticeAnswer)),
    })
    child.connection.fetch.register({ path: ADD_WORKSPACE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => addWorkspace(request, deps) })
    child.connection.fetch.register({ path: CLONE_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => clones.start(request) })
    child.connection.fetch.register({ path: CLONE_STATUS_PATH, methods: ['POST'], requestBody: 'buffered', fetch: request => clones.status(request) })
  })
  ctx.connection.fetch.register({
    path: SETUP_RECORD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await readSetupRecord(ctx.get('profileContext')?.dir, warn)),
  })
  ctx.connection.fetch.register({
    path: READINESS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => json(await readReadiness(processReadinessEnvironment(systemTailscale()))),
  })
  ctx.connection.fetch.register({
    path: KEY_TEST_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // A380: an approved phone tests keys; the answer names each provider's result, never a key.
    admitPeer: admitKeyDevice(() => ctx.get('homeAuth')),
    fetch: async () => json(await testKeys(keyTestDeps(ctx, config.keyTestTimeoutMs, config.hiddenProviders))),
  })
  ctx.connection.fetch.register({
    path: RECOMMEND_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // A381: an approved phone reads what the recommended plugins are for; the answer names packages and connections only.
    admitPeer: admitApprovedDevice(),
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch (_notJson) {
        // The parser's message quotes the body, so the request is only refused.
        body = undefined
      }
      const parsed = RecommendRequest.safeParse(body)
      if (!parsed.success) return new Response(JSON.stringify({ error: 'the request must be JSON with registry' }), { status: 400, headers: { 'content-type': 'application/json' } })
      return json(await recommend(config.plugins.get(), parsed.data.registry, {
        installed: installedReader(ctx.get('profileContext')?.dir, import.meta.url),
        registry: registryReader(config.registry),
        timeoutMs: config.registryTimeoutMs,
      }))
    },
  })
}

/**
 * The credential reference a configurable route's settings profile names.
 * @param ctx - the plugin context.
 * @param entry - the route's directory entry.
 * @returns the reference, or undefined when the profile names none.
 * @throws when the settings service is not mounted, so the profile cannot be read.
 */
function credentialRef(ctx: Context, entry: { readonly settingsNs: string; readonly settingsPath: readonly string[] }): string | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) throw new Error('the settings service is not mounted, so the route\'s credential reference cannot be read')
  let profile: unknown = settings.describe({ redactSecrets: true }).find(row => row.ns === entry.settingsNs)?.value
  for (const key of entry.settingsPath) profile = typeof profile === 'object' && profile !== null ? Reflect.get(profile, key) : undefined
  const ref: unknown = typeof profile === 'object' && profile !== null ? Reflect.get(profile, 'apiKeyEnv') : undefined
  return typeof ref === 'string' && ref !== '' ? ref : undefined
}

/**
 * The key test's parts in this harness: upstream's provider registry and discoveries, each configurable route's credential
 * as the credentials service describes its reference (`configured`, read without the value), and the official DeepSeek
 * route's listing with the key its credential reference resolves to (`DEEPSEEK_API_KEY`, through the credentials service,
 * or the environment where none is mounted) at the address `DEEPSEEK_BASE_URL` names, or DeepSeek's public one.
 * @param ctx - the plugin context.
 * @param timeoutMs - the most time one route's test may take.
 * @param hidden - route ids the test leaves out.
 * @returns the parts.
 */
export function keyTestDeps(ctx: Context, timeoutMs: number, hidden: readonly string[]): KeyTestDeps {
  const env = process.env
  return {
    timeoutMs,
    hidden,
    providers: () => ctx.get('llm')?.listProviders() ?? [],
    configurable: () => ctx.get('llm')?.listConfigurableProviders() ?? [],
    needsKey: (provider) => {
      const entry = ctx.get('llm')?.listConfigurableProviders().find(each => each.provider === provider)
      // A route the directory does not list is not known to be keyless.
      if (entry === undefined) return true
      return credentialRef(ctx, entry) !== undefined || (entry.nativeAuth?.env.length ?? 0) > 0
    },
    credentialConfigured: async (provider) => {
      const entry = ctx.get('llm')?.listConfigurableProviders().find(each => each.provider === provider)
      if (entry === undefined) return false
      const ref = credentialRef(ctx, entry)
      if (ref === undefined) return false
      const credentials = ctx.get('credentials')
      // Without the credentials service the launch environment is the store, as for the DeepSeek route below.
      if (credentials === undefined) return (env[ref] ?? '') !== ''
      return (await credentials.describe(brandString<CredentialRef>(ref))).configured
    },
    discover: async (settingsNs, provider, signal) => {
      const llm = ctx.get('llm')
      if (llm === undefined) throw Object.assign(new Error('no model runtime'), { code: 'NO_DISCOVERY' })
      await llm.discoverModels(settingsNs, { provider }, signal)
    },
    deepseek: async (signal) => {
      const ref = brandString<CredentialRef>(SETUP_DEFAULT_CREDENTIAL_VARIABLE)
      const credentials = ctx.get('credentials')
      const key = credentials === undefined ? env[SETUP_DEFAULT_CREDENTIAL_VARIABLE] : (await credentials.resolve(ref))?.value
      if (key === undefined || key === '') return 'no-key'
      const base = env['DEEPSEEK_BASE_URL'] !== undefined && env['DEEPSEEK_BASE_URL'] !== '' ? env['DEEPSEEK_BASE_URL'] : PUBLIC_BASE_URL
      try {
        await requestModelListing(modelListingURL(base), { 'x-api-key': key }, signal)
        return 'works'
      } catch (error) {
        return listingResult(error)
      }
    },
  }
}
