import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcToolExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import McpResources from '@deepseek-ai/dsh-mcp-resources'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import Llm, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Agents from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Projections from '@deepseek-ai/dsh-session-projection'
import WorkingDirectory from '@deepseek-ai/dsh-working-directory'
import { bindScopeParent } from '@deepseek-ai/dsh-scope'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { BrowserMcpConfig, mountSessionMcp, validateBrowserMcpConfig, type BrowserToolCall, type SessionMcpOptions } from '../src/mcp.ts'

/** Lets one test make `realpath` fail for a path; every other call is the real one. */
const realpathHook = vi.hoisted(() => ({ fail: undefined as undefined | ((path: string) => NodeJS.ErrnoException | undefined) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: (async (path: Parameters<typeof actual.realpath>[0], ...rest: unknown[]) => {
    const error = realpathHook.fail?.(String(path))
    if (error !== undefined) throw error
    return (actual.realpath as (...args: unknown[]) => Promise<string>)(path, ...rest)
  }) as typeof actual.realpath }
})

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
const activations: Promise<void>[] = []
const TOOL = 'mcp__browser-fixture__visit'

afterEach(async () => {
  realpathHook.fail = undefined
  const disposed = await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(activations.splice(0))
  const removed = await Promise.allSettled(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const failures: unknown[] = []
  for (const result of [...disposed, ...removed]) {
    if (result.status === 'rejected') failures.push(result.reason)
  }
  if (failures.length > 0) throw new AggregateError(failures, 'MCP fixture cleanup failed')
})

/** Observe pending creation or resume before a readiness assertion can fail; callers retain its original result. */
function observeActivation(activation: Promise<AgentHandle>): Promise<AgentHandle> {
  activations.push(activation.then(() => {}, () => {}))
  return activation
}

class FixtureModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text'] })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools?.some(tool => tool.name === TOOL) && options.messages.at(-1)?.role === 'user') {
      const call = { type: 'tool-call' as const, id: ToolCallId('visit'), name: TOOL, arguments: '{"label":"fixture"}' }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
    } else {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'Visited.' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Visited.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

class PresentationRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'fixture'
  resolve(): never { throw new Error('Unexpected PTC execution in a presentation test') }
  run(): Promise<never> { return Promise.reject(new Error('Unexpected PTC execution in a presentation test')) }
}

/** An add-time consent that refuses the browser fixture's start and allows every other server's. */
class RefuseBrowserConsent extends McpClient.McpAddConsent {
  static readonly providesMcpAddConsent = true
  readonly reviewed: string[] = []
  /** Whether the browser fixture's start is now accepted. */
  accepted = false
  review(command: McpServerCommand): Promise<McpConsentDecision> {
    this.reviewed.push(command.serverName)
    return Promise.resolve(command.serverName === 'browser-fixture' && !this.accepted ? { allow: false, reason: 'no server is accepted yet' } : { allow: true })
  }
}

/** A row that declares the add-time consent and fails to start, so no consent service exists. */
const FailedConsent = {
  providesMcpAddConsent: true,
  apply(): void { throw new Error('the consent row failed to start') },
}

/** A Loader row of an MCP server outside the browser provider, beside the refused browser server. */
const OTHER_TOOL = 'mcp__other-fixture__visit'

/** The fixture provider's settings for one {@link load}; each omitted field keeps the mount's default. */
interface LoadOptions {
  exclusive?: boolean
  mode?: string
  toolCallTimeoutMs?: number
  toolOrder?: string[]
  consent?: boolean | 'failed'
  explainFailure?: (message: string) => string | undefined
  directory?: string
  outputFolder?: string
  outputRoot?: string
  refuseCall?: SessionMcpOptions['refuseCall']
  checkResult?: SessionMcpOptions['checkResult']
  prepareCall?: SessionMcpOptions['prepareCall']
  registration?: SessionMcpOptions['registration']
  admission?: SessionMcpOptions['admission']
  deniedTools?: string[]
}

