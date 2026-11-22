/**
 * Privacy defaults of a Delorun CLI profile, against local network fixtures: upstream's own plugins, configured with the
 * rows the profile composes, send no session log in a model request body and no analytics record to a collector, where
 * the same plugins configured with upstream's web profile rows send both. No row of the composition names a Delorun host.
 */
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import ProductAnalytics from '@deepseek-ai/dsh-client-product-analytics'
import DeepSeekLlmApiExtensions from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import ProductTelemetry, { Config as TelemetryConfig } from '@deepseek-ai/dsh-host-product-telemetry-otel'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import OTel from '@deepseek-ai/dsh-otel'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionLogDeepSeek from '@deepseek-ai/dsh-session-log-deepseek'
import { SETUP_OPT_IN_ROWS } from '@delorun/contract-setup-answers'
import { LOCAL_BUNDLE, LOCAL_ROWS, UPSTREAM_TEMPLATE } from '../src/profile.ts'
import { createTestHome, DELORUN_PROFILE, type ComposedRows, type TestHome } from './profiles.ts'

let home: TestHome
const cleanup: (() => Promise<void>)[] = []

beforeAll(() => { home = createTestHome() })
afterAll(() => { home.remove() })
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
  vi.unstubAllEnvs()
})

/**
 * One composed row's config.
 * @param rows - a composed entry list.
 * @param id - the row's id.
 * @returns the row's config, or undefined when the row has none.
 */
function configOf(rows: ComposedRows, id: string): Record<string, unknown> | undefined {
  const row = rows.find(entry => entry.id === id)
  if (row === undefined) throw new Error(`no ${id} row in the composition`)
  return row.config
}

/**
 * Send one model request through upstream's DeepSeek provider to a mock model server, with the session-log plugin
 * configured as a profile composes it.
 * @param sessionLog - the `session-log-deepseek` row's composed config, which is empty in upstream's profiles.
 * @returns every request body the mock server received.
 */
async function modelRequestBodies(sessionLog: Record<string, unknown> | undefined): Promise<unknown[]> {
  vi.stubEnv('DSH_HOME', home.dir)
  vi.stubEnv('DEEPSEEK_API_KEY', 'privacy-fixture-key')
  const server = await startMockLlmServer({ sequence: ['success'], repeatLast: true })
  cleanup.push(() => server.close())
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(DeepSeekLlmApiExtensions)
  await ctx.plugin(LlmDeepSeek, { baseURL: server.baseURL })
  await ctx.plugin(SessionLogDeepSeek, sessionLog ?? {})
  const session = ctx.sessions.create(SessionId('delorun-privacy-defaults'))
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Say hello.' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  for (let request = 0; request < 2; request += 1) {
    for await (const _chunk of ctx.llm.stream({ provider: 'deepseek-official', model: 'deepseek-v4-flash', sessionId: session.id, messages: session.deriveMessages() })) { /* drain */ }
  }
  return server.requests.map(request => request.body)
}

/**
 * Report one desktop analytics event through upstream's analytics and exporter plugins to a local OTLP collector,
 * with analytics configured as a profile composes it, and drain the exporter.
 * @param enabled - the `product-analytics` row's composed `config.enabled`.
 * @returns the bodies the collector received.
 */
async function collectorBodies(enabled: unknown): Promise<string[]> {
  const captures: string[] = []
  const collector = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => { captures.push(Buffer.concat(chunks).toString()); response.end('{}') })
  })
  collector.listen(0, '127.0.0.1')
  await once(collector, 'listening')
  cleanup.push(async () => { const closed = once(collector, 'close'); collector.close(); collector.closeAllConnections(); await closed })
  const address = collector.address()
  if (address === null || typeof address === 'string') throw new Error('the collector has no port')
  const ctx = new Context()
  cleanup.push(() => ctx.fiber.dispose())
  // Stand-ins for the Host services analytics reads around a report; they hold no identity.
  ctx.provide('credentials', { readRecord: async () => undefined } as never)
  ctx.provide('deepseekAccount', { getDeviceIdentity: async () => undefined } as never)
  ctx.provide('webServer', {} as never)
  await ctx.plugin(OTel)
  const exporter = await ctx.plugin(ProductTelemetry, TelemetryConfig({
    endpoint: `http://127.0.0.1:${String(address.port)}/v1/logs`, serviceName: 'delorun-privacy-fixture', serviceVersion: '1', compression: 'none',
  }))
  await ctx.plugin(ProductAnalytics, { enabled: enabled === true, appVersion: 'fixture' })
  await ctx.productAnalytics.report({ eventName: 'api_key_save_click', timestamp: 1_800_000_000_000, attributes: {} })
  await exporter.dispose()
  return captures
}

/**
 * Every string in a composed value, `!!js` expressions included as their source text.
 * @param value - a row or part of one.
 * @returns the strings, depth first.
 */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings)
  return []
}

