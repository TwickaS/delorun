/**
 * An accepted server starts without a restart of the studio: under a real Loader, a stdio mcp-client row that the
 * add-time consent refused stays stopped with the typed refusal, and once the person accepts the review the studio
 * showed, the row starts again with its own configuration and registers its tools. Revoking the acceptance stops the
 * row again and removes its tools, and its review is listed as revoked. The MCP SDK is replaced by a stub, so no process starts.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockConnect, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>(async () => {})
  class MockClient {
    transport = {}
    connect = mockConnect
    close = vi.fn(async () => {})
    listTools = vi.fn(async () => ({ tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
  }
  return { mockConnect, MockClient }
})

vi.mock('@modelcontextprotocol/client', () => ({ Client: MockClient, StreamableHTTPClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/client/stdio', () => ({ StdioClientTransport: vi.fn() }))

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpConsentRefusedError } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import * as McpConsentPlugin from '../src/index.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delo-mcp-restart-')))
  mkdirSync(join(root, 'home'), { recursive: true })
  // The executable the server's absolute command names, which the mcp-client resolves before the review.
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'bin', 'server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  vi.stubEnv('DELO_HOME', join(root, 'home'))
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
    await ctx.loader.create({ name: 'cordis:consent', config: { enabled: true } })
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
})
