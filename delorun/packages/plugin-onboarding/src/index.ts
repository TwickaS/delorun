/**
 * Host entry of Delorun's onboarding. The flow is browser-only; this half keeps the row's configuration (progress and
 * the recommended packages and rows) as live settings and serves the guide's exact Connection Fetch routes: what the terminal
 * setup recorded ({@link SETUP_RECORD_PATH}), so onboarding can leave out what the terminal covered; this computer's
 * readiness ({@link READINESS_PATH}); the key test ({@link KEY_TEST_PATH}); which connections the recommended plugins
 * are for ({@link RECOMMEND_PATH}); and, while upstream's workspace registry is present, which workspace records it set
 * aside ({@link WORKSPACE_NOTICE_PATH}) and an installed agent's models ({@link AGENT_MODELS_PATH}). Adding, creating and
 * cloning a workspace are `@delorun/plugin-new-workspace`'s routes.
 * @module @delorun/plugin-onboarding
 */
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: the ctx.profileContext merge.
import type {} from '@deepseek-ai/dsh-app-boot'
// Type-only: the ctx.connection merge.
import type {} from '@deepseek-ai/dsh-client-connection'
// Type-only: the ctx.settings merge.
import type {} from '@deepseek-ai/dsh-settings'
// The ctx.homeAuth merge, and the pathname the guard compares.
import { admitApprovedDevice, admitKeyDevice, requireComputerOrDevice, routedPathname } from '@delorun/home-auth'
// Type-only: the ctx.workspaceRegistry merge.
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: the ctx.subagents merge.
import type {} from '@deepseek-ai/dsh-subagent'
import { brandString } from '@deepseek-ai/dsh-brand'
// The ctx.credentials merge and the credential reference's brand.
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
// Type-only: the ctx.llm merge.
import type {} from '@deepseek-ai/dsh-llm'
import { modelListingURL, PUBLIC_BASE_URL, requestModelListing } from '@deepseek-ai/dsh-llm-deepseek'
import { systemTailscale } from '@delorun/reach'
import { SETUP_DEFAULT_CREDENTIAL_VARIABLE } from '@delorun/contract-setup-answers'
// Type-only: the ctx.previewFlags merge.
import type {} from '@delorun/preview-flags'
import { readSetupRecord } from './answers.ts'
import { createDeferredStore } from './deferred.ts'
import type { Config } from './config.ts'
import { DEEPSEEK_ROUTE, listingResult, testKeys, type KeyTestDeps } from './key-test.ts'
import { VARIABLE_NAME, type KeySource, type KeySourceKind } from './wire.ts'
import { assertRowsExist, type RowSource } from './rows.ts'
import { findLocalServers } from './local-models.ts'
import { PREVIEW_FLAGS } from './preview-flags.ts'
import { processReadinessEnvironment, readReadiness } from './readiness.ts'
import { installedReader, recommend, registryReader } from './recommend.ts'
import {
  AGENT_MODELS_PATH, AgentModelsRequest, DEFER_STEP_PATH, DeferStepRequest, KEY_TEST_PATH, LOCAL_MODELS_PATH, MAX_SET_ASIDE, READINESS_PATH, RECOMMEND_PATH, RecommendRequest, SETUP_RECORD_PATH, START_PATH, WORKSPACE_NOTICE_PATH,
  type StartAnswer, type WorkspaceNoticeAnswer,
} from './wire.ts'
import { listAgentModels } from './agent-models.ts'

