/**
 * A consent row whose service crashed while its switch is on refuses every MCP server start: under a real Loader the
 * crashed row is not active, so the declaring-row check in the mcp-client leaves the server stopped, naming the row.
 * With the switch off, the same server starts as stock. The crash is a second provider of the `mcpReviews` service,
 * which the consent's mount refuses. The MCP SDK is replaced by a stub, so no process starts.
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

const { mockConnect, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>(async () => {})
  class MockClient {
    transport: Transport | undefined
    onclose: (() => void) | undefined
    async connect(transport: Transport): Promise<void> {
      this.transport = transport
      const onclose = transport.onclose
      transport.onclose = () => { onclose?.(); this.onclose?.() }
      await transport.start()
      await mockConnect.call(this)
    }
    listResources = async () => ({ resources: [] })
    close = vi.fn(async () => {})
    listTools = vi.fn(async () => ({ tools: [], nextCursor: undefined }))
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
  }
  return { mockConnect, MockClient }
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

import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { McpConsentUnavailableError } from '@deepseek-ai/dsh-mcp-client'
import * as McpConsentPlugin from '../src/index.ts'

let root: string
let ctx: Context

beforeEach(async () => {
  mockConnect.mockClear()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-mcp-failclosed-')))
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
  // A second provider of the review service: the consent's mount throws on it, so its service never registers.
  ctx.provide('mcpReviews', {} as never)
})

afterEach(async () => {
  await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

/**
 * Create the consent row with the given switch and a stdio server row.
 * @param enabled - the consent's switch.
 * @returns the server row's id and the consent row's id.
 */
async function rows(enabled: boolean): Promise<{ readonly server: string, readonly consent: string }> {
  const consent = await ctx.loader.create({ name: 'cordis:consent', config: { enabled } })
  const server = await ctx.loader.create({
    name: 'cordis:mcp',
    config: { transport: 'stdio', serverName: 'files', command: join(root, 'bin', 'server'), args: [], env: {}, cwd: root },
  })
  await ctx.loader.await()
  return { server, consent }
}

describe('a consent row whose service crashed', () => {
  it('leaves every server stopped and names the row while the switch is on', async () => {
    const { server, consent } = await rows(true)
    const failure: unknown = await ctx.loader.resolve(server).fiber?.await().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpConsentUnavailableError)
    expect((failure as Error).message).toContain(consent)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('starts the server as stock while the switch is off', async () => {
    const { server } = await rows(false)
    await ctx.loader.resolve(server).fiber?.await()
    expect(mockConnect).toHaveBeenCalledTimes(1)
  })
})
