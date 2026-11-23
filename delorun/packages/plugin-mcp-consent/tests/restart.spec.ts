/**
 * An accepted server starts without a restart of the studio: under a real Loader, a stdio mcp-client row that the
 * add-time consent refused stays stopped with the typed refusal, and once the person accepts the review the studio
 * showed, the row starts again with its own configuration and registers its tools. Revoking the acceptance stops the
 * row again and removes its tools, and its review is listed as revoked. A server whose script is rewritten while it runs
 * is reviewed again before its reconnect, stays stopped with a review whose change is `contents`, and starts again
 * once the person accepts that review. The MCP SDK is replaced by a stub, so no process starts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
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
import McpServerManager from '@deepseek-ai/dsh-mcp-manager/src/index.ts'
import * as McpConsentPlugin from '../src/index.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  clients.length = 0
  mockConnect.mockClear()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-restart-')))
  mkdirSync(join(root, 'home'), { recursive: true })
  // The executable the server's absolute command names, which the mcp-client resolves before the review.
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
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('an accepted server', () => {
  it('starts again under the Loader without a restart, with its own configuration', async () => {
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask: 'always' } })
    const serverId = await ctx.loader.create({
      name: 'cordis:mcp',
      config: { transport: 'stdio', serverName: 'files', command: join(root, 'bin', 'server'), args: ['--stdio'], env: {}, cwd: root },
    })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(serverId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).not.toHaveBeenCalled()
    const reviews = ctx.get('mcpReviews')
    const [pending] = reviews?.pending() ?? []
    expect(pending?.serverName).toBe('files')
    await expect(reviews?.acceptReview('files', pending?.reviewId ?? '', true)).resolves.toEqual({ started: 1 })
    await ctx.loader.resolve(serverId).fiber?.await()
    expect(mockConnect).toHaveBeenCalledTimes(1)
    expect(ctx.tools.get('mcp__files__remote')).toBeDefined()
    expect(reviews?.pending()).toEqual([])
    const [accepted] = await reviews?.accepted() ?? []
    expect([accepted?.serverName, accepted?.configured]).toEqual(['files', true])
    await expect(reviews?.revokeAcceptance(accepted?.acceptanceId ?? '', true)).resolves.toEqual({ stopped: 1 })
    await expect(ctx.loader.resolve(serverId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    expect(ctx.tools.get('mcp__files__remote')).toBeUndefined()
    expect(reviews?.pending().map(review => [review.change, review.state])).toEqual([['new', 'revoked']])
  })
  it('starts again when the MCP manager holds it stopped, so its tools reach the next model request without a restart', async () => {
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask: 'always' } })
    await ctx.loader.await()
    await ctx.plugin(McpServerManager, { servers: { files: { transport: 'stdio', command: join(root, 'bin', 'server'), args: ['--stdio'], cwd: root } } })
    const manager = ctx.get('mcpManager')
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'files')?.status).toMatchObject({ state: 'failed', reason: 'load' }) })
    expect(mockConnect).not.toHaveBeenCalled()
    const reviews = ctx.get('mcpReviews')
    const [pending] = reviews?.pending() ?? []
    expect(pending?.serverName).toBe('files')
    await expect(reviews?.acceptReview('files', pending?.reviewId ?? '', true)).resolves.toEqual({ started: 1 })
    await vi.waitFor(() => { expect(manager?.list().find(server => server.name === 'files')?.status.state).toBe('connected') })
    expect(mockConnect).toHaveBeenCalledTimes(1)
    // The agent loop reads the tool list at each model step, so a running chat's next request offers the tool.
    expect(ctx.tools.get('mcp__files__remote')).toBeDefined()
    expect(ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__files__remote')
  })

})

describe('a server whose script changed while it ran', () => {
  it('is reviewed again before its reconnect, held as a contents review, and starts again once the person accepts it', async () => {
    const script = join(root, 'server.js')
    writeFileSync(script, 'console.log("accepted")\n')
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true, ask: 'always' } })
    const serverId = await ctx.loader.create({
      name: 'cordis:mcp',
      config: {
        transport: 'stdio', serverName: 'files', command: join(root, 'bin', 'server'), args: ['server.js'], env: {}, cwd: root,
        reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 2 },
      },
    })
    await ctx.loader.await()
    await expect(ctx.loader.resolve(serverId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    const reviews = ctx.get('mcpReviews')
    await reviews?.acceptReview('files', reviews.pending()[0]?.reviewId ?? '', true)
    await ctx.loader.resolve(serverId).fiber?.await()
    expect(ctx.tools.get('mcp__files__remote')).toBeDefined()
    expect(mockConnect).toHaveBeenCalledTimes(1)

    // A chat rewrites the script and kills the server; the reconnect reviews the start before it spawns again.
    writeFileSync(script, 'console.log("rewritten")\n')
    clients.at(-1)?.onclose?.()
    await vi.waitFor(() => { expect(reviews?.pending()).toHaveLength(1) })
    const [held] = reviews?.pending() ?? []
    expect(held).toMatchObject({ serverName: 'files', change: 'contents', state: 'waiting' })
    expect(held?.reason).toContain(`the contents of the file ${JSON.stringify(script)}, the argument 0, changed since the person accepted this server`)
    expect(held?.files.map(file => [file.argument, file.path])).toEqual([[undefined, join(root, 'bin', 'server')], [0, script]])
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__files__remote')).toBeUndefined() })
    expect(mockConnect).toHaveBeenCalledTimes(1)

    await expect(reviews?.acceptReview('files', held?.reviewId ?? '', true)).resolves.toEqual({ started: 1 })
    await ctx.loader.resolve(serverId).fiber?.await()
    expect(mockConnect).toHaveBeenCalledTimes(2)
    expect(ctx.tools.get('mcp__files__remote')).toBeDefined()
    expect(reviews?.pending()).toEqual([])
  })
})
