/**
 * Tests for the add-time consent before a reconnect: with a mounted consent,
 * the start is resolved and reviewed again before each reconnect spawns the
 * server, a refusal ends the reconnect loop, and without a consent the
 * reconnect spawns the configured start exactly as upstream does. Isolated
 * file so the vi.mock of the MCP SDK doesn't pollute other test suites.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const { mockConnect, mockClose, mockListTools, MockClient, instances } = vi.hoisted(() => {
  const mockConnect = vi.fn<() => Promise<void>>()
  const mockClose = vi.fn<() => Promise<void>>()
  const mockListTools = vi.fn<(_params?: Record<string, unknown>) => Promise<unknown>>()
  class MockClient {
    transport: object | undefined = {}
    onclose: (() => void) | undefined
    connect = mockConnect
    close = mockClose
    listTools = mockListTools
    getServerCapabilities = () => ({ tools: {} })
    getInstructions(): string | undefined { return undefined }
    constructor() {
      instances.push(this)
    }
  }
  const instances: MockClient[] = []
  return { mockConnect, mockClose, mockListTools, MockClient, instances }
})

vi.mock('@modelcontextprotocol/client', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client')>(),
  Client: MockClient,
  StreamableHTTPClientTransport: vi.fn(),
}))

vi.mock('@modelcontextprotocol/client/stdio', async importOriginal => ({
  ...await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>(),
  StdioClientTransport: vi.fn(function () { return { close: () => Promise.resolve() } }),
}))

import { apply, inject } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { McpAddConsent } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client/src/consent.ts'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

/** A consent stub whose reviews are scripted, one decision per call. */
class StubConsent extends McpAddConsent {
  readonly calls: McpServerCommand[] = []

  constructor(ctx: Context, private readonly decisions: (() => Promise<McpConsentDecision>)[]) {
    super(ctx)
  }

  review(command: McpServerCommand): Promise<McpConsentDecision> {
    this.calls.push(command)
    const decision = this.decisions.shift()
    if (decision === undefined) throw new Error('the stub ran out of scripted decisions')
    return decision()
  }
}

const allow = (): Promise<McpConsentDecision> => Promise.resolve({ allow: true })

