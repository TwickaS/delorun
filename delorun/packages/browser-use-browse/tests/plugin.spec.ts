/**
 * Specs of the whole `browser-use-browse` row through the real agent loop, approval service and session MCP mount, with
 * a stand-in browse server: no grant starts no server, Allow starts it for that chat before the model's next step, and
 * turning the grant off stops it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type { McpConsentDecision, McpServerCommand } from '@deepseek-ai/dsh-mcp-client'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService, { type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MockAdapter, textResponse, toolCallResponse } from '../../../../packages/core/agent-loop/tests/mock-adapter.ts'
import * as BrowseDriver from '../src/index.ts'
import { Config } from '../src/config.ts'
import { browseWaitingAnswer } from '../src/copy.ts'

/** A consent that accepts every start and keeps what each start asked for. */
class RecordingConsent extends McpClient.McpAddConsent {
  static readonly providesMcpAddConsent = true
  readonly reviewed: McpServerCommand[] = []
  review(command: McpServerCommand): Promise<McpConsentDecision> {
    this.reviewed.push(command)
    return Promise.resolve({ allow: true })
  }
}

const fixture = fileURLToPath(new URL('./fixtures/browse-fixture.mjs', import.meta.url))
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** The fixture's records: one `initialize` per started server, one `call` per tool call it answered. */
function events(root: string): { event: string, pid: number, name?: string }[] {
  try {
    return readFileSync(join(root, 'events.ndjson'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string, pid: number, name?: string })
  } catch (error) {
    // No file yet means the fixture never started.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/**
 * The loop, the approval service with a scripted answer, and the row running the stand-in server.
 * @param adapter - the scripted model.
 * @param answer - the person's answer.
 * @param server - the stand-in server's script.
 * @param consent - whether a consent that records each start is mounted.
 */
async function harness(adapter: MockAdapter, answer: () => ApprovalOutcome, server = fixture, consent = false) {
  const root = mkdtempSync(join(tmpdir(), 'realb-plugin-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
  await ctx.plugin(BrowserUse)
  await ctx.plugin(ApprovalService, { policy: 'ask' })
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.on('approval/request', () => Promise.resolve(answer()))
  if (consent) await ctx.plugin(RecordingConsent)
  await ctx.plugin(BrowseDriver, Config({ command: process.execPath, args: [server, root] }))
  return { ctx, root }
}

/** Run one prompt of the person's to idle. */
async function run(ctx: Context, agent: Agent, text: string): Promise<void> {
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await idle
}

const ASK = toolCallResponse('ask', 'use_my_browser', { reason: 'read the order page' })
const EXECUTE = toolCallResponse('run', 'mcp__browse__execute', { code: 'return await page.title()' })

describe('the browse row', () => {
  it('starts no server without a grant, starts it for the granted chat alone before the next step, and stops it when the grant ends', async () => {
    const { ctx, root } = await harness(new MockAdapter([ASK, EXECUTE, textResponse('done')]), () => 'allowed-once')
    const other = await ctx.agentLoop.create(SessionId('other'), { provider: 'mock', model: 'mock' }, { cwd: root })
    const chat = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { cwd: root })
    // Pins the admission: no chat holds a grant, so no browse server starts and the slot stays the isolated browser's.
    expect(events(root).filter(event => event.event === 'initialize')).toEqual([])
    expect(ctx.browserUse.providerName).toBeUndefined()
    await run(ctx, chat, 'check my order')
    expect(events(root).filter(event => event.event === 'initialize')).toHaveLength(1)
    expect(events(root).filter(event => event.event === 'call')).toEqual([expect.objectContaining({ name: 'execute' })])
    const log = chat.session.snapshotEvents()
    expect(JSON.stringify(log.filter(event => event.type === 'tool/result').at(-1))).toContain('Example Domain')
    expect(ctx.tools.schemas(other).some(tool => tool.name.startsWith('mcp__browse__'))).toBe(false)
    // Turning it off stops the chat's server and takes its tools away.
    const [started] = events(root).filter(event => event.event === 'initialize')
    expect(ctx.realBrowser.end(chat.session)).toBe(true)
    await ctx.realBrowser.settled(chat.session)
    expect(() => process.kill(started!.pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(ctx.tools.schemas(chat).some(tool => tool.name.startsWith('mcp__browse__'))).toBe(false)
  })

  it('tells the model when browse offers no tools after Allow, instead of naming tools it does not have', async () => {
    const { ctx, root } = await harness(new MockAdapter([ASK, textResponse('ok')]), () => 'allowed-once', join(tmpdir(), 'realb-no-such-server.mjs'))
    const chat = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await run(ctx, chat, 'check my order')
    expect(ctx.realBrowser.live(chat.session)).toBe(true)
    const answer = JSON.stringify(chat.session.snapshotEvents().filter(event => event.type === 'tool/result').at(0))
    expect(answer).toContain(JSON.stringify(browseWaitingAnswer('read the order page')).slice(1, -1))
    expect(ctx.tools.schemas(chat).some(tool => tool.name.startsWith('mcp__browse__'))).toBe(false)
  })

  it('starts browse the same way for every chat, so one acceptance of the start covers them all', async () => {
    const { ctx, root } = await harness(new MockAdapter([ASK, textResponse('one'), ASK, textResponse('two')]), () => 'allowed-once', fixture, true)
    const first = await ctx.agentLoop.create(SessionId('first'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await run(ctx, first, 'check my order')
    // The second chat works in another folder, and the Host's environment changed in between.
    vi.stubEnv('OPENCODE_BROWSER_ALLOW_ALL_COOKIES', '1')
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    const second = await ctx.agentLoop.create(SessionId('second'), { provider: 'mock', model: 'mock' }, { cwd: elsewhere })
    await run(ctx, second, 'check my order')
    vi.unstubAllEnvs()
    const reviewed = (ctx.get('mcpAddConsent') as RecordingConsent).reviewed.filter(command => command.serverName === 'browse')
    expect(reviewed).toHaveLength(2)
    const [one, two] = reviewed.map(({ command, args, cwd, env }) => ({ command, args, cwd, env }))
    expect(two).toEqual(one)
    // Pins the fixed folder: browse runs in the Harness home's browser-use/browse folder, never in a chat's folder.
    expect(one?.cwd.endsWith(join('browser-use', 'browse'))).toBe(true)
    expect([root, elsewhere]).not.toContain(one?.cwd)
    // Pins the blanking of a variable set after load: the client reads the Host's environment at each start.
    expect(one?.env['OPENCODE_BROWSER_ALLOW_ALL_COOKIES']).toBe('')
  })

  it('records no grant and starts no server on "Not now"', async () => {
    const { ctx, root } = await harness(new MockAdapter([ASK, textResponse('ok')]), () => 'rejected')
    const chat = await ctx.agentLoop.create(SessionId('chat'), { provider: 'mock', model: 'mock' }, { cwd: root })
    await run(ctx, chat, 'check my order')
    expect(chat.session.snapshotEvents().some(event => event.type === 'real-browser/granted')).toBe(false)
    expect(events(root)).toEqual([])
  })
})
