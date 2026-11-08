/**
 * Tests for the optional `mcpAddConsent` seam: the add-time consent a mounted
 * service runs before a stdio server's command starts. Isolated file so the
 * vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

// ---- Mock MCP SDK ----

const { mockConnect, mockClose, mockListTools, MockClient } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  const mockSetNotificationHandler = vi.fn()
  class MockClient {
    transport = {}
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    constructor(_info: unknown, options: { listChanged: { tools: { onChanged: () => void } } }) {
      void mockSetNotificationHandler('notifications/tools/list_changed', options.listChanged.tools.onChanged)
    }
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
  }
  return { mockConnect, mockClose, mockListTools, MockClient }
})

vi.mock('@modelcontextprotocol/client', () => ({
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: vi.fn(),
}))

import { apply, inject } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpAddConsent, McpConsentRefusedError } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

const stdioConfig: Config = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

/** A consent stub whose reviews are scripted, one decision per call. */
class StubConsent extends McpAddConsent {
  readonly calls: McpServerCommand[] = []

  constructor(ctx: Context, private readonly decisions: Promise<McpConsentDecision>[]) {
    super(ctx)
  }

  review(command: McpServerCommand): Promise<McpConsentDecision> {
    this.calls.push(command)
    const decision = this.decisions.shift()
    if (decision === undefined) throw new Error('the stub ran out of scripted decisions')
    return decision
  }
}

// ---- Tests ----

describe('the optional mcpAddConsent seam', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    ctx = await mountRegistry()
  })

  it('starts the server exactly as upstream does when no consent service is mounted', async () => {
    await apply(ctx, stdioConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('holds a new server row until the mounted service allows it', async () => {
    const pending: PromiseWithResolvers<McpConsentDecision> = Promise.withResolvers()
    const consent = new StubConsent(ctx, [pending.promise])
    const fiber = ctx.plugin({ name: 'mcp-consent-held', inject, apply }, stdioConfig)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    // The review sees the command each boot, before any child process starts.
    await vi.waitFor(() => { expect(consent.calls).toEqual([{
      serverName: 'srv',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
    }]) })
    expect(mockConnect).not.toHaveBeenCalled()
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    pending.resolve({ allow: true })
    await activation
    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
  })

  it('leaves the server stopped with the typed reason when the service refuses', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'not on the accepted list' })])

    await expect(apply(ctx, { ...stdioConfig, failOnStartupError: true })).rejects.toMatchObject({
      message: 'mcp-client(srv): the add-time consent did not allow this server\'s command, so the server stays stopped — '
        + 'not on the accepted list. The consent covers the command "npx" "-y" "@modelcontextprotocol/server-fs" "/tmp". '
        + 'A server command runs outside the agent sandbox.',
    })

    expect(mockConnect).not.toHaveBeenCalled()
    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('shows the refusal as the typed error without failing the startup path when not fatal', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'refused' })])

    const failure: unknown = await apply(ctx, stdioConfig).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    expect((failure as McpConsentRefusedError).serverName).toBe('srv')
    expect((failure as McpConsentRefusedError).command).toBe('npx')
    expect((failure as McpConsentRefusedError).reason).toBe('refused')
    expect(mockConnect).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('reviews the command at every boot, so a changed command reaches the service again', async () => {
    const consent = new StubConsent(ctx, [Promise.resolve({ allow: true }), Promise.resolve({ allow: true })])

    const first = createScope(ctx, {})
    await apply(first.ctx, stdioConfig)
    await first.dispose()

    const second = createScope(ctx, {})
    await apply(second.ctx, stdioConfig)
    await second.dispose()

    expect(consent.calls).toEqual([
      { serverName: 'srv', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'] },
      { serverName: 'srv', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'] },
    ])
  })

  it('does not hold a Streamable HTTP server, which starts no local command', async () => {
    const pending: PromiseWithResolvers<McpConsentDecision> = Promise.withResolvers()
    const consent = new StubConsent(ctx, [pending.promise])

    await apply(ctx, {
      transport: 'streamable-http',
      serverName: 'web',
      url: 'http://localhost:3000/mcp',
      headers: {},
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    })

    expect(consent.calls).toEqual([])
    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__web__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })
})
