/**
 * Tests for the optional `mcpAddConsent` seam: the add-time consent a mounted
 * service runs before a stdio server's command starts, the start it is shown
 * (command, arguments, working directory and environment), and the lookup that
 * waits for a declared provider whatever the order of the loader's rows.
 * Isolated file so the vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
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

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { apply, inject } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpAddConsent, McpConsentRefusedError, McpConsentUnavailableError } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
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
      env: {},
      cwd: '',
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
        + 'not on the accepted list. The consent covers the command "npx" "-y" "@modelcontextprotocol/server-fs" "/tmp", '
        + 'run in the Host\'s working directory with no configured environment variables. '
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

    const start = { serverName: 'srv', command: 'npx', args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'], env: {}, cwd: '' }
    expect(consent.calls).toEqual([start, start])
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

  it('shows the review the working directory and the configured environment along with the command', async () => {
    const consent = new StubConsent(ctx, [Promise.resolve({ allow: true })])

    await apply(ctx, { ...stdioConfig, cwd: '/srv/mcp', env: { NODE_OPTIONS: '--require ./hook.js', PATH: '/opt/bin' } })

    expect(consent.calls).toEqual([{
      serverName: 'srv',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
      env: { NODE_OPTIONS: '--require ./hook.js', PATH: '/opt/bin' },
      cwd: '/srv/mcp',
    }])
    await ctx.fiber.dispose()
  })

  it('names the working directory and the environment variable names in a refusal, never the values', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'the environment changed' })])

    const failure: unknown = await apply(ctx, { ...stdioConfig, cwd: '/srv/mcp', env: { TOKEN: 'secret-value-123', LD_PRELOAD: '/tmp/x.so' } })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    const refusal = failure as McpConsentRefusedError
    expect(refusal.message).toBe('mcp-client(srv): the add-time consent did not allow this server\'s command, so the server stays stopped — '
      + 'the environment changed. The consent covers the command "npx" "-y" "@modelcontextprotocol/server-fs" "/tmp", '
      + 'run in "/srv/mcp" with the configured environment variables LD_PRELOAD, TOKEN (values not shown). '
      + 'A server command runs outside the agent sandbox.')
    expect(refusal.cwd).toBe('/srv/mcp')
    expect(refusal.envNames).toEqual(['LD_PRELOAD', 'TOKEN'])
    expect(JSON.stringify(Object.entries(refusal))).not.toContain('secret-value-123')
    expect(mockConnect).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('the consent lookup under a Loader, whatever the order of its rows', () => {
  let ctx: Context
  /** The provider row's module, released by the test so the server row starts first. */
  let providerModule: PromiseWithResolvers<object>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockResolvedValue(undefined)
    mockListTools.mockResolvedValue({
      tools: [{ name: 'remote', description: 'A remote tool', inputSchema: { type: 'object' } }],
      nextCursor: undefined,
    })
    ctx = await mountRegistry()
    await ctx.plugin(Loader)
    providerModule = Promise.withResolvers()
    ctx.loader.builtins['mcp'] = McpClient
    ctx.loader.builtins['provider'] = providerModule.promise
  })

  afterEach(async () => {
    // A test that failed before releasing the provider's module leaves its row importing; release it so disposal settles.
    providerModule.resolve({ name: 'consent-provider', apply() {} })
    await ctx.fiber.dispose()
  })

  /**
   * Create the server row first and the provider row second, without waiting
   * for either: the server row's module is ready at once and the provider's
   * only when the test releases it, so the server row activates first.
   * @returns each row's creation, which settles with the row's id once its fiber exists.
   */
  function startRows(): { server: Promise<string>; provider: Promise<string> } {
    const server = ctx.loader.create({ name: 'cordis:mcp', config: { ...stdioConfig } })
    const provider = ctx.loader.create({ name: 'cordis:provider' })
    return { server, provider }
  }

  it('holds a server row that starts before the declared consent row until that row reviews it', async () => {
    let consent: StubConsent | undefined
    const rows = startRows()
    const serverId = await rows.server
    // The server row is created and waiting; nothing started without a review.
    expect(mockConnect).not.toHaveBeenCalled()

    providerModule.resolve({
      name: 'consent-provider',
      providesMcpAddConsent: true,
      apply(providerCtx: Context) { consent = new StubConsent(providerCtx, [Promise.resolve({ allow: false, reason: 'not accepted' })]) },
    })
    await rows.provider
    await ctx.loader.await()

    expect(consent?.calls.map(call => call.serverName)).toEqual(['srv'])
    await expect(ctx.loader.resolve(serverId).fiber?.await()).rejects.toBeInstanceOf(McpConsentRefusedError)
    expect(mockConnect).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
  })

  it('keeps the server stopped when the declared consent row fails to start', async () => {
    const rows = startRows()
    const serverId = await rows.server
    providerModule.resolve({
      name: 'consent-provider',
      providesMcpAddConsent: true,
      apply() { throw new Error('the consent provider failed') },
    })
    await rows.provider
    await ctx.loader.await()

    const failure: unknown = await ctx.loader.resolve(serverId).fiber?.await().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpConsentUnavailableError)
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('starts the server as upstream does when the declared row registers no consent, as with its switch off', async () => {
    const rows = startRows()
    const serverId = await rows.server
    providerModule.resolve({ name: 'consent-provider', providesMcpAddConsent: true, apply() {} })
    await rows.provider
    await ctx.loader.await()

    await ctx.loader.resolve(serverId).fiber?.await()
    expect(mockConnect).toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
  })
})