async function load(options: LoadOptions = {}) {
  const { exclusive = false, mode, toolCallTimeoutMs, toolOrder, consent = false } = options
  const { explainFailure, directory, outputFolder, outputRoot, refuseCall, checkResult, prepareCall } = options
  const { registration, admission, deniedTools } = options
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-'))
  roots.push(root)
  const model = new FixtureModel()
  const warnings: string[] = []
  const modules = new Map<string, unknown>([
    ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['toolExecutor', NativeToolExecutor], ['llm', Llm],
    ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections],
    ['fs', LocalFileSystem], ['workingDirectory', WorkingDirectory],
    ['model', { inject: ['llm'], apply(ctx: Context) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], model)) } }],
    ['browser', { inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'], apply(ctx: Context) {
      ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
      mountSessionMcp(ctx, {
        name: 'browser-fixture', exclusive, command: process.execPath, args: [fixture, root, ...mode === undefined ? [] : [mode]],
        ...toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs, env: {} }, ...explainFailure === undefined ? {} : { explainFailure },
        ...directory === undefined ? {} : { directory }, ...outputFolder === undefined ? {} : { outputFolder },
        ...outputRoot === undefined ? {} : { outputRoot },
        ...prepareCall === undefined ? {} : { prepareCall },
        ...refuseCall === undefined ? {} : { refuseCall }, ...checkResult === undefined ? {} : { checkResult },
        ...deniedTools === undefined ? {} : { deniedTools },
        ...registration === undefined ? {} : { registration }, ...admission === undefined ? {} : { admission },
      })
    } }],
    ...consent === true ? [['consent', RefuseBrowserConsent], ['other', McpClient]] as const : [],
    ...consent === 'failed' ? [['consent', FailedConsent]] as const : [],
  ])
  const otherRoot = join(root, 'other')
  await mkdir(otherRoot)
  const otherConfig = { transport: 'stdio', serverName: 'other-fixture', command: process.execPath, args: [fixture, otherRoot], cwd: otherRoot, reconnect: { enabled: false } }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({
    id: name, name,
    config: name === 'loop' ? { agents: [] } : name === 'prompt' && toolOrder !== undefined ? { toolOrder } : name === 'other' ? otherConfig : {},
  }))))
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`Unexpected fixture module ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const browser = [...ctx.loader.entries()].find(entry => entry.options.id === 'browser')!.fiber!
  return { ctx, root, model, browser, warnings }
}

async function warm(ctx: Context, agent: Agent, signal = new AbortController().signal) {
  await agent.whenIdle()
  return ctx.systemPrompt.assemble({ agent, scope: agent, signal })
}

function execute(ctx: Context, agent: Agent, name = TOOL) {
  return executeToolFixture(ctx, { agent, name, arguments: name === TOOL ? { label: 'direct' } : {}, callId: ToolCallId('direct'), signal: new AbortController().signal })
}

function visit(ctx: Context, agent: Agent, label: string) {
  const signal = new AbortController().signal
  return executeToolFixture(ctx, { agent, name: TOOL, arguments: { label }, callId: ToolCallId(label), signal })
}

function resource(ctx: Context, agent: Agent | undefined, name = 'read_mcp_resource', server = 'browser-fixture', callId = name) {
  return executeToolFixture(ctx, {
    ...agent === undefined ? {} : { agent }, name,
    arguments: { server, ...name === 'read_mcp_resource' ? { uri: 'browser-fixture://state' } : {} },
    callId: ToolCallId(callId), signal: new AbortController().signal,
  })
}

function browserState(result: Awaited<ReturnType<typeof resource>>): { counter: number; pid: number } {
  expect(result.isError).toBe(false)
  const value = result.value as { contents: { text: string }[] }
  return JSON.parse(value.contents[0]!.text) as { counter: number; pid: number }
}

function registerIndependentTool(ctx: Context) {
  ctx.tools.register({
    name: 'unrelated', description: 'An independent capability.', parameters: { type: 'object' },
    output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Independent.' }] },
    execute: async () => true,
  })
}

async function events(root: string) {
  return (await readFile(join(root, 'events.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { event: string; pid: number; name?: string; cwd?: string; outputDir?: string | null; arguments?: unknown; roots?: { uri: string; name: string }[] })
}

it('requires a browser mode and validates launch and attachment settings', () => {
  expect(BrowserMcpConfig({ mode: 'launch' })).toEqual({ mode: 'launch', headless: true })
  expect(BrowserMcpConfig({ mode: 'launch', headless: false, executablePath: '/chromium', toolCallTimeoutMs: 12 })).toMatchObject({ headless: false, toolCallTimeoutMs: 12 })
  expect(BrowserMcpConfig({ mode: 'attach', endpoint: 'wss://browser.example/devtools/browser/id' })).toMatchObject({ mode: 'attach' })
  for (const invalid of [{}, { mode: 'attach' }, { mode: 'attach', endpoint: 'file:///tmp/browser' }, { mode: 'launch', toolCallTimeoutMs: 0 }, { mode: 'launch', executablePath: '' }]) {
    expect(() => BrowserMcpConfig(invalid as never)).toThrow()
  }
  for (const endpoint of ['http://localhost:bad/path', 'http://localhost trailing-junk', 'file:///tmp/browser', 'http://localhost/ ']) {
    expect(() => { validateBrowserMcpConfig({ mode: 'attach', endpoint }) }).toThrow('browser endpoint')
  }
})

it('waits for SystemPrompt and ToolRuntime before reserving the provider', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(BrowserUse)
  await ctx.plugin(Projections)
  await ctx.plugin(Agents)
  provideWorkingDirectoryFixture(ctx)
  const tools = ctx.plugin(Tools)
  const browser = ctx.plugin({
    inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
    apply(provider: Context) {
      mountSessionMcp(provider, { name: 'browser-fixture', exclusive: true, command: process.execPath, args: [fixture] })
    },
  })
  await Promise.all([tools, browser])
  expect(ctx.get('tools')).toBeUndefined()
  expect(ctx.browserUse.providerName).toBeUndefined()
  await ctx.plugin(SystemPrompt)
  await Promise.all([tools, browser])
  expect(ctx.browserUse.providerName).toBe('browser-fixture')
})

describe('Session MCP Loader composition', () => {
  it('discovers schemas before the first model request and retains distinct state across turns', async () => {
    const { ctx, root, model, browser } = await load({ toolCallTimeoutMs: 5000, toolOrder: [TOOL, '<unlisted-tools>'] })
    const first = await ctx.agents.create({ sessionId: SessionId('first'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    const second = await ctx.agents.create({ sessionId: SessionId('second') })
    expect(ctx.tools.schemas()).toEqual([])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    expect(model.requests[0]?.tools?.find(tool => tool.name === TOOL)).toMatchObject({ description: 'Visit the fixture page.', parameters: { required: ['label'], additionalProperties: false } })
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 1: fixture')
    expect((await execute(ctx, first.agent)).content).toEqual([{ type: 'text', text: 'Visit 2: direct' }])
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit once more.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(4)
    expect(JSON.stringify(first.agent.session.snapshotEvents())).toContain('Visit 3: fixture')
    await warm(ctx, second.agent)
    expect((await execute(ctx, second.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    expect(ctx.tools.schemas()).toEqual([])
    expect(ctx.tools.schemas(first.agent)).toHaveLength(2)
    const initial = await events(root)
    expect(initial.filter(event => event.event === 'start')).toHaveLength(4)
    expect(initial.filter(event => event.event === 'probe')).toHaveLength(2)
    expect(initial.filter(event => event.event === 'initialize')).toHaveLength(2)
    await first.dispose()
    expect(ctx.tools.schemas(first.agent)).toEqual([])
    const resumed = await ctx.agents.create({ sessionId: SessionId('first') })
    await warm(ctx, resumed.agent)
    expect((await execute(ctx, resumed.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await browser.dispose()
    expect(ctx.browserUse.providerName).toBeUndefined()
    const closed = await events(root)
    for (const { pid } of closed.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('keeps unrelated and child Sessions running without a busy attachment and admits a later owner', async () => {
    const { ctx, root, model } = await load({ exclusive: true })
    registerIndependentTool(ctx)
    const first = await ctx.agents.create({ sessionId: SessionId('first') })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (_inner, agent) => { bindScopeParent(agent, first.agent) },
    })
    await warm(ctx, first.agent)
    expect(ctx.tools.schemas(child.agent).some(tool => tool.name === TOOL)).toBe(false)
    for (const { agent } of [second, child]) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    }
    await Promise.all([second.agent.whenIdle(), child.agent.whenIdle()])
    expect(model.requests).toHaveLength(2)
    expect(model.requests.map(request => request.tools?.map(tool => tool.name))).toEqual([['unrelated'], ['unrelated']])
    for (const { agent } of [second, child]) {
      expect(ctx.tools.schemas(agent).map(tool => tool.name)).toEqual(['unrelated'])
      expect((await execute(ctx, agent)).isError).toBe(true)
      expect((await execute(ctx, agent, 'unrelated')).isError).toBe(false)
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    }
    first.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__late', description: 'A newly discovered browser operation.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [{ type: 'text', text: 'Late browser result.' }] },
      execute: async () => true,
    })
    expect(ctx.tools.schemas(child.agent).filter(tool => tool.name.startsWith('mcp__browser-fixture__'))).toEqual([])
    expect((await warm(ctx, child.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__late')).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    await first.dispose()
    expect((await warm(ctx, child.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect((await execute(ctx, child.agent)).isError).toBe(true)
    expect((await warm(ctx, second.agent)).tools.map(tool => tool.name)).toEqual(['unrelated'])
    const successor = await ctx.agents.create({ sessionId: SessionId('successor') })
    expect((await warm(ctx, successor.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
    await successor.dispose()
    await second.dispose()
    const resumed = await ctx.agents.create({ sessionId: SessionId('second') })
    expect((await warm(ctx, resumed.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
  })

  it('allows another Session to answer while attached-browser discovery is pending', async () => {
    const { ctx, root, model, browser } = await load({ exclusive: true, mode: 'hold' })
    const first = observeActivation(ctx.agents.create({ sessionId: SessionId('first') }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    second.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without using the browser.' }], source: { kind: 'user' } }))
    await second.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools ?? []).toEqual([])
    expect((await events(root)).filter(event => event.event === 'start')).toHaveLength(1)
    await browser.dispose()
    await expect(first).rejects.toThrow()
    expect(ctx.agents.get(SessionId('first'))).toBeUndefined()
    expect(ctx.sessions.get(SessionId('first'))).toBeUndefined()
  })

  it('rolls back failed discovery and stops a child when unload interrupts discovery', async () => {
    const failed = await load({ mode: 'fail', toolOrder: [TOOL, '<unlisted-tools>'] })
    let failedAgent!: Agent
    const laterListener = vi.fn()
    await expect(failed.ctx.agents.create({
      sessionId: SessionId('failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        failedAgent = agent
        inner.on('agent/created', () => { agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } })) }, { prepend: true })
        inner.on('agent/created', laterListener)
      },
    })).rejects.toThrow('initial connection')
    expect(failed.model.requests).toEqual([])
    expect(laterListener).not.toHaveBeenCalled()
    expect(failed.ctx.agents.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.sessions.get(failedAgent.id)).toBeUndefined()
    expect(failed.ctx.tools.schemas(failedAgent)).toEqual([])
    const failedEvents = await events(failed.root)
    expect(failedEvents.filter(event => event.event === 'initialize')).toHaveLength(1)
    for (const { pid } of failedEvents.filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    const held = await load({ mode: 'hold' })
    const pendingOwner = observeActivation(held.ctx.agents.create({ sessionId: SessionId('pending') }))
    await expect.poll(async () => (await events(held.root)).some(event => event.event === 'probe')).toBe(true)
    await held.browser.dispose()
    await expect(pendingOwner).rejects.toThrow()
    expect(held.ctx.agents.get(SessionId('pending'))).toBeUndefined()
    for (const { pid } of (await events(held.root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('starts no server for a Session the admission does not admit, refuses its browser calls, and follows its admission', async () => {
    const admittedSessions = new Set<string>()
    const listeners = new Set<(session: Agent['session']) => Promise<void>>()
    const admission: NonNullable<SessionMcpOptions['admission']> = {
      admitted: agent => admittedSessions.has(agent.id),
      changed: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    const { ctx, root } = await load({ registration: 'none', admission })
    // One `initialize` per Session's server; the client's discovery probe starts a process of its own that never initializes.
    const starts = async () => (await events(root).catch(() => [])).filter(event => event.event === 'initialize')
    admittedSessions.add('granted')
    const granted = await ctx.agents.create({ sessionId: SessionId('granted'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const other = await ctx.agents.create({ sessionId: SessionId('other'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    // Pins admission: only the admitted Session starts a server; the other gets no tools, no prompt section, no process.
    expect(await starts()).toHaveLength(1)
    const assembled = await warm(ctx, other.agent)
    expect(assembled.tools.some(tool => tool.name.startsWith('mcp__browser-fixture__'))).toBe(false)
    expect(assembled.sections.some(section => section.name === 'mcp:browser-fixture')).toBe(false)
    expect((await warm(ctx, granted.agent)).tools.map(tool => tool.name)).toContain(TOOL)
    // Pins the denial: a browser call from a Session that is not admitted is refused before any server sees it.
    const refused = await execute(ctx, other.agent)
    expect(refused.isError).toBe(true)
    expect(JSON.stringify(refused)).toContain('this Session may not use this browser')
    expect((await events(root)).filter(event => event.event === 'call')).toHaveLength(0)
    expect((await visit(ctx, granted.agent, 'first')).isError).toBe(false)
    // Pins the call-time check: once the provider stops admitting a Session, its calls are refused before the change is
    // reported and its server stopped.
    admittedSessions.delete('granted')
    expect((await visit(ctx, granted.agent, 'early')).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'call')).toHaveLength(1)
    admittedSessions.add('granted')
    // A change of admission starts the newly admitted Session's server and stops the one no longer admitted.
    admittedSessions.add('other')
    admittedSessions.delete('granted')
    // Each listener settles once the Session's server has started or stopped.
    await Promise.all([...listeners].flatMap(listener => [listener(other.agent.session), listener(granted.agent.session)]))
    expect(await starts()).toHaveLength(2)
    const [first] = await starts()
    expect(() => process.kill(first!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect((await warm(ctx, other.agent)).tools.map(tool => tool.name)).toContain(TOOL)
    expect((await visit(ctx, other.agent, 'second')).isError).toBe(false)
    // Pins the end of admission: the Session's calls are refused and reach no server.
    const callsBefore = (await events(root)).filter(event => event.event === 'call').length
    expect((await execute(ctx, granted.agent)).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'call')).toHaveLength(callsBefore)
    expect((await warm(ctx, granted.agent)).tools.some(tool => tool.name.startsWith('mcp__browser-fixture__'))).toBe(false)
    // Pins the slot: with `registration: 'none'` the mount takes no browser-use slot.
    expect(ctx.browserUse.providerName).toBeUndefined()
  })

  it('creates the Session without browser tools when the add-time consent refuses the browser server', async () => {
    const { ctx, root, model, warnings } = await load({ consent: true })
    const consent = ctx.get('mcpAddConsent') as RefuseBrowserConsent
    const created = await ctx.agents.create({ sessionId: SessionId('refused'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    expect(ctx.agents.get(created.agent.id)).toBe(created.agent)
    const assembled = await warm(ctx, created.agent)
    expect(assembled.tools.map(tool => tool.name)).toContain(OTHER_TOOL)
    expect(assembled.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(assembled.sections.map(section => section.name)).toContain('mcp:other-fixture')
    expect(assembled.sections.some(section => section.name === 'mcp:browser-fixture')).toBe(false)
    expect(warnings).toEqual([expect.stringContaining('browser-fixture: the browser tools are off in Session refused until the server\'s start is allowed')])
    expect(warnings[0]).toContain('no server is accepted yet')
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Answer without the browser.' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    const offered = model.requests.at(-1)?.tools?.map(tool => tool.name) ?? []
    expect(offered).toContain(OTHER_TOOL)
    expect(offered.some(name => name.startsWith('mcp__browser-fixture__'))).toBe(false)
    expect((await execute(ctx, created.agent, OTHER_TOOL)).isError).toBe(false)
    expect((await events(join(root, 'other'))).some(event => event.event === 'start')).toBe(true)
    await expect(readFile(join(root, 'events.ndjson'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const second = await ctx.agents.create({ sessionId: SessionId('refused-again') })
    await warm(ctx, second.agent)
    expect(consent.reviewed.filter(name => name === 'browser-fixture')).toHaveLength(2)
    expect(warnings).toHaveLength(2)
  })

  it('starts the browser server in a Session its refusal left without tools only once the consent accepts it', async () => {
    const { ctx, root, model } = await load({ consent: true })
    const consent = ctx.get('mcpAddConsent') as RefuseBrowserConsent
    const created = await ctx.agents.create({ sessionId: SessionId('refused-then-accepted'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    await warm(ctx, created.agent)
    const reviewed = (): number => consent.reviewed.filter(name => name === 'browser-fixture').length
    expect(reviewed()).toBe(1)
    // Still refused: the check runs again, nothing starts, and the Session keeps no browser tools.
    await ctx.parallel('mcp-client/consent-accepted', 'browser-fixture')
    expect(reviewed()).toBe(2)
    await expect(readFile(join(root, 'events.ndjson'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await warm(ctx, created.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    // Another server's acceptance asks nothing.
    await ctx.parallel('mcp-client/consent-accepted', 'other-fixture')
    expect(reviewed()).toBe(2)
    consent.accepted = true
    await ctx.parallel('mcp-client/consent-accepted', 'browser-fixture')
    expect((await warm(ctx, created.agent)).tools.map(tool => tool.name)).toContain(TOOL)
    // The same chat's next turn offers the server's tools to the model; nothing restarts.
    created.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the browser now.' }], source: { kind: 'user' } }))
    await created.agent.whenIdle()
    expect(model.requests.at(-1)?.tools?.map(tool => tool.name)).toContain(TOOL)
    expect((await execute(ctx, created.agent, TOOL)).isError).toBe(false)
  })

  it('starts no server after the consent is accepted in a Session whose admission has ended', async () => {
    const admittedSessions = new Set<string>(['refused-session'])
    const admission: NonNullable<SessionMcpOptions['admission']> = {
      admitted: agent => admittedSessions.has(agent.id),
      changed: () => () => {},
    }
    const { ctx, root } = await load({ consent: true, registration: 'none', admission })
    const consent = ctx.get('mcpAddConsent') as RefuseBrowserConsent
    const refused = await ctx.agents.create({ sessionId: SessionId('refused-session'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const unadmitted = await ctx.agents.create({ sessionId: SessionId('no-browser'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const reviewed = (): number => consent.reviewed.filter(name => name === 'browser-fixture').length
    // Only the admitted Session asked the consent; the Session of a No browser workspace never did.
    expect(reviewed()).toBe(1)
    // The provider stops admitting the refused Session before it reports the change.
    admittedSessions.delete('refused-session')
    consent.accepted = true
    await ctx.parallel('mcp-client/consent-accepted', 'browser-fixture')
    expect(reviewed()).toBe(1)
    await expect(readFile(join(root, 'events.ndjson'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    for (const created of [refused, unadmitted]) {
      expect((await warm(ctx, created.agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
      expect((await execute(ctx, created.agent, TOOL)).isError).toBe(true)
    }
  })

  it('creates the Session without browser tools when a row declares the add-time consent and did not start', async () => {
    const { ctx, root, warnings } = await load({ consent: 'failed' })
    const created = await ctx.agents.create({ sessionId: SessionId('unavailable'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    expect(ctx.agents.get(created.agent.id)).toBe(created.agent)
    const assembled = await warm(ctx, created.agent)
    expect(assembled.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(assembled.sections.some(section => section.name === 'mcp:browser-fixture')).toBe(false)
    expect(warnings).toEqual([expect.stringContaining('browser-fixture: the browser tools are off in Session unavailable until the server\'s start is allowed')])
    expect(warnings[0]).toContain('declares the add-time consent but did not start, so the server stays stopped')
    await expect(readFile(join(root, 'events.ndjson'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await execute(ctx, created.agent)).isError).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('narrows an existing fixed directory that others can enter to its owner', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-wide-'))
    roots.push(base)
    const fixed = join(base, 'fixed')
    await mkdir(fixed, { mode: 0o755 })
    await chmod(fixed, 0o755)
    const { ctx } = await load({ directory: fixed })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('narrowed') })
    await warm(ctx, agent)
    expect((await stat(fixed)).mode & 0o777).toBe(0o700)
  })

  it('starts every Session\'s server in the fixed directory, creating it, whatever each Session\'s working directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-fixed-'))
    roots.push(base)
    const fixed = join(base, 'browser-use', 'browser-fixture')
    const { ctx, root } = await load({ directory: fixed })
    const first = join(root, 'first'), second = join(root, 'second')
    await Promise.all([mkdir(first), mkdir(second)])
    for (const [id, cwd] of [['fixed-first', first], ['fixed-second', second]] as const) {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      await warm(ctx, agent)
    }
    const starts = (await events(root)).filter(event => event.event === 'start')
    expect(starts.length).toBeGreaterThan(0)
    expect(new Set(starts.map(event => event.cwd))).toEqual(new Set([await realpath(fixed)]))
  })

  it('tells each Session\'s server that Session\'s working directory as its one MCP root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'dsh-browser-mcp-roots-'))
    roots.push(base)
    const { ctx, root } = await load({ directory: join(base, 'fixed') })
    const first = join(root, 'first'), second = join(root, 'second')
    await Promise.all([mkdir(first), mkdir(second)])
    for (const [id, cwd] of [['roots-first', first], ['roots-second', second]] as const) {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      await warm(ctx, agent)
    }
    await vi.waitFor(async () => {
      expect((await events(root)).filter(event => event.event === 'roots')).toHaveLength(2)
    })
    const answered = (await events(root)).filter(event => event.event === 'roots').map(event => event.roots)
    expect(answered).toEqual(expect.arrayContaining([
      [{ uri: pathToFileURL(first).href, name: 'first' }],
      [{ uri: pathToFileURL(second).href, name: 'second' }],
    ]))
  })

  it('creates the output folder with a .gitignore of * when a Session\'s server starts, and adds one to an existing folder that has none', async () => {
    const { ctx, root } = await load({ outputFolder: '.fixture-output' })
    const fresh = join(root, 'fresh'), used = join(root, 'used')
    await Promise.all([mkdir(fresh), mkdir(join(used, '.fixture-output'), { recursive: true })])
    await writeFile(join(used, '.fixture-output', 'kept.png'), 'kept')
    for (const [id, cwd] of [['output-fresh', fresh], ['output-used', used]] as const) {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toContain(TOOL)
    }
    expect(await readdir(fresh)).toEqual(['.fixture-output'])
    expect(await readdir(join(fresh, '.fixture-output'))).toEqual(['.gitignore'])
    expect(await readFile(join(fresh, '.fixture-output', '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readdir(used)).toEqual(['.fixture-output'])
    expect((await readdir(join(used, '.fixture-output'))).sort()).toEqual(['.gitignore', 'kept.png'])
    expect(await readFile(join(used, '.fixture-output', '.gitignore'), 'utf8')).toBe('*\n')
    expect(await readFile(join(used, '.fixture-output', 'kept.png'), 'utf8')).toBe('kept')
  })

  it('gives each Session its own owner-only output folder under the output root, tells the server, and leaves the Session\'s folder without one', async () => {
    const offered: BrowserToolCall[] = []
    const { ctx, root } = await load({ outputFolder: '.fixture-output', outputRoot: join(tmpdir(), `dsh-output-root-${process.pid}`), refuseCall: async (call) => { offered.push(call); return undefined } })
    const outputRoot = join(tmpdir(), `dsh-output-root-${process.pid}`)
    roots.push(outputRoot)
    const [first, second] = [join(root, 'first'), join(root, 'second')]
    await Promise.all([mkdir(first), mkdir(second)])
    for (const [id, cwd] of [['output-one', first], ['output-two', second]] as const) {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      await warm(ctx, agent)
      expect((await visit(ctx, agent, id)).isError).toBe(false)
    }
    const folders = offered.map(call => call.outputDirectory!)
    expect(new Set(folders).size).toBe(2)
    for (const folder of folders) {
      expect(dirname(folder)).toBe(outputRoot)
      expect((await stat(folder)).mode & 0o777).toBe(0o700)
    }
    expect([...new Set((await events(root)).filter(event => event.event === 'start').map(event => String(event.outputDir)))].sort()).toEqual([...folders].sort())
    expect(await readdir(first)).toEqual([])
    expect(await readdir(second)).toEqual([])
  })

  it('leaves Browser off in a chat whose output folder overlaps a folder the chat can write: its working directory, or a root of its sandbox policy', async () => {
    const outputRoot = join(tmpdir(), `dsh-overlap-root-${process.pid}`)
    roots.push(outputRoot)
    const { ctx, root, warnings } = await load({ outputRoot })
    const start = async (id: string, cwd: string): Promise<void> => {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      expect(ctx.agents.get(agent.id)).toBe(agent)
      const assembled = await warm(ctx, agent)
      expect(assembled.tools.some(tool => tool.name === TOOL)).toBe(false)
      expect(assembled.sections.some(section => section.name === 'mcp:browser-fixture')).toBe(false)
      expect(await execute(ctx, agent, TOOL).then(result => result.isError, () => true)).toBe(true)
    }
    // XDG_CACHE_HOME pointing into the workspace: the output folder lies inside the working directory.
    await start('overlap-inside', tmpdir())
    expect(warnings.at(-1)).toContain('Browser is off in this chat: its output folder would sit inside a folder this chat can write')
    expect(warnings.at(-1)).toContain("Use a workspace that isn't your home folder.")
    const quiet = join(root, 'quiet')
    await mkdir(quiet)
    ctx.provide('sandboxPolicy')
    ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: quiet, additionalWritableRoots: [tmpdir()] }) } as never)
    await start('overlap-extra-root', quiet)
    // A chat in a subfolder, with the output folder elsewhere in the sandbox's workspace root.
    const sub = join(root, 'workspace-sub')
    await mkdir(sub)
    ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: tmpdir() }) } as never)
    await start('overlap-workspace-root', sub)
    expect(warnings).toHaveLength(3)
    expect(existsSync(join(root, 'events.ndjson'))).toBe(false)
  })

  it('names the remedy by the cause of the overlap: the workspace, an extra writable folder, or XDG_CACHE_HOME', async () => {
    const outputRoot = join(tmpdir(), `dsh-cause-root-${process.pid}`)
    roots.push(outputRoot)
    const { ctx, root, warnings } = await load({ outputRoot })
    const quiet = join(root, 'quiet')
    await mkdir(quiet)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('cause-workspace'), meta: { cwd: tmpdir() } })
    await warm(ctx, agent)
    expect(warnings.at(-1)).toContain("Use a workspace that isn't your home folder.")
    ctx.provide('sandboxPolicy')
    ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write', workspaceRoot: quiet, additionalWritableRoots: [tmpdir()] }) } as never)
    const extra = await ctx.agents.create({ sessionId: SessionId('cause-extra'), meta: { cwd: quiet } })
    await warm(ctx, extra.agent)
    expect(warnings.at(-1)).toContain(`${await realpath(tmpdir())} is an extra folder this chat can write`)
    vi.stubEnv('XDG_CACHE_HOME', tmpdir())
    try {
      const cache = await ctx.agents.create({ sessionId: SessionId('cause-cache'), meta: { cwd: quiet } })
      await warm(ctx, cache.agent)
    } finally {
      vi.unstubAllEnvs()
    }
    expect(warnings.at(-1)).toContain('XDG_CACHE_HOME points inside it; point XDG_CACHE_HOME somewhere this chat cannot write.')
    expect(warnings).toHaveLength(3)
  })

  it.each(['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP', 'EPERM', 'EIO', 'ENAMETOOLONG'])('leaves Browser off, and starts no server, when the file system cannot resolve the output folder (%s)', async (code) => {
    const outputRoot = join(tmpdir(), `dsh-check-root-${process.pid}`)
    roots.push(outputRoot)
    const { ctx, root, warnings } = await load({ outputRoot })
    realpathHook.fail = path => path.startsWith(outputRoot) ? Object.assign(new Error(`${code}: cannot resolve`), { code, syscall: 'realpath' }) : undefined
    const { agent } = await ctx.agents.create({ sessionId: SessionId('check-fails') })
    const assembled = await warm(ctx, agent)
    expect(assembled.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(assembled.sections.some(section => section.name === 'mcp:browser-fixture')).toBe(false)
    expect(await execute(ctx, agent, TOOL).then(result => result.isError, () => true)).toBe(true)
    expect(warnings).toEqual([expect.stringContaining('its output folder could not be checked')])
    expect(warnings[0]).toContain(`${code}: cannot resolve`)
    expect(existsSync(join(root, 'events.ndjson'))).toBe(false)
  })

  it('lets any other error of the check propagate, so the chat fails loudly instead of Browser going quietly off', async () => {
    const outputRoot = join(tmpdir(), `dsh-check-root-other-${process.pid}`)
    roots.push(outputRoot)
    const { ctx, warnings } = await load({ outputRoot })
    ctx.provide('sandboxPolicy')
    ctx.set('sandboxPolicy', { resolve: () => { throw new Error('policy unreadable') } } as never)
    await expect(ctx.agents.create({ sessionId: SessionId('check-throws') }).then(({ agent }) => warm(ctx, agent))).rejects.toThrow('policy unreadable')
    ctx.set('sandboxPolicy', undefined)
    realpathHook.fail = path => path.startsWith(outputRoot) ? new TypeError('disk on fire') : undefined
    await expect(ctx.agents.create({ sessionId: SessionId('check-eio') }).then(({ agent }) => warm(ctx, agent))).rejects.toThrow('disk on fire')
    expect(warnings).toEqual([])
  })

  it('checks the output folder again when the consent is accepted for a chat the folder check left without Browser, and keeps it off', async () => {
    const outputRoot = join(tmpdir(), `dsh-retry-root-${process.pid}`)
    roots.push(outputRoot)
    const { ctx, root, warnings } = await load({ consent: true, outputRoot })
    const consent = ctx.get('mcpAddConsent') as RefuseBrowserConsent
    consent.accepted = true
    const { agent } = await ctx.agents.create({ sessionId: SessionId('folder-then-consent'), meta: { cwd: tmpdir() } })
    expect((await warm(ctx, agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(warnings).toHaveLength(1)
    await ctx.parallel('mcp-client/consent-accepted', 'browser-fixture')
    expect(warnings).toHaveLength(2)
    expect((await warm(ctx, agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(existsSync(join(root, 'events.ndjson'))).toBe(false)
  })

  it('never writes through a link or over a person\'s own rules in the output folder', async () => {
    const { ctx, root, warnings } = await load({ outputFolder: '.fixture-output' })
    const elsewhere = join(root, 'elsewhere')
    await mkdir(elsewhere)
    const linked = join(root, 'linked'), ruled = join(root, 'ruled'), dangling = join(root, 'dangling'), file = join(root, 'file')
    await Promise.all([mkdir(linked), mkdir(join(ruled, '.fixture-output'), { recursive: true }), mkdir(join(dangling, '.fixture-output'), { recursive: true }), mkdir(file)])
    await symlink(elsewhere, join(linked, '.fixture-output'))
    await writeFile(join(ruled, '.fixture-output', '.gitignore'), '!keep.png\n')
    await symlink(join(elsewhere, 'written-through'), join(dangling, '.fixture-output', '.gitignore'))
    await writeFile(join(file, '.fixture-output'), 'a file, not a folder')
    for (const [id, cwd] of [['output-linked', linked], ['output-ruled', ruled], ['output-dangling', dangling], ['output-file', file]] as const) {
      const { agent } = await ctx.agents.create({ sessionId: SessionId(id), meta: { cwd } })
      expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toContain(TOOL)
    }
    expect(await readdir(elsewhere)).toEqual([])
    expect(await readFile(join(ruled, '.fixture-output', '.gitignore'), 'utf8')).toBe('!keep.png\n')
    expect(await readlink(join(dangling, '.fixture-output', '.gitignore'))).toBe(join(elsewhere, 'written-through'))
    expect(await readFile(join(file, '.fixture-output'), 'utf8')).toBe('a file, not a folder')
    expect(warnings).toEqual([])
  })

  it('creates no output folder for a Session whose server the add-time consent refuses', async () => {
    const { ctx, root } = await load({ consent: true, outputFolder: '.fixture-output' })
    const cwd = join(root, 'refused')
    await mkdir(cwd)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('output-refused'), meta: { cwd } })
    expect((await warm(ctx, agent)).tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(await readdir(cwd)).toEqual([])
  })

  it('keeps the browser tools and logs a warning when the output folder cannot be created', async () => {
    const { ctx, root, warnings } = await load({ outputFolder: join('absent', 'output') })
    const cwd = join(root, 'unwritable')
    await mkdir(cwd)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('output-failed'), meta: { cwd } })
    expect((await warm(ctx, agent)).tools.map(tool => tool.name)).toContain(TOOL)
    expect(await readdir(cwd)).toEqual([])
    expect(warnings).toEqual([expect.stringContaining('with a .gitignore in Session output-failed\'s folder, so Git may pick up files')])
    expect(warnings[0]).toMatch(/^browser-fixture: could not create absent[/\\]output .*ENOENT/u)
  })

  it('never offers a denied server tool to a Session or its model, and a call to it never reaches the server', async () => {
    const UNSAFE = 'mcp__browser-fixture__unsafe'
    const open = await load({ mode: 'unsafe-tool' })
    const offered = await open.ctx.agents.create({ sessionId: SessionId('undenied') })
    expect((await warm(open.ctx, offered.agent)).tools.map(tool => tool.name)).toContain(UNSAFE)

    const { ctx, root, model } = await load({ mode: 'unsafe-tool', deniedTools: ['unsafe'] })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('denied'), agentOptions: { provider: 'fixture', model: 'fixture' } })
    const assembled = await warm(ctx, agent)
    expect(assembled.tools.map(tool => tool.name)).toContain(TOOL)
    expect(assembled.tools.some(tool => tool.name === UNSAFE)).toBe(false)
    expect(ctx.tools.schemas(agent).some(tool => tool.name === UNSAFE)).toBe(false)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Use the browser.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const sent = model.requests.at(-1)?.tools?.map(tool => tool.name) ?? []
    expect(sent).toContain(TOOL)
    expect(sent).not.toContain(UNSAFE)
    const refused = await executeToolFixture(ctx, {
      agent, name: UNSAFE, arguments: {}, callId: ToolCallId('unsafe'), signal: new AbortController().signal,
    }).then(result => result.isError, () => true)
    expect(refused).toBe(true)
    expect((await visit(ctx, agent, 'allowed')).isError).toBe(false)
    const reached = (await events(root)).filter(event => event.event === 'call').map(event => event.name)
    expect(reached).toContain('visit')
    expect(reached).not.toContain('unsafe')
  })

  it('fails a call the provider refuses without sending it to the server, and sends every other call', async () => {
    const offered: BrowserToolCall[] = []
    const { ctx, root } = await load({ refuseCall: async (call) => {
      offered.push(call)
      return (call.arguments as { label: string }).label === 'refused' ? 'This call is refused.' : undefined
    } })
    const cwd = join(root, 'guarded')
    await mkdir(cwd)
    const { agent } = await ctx.agents.create({ sessionId: SessionId('guarded'), meta: { cwd } })
    await warm(ctx, agent)
    const call = (label: string) => visit(ctx, agent, label)
    const refused = await call('refused')
    expect(refused).toMatchObject({ isError: true, error: { message: 'This call is refused.' }, content: [{ type: 'text', text: 'Error: This call is refused.' }] })
    expect((await events(root)).filter(event => event.event === 'call')).toEqual([])
    expect((await call('allowed')).isError).toBe(false)
    expect((await events(root)).filter(event => event.event === 'call')).toHaveLength(1)
    expect(offered).toEqual([
      { tool: 'visit', arguments: { label: 'refused' }, directory: cwd },
      { tool: 'visit', arguments: { label: 'allowed' }, directory: cwd },
    ])
  })

  it('lets the provider replace a call\'s arguments before the server sees them, or refuse the call', async () => {
    const { ctx, root } = await load({ prepareCall: async (call) => {
      const label = (call.arguments as { label: string }).label
      if (label === 'throws') throw new Error('copy failed')
      return label === 'refused' ? 'Not readable.' : label === 'copy' ? { arguments: { label: 'copied' }, note: 'Uploaded a copy.' } : undefined
    } })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('prepared') })
    await warm(ctx, agent)
    expect(await visit(ctx, agent, 'refused')).toMatchObject({ isError: true, error: { message: 'Not readable.' } })
    const copied = await visit(ctx, agent, 'copy')
    expect(copied.isError).toBe(false)
    expect(copied.content.at(-1)).toMatchObject({ type: 'text', text: 'Uploaded a copy.' })
    expect((await visit(ctx, agent, 'throws')).isError).toBe(true)
    expect((await visit(ctx, agent, 'same')).isError).toBe(false)
    expect((await events(root)).filter(event => event.event === 'call').map(event => (event.arguments as { label: string }).label)).toEqual(['copied', 'same'])
  })

  it('replaces a call\'s result with the provider\'s refusal after the server answered, and keeps it otherwise', async () => {
    const checked: Array<[BrowserToolCall, boolean]> = []
    const { ctx, root } = await load({ checkResult: async (call, startedAt) => {
      checked.push([call, startedAt <= Date.now()])
      return (call.arguments as { label: string }).label === 'landed-outside' ? 'The file landed outside.' : undefined
    } })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('checked') })
    await warm(ctx, agent)
    expect(await visit(ctx, agent, 'landed-outside')).toMatchObject({ isError: true, error: { message: 'The file landed outside.' } })
    expect((await visit(ctx, agent, 'fine')).isError).toBe(false)
    expect((await events(root)).filter(event => event.event === 'call')).toHaveLength(2)
    expect(checked.map(([call, timed]) => [(call.arguments as { label: string }).label, timed])).toEqual([['landed-outside', true], ['fine', true]])
  })

  it('replaces a browser failure the provider explains and keeps every other failure and result', async () => {
    const explainFailure = (message: string) => message.includes('is not installed') ? 'Browser needs setup; ask the person.' : undefined
    const { ctx } = await load({ explainFailure })
    const { agent } = await ctx.agents.create({ sessionId: SessionId('explained') })
    await warm(ctx, agent)
    const call = (label: string) => visit(ctx, agent, label)
    const missing = await call('missing-browser')
    expect(missing.isError).toBe(true)
    expect(missing.content).toEqual([{ type: 'text', text: 'Error: Browser needs setup; ask the person.' }])
    expect(missing.error?.message).toBe('Browser needs setup; ask the person.')
    expect((await call('page')).content).toEqual([{ type: 'text', text: 'Visit 2: page' }])
    const unexplained = await load()
    const other = await unexplained.ctx.agents.create({ sessionId: SessionId('unexplained') })
    await warm(unexplained.ctx, other.agent)
    const raw = await executeToolFixture(unexplained.ctx, {
      agent: other.agent, name: TOOL, arguments: { label: 'missing-browser' }, callId: ToolCallId('raw'), signal: new AbortController().signal,
    })
    expect(raw.isError).toBe(true)
    expect(JSON.stringify(raw.content)).toContain('is not installed; expected executable at')
  })

  it('does not reconnect and silently replace browser state after a process exits', async () => {
    const { ctx, root } = await load()
    const owner = await ctx.agents.create({ sessionId: SessionId('disconnect') })
    await warm(ctx, owner.agent)
    const servingPid = (await events(root)).find(event => event.event === 'initialize')!.pid
    await execute(ctx, owner.agent, 'mcp__browser-fixture__disconnect')
    let exitError: unknown
    await expect.poll(() => {
      try { process.kill(servingPid, 0) } catch (error) {
        exitError = error
        return true
      }
      return false
    }).toBe(true)
    expect(exitError).toEqual(expect.objectContaining({ code: 'ESRCH' }))
    await warm(ctx, owner.agent)
    expect((await events(root)).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect((await execute(ctx, owner.agent)).isError).toBe(true)
  })

  it('keeps browser ownership exact when scopes inherit tools and leaves unrelated tools usable', async () => {
    const { ctx } = await load()
    await ctx.systemPrompt.assemble()
    const owner = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'),
      setup: (_inner, agent) => { bindScopeParent(agent, owner.agent) },
    })
    await warm(ctx, owner.agent)
    registerIndependentTool(ctx)
    expect((await execute(ctx, owner.agent, 'unrelated')).content).toEqual([{ type: 'text', text: 'Independent.' }])
    await warm(ctx, child.agent)
    expect((await execute(ctx, child.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
  })

  it('denies inherited browser resources and instructions while keeping unrelated MCP servers usable', async () => {
    const { ctx, root } = await load({ exclusive: true })
    await ctx.plugin(McpResources)
    ctx.mcpResources.register('docs', { request: async () => ({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] }) })
    const parent = await ctx.agents.create({ sessionId: SessionId('resource-parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('resource-child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    expect(renderPrompt(await warm(ctx, parent.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    const blocked = await warm(ctx, child.agent)
    expect(blocked.tools.some(tool => tool.name === TOOL)).toBe(false)
    expect(renderPrompt(blocked)).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(renderPrompt(blocked)).toContain('browser-fixture')
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect((await resource(ctx, child.agent, name)).isError).toBe(true)
    }
    expect((await resource(ctx, undefined)).isError).toBe(true)
    expect((await events(root)).filter(event => event.event === 'resource')).toEqual([])
    expect((await resource(ctx, child.agent, 'read_mcp_resource', 'docs')).value)
      .toEqual({ contents: [{ uri: 'docs://memo', text: 'Independent document.' }] })
    for (const args of [null, 'invalid arguments']) {
      expect((await executeToolFixture(ctx, { agent: child.agent, name: 'read_mcp_resource', arguments: args, callId: ToolCallId('invalid-resource'), signal: new AbortController().signal })).isError).toBe(true)
    }
    expect(browserState(await resource(ctx, parent.agent)).counter).toBe(0)
    await parent.dispose()
    expect(renderPrompt(await warm(ctx, child.agent))).not.toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect((await resource(ctx, child.agent)).isError).toBe(true)
    const successor = await ctx.agents.create({ sessionId: SessionId('resource-successor') })
    expect(renderPrompt(await warm(ctx, successor.agent))).toContain('BROWSER_FIXTURE_INSTRUCTION')
    expect(browserState(await resource(ctx, successor.agent)).counter).toBe(0)
  })

  it('uses the child connection for resources and serializes them with browser tools exactly once', async () => {
    const { ctx } = await load()
    await ctx.plugin(McpResources)
    const parent = await ctx.agents.create({ sessionId: SessionId('parent') })
    const child = await ctx.agents.create({
      sessionId: SessionId('child'),
      setup: (_inner, agent) => { bindScopeParent(agent, parent.agent) },
    })
    await warm(ctx, parent.agent)
    await execute(ctx, parent.agent)
    await warm(ctx, child.agent)
    const parentOnly = vi.fn(async () => true)
    parent.agent.ctx.tools.register({
      name: 'mcp__browser-fixture__parent_only', description: 'A browser operation available only in the parent.', parameters: { type: 'object' },
      output: { schema: { type: 'boolean' }, render: () => [] }, execute: parentOnly,
    })
    expect((await execute(ctx, child.agent, 'mcp__browser-fixture__parent_only')).isError).toBe(true)
    expect(parentOnly).not.toHaveBeenCalled()
    const parentState = browserState(await resource(ctx, parent.agent))
    const childState = browserState(await resource(ctx, child.agent))
    expect(parentState.counter).toBe(1)
    expect(childState.counter).toBe(0)
    expect(childState.pid).not.toBe(parentState.pid)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const started: string[] = []
    const stop = ctx.on('tools/execute', async (exec, next) => {
      if (exec.agent === child.agent) {
        started.push(exec.name)
        if (exec.callId === ToolCallId('held-resource')) {
          entered.resolve(undefined)
          await release.promise
        }
      }
      return next()
    })
    try {
      const reading = resource(ctx, child.agent, 'read_mcp_resource', 'browser-fixture', 'held-resource')
      await entered.promise
      const visiting = execute(ctx, child.agent)
      expect((await execute(ctx, parent.agent)).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource'])
      release.resolve(undefined)
      expect(browserState(await reading).counter).toBe(0)
      expect((await visiting).isError).toBe(false)
      expect(started).toEqual(['read_mcp_resource', TOOL])
      expect(browserState(await resource(ctx, child.agent)).counter).toBe(1)
    } finally {
      release.resolve(undefined)
      stop()
    }
  })

  it('holds an immediate PTC turn until the first SDK includes browser tools', async () => {
    const { ctx, root, model } = await load({ mode: 'gate', toolOrder: ['run_code', '<unlisted-tools>'] })
    await ctx.plugin(PresentationRuntime)
    let created = false
    let initializing!: Agent
    const creation = observeActivation(ctx.agents.create({
      sessionId: SessionId('ptc-first-request'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.plugin(PtcToolExecutor)
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Describe the available browser tools.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }).then((handle) => {
      created = true
      return handle
    }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    expect(created).toBe(false)
    expect(model.requests).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    await writeFile(join(root, 'release'), '')
    const owner = await creation
    await owner.agent.whenIdle()
    expect(model.requests).toHaveLength(1)
    expect(model.requests[0]?.tools?.map(tool => tool.name)).toEqual(['run_code'])
    expect(JSON.stringify(model.requests[0]?.messages)).toContain(TOOL)
  })

  it('cancels creation during discovery, closes its process, and releases the attachment', async () => {
    const { ctx, root, model } = await load({ exclusive: true, mode: 'gate' })
    const controller = new AbortController()
    let initializing!: Agent
    const creation = observeActivation(ctx.agents.create({
      sessionId: SessionId('canceled-startup'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }))
    await expect.poll(async () => (await events(root)).some(event => event.event === 'probe')).toBe(true)
    controller.abort(new Error('cancel browser startup'))
    await expect(creation).rejects.toThrow('cancel browser startup')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
    await writeFile(join(root, 'release'), '')
    const successor = await ctx.agents.create({ sessionId: initializing.id })
    expect((await execute(ctx, successor.agent)).isError).toBe(false)
  })

  it('closes the discovered client when a later creation listener rejects', async () => {
    const { ctx, root, model } = await load({ toolOrder: [TOOL, '<unlisted-tools>'] })
    let initializing!: Agent
    await expect(ctx.agents.create({
      sessionId: SessionId('later-listener-failure'), agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        initializing = agent
        inner.on('agent/created', () => {
          expect(ctx.tools.schemas(agent).some(tool => tool.name === TOOL)).toBe(true)
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
          throw new Error('later initialization failed')
        })
      },
    })).rejects.toThrow('later initialization failed')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(initializing.id)).toBeUndefined()
    expect(ctx.sessions.get(initializing.id)).toBeUndefined()
    expect(ctx.tools.schemas(initializing)).toEqual([])
    expect((await execute(ctx, initializing)).isError).toBe(true)
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }
  })

  it('cancels before browser discovery without starting a process', async () => {
    const { ctx, root, model } = await load({ mode: 'gate' })
    const controller = new AbortController()
    await expect(ctx.agents.create({
      sessionId: SessionId('canceled-at-creation'), signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner) => {
        inner.on('agent/created', () => { controller.abort(new Error('cancel before discovery')) }, { prepend: true })
      },
    })).rejects.toThrow('cancel before discovery')
    expect(model.requests).toEqual([])
    expect(ctx.agents.get(SessionId('canceled-at-creation'))).toBeUndefined()
    await expect(readFile(join(root, 'events.ndjson'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('retains a live server directory and starts the resumed server in the current Session directory', async () => {
    const { ctx, root } = await load()
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await mkdir(join(root, 'original'))
    await mkdir(join(root, 'selected'))
    const original = await realpath(join(root, 'original'))
    const selected = await realpath(join(root, 'selected'))
    const sessionId = SessionId('browser-directory')
    const first = await ctx.agents.create({ sessionId, meta: { cwd: original } })
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const initial = await events(root)
    const firstCall = initial.findLast(event => event.event === 'call')
    expect(firstCall).toMatchObject({ cwd: original })
    const starts = initial.filter(event => event.event === 'start').length

    await ctx.workingDirectory.set(first.agent, selected)
    expect(first.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, first.agent)).isError).toBe(false)
    const changed = await events(root)
    expect(changed.findLast(event => event.event === 'call')).toMatchObject({ cwd: original, pid: firstCall?.pid })
    expect(changed.filter(event => event.event === 'start')).toHaveLength(starts)
    await first.dispose()

    const resumed = await ctx.agents.resume({ resumeSessionId: sessionId })
    expect(resumed.agent.session.header.cwd).toBe(original)
    expect((await execute(ctx, resumed.agent)).isError).toBe(false)
    const reopened = await events(root)
    expect(reopened.findLast(event => event.event === 'call')).toMatchObject({ cwd: selected })
    expect(reopened.filter(event => event.event === 'start').length).toBeGreaterThan(starts)
    await resumed.dispose()
  })

  it('awaits discovery on persisted resume and releases a canceled resume before retry', async () => {
    const { ctx, root, model } = await load({ exclusive: true, mode: 'gate' })
    await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    await writeFile(join(root, 'release'), '')
    const sessionId = SessionId('persisted-browser')
    const first = await ctx.agents.create({ sessionId, agentOptions: { provider: 'fixture', model: 'fixture' } })
    first.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit the fixture.' }], source: { kind: 'user' } }))
    await first.agent.whenIdle()
    expect(model.requests).toHaveLength(2)
    await first.dispose()
    await rm(join(root, 'release'))

    const controller = new AbortController()
    const canceledResume = observeActivation(ctx.agents.resume({
      resumeSessionId: sessionId, signal: controller.signal,
      agentOptions: { provider: 'fixture', model: 'fixture' },
      setup: (inner, agent) => {
        inner.on('agent/created', () => {
          agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Visit again.' }], source: { kind: 'user' } }))
        }, { prepend: true })
      },
    }))
    await expect.poll(async () => (await events(root)).filter(event => event.event === 'probe')).toHaveLength(2)
    expect(model.requests).toHaveLength(2)
    controller.abort(new Error('cancel browser resume'))
    await expect(canceledResume).rejects.toThrow('cancel browser resume')
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
    for (const { pid } of (await events(root)).filter(event => event.event === 'start')) {
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    }

    let resumed = false
    const resuming = observeActivation(ctx.agents.resume({ resumeSessionId: sessionId }).then((handle) => {
      resumed = true
      return handle
    }))
    await expect.poll(async () => (await events(root)).filter(event => event.event === 'probe')).toHaveLength(3)
    expect(resumed).toBe(false)
    expect(model.requests).toHaveLength(2)
    await writeFile(join(root, 'release'), '')
    const owner = await resuming
    expect(ctx.tools.schemas(owner.agent).some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, owner.agent)).content).toEqual([{ type: 'text', text: 'Visit 1: direct' }])
    await owner.dispose()
  })

  it('initializes only future activations after provider reload', async () => {
    const { ctx, root, browser } = await load()
    await browser.dispose()
    const existing = await ctx.agents.create({ sessionId: SessionId('existing') })
    await ctx.plugin({
      inject: ['browserUse', 'agents', 'tools', 'systemPrompt', 'workingDirectory'],
      apply(inner: Context) {
        mountSessionMcp(inner, { name: 'browser-fixture', exclusive: false, command: process.execPath, args: [fixture, root] })
      },
    })
    expect((await warm(ctx, existing.agent)).tools).toEqual([])
    const future = await ctx.agents.create({ sessionId: SessionId('future') })
    expect((await warm(ctx, future.agent)).tools.some(tool => tool.name === TOOL)).toBe(true)
    expect((await execute(ctx, existing.agent)).isError).toBe(true)
    expect((await execute(ctx, future.agent)).isError).toBe(false)
  })
})
