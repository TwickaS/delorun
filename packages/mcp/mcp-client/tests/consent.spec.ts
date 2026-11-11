/**
 * Tests for the optional `mcpAddConsent` seam: the add-time consent a mounted
 * service runs before a stdio server's command starts, the start it is shown
 * (command, arguments, working directory and environment, with the executable
 * path, Windows command shell and working directory they resolve to), the spawn of the reviewed
 * paths, and the lookup that waits for a declared provider whatever the order
 * of the loader's rows. Isolated file so the vi.mock of the MCP SDK doesn't
 * pollute other test suites.
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

vi.mock('@modelcontextprotocol/client/stdio', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>(),
  StdioClientTransport: vi.fn(),
}))

import * as McpClient from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { apply, inject } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpAddConsent, McpConsentRefusedError, McpConsentUnavailableError } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import { McpServerStartUnresolvedError } from '@deepseek-ai/dsh-mcp-client/src/server-start.ts'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

const stdioConfig: Config & { transport: 'stdio' } = {
  transport: 'stdio',
  serverName: 'srv',
  command: 'tool',
  args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
  env: {},
  cwd: '',
  toolCallTimeoutMs: 60_000,
  failOnStartupError: false,
}

/**
 * A temporary tree of two directories, `a` and `b`, each holding an
 * executable `bin/tool`, with the Host's ambient PATH set to `a/bin` and then
 * `b/bin` and the Host's working directory reported as `a`.
 */
interface ToolTree {
  /** The tree's canonical root. */
  readonly root: string
  /** `<root>/a`. */
  readonly a: string
  /** `<root>/b`. */
  readonly b: string
  /** Report the Host's working directory as another directory. */
  readonly hostIn: (dir: string) => void
  /** Remove the tree and restore the stubs. */
  readonly remove: () => void
}

/**
 * Create a {@link ToolTree}.
 * @returns the tree.
 */