export { SETUP_ANSWERS_FILENAME, MAX_ANSWERS_BYTES, readSetupRecord } from './answers.ts'
export { Config, DEFAULT_SETTINGS, ONBOARDING_ROW_ID, PACKAGE_NAME, RECOMMENDED_LIMIT, ROW_ID, type OnboardingSettings } from './config.ts'
export {
  CONNECTION_ID, FOLDER_KINDS, KEY_RESULTS, KEY_TEST_PATH, KeyTestAnswer, LOCAL_MODELS_PATH, LOCAL_SERVER_KINDS, LocalModelsAnswer, LocalServer, isLoopbackBaseURL, MAX_SECTIONS, NO_RECORD, READINESS_PATH, Readiness,
  DEFER_STEP_PATH, DEFERRABLE_STEPS, DeferStepAnswer, DeferStepRequest, DeferrableStep, MAX_SET_ASIDE, RECOMMEND_PATH, RecommendAnswer, SECTION_NAME, SETUP_RECORD_PATH, SetupRecord, START_ID, START_PATH, StartAnswer, WORKSPACE_NOTICE_PATH, WorkspaceNoticeAnswer,
  type FolderKind, type KeyResult,
} from './wire.ts'
export { declaredConnections } from './recommend.ts'
export { assertRowsExist, type RowSource } from './rows.ts'
export { PREVIEW_FLAGS, PREVIEW_STEPS } from './preview-flags.ts'

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
 * Keep the row's settings, and serve the setup record, this computer's readiness, the key test, the recommendations,
 * and, while the registry is present, the workspace notice and an agent's models.
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
  // The planned steps the studio shows under a preview flag; without the preview-flags row nothing is declared and every preview is off.
  ctx.inject(['previewFlags'], (child) => {
    for (const flag of PREVIEW_FLAGS) child.effect(() => child.previewFlags.declare(flag), `delorun-onboarding: preview flag ${flag.id}`)
  })
  // Without the registry the routes are absent and the studio's requests fail, which its folder choice reports.
  ctx.inject(['workspaceRegistry'], (child) => {
    // Before the body is read: only the computer or a reach device reaches the route; it lists an agent's models, which any approved device may (class `free`).
    child.on('connection/request', async (request, response, next) => {
      if (routedPathname(request.url) === AGENT_MODELS_PATH && !requireComputerOrDevice(request, response, child.get('homeAuth'), 'Listing an agent\'s models')) return
      await next()
    })
    child.connection.fetch.register({
      path: WORKSPACE_NOTICE_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      admitPeer: admitApprovedDevice(),
      fetch: () => Promise.resolve(json({ setAside: child.workspaceRegistry.quarantined.slice(-MAX_SET_ASIDE).map(file => basename(file)) } satisfies WorkspaceNoticeAnswer)),
    })
    child.connection.fetch.register({
      path: AGENT_MODELS_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      admitPeer: admitApprovedDevice(),
      fetch: async (request) => {
        let body: unknown
        try {
          body = await request.json()
        } catch (_notJson) {
          // The parser's message quotes the body, so the request is only refused.
          body = undefined
        }
        const parsed = AgentModelsRequest.safeParse(body)
        if (!parsed.success) return new Response(JSON.stringify({ error: 'the request must be JSON with agent' }), { status: 400, headers: { 'content-type': 'application/json' } })
        return json(await listAgentModels(parsed.data.agent, {
          provider: agent => ctx.get('subagents')?.getProvider(agent),
          cwd: () => ctx.get('profileContext')?.dir ?? process.cwd(),
          timeoutMs: config.agentModelsTimeoutMs,
          warn,
        }))
      },
    })
  })
  const deferred = createDeferredStore(ctx.get('profileContext')?.dir, warn)
  ctx.connection.fetch.register({
    path: SETUP_RECORD_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: admitApprovedDevice(),
    fetch: async () => {
      const record = await readSetupRecord(ctx.get('profileContext')?.dir, warn)
      const steps = await deferred.read()
      return json(steps.length === 0 ? record : { ...record, deferred: steps })
    },
  })
  ctx.connection.fetch.register({
    path: DEFER_STEP_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // An approved phone may only note that a step waits for the computer; the note changes no setting.
    admitPeer: admitApprovedDevice(),
    fetch: async (request) => {
      let body: unknown
      try {
        body = await request.json()
      } catch (_notJson) {
        // The parser's message quotes the body, so the request is only refused.
        body = undefined
      }
      const parsed = DeferStepRequest.safeParse(body)
      if (!parsed.success) return new Response(JSON.stringify({ error: 'the request must be JSON with a known step id and deferred' }), { status: 400, headers: { 'content-type': 'application/json' } })
      try {
        return json({ deferred: await deferred.set(parsed.data.id, parsed.data.deferred) })
      } catch (error) {
        warn(`a deferred step was not kept: ${error instanceof Error ? error.message : 'unknown failure'}`)
        return new Response(JSON.stringify({ error: 'the deferred step could not be kept' }), { status: 500, headers: { 'content-type': 'application/json' } })
      }
    },
  })
  ctx.connection.fetch.register({
    path: READINESS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: admitApprovedDevice(),
    fetch: async () => json(await readReadiness(processReadinessEnvironment(systemTailscale()))),
  })
  // Named once per start, so "Complete setup later" holds until Delorun next starts and not longer.
  const startId = randomUUID()
  ctx.connection.fetch.register({
    path: START_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    // A random id for this start and nothing else, so an approved phone reads it like the computer does.
    admitPeer: admitApprovedDevice(),
    fetch: () => Promise.resolve(json({ startId } satisfies StartAnswer)),
  })
  ctx.connection.fetch.register({
    path: KEY_TEST_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // An approved phone tests keys; the answer names each provider's result, never a key.
    admitPeer: admitKeyDevice(() => ctx.get('homeAuth')),
    fetch: async () => json(await testKeys(keyTestDeps(ctx, config.keyTestTimeoutMs, config.hiddenProviders))),
  })
  ctx.connection.fetch.register({
    path: LOCAL_MODELS_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    admitPeer: admitApprovedDevice(),
    fetch: async () => json(await findLocalServers(config.keyTestTimeoutMs)),
  })
  ctx.connection.fetch.register({
    path: RECOMMEND_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // An approved phone reads what the recommended plugins are for; the answer names packages and connections only.
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

/** The credentials service's source layers, as the wire names them. */
const SOURCE_KINDS: Readonly<Record<string, KeySourceKind>> = { 'file': 'saved', 'env': 'environment', 'project-env': 'project-file', 'user-env': 'home-file' }

/**
 * The key test's parts in this harness: upstream's provider registry and discoveries, each configurable route's credential
 * as the credentials service describes its reference (`configured`, read without the value), and the official DeepSeek
 * route's listing with the key its credential reference resolves to (the variable its profile names, `DEEPSEEK_API_KEY` by default, through the credentials service,
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
    credentialSource: async (provider): Promise<KeySource | undefined> => {
      const entry = ctx.get('llm')?.listConfigurableProviders().find(each => each.provider === provider)
      if (entry === undefined) return undefined
      const variable = credentialRef(ctx, entry) ?? (provider === DEEPSEEK_ROUTE ? SETUP_DEFAULT_CREDENTIAL_VARIABLE : undefined)
      if (variable === undefined) return undefined
      // Only the variable's name travels; a reference that is not a plain name is left out rather than sent.
      const name = VARIABLE_NAME.test(variable) ? variable : undefined
      const credentials = ctx.get('credentials')
      if (credentials === undefined) return (env[variable] ?? '') === '' ? undefined : { kind: 'environment', ...(name === undefined ? {} : { variable: name }) }
      const info = await credentials.describe(brandString<CredentialRef>(variable))
      if (!info.configured) return undefined
      return { kind: (info.source === undefined ? undefined : SOURCE_KINDS[info.source]) ?? 'unknown', ...(name === undefined ? {} : { variable: name }) }
    },
    discover: async (settingsNs, provider, signal) => {
      const llm = ctx.get('llm')
      if (llm === undefined) throw Object.assign(new Error('no model runtime'), { code: 'NO_DISCOVERY' })
      await llm.discoverModels(settingsNs, { provider }, signal)
    },
    deepseek: async (signal) => {
      // The variable the route's own profile names, as the provider reads it; the default only where the profile names none.
      const entry = ctx.get('llm')?.listConfigurableProviders().find(each => each.provider === DEEPSEEK_ROUTE)
      const variable = (entry === undefined ? undefined : credentialRef(ctx, entry)) ?? SETUP_DEFAULT_CREDENTIAL_VARIABLE
      const ref = brandString<CredentialRef>(variable)
      const credentials = ctx.get('credentials')
      const key = credentials === undefined ? env[variable] : (await credentials.resolve(ref))?.value
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