describe('the add-time consent before a reconnect', () => {
  let ctx: Context
  let root: string
  let errors: string[]

  /**
   * The server's configuration, a bare command found on the tree's PATH, reconnecting at once.
   * @returns the configuration.
   */
  function config(): Config {
    return {
      transport: 'stdio',
      serverName: 'srv',
      command: 'tool',
      args: ['server.js'],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
      reconnect: { initialDelayMs: 1, maxDelayMs: 4, maxAttempts: 3 },
    }
  }

  /** The spawns so far, as the executable and working directory each was given. */
  function spawns(): [string, string | undefined][] {
    return vi.mocked(StdioClientTransport).mock.calls.map(([params]) => [params.command, params.cwd])
  }

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-consent-reconnect-')))
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'bin', 'tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    vi.stubEnv('PATH', join(root, 'bin'))
    vi.spyOn(process, 'cwd').mockReturnValue(root)
    vi.clearAllMocks()
    instances.length = 0
    mockConnect.mockResolvedValue(undefined)
    mockClose.mockImplementation(function (this: { onclose?: () => void }) {
      this.onclose?.()
      return Promise.resolve()
    })
    mockListTools.mockResolvedValue({ tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined })
    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolExecutor)
    errors = []
    ctx.logger.error = ((message: unknown) => { errors.push(String(message)) }) as typeof ctx.logger.error
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    rmSync(root, { recursive: true, force: true })
  })

  it('reconnects with the configured start exactly as upstream does when no consent is mounted', async () => {
    await apply(ctx, config())
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeDefined() })
    expect(spawns()).toEqual([['tool', ''], ['tool', '']])
  })

  it('reviews the start again before a reconnect spawns the reviewed executable', async () => {
    const consent = new StubConsent(ctx, [allow, allow])
    await apply(ctx, config())
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(consent.calls).toHaveLength(2)
    expect(consent.calls[1]).toMatchObject({ resolvedCommand: join(root, 'bin', 'tool'), resolvedCwd: root })
    expect(spawns()).toEqual([[join(root, 'bin', 'tool'), root], [join(root, 'bin', 'tool'), root]])
  })

  it('spawns the executable path an allowing decision names, at boot and at each reconnect', async () => {
    const pinned = (path: string) => (): Promise<McpConsentDecision> => Promise.resolve({ allow: true, spawnCommand: path })
    new StubConsent(ctx, [pinned(join(root, 'pinned', 'tool-1')), pinned(join(root, 'pinned', 'tool-2'))])
    await apply(ctx, config())
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(instances).toHaveLength(2) })
    expect(spawns()).toEqual([[join(root, 'pinned', 'tool-1'), root], [join(root, 'pinned', 'tool-2'), root]])
  })

  it('stops reconnecting, unregisters the tools and spawns nothing when the consent refuses the reconnect', async () => {
    const consent = new StubConsent(ctx, [allow, () => Promise.resolve({ allow: false, reason: 'the file changed' })])
    await apply(ctx, config())
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(errors.some(line => line.includes('reconnect stopped before the attempt'))).toBe(true) })
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__srv__remote')).toBeUndefined() })
    expect(errors.join('\n')).toContain('the file changed')
    expect(consent.calls).toHaveLength(2)
    expect(spawns()).toHaveLength(1)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(consent.calls).toHaveLength(2)
    expect(instances).toHaveLength(1)
  })

  it('stops reconnecting when the start no longer resolves', async () => {
    const consent = new StubConsent(ctx, [allow])
    await apply(ctx, config())
    rmSync(join(root, 'bin', 'tool'))
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(errors.some(line => line.includes('could not be resolved to an executable'))).toBe(true) })
    expect(consent.calls).toHaveLength(1)
    expect(spawns()).toHaveLength(1)
  })

  it('stops reconnecting when the consent that allowed the server is no longer mounted', async () => {
    const holder = ctx.plugin({ name: 'consent-holder', apply: (child: Context) => { new StubConsent(child, [allow]) } })
    await holder
    await apply(ctx, config())
    await holder.dispose()
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(errors.some(line => line.includes('the add-time consent that allowed this server is no longer mounted'))).toBe(true) })
    expect(spawns()).toHaveLength(1)
  })

  it('names a review that fails with a value that is not an error', async () => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection is the case under test
    new StubConsent(ctx, [allow, () => Promise.reject('the store is gone')])
    await apply(ctx, config())
    instances[0]!.onclose?.()

    await vi.waitFor(() => { expect(errors.some(line => line.includes('reconnect stopped before the attempt: the store is gone'))).toBe(true) })
    expect(spawns()).toHaveLength(1)
  })

  it('spawns nothing when the plugin is disposed while the reconnect is reviewed', async () => {
    const review: PromiseWithResolvers<McpConsentDecision> = Promise.withResolvers()
    const consent = new StubConsent(ctx, [allow, () => review.promise])
    const fiber = ctx.plugin({ name: 'mcp-client-under-review', inject, apply }, config())
    await fiber
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(consent.calls).toHaveLength(2) })

    const disposing = fiber.dispose()
    review.resolve({ allow: true })
    await disposing
    expect(spawns()).toHaveLength(1)
    expect(instances).toHaveLength(1)
  })

  it('logs nothing when a reconnect review fails after the plugin was disposed', async () => {
    const review: PromiseWithResolvers<McpConsentDecision> = Promise.withResolvers()
    const consent = new StubConsent(ctx, [allow, () => review.promise])
    const fiber = ctx.plugin({ name: 'mcp-client-under-review', inject, apply }, config())
    await fiber
    instances[0]!.onclose?.()
    await vi.waitFor(() => { expect(consent.calls).toHaveLength(2) })

    const disposing = fiber.dispose()
    review.reject(new Error('the consent unloaded'))
    await disposing
    expect(errors).toEqual([])
    expect(spawns()).toHaveLength(1)
  })
})
