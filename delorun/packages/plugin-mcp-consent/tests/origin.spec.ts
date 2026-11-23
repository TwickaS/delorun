/**
 * Where a server's definition lives decides whether it asks (A631): a stdio server a Loader row of the profile defines,
 * one the MCP manager's Settings list holds and one a pack plugin mounts start without asking under the default ask
 * mode; a server another plugin mounts asks, whatever it is named, and an acceptance of the person's own server of the
 * same name does not cover it. "Always ask" asks for every server and "Never ask" for none. The MCP SDK is replaced by
 * a stub, so no process starts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { ComputerOnlySwitch } from '@delorun/home-auth'
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
import { originOf } from '../src/origin.ts'

let root: string
let ctx: Context
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
 * Start the consent with an ask mode, then the given rows, and wait for them to settle.
 * @param ask - the ask mode.
 * @param rows - the rows after the consent's.
 * @returns each row's start: undefined when it started, the refusal otherwise.
 */
async function startRows(ask: string, rows: readonly { name: string; config: Record<string, unknown> }[]): Promise<readonly unknown[]> {
  await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask } })
  const ids: string[] = []
  for (const row of rows) ids.push(await ctx.loader.create(row))
  await ctx.loader.await()
  return Promise.all(ids.map(id => ctx.loader.resolve(id).fiber?.await().then(() => undefined, (error: unknown) => error)))
}

describe('the origin of a server', () => {
  it('starts a server the profile defines without asking under the default mode', async () => {
    const [profile] = await startRows('outside', [{ name: 'cordis:mcp', config: serverRow('files') }])
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
    const [own] = await startRows('outside', [{ name: 'cordis:mcp', config: serverRow('files') }])
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
    const rowId = await ctx.loader.create({ name: 'cordis:mcp', config: serverRow('files') })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(rowId).fiber?.await().then(() => 'started')).resolves.toBe('started')
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

  it('asks for every server under "Always ask", the profile\'s too', async () => {
    const [profile] = await startRows('always', [{ name: 'cordis:mcp', config: serverRow('files') }])
    expect(profile).toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.get('mcpReviews')?.pending()[0]?.origin).toEqual({ kind: 'profile' })
  })

  it('names a pack plugin by the module of its row, never by the server it mounts', async () => {
    ctx.loader.builtins['fake-pack'] = { name: 'fake-pack', reusable: true, apply: async (pluginCtx: Context) => {
      await pluginCtx.plugin({ name: 'fake-pack-session', apply: (sessionCtx: Context) => { mounted = sessionCtx } })
    } }
    await ctx.loader.create({ name: 'cordis:fake-pack' })
    await ctx.loader.create({ name: 'cordis:project-plugin', config: { serverName: 'other' } })
    await ctx.loader.await()
    const packs = new Map([['cordis:fake-pack', '@delorun/bundle-fake']])
    expect(mounted === undefined ? undefined : originOf(mounted, 'playwright-mcp', undefined, packs)).toEqual({ kind: 'pack', pack: '@delorun/bundle-fake', plugin: 'cordis:fake-pack' })
    expect(originOf(new Context(), 'playwright-mcp', undefined, packs)).toEqual({ kind: 'unknown' })
  })

  it('takes the MCP manager\'s configured servers as the person\'s, and asks for a registered one', async () => {
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true } })
    ctx.loader.builtins['manager'] = McpServerManager
    await ctx.loader.create({ name: 'cordis:manager', config: { servers: { files: { transport: 'stdio', command: join(root, 'bin', 'server'), args: ['--stdio'], cwd: root } } } })
    await ctx.loader.await()
    const manager = ctx.get('mcpManager')
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'files')?.status.state).not.toBe('connecting') })
    expect(ctx.get('mcpReviews')?.pending().map(review => review.origin)).toEqual([])
    expect(manager?.list().find(server => server.name === 'files')?.status.state).toBe('connected')
    const dispose = manager?.register('helper', { transport: 'stdio', command: join(root, 'bin', 'server'), args: ['--stdio'], cwd: root })
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'helper')?.status.state).toBe('failed') })
    expect(ctx.get('mcpReviews')?.pending().map(review => [review.serverName, review.origin.kind])).toEqual([['helper', 'plugin']])
    dispose?.()
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
