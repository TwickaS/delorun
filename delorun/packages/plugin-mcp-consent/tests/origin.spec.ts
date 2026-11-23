/**
 * Where a server's definition lives decides whether it asks (A631, L201): a stdio server a row of the person's own
 * patch file defines, one the MCP manager's Settings list holds and one a pack's row mounts start without asking under
 * the default ask mode; a server another plugin mounts asks, whatever it is named, and so does one a third-party
 * bundle's row defines or whose row a third-party bundle changes, and an acceptance of the person's own server of the
 * same name does not cover it. The layers are read from the profile's files at each review, so a bundle added since
 * counts at the next one. "Always ask" asks for every server and "Never ask" for none. The MCP SDK is replaced by a
 * stub, so no process starts.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ComputerOnlySwitch } from '@delorun/home-auth'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Transport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, MockClient, clients } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>(async () => {})
  const clients: { onclose?: (() => void) | undefined }[] = []
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
    constructor() {
      clients.push(this)
    }
    async connect(transport: Transport): Promise<void> {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); this.onclose?.() }
      await transport.start()
      await mockConnect.call(this)
    }
    listResources = async () => ({ resources: [] })
    close = vi.fn(async () => { await this.transport?.close() })
    listTools = vi.fn(async () => ({ tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
  }
  return { mockConnect, MockClient, clients }
})

vi.mock('@modelcontextprotocol/client', () => ({ Client: MockClient, StreamableHTTPClientTransport: vi.fn(function () {
    return {
      onclose: undefined as (() => void) | undefined,
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close() { this.onclose?.(); return Promise.resolve() },
    }
  }) }))
vi.mock('@modelcontextprotocol/client/stdio', () => ({ StdioClientTransport: vi.fn(function () {
    return {
      onclose: undefined as (() => void) | undefined,
      start: () => Promise.resolve(),
      send: () => Promise.resolve(),
      close() { this.onclose?.(); return Promise.resolve() },
    }
  }) }))

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpConsentRefusedError } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
// The package's own entry, as the consent's origin check imports it, so the class is the one it compares.
import McpServerManager from '@deepseek-ai/dsh-mcp-manager'
import * as McpConsentPlugin from '../src/index.ts'
import type { LayerKind, RowLayer, RowSources } from '../src/layers.ts'
import { originOf } from '../src/origin.ts'

let root: string
let ctx: Context
/** What the stand-in launcher judges each bundle to be; a bundle it does not name is `other`. */
let layerKinds: Map<string, LayerKind>
/** The context of the latest mcp-client the stand-in plugins mounted. */
let mounted: Context | undefined

/** A plugin, other than a pack's, that mounts a stdio server of the name it is configured with. */
function serverMounter(): (ctx: Context, config: { serverName: string }) => Promise<void> {
  return async (pluginCtx, config) => {
    await pluginCtx.plugin(McpClient, McpClient.Config({ transport: 'stdio', serverName: config.serverName, command: join(root, 'bin', 'server'), args: ['--stdio'], env: {}, cwd: root }))
  }
}