function toolTree(): ToolTree {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-consent-start-')))
  const a = join(root, 'a')
  const b = join(root, 'b')
  for (const dir of [a, b]) {
    mkdirSync(join(dir, 'bin'), { recursive: true })
    writeFileSync(join(dir, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  vi.stubEnv('PATH', `${join(a, 'bin')}:${join(b, 'bin')}`)
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(a)
  return {
    root,
    a,
    b,
    hostIn: dir => void cwd.mockReturnValue(dir),
    remove: () => {
      cwd.mockRestore()
      vi.unstubAllEnvs()
      rmSync(root, { recursive: true, force: true })
    },
  }
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
  let tree: ToolTree

  afterEach(() => {
    tree.remove()
  })

  beforeEach(async () => {
    tree = toolTree()
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

  /**
   * The start a review of {@link stdioConfig} is shown with the tree's defaults: the Host in `a`, `a/bin` first on PATH.
   * @param overrides - the fields that differ.
   * @returns the start.
   */
  function startOf(overrides: Partial<McpServerCommand> = {}): McpServerCommand {
    return {
      serverName: 'srv',
      command: 'tool',
      args: ['-y', '@modelcontextprotocol/server-fs', '/tmp'],
      env: {},
      cwd: '',
      resolvedCommand: join(tree.a, 'bin', 'tool'),
      resolvedCwd: tree.a,
      ...overrides,
    }
  }

  it('starts the server exactly as upstream does when no consent service is mounted', async () => {
    await apply(ctx, stdioConfig)

    expect(mockConnect).toHaveBeenCalled()
    expect(StdioClientTransport).toHaveBeenCalledWith(expect.objectContaining({ command: 'tool', cwd: '' }))
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('holds a new server row until the mounted service allows it, then spawns the reviewed executable in the reviewed directory', async () => {
    const pending: PromiseWithResolvers<McpConsentDecision> = Promise.withResolvers()
    const consent = new StubConsent(ctx, [pending.promise])
    const fiber = ctx.plugin({ name: 'mcp-consent-held', inject, apply }, stdioConfig)
    let activated = false
    const activation = Promise.resolve(fiber).then(() => { activated = true })

    // The review sees the command each boot, before any child process starts.
    await vi.waitFor(() => { expect(consent.calls).toEqual([startOf()]) })
    expect(mockConnect).not.toHaveBeenCalled()
    expect(StdioClientTransport).not.toHaveBeenCalled()
    expect(activated).toBe(false)
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()

    pending.resolve({ allow: true })
    await activation
    expect(mockConnect).toHaveBeenCalled()
    expect(StdioClientTransport).toHaveBeenCalledWith(expect.objectContaining({ command: join(tree.a, 'bin', 'tool'), cwd: tree.a }))
    expect(vi.mocked(StdioClientTransport).mock.calls.map(([params]) => [params.command, params.cwd]))
      .toEqual(vi.mocked(StdioClientTransport).mock.calls.map(() => [join(tree.a, 'bin', 'tool'), tree.a]))
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    await fiber.dispose()
  })

  it('leaves the server stopped with the typed reason when the service refuses', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'not on the accepted list' })])

    await expect(apply(ctx, { ...stdioConfig, failOnStartupError: true })).rejects.toMatchObject({
      message: 'mcp-client(srv): the add-time consent did not allow this server\'s command, so the server stays stopped — '
        + 'not on the accepted list. The consent covers the command "tool" "-y" "@modelcontextprotocol/server-fs" "/tmp", '
        + `which runs the executable ${JSON.stringify(join(tree.a, 'bin', 'tool'))} in ${JSON.stringify(tree.a)} `
        + '(configured as the Host\'s working directory) with no configured environment variables. '
        + 'A server command runs outside the agent sandbox.',
    })

    expect(mockConnect).not.toHaveBeenCalled()
    expect(StdioClientTransport).not.toHaveBeenCalled()
    expect(mockListTools).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('shows the refusal as the typed error without failing the startup path when not fatal', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'refused' })])

    const failure: unknown = await apply(ctx, stdioConfig).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    expect(failure).toMatchObject({
      serverName: 'srv',
      command: 'tool',
      cwd: '',
      resolvedCommand: join(tree.a, 'bin', 'tool'),
      resolvedCwd: tree.a,
      resolvedShell: undefined,
      reason: 'refused',
    })
    expect(mockConnect).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('resolves the start again at every boot, so a changed PATH order or Host working directory reaches the review as a different start', async () => {
    const consent = new StubConsent(ctx, [Promise.resolve({ allow: true }), Promise.resolve({ allow: true })])

    const first = createScope(ctx, {})
    await apply(first.ctx, stdioConfig)
    await first.dispose()

    vi.stubEnv('PATH', `${join(tree.b, 'bin')}:${join(tree.a, 'bin')}`)
    tree.hostIn(tree.b)
    vi.mocked(StdioClientTransport).mockClear()
    const second = createScope(ctx, {})
    await apply(second.ctx, stdioConfig)
    await second.dispose()

    expect(consent.calls).toEqual([startOf(), startOf({ resolvedCommand: join(tree.b, 'bin', 'tool'), resolvedCwd: tree.b })])
    expect(StdioClientTransport).toHaveBeenCalledWith(expect.objectContaining({ command: join(tree.b, 'bin', 'tool'), cwd: tree.b }))
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

  it('shows the review the configured working directory and environment with the canonical directory and the executable they resolve to', async () => {
    const consent = new StubConsent(ctx, [Promise.resolve({ allow: true })])
    // A relative working directory through a symbolic link, and a relative PATH entry resolved against that directory.
    symlinkSync(tree.b, join(tree.a, 'to-b'))

    await apply(ctx, { ...stdioConfig, cwd: 'to-b', env: { NODE_OPTIONS: '--require ./hook.js', PATH: 'bin' } })

    expect(consent.calls).toEqual([startOf({
      env: { NODE_OPTIONS: '--require ./hook.js', PATH: 'bin' },
      cwd: 'to-b',
      resolvedCommand: join(tree.b, 'bin', 'tool'),
      resolvedCwd: tree.b,
    })])
    expect(StdioClientTransport).toHaveBeenCalledWith(expect.objectContaining({ command: join(tree.b, 'bin', 'tool'), cwd: tree.b }))
    expect(vi.mocked(StdioClientTransport).mock.calls.map(([params]) => [params.env?.['NODE_OPTIONS'], params.env?.['PATH']]))
      .toContainEqual(['--require ./hook.js', 'bin'])
    await ctx.fiber.dispose()
  })

  it('names the working directory and the environment variable names in a refusal, never the values', async () => {
    new StubConsent(ctx, [Promise.resolve({ allow: false, reason: 'the environment changed' })])

    const failure: unknown = await apply(ctx, { ...stdioConfig, cwd: tree.b, env: { TOKEN: 'secret-value-123', LD_PRELOAD: '/tmp/x.so' } })
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(McpConsentRefusedError)
    const refusal = failure as McpConsentRefusedError
    expect(refusal.message).toBe('mcp-client(srv): the add-time consent did not allow this server\'s command, so the server stays stopped — '
      + 'the environment changed. The consent covers the command "tool" "-y" "@modelcontextprotocol/server-fs" "/tmp", '
      + `which runs the executable ${JSON.stringify(join(tree.a, 'bin', 'tool'))} in ${JSON.stringify(tree.b)} `
      + `(configured as ${JSON.stringify(tree.b)}) with the configured environment variables LD_PRELOAD, TOKEN (values not shown). `
      + 'A server command runs outside the agent sandbox.')
    expect(refusal.cwd).toBe(tree.b)
    expect(refusal.envNames).toEqual(['LD_PRELOAD', 'TOKEN'])
    expect(JSON.stringify(Object.entries(refusal))).not.toContain('secret-value-123')
    expect(mockConnect).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})

describe('a refusal of a Windows batch file', () => {
  it('names the command shell that runs the batch file, in the message and as a field', () => {
    const refusal = new McpConsentRefusedError({
      serverName: 'srv',
      command: 'npx',
      args: ['-y', '@scope/server'],
      env: {},
      cwd: '',
      resolvedCommand: 'C:\\Program Files\\nodejs\\npx.cmd',
      resolvedCwd: 'C:\\work\\repo',
      resolvedShell: 'C:\\Windows\\System32\\cmd.exe',
    }, 'refused')
    expect(refusal.resolvedShell).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(refusal.message).toContain(
      'which runs the batch file "C:\\\\Program Files\\\\nodejs\\\\npx.cmd" through the command shell "C:\\\\Windows\\\\System32\\\\cmd.exe" in "C:\\\\work\\\\repo"',
    )
  })
})

describe('a start whose executable or working directory cannot be resolved', () => {
  let ctx: Context
  let tree: ToolTree
  let consent: StubConsent

  beforeEach(async () => {
    tree = toolTree()
    vi.clearAllMocks()
    mockConnect.mockResolvedValue(undefined)
    ctx = await mountRegistry()
    consent = new StubConsent(ctx, [Promise.resolve({ allow: true })])
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    tree.remove()
  })

  /**
   * Start the server under the stub consent and return its failure, checking that nothing was reviewed or spawned.
   * @param config - the overrides of {@link stdioConfig}.
   * @returns the failure's reason.
   */
  async function unresolved(config: Partial<typeof stdioConfig>): Promise<string> {
    const failure: unknown = await apply(ctx, { ...stdioConfig, ...config }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpServerStartUnresolvedError)
    expect(consent.calls).toEqual([])
    expect(StdioClientTransport).not.toHaveBeenCalled()
    expect(mockConnect).not.toHaveBeenCalled()
    return (failure as McpServerStartUnresolvedError).reason
  }

  it('keeps the server stopped, unreviewed, when no executable of the command\'s name is on PATH', async () => {
    const failure: unknown = await apply(ctx, { ...stdioConfig, command: 'absent' }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(McpServerStartUnresolvedError)
    expect(failure).toMatchObject({
      serverName: 'srv',
      command: 'absent',
      cwd: '',
      message: 'mcp-client(srv): the command "absent" could not be resolved to an executable, so the add-time consent cannot review it '
        + 'and the server stays stopped — no executable file named "absent" is in the server\'s PATH. '
        + 'A server command runs outside the agent sandbox.',
    })
    expect(consent.calls).toEqual([])
    expect(mockConnect).not.toHaveBeenCalled()
  })

  it('skips a directory and a file without execute permission on PATH, as the spawn does', async () => {
    mkdirSync(join(tree.root, 'c', 'tool'), { recursive: true })
    chmodSync(join(tree.a, 'bin', 'tool'), 0o644)
    vi.stubEnv('PATH', `${join(tree.root, 'c')}:${join(tree.a, 'bin')}:${join(tree.b, 'bin')}`)

    await apply(ctx, stdioConfig)

    expect(consent.calls.map(call => call.resolvedCommand)).toEqual([join(tree.b, 'bin', 'tool')])
  })

  it('looks a command up in the working directory for an empty PATH entry', async () => {
    await apply(ctx, { ...stdioConfig, cwd: 'bin', env: { PATH: '' } })

    expect(consent.calls.map(call => [call.resolvedCommand, call.resolvedCwd])).toEqual([[join(tree.a, 'bin', 'tool'), join(tree.a, 'bin')]])
  })

  it('resolves a command that names a path against the working directory, without a PATH lookup', async () => {
    vi.stubEnv('PATH', join(tree.b, 'bin'))

    await apply(ctx, { ...stdioConfig, command: './bin/tool' })

    expect(consent.calls.map(call => call.resolvedCommand)).toEqual([join(tree.a, 'bin', 'tool')])
  })

  it('keeps the server stopped when a command that names a path is not an executable file', async () => {
    await expect(unresolved({ command: './bin/absent' })).resolves.toBe(`${JSON.stringify(join(tree.a, 'bin', 'absent'))} is not an executable file`)
  })

  it('keeps the server stopped when the environment sets no PATH for a bare command', async () => {
    vi.stubEnv('PATH', undefined)
    await expect(unresolved({})).resolves.toBe('the server\'s environment sets no PATH to look the command up in')
  })

  it('keeps the server stopped when the working directory does not exist or is not a directory', async () => {
    await expect(unresolved({ cwd: 'absent' })).resolves.toBe(`the working directory ${JSON.stringify(join(tree.a, 'absent'))} does not exist or cannot be read`)
    await expect(unresolved({ cwd: 'bin/tool' })).resolves.toBe(`the working directory ${JSON.stringify(join(tree.a, 'bin', 'tool'))} is not a directory`)
  })
})

describe('the consent lookup under a Loader, whatever the order of its rows', () => {
  let ctx: Context
  let tree: ToolTree
  /** The provider row's module, released by the test so the server row starts first. */
  let providerModule: PromiseWithResolvers<object>

  beforeEach(async () => {
    tree = toolTree()
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
    tree.remove()
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

  it('starts the server as upstream does when the only other row fails to import its module', async () => {
    providerModule.reject(new Error('the module could not be imported'))
    const rows = startRows()
    const serverId = await rows.server
    await rows.provider.catch((error: unknown) => error)
    await ctx.loader.await()

    await ctx.loader.resolve(serverId).fiber?.await()
    expect(mockConnect).toHaveBeenCalled()
  })

  it('counts a declaring row whose disabled expression throws as a row that provides nothing', async () => {
    providerModule.resolve({ name: 'consent-provider', providesMcpAddConsent: true, apply() { throw new Error('a disabled row never starts') } })
    const provider = ctx.loader.create({
      name: 'cordis:provider',
      get disabled(): boolean { throw new Error('the switch expression failed') },
    })
    const serverId = await ctx.loader.create({ name: 'cordis:mcp', config: { ...stdioConfig } })
    await provider.catch((error: unknown) => error)
    await ctx.loader.await()

    await ctx.loader.resolve(serverId).fiber?.await()
    expect(mockConnect).toHaveBeenCalled()
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