describe('a Delorun CLI profile', () => {
  it('lists the two upstream opt-in rows it turns off, and the rows it removes or overrides', () => {
    expect(LOCAL_ROWS.filter(row => row.kind === 'changed').map(row => row.id).sort())
      .toEqual([
        SETUP_OPT_IN_ROWS.desktopAnalytics, 'command-feedback', 'connection', 'deepseek-account',
        'plugin-manager', 'sandbox', 'session-telemetry-otel', 'workspace-controller',
        SETUP_OPT_IN_ROWS.sessionLogUpload, 'ui-account-notifications', 'ui-message-feedback', 'ui-settings-account', 'ui-settings-models',
      ].sort())
  })

  it('default-profile model request carries no dsh_session_log', async () => {
    const delorun = configOf(home.rows(DELORUN_PROFILE), SETUP_OPT_IN_ROWS.sessionLogUpload)
    expect(delorun).toEqual({ enabled: false })
    const bodies = await modelRequestBodies(delorun)
    expect(bodies).toHaveLength(2)
    for (const body of bodies) expect(body).not.toHaveProperty('dsh_session_log')
  })

  it('upstream\'s web profile, the control, sends the session log to the same fixture', async () => {
    const bodies = await modelRequestBodies(configOf(home.rows(UPSTREAM_TEMPLATE), SETUP_OPT_IN_ROWS.sessionLogUpload))
    expect(bodies[0]).toHaveProperty('dsh_session_log')
  })

  it('default-profile run sends no analytics or upload', async () => {
    const delorun = home.rows(DELORUN_PROFILE).find(row => row.id === SETUP_OPT_IN_ROWS.desktopAnalytics)
    const upstream = home.rows(UPSTREAM_TEMPLATE).find(row => row.id === SETUP_OPT_IN_ROWS.desktopAnalytics)
    // The row keeps upstream's mount condition, so outside the desktop profile it does not mount at all.
    expect(delorun?.disabled).toEqual(upstream?.disabled)
    expect(delorun?.config).toEqual({ ...upstream?.config, enabled: false })
    expect(await collectorBodies(delorun?.config?.['enabled'])).toEqual([])
    expect(await collectorBodies(upstream?.config?.['enabled'])).toHaveLength(1)
  })

  it('configures no Delorun telemetry destination anywhere in the composition', () => {
    const rows = home.rows(DELORUN_PROFILE)
    const destinations = strings(rows).flatMap(text => [...text.matchAll(/\bhttps?:\/\/([^/'"\s:]+)/g)].map(match => match[1]))
    // The scan reads expressions too: upstream's own collectors are among the destinations it finds.
    expect(destinations).toContain('dsh-otel-collector.deepseeksvc.com')
    expect(destinations.filter(host => host?.includes('delorun') === true)).toEqual([])
    const delorunRows = rows.filter(row => strings([row.name]).some(name => name.startsWith('@delorun/')))
    const studioRows = ['delorun-theme', 'delorun-settings-layout', 'delorun-chat-states', 'delorun-sidebar', 'delorun-onboarding', 'delorun-new-workspace', 'delorun-downloads', 'delorun-preview-flags', 'delorun-cost-meter', 'delorun-thinking-rsvp']
    expect(delorunRows.map(row => row.id)).toEqual([...LOCAL_ROWS.filter(row => row.kind === 'added').map(row => row.id), ...studioRows])
    // The bundle's own browser half, each consent and guard plugin it mounts, the external-agent start gate, which sends nothing itself and starts a program only for a seat or a limits check the person asked for, its update gate, its update check, which fetches
    // the release channel's signed files and sends nothing about the person, the trust bill, which serves what the start check and the stored records say, the plugin packs, which fetch the signed packs file and a pack only when the person adds one, the plugin install check, which asks the advisory
    // feed and the registry only when the person installs a plugin, the trash, which keeps everything local, the home's
    // admission and remote access, the studio plugins of @delorun/bundle-studio and its preview flags, which read the profile's bundles and send nothing, and the new-workspace flow, whose clone reaches only the address the person types.
    expect(delorunRows.map(row => row.name)).toEqual([
      LOCAL_BUNDLE,
      '@delorun/plugin-instruction-consent',
      '@delorun/plugin-mcp-consent',
      '@delorun/plugin-permission-defaults',
      '@delorun/plugin-schedule-consent',
      '@delorun/plugin-fetch-guard',
      '@delorun/plugin-tool-failure-guard',
      '@delorun/skill-plugin-authoring',
      '@delorun/skill-report-problem',
      '@delorun/plugin-delegation-consent',
      '@delorun/external-agents',
      '@delorun/agent-claude-code',
      '@delorun/agent-codex',
      '@delorun/plugin-agent-seats',
      '@delorun/plugin-multiview',
      '@delorun/plugin-changes',
      '@delorun/plugin-update',
      '@delorun/plugin-packs',
      '@delorun/bundle-local/workspace-rename',
      `${LOCAL_BUNDLE}/prompt-wording`,
      `${LOCAL_BUNDLE}/update-gate`,
      `${LOCAL_BUNDLE}/update-check`,
      `${LOCAL_BUNDLE}/trust`,
      `${LOCAL_BUNDLE}/profile-versions`,
      `${LOCAL_BUNDLE}/requirements`,
      `${LOCAL_BUNDLE}/report`,
      `${LOCAL_BUNDLE}/run-settings`,
      '@delorun/plugin-install-check',
      '@delorun/plugin-trash',
      '@delorun/home-auth',
      '@delorun/reach',
      '@delorun/plugin-theme',
      '@delorun/plugin-settings-layout',
      '@delorun/plugin-chat-states',
      '@delorun/plugin-sidebar',
      '@delorun/plugin-onboarding',
      '@delorun/plugin-new-workspace',
      '@delorun/plugin-downloads',
      '@delorun/preview-flags',
      '@delorun/plugin-cost-meter',
      '@delorun/plugin-thinking-rsvp',
    ])
  })
})