beforeEach(async () => {
  clients.length = 0
  mockConnect.mockClear()
  mounted = undefined
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-origin-')))
  mkdirSync(join(root, 'home'), { recursive: true })
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('DELORUN_HOME', join(root, 'home'))
  ctx = new Context()
  writeProfile({ own: ['files'] })
  mkdirSync(join(root, 'install'))
  writeFileSync(join(root, 'install', 'package.json'), JSON.stringify({ name: 'install', private: true }))
  const profile: ProfileContext = {
    name: 'default', dir: join(root, 'profile'), patchPath: join(root, 'profile', 'cordis.patch.yml'), installAnchor: join(root, 'install', 'package.json'),
    cwd: root, home: join(root, 'dsh-home'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  ctx.provide('profileContext', profile)
  layerKinds = new Map()
  ctx.provide('delorunPackLayers', { kindOf: layer => Promise.resolve(layerKinds.get(layer.packageName) ?? 'other') })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(Loader)
  ctx.loader.builtins['mcp'] = McpClient
  ctx.loader.builtins['consent'] = McpConsentPlugin
  ctx.loader.builtins['project-plugin'] = { name: 'project-plugin', reusable: true, apply: serverMounter() }
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/** The row config of a stdio server the profile defines. */
function serverRow(serverName: string): Record<string, unknown> {
  return { transport: 'stdio', serverName, command: join(root, 'bin', 'server'), args: ['--stdio'], env: {}, cwd: root }
}

/**
 * Write the profile's files: its manifest listing the bundles, the person's own patch file inserting the named rows,
 * and each bundle's package in the profile's `node_modules` with its patch list.
 * @param options - the ids of the person's own rows and each bundle's patches.
 */
function writeProfile(options: { readonly own?: readonly string[]; readonly bundles?: Readonly<Record<string, readonly unknown[]>> } = {}): void {
  const dir = join(root, 'profile')
  const bundles = options.bundles ?? {}
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'profile', private: true, dsh: { profile: { bundles: Object.keys(bundles) } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([{ insert: (options.own ?? []).map(id => ({ id, name: 'cordis:mcp' })) }]))
  for (const [name, patches] of Object.entries(bundles)) {
    const folder = join(dir, 'node_modules', name)
    mkdirSync(folder, { recursive: true })
    writeFileSync(join(folder, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(folder, 'cordis.patch.yml'), JSON.stringify(patches))
  }
}

/**
 * Create a row under the id the profile's files name it by: the Loader keeps an id the options carry (`ensureId`),
 * though `create`'s type leaves it out.
 * @param row - the row, with its id.
 * @returns the row's id.
 */
function createRow(row: { id: string; name: string; config: Record<string, unknown> }): Promise<string> {
  return ctx.loader.create(row)
}

/**
 * Start one row and wait for it to settle.
 * @param row - the row, with its id.
 * @returns undefined when it started, the refusal otherwise.
 */
async function startRow(row: { id: string; name: string; config: Record<string, unknown> }): Promise<unknown> {
  const id = await createRow(row)
  await ctx.loader.await()
  return ctx.loader.resolve(id).fiber?.await().then(() => undefined, (error: unknown) => error)
}

/**
 * Start the consent with an ask mode, then the given rows, and wait for them to settle.
 * @param ask - the ask mode.
 * @param rows - the rows after the consent's.
 * @returns each row's start: undefined when it started, the refusal otherwise.
 */
async function startRows(ask: string, rows: readonly { id?: string; name: string; config: Record<string, unknown> }[]): Promise<readonly unknown[]> {
  await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask } })
  const ids: string[] = []
  for (const row of rows) ids.push(await ctx.loader.create(row))
  await ctx.loader.await()
  return Promise.all(ids.map(id => ctx.loader.resolve(id).fiber?.await().then(() => undefined, (error: unknown) => error)))
}

describe('the origin of a server', () => {
  it('starts a server the profile defines without asking under the default mode', async () => {
    const [profile] = await startRows('outside', [{ id: 'files', name: 'cordis:mcp', config: serverRow('files') }])
    expect(profile).toBeUndefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(ctx.get('mcpReviews')?.pending()).toEqual([])
  })

  it('asks for a server another plugin mounts even when it is named like a pack server', async () => {
    const [plugin] = await startRows('outside', [{ name: 'cordis:project-plugin', config: { serverName: 'playwright-mcp' } }])
    expect(plugin).toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.get('mcpReviews')?.pending().map(review => [review.serverName, review.origin])).toEqual([['playwright-mcp', { kind: 'plugin', plugin: 'cordis:project-plugin' }]])
  })

  it('asks for a plugin server named like the person\'s own, which an acceptance of the person\'s server does not cover', async () => {
    const consent = (): McpConsentPlugin.DelorunMcpConsent => ctx.get('mcpAddConsent') as McpConsentPlugin.DelorunMcpConsent
    // The person's own server starts unasked under the default mode.
    const [own] = await startRows('outside', [{ id: 'files', name: 'cordis:mcp', config: serverRow('files') }])
    expect(own).toBeUndefined()
    for (const entry of [...ctx.loader.entries()]) await ctx.loader.remove(entry.id)
    // Under "Always ask" the person accepts their own server, and the store records it for the profile.
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask: 'always' } })
    await ctx.loader.await()
    const bin = join(root, 'bin', 'server')
    await consent().accept({ serverName: 'files', command: bin, args: ['--stdio'], env: {}, cwd: root, resolvedCommand: bin, resolvedCwd: root }, undefined, { kind: 'profile' })
    // A plugin's server of the same name and the very same start still asks: the acceptance covers the profile only.
    const pluginId = await ctx.loader.create({ name: 'cordis:project-plugin', config: { serverName: 'files' } })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(pluginId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([{ kind: 'plugin', plugin: 'cordis:project-plugin' }])
    await ctx.loader.remove(pluginId)
    // The person's own row of that start starts under the same mode.
    const rowId = await createRow({ id: 'files', name: 'cordis:mcp', config: serverRow('files') })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(rowId).fiber?.await().then(() => 'started')).resolves.toBe('started')
  })

  it('asks once more for a plugin server whose acceptance a version-6 store holds without an origin', async () => {
    const consent = (): McpConsentPlugin.DelorunMcpConsent => ctx.get('mcpAddConsent') as McpConsentPlugin.DelorunMcpConsent
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask: 'outside' } })
    await ctx.loader.await()
    const bin = join(root, 'bin', 'server')
    await consent().accept({ serverName: 'tools', command: bin, args: ['--stdio'], env: {}, cwd: root, resolvedCommand: bin, resolvedCwd: root }, undefined, { kind: 'plugin', plugin: 'cordis:project-plugin' })
    // The store as version 6 wrote it: the same acceptance, with no origin.
    const path = join(root, 'home', 'secrets', 'mcp-add-consent', 'acceptances.json')
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { version: number; acceptances: Record<string, Record<string, unknown>> }
    for (const acceptance of Object.values(stored.acceptances)) Reflect.deleteProperty(acceptance, 'origin')
    writeFileSync(path, JSON.stringify({ ...stored, version: 6 }), { mode: 0o600 })
    const pluginId = await ctx.loader.create({ name: 'cordis:project-plugin', config: { serverName: 'tools' } })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(pluginId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.get('mcpReviews')?.pending().map(review => [review.serverName, review.origin])).toEqual([['tools', { kind: 'plugin', plugin: 'cordis:project-plugin' }]])
  })

  it('starts a plugin server unasked only under "Never ask"', async () => {
    for (const ask of ['outside', 'always']) {
      const [plugin] = await startRows(ask, [{ name: 'cordis:project-plugin', config: { serverName: 'tools' } }])
      expect(plugin).toBeInstanceOf(McpConsentRefusedError)
      for (const entry of [...ctx.loader.entries()]) await ctx.loader.remove(entry.id)
    }
    expect(mockConnect).not.toHaveBeenCalled()
    const [plugin] = await startRows('never', [{ name: 'cordis:project-plugin', config: { serverName: 'tools' } }])
    expect(plugin).toBeUndefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('starts a waiting server without a restart once the ask mode no longer asks for it', async () => {
    const [profile] = await startRows('always', [{ id: 'files', name: 'cordis:mcp', config: serverRow('files') }])
    expect(profile).toBeInstanceOf(McpConsentRefusedError)
    const consentId = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:consent')?.id ?? ''
    await ctx.loader.update(consentId, { config: { enabled: true, ask: 'outside' } })
    await vi.waitFor(() => { expect(mockConnect).toHaveBeenCalledTimes(1) })
    expect(ctx.tools.get('mcp__files__remote')).toBeDefined()
  })

  it('asks for every server under "Always ask", the profile\'s too', async () => {
    const [profile] = await startRows('always', [{ id: 'files', name: 'cordis:mcp', config: serverRow('files') }])
    expect(profile).toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending()[0]?.origin).toEqual({ kind: 'profile' })
    // Nothing ran: a profile server waits for its acceptance before its command starts.
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__files__remote')).toBeUndefined()
  })

  it('names a pack by the bundle that inserted the nearest row, and a third-party bundle around it before anything else', async () => {
    ctx.loader.builtins['fake-pack'] = { name: 'fake-pack', reusable: true, apply: async (pluginCtx: Context) => {
      await pluginCtx.plugin({ name: 'fake-pack-session', apply: (sessionCtx: Context) => { mounted = sessionCtx } })
    } }
    await createRow({ id: 'pack-row', name: 'cordis:fake-pack', config: {} })
    await ctx.loader.await()
    const sources = (bundles: [string, readonly RowLayer[]][]): RowSources => ({ own: new Set(['pack-row']), bundles: new Map(bundles) })
    const client = mounted
    expect(client).toBeDefined()
    if (client === undefined) return
    // A pack that inserted the row: `pack`, whatever server the row's plugin mounts.
    expect(originOf(client, 'playwright-mcp', undefined, sources([['pack-row', [{ bundle: '@delorun/pack-fake', kind: 'pack', inserts: true }]]])))
      .toEqual({ kind: 'pack', pack: '@delorun/pack-fake', plugin: 'cordis:fake-pack' })
    // The same row changed by a third-party bundle: that bundle's.
    expect(originOf(client, 'playwright-mcp', undefined, sources([['pack-row', [{ bundle: '@delorun/pack-fake', kind: 'pack', inserts: true }, { bundle: 'evil-bundle', kind: 'other', inserts: false }]]])))
      .toEqual({ kind: 'plugin', plugin: 'evil-bundle' })
    // A pack's name on a bundle the launcher does not judge a pack: a third party's.
    expect(originOf(client, 'playwright-mcp', undefined, sources([['pack-row', [{ bundle: '@delorun/pack-fake', kind: 'other', inserts: true }]]])))
      .toEqual({ kind: 'plugin', plugin: '@delorun/pack-fake' })
    // The person's own row of a plugin that mounts a server is a plugin's, and nothing counts without row sources.
    expect(originOf(client, 'playwright-mcp', undefined, sources([]))).toEqual({ kind: 'plugin', plugin: 'cordis:fake-pack' })
    expect(originOf(client, 'playwright-mcp', undefined, undefined)).toEqual({ kind: 'plugin', plugin: 'cordis:fake-pack' })
    expect(originOf(new Context(), 'playwright-mcp', undefined, sources([]))).toEqual({ kind: 'unknown' })
  })

  it('asks for a server a third-party bundle\'s mcp-client row defines', async () => {
    writeProfile({ own: ['files'], bundles: { 'evil-bundle': [{ insert: [{ id: 'evil-files', name: 'cordis:mcp', config: serverRow('files') }] }] } })
    await startRows('outside', [])
    expect(await startRow({ id: 'evil-files', name: 'cordis:mcp', config: serverRow('files') })).toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.get('mcpReviews')?.pending().map(review => [review.serverName, review.origin])).toEqual([['files', { kind: 'plugin', plugin: 'evil-bundle' }]])
  })

  it('asks for playwright-mcp a third-party bundle adds with its own config, beside a pack\'s row of the same plugin', async () => {
    ctx.loader.builtins['pack-plugin'] = { name: 'pack-plugin', reusable: true, apply: serverMounter() }
    layerKinds.set('@delorun/pack-browser', 'pack')
    const packRow = { id: 'pack-pw', name: 'cordis:pack-plugin', config: { serverName: 'playwright-mcp' } }
    writeProfile({ bundles: {
      '@delorun/pack-browser': [{ insert: [packRow] }],
      'evil-bundle': [{ insert: [{ id: 'evil-pw', name: 'cordis:pack-plugin', config: { serverName: 'playwright-mcp' } }] }],
    } })
    await startRows('outside', [])
    // The pack's own row starts unasked.
    expect(await startRow(packRow)).toBeUndefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    await ctx.loader.remove('pack-pw')
    // The third-party bundle's row of the same plugin and server asks, and names the bundle.
    expect(await startRow({ id: 'evil-pw', name: 'cordis:pack-plugin', config: { serverName: 'playwright-mcp' } })).toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([{ kind: 'plugin', plugin: 'evil-bundle' }])
    // A third-party bundle that only changes the pack's row makes it that bundle's too.
    writeProfile({ bundles: { '@delorun/pack-browser': [{ insert: [packRow] }], 'evil-bundle': [{ id: 'pack-pw', config: { serverName: 'playwright-mcp' } }] } })
    expect(await startRow(packRow)).toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  it('reads the layers again at each review, so a bundle added by a hot reload counts at the next one', async () => {
    await startRows('outside', [])
    expect(await startRow({ id: 'files', name: 'cordis:mcp', config: serverRow('files') })).toBeUndefined()
    await ctx.loader.remove('files')
    // A bundle selected since, which changes the person's row, makes the row's next start ask.
    writeProfile({ own: ['files'], bundles: { 'evil-bundle': [{ id: 'files', config: serverRow('files') }] } })
    expect(await startRow({ id: 'files', name: 'cordis:mcp', config: serverRow('files') })).toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([{ kind: 'plugin', plugin: 'evil-bundle' }])
    await ctx.loader.remove('files')
    // A row the person's file inserts only since the last review is theirs at the next one.
    writeProfile({ own: ['late'] })
    expect(await startRow({ id: 'late', name: 'cordis:mcp', config: serverRow('late') })).toBeUndefined()
  })

  it('takes no row as the person\'s without the profile\'s files', async () => {
    writeFileSync(join(root, 'profile', 'package.json'), '{')
    const [row] = await startRows('outside', [{ id: 'files', name: 'cordis:mcp', config: serverRow('files') }])
    expect(row).toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([{ kind: 'unknown' }])
  })

  it('takes the MCP manager\'s configured servers as the person\'s, and asks for a registered one', async () => {
    // The manager's row comes from one of Delorun's runtime bundles.
    layerKinds.set('@delorun/bundle-runtime', 'runtime')
    writeProfile({ bundles: { '@delorun/bundle-runtime': [{ insert: [{ id: 'mcp-manager', name: 'cordis:manager' }] }] } })
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true } })
    ctx.loader.builtins['manager'] = McpServerManager
    await createRow({ id: 'mcp-manager', name: 'cordis:manager', config: { servers: { files: { transport: 'stdio', command: join(root, 'bin', 'server'), args: ['--stdio'], cwd: root } } } })
    await ctx.loader.await()
    const manager = ctx.get('mcpManager')
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'files')?.status.state).not.toBe('connecting') })
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([])
    expect(manager?.list().find(server => server.name === 'files')?.status.state).toBe('connected')
    const dispose = manager?.register('helper', { transport: 'stdio', command: join(root, 'bin', 'server'), args: ['--stdio'], cwd: root })
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'helper')?.status.state).toBe('failed') })
    expect(ctx.get('mcpReviews')?.pending().map(review => [review.serverName, review.origin.kind])).toEqual([['helper', 'plugin']])
    dispose?.()
    // A third-party bundle that changes the manager's row makes its servers that bundle's at their next start.
    writeProfile({ bundles: {
      '@delorun/bundle-runtime': [{ insert: [{ id: 'mcp-manager', name: 'cordis:manager' }] }],
      'evil-bundle': [{ id: 'mcp-manager', config: { servers: {} } }],
    } })
    await manager?.restart('files')
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'files')?.status.state).toBe('failed') })
    expect(ctx.get('mcpReviews')?.pending().find(review => review.serverName === 'files')?.origin).toEqual({ kind: 'plugin', plugin: 'evil-bundle' })
  })
})

describe('the ask settings', () => {
  it('registers turning the consent off and the ask mode as computer-only switches, on or off', async () => {
    for (const enabled of [true, false]) {
      const registered: ComputerOnlySwitch[] = []
      const scope = new Context()
      scope.provide('homeAuth', { registerComputerOnlySwitch: (target: ComputerOnlySwitch) => { registered.push(target); return () => {} } } as never)
      await scope.plugin(McpConsentPlugin, { enabled, ask: 'outside' })
      expect(registered.map(target => [target.ns, target.field])).toEqual([['delorun-mcp-consent', 'enabled'], ['delorun-mcp-consent', 'ask']])
      await scope.fiber.dispose()
    }
  })
})
