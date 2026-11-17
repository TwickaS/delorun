import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCodeDriver } from '../src/driver.ts'
import type { JsonValue, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramHarnessTool, ProgramOpenRequest, ProgramSession, ProgramSpawn, SessionId } from '@delorun/external-agents/contract'
import { loadClaudeSdk, TESTED_SDK_VERSION } from '../src/sdk.ts'
import { locateSdk } from './locate-sdk.ts'
import { startMessagesFixture, type MessagesFixture, type MessagesStep } from './messages-fixture.ts'

const roots: string[] = []
const contexts: Context[] = []
const fixtures: MessagesFixture[] = []
const ambient = { model: process.env.ANTHROPIC_MODEL, small: process.env.ANTHROPIC_SMALL_FAST_MODEL }

beforeAll(() => {
  // An ambient model setting would reach the program and override the fixture's settings.
  delete process.env.ANTHROPIC_MODEL
  delete process.env.ANTHROPIC_SMALL_FAST_MODEL
})

afterAll(() => {
  if (ambient.model !== undefined) process.env.ANTHROPIC_MODEL = ambient.model
  if (ambient.small !== undefined) process.env.ANTHROPIC_SMALL_FAST_MODEL = ambient.small
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

interface Harness {
  readonly driver: ClaudeCodeDriver
  readonly fixture: MessagesFixture
  readonly task: string
  readonly handles: SubprocessHandle[]
  readonly argvs: string[][]
  readonly spawn: ProgramSpawn
  /** The scratch home holding the Claude Code configuration folder, outside the task folder. */
  readonly root: string
}

/** A scratch Claude Code home and task folder, a Messages fixture, and the gate's spawn over the harness's subprocess owner. */
async function harness(script: readonly MessagesStep[], signedIn = true, toolWaitMs = 900_000): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'ea1-claude-real-'))
  roots.push(root)
  const task = join(root, 'task')
  const config = join(root, 'claude-config')
  mkdirSync(task)
  mkdirSync(config)
  mkdirSync(join(root, 'xdg'))
  writeFileSync(join(config, 'settings.json'), `${JSON.stringify({ model: 'fixture-model', permissions: { defaultMode: 'default' } })}\n`)
  const fixture = await startMessagesFixture(script)
  fixtures.push(fixture)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const handles: SubprocessHandle[] = []
  const argvs: string[][] = []
  const spawn: ProgramSpawn = (request) => {
    argvs.push([...request.argv])
    const handle = ctx.subprocess.spawn({ argv: request.argv, env: request.env, stdio: request.stdio, cwd: task, graceMs: 3000 })
    handles.push(handle)
    return handle
  }
  const driver = new ClaudeCodeDriver({
    sdk: () => loadClaudeSdk(locateSdk()),
    harnessToolTimeoutMs: () => toolWaitMs, level: () => 'standard',
    env: {
      ...signedIn ? { ANTHROPIC_API_KEY: 'ea1-fake-key' } : {},
      ANTHROPIC_BASE_URL: fixture.baseUrl,
      CLAUDE_CONFIG_DIR: config,
      HOME: root,
      XDG_CONFIG_HOME: join(root, 'xdg'),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
      DISABLE_TELEMETRY: '1',
      DISABLE_ERROR_REPORTING: '1',
      HTTP_PROXY: '',
      HTTPS_PROXY: '',
      ALL_PROXY: '',
      NO_PROXY: '127.0.0.1,localhost',
    },
  })
  return { driver, fixture, task, handles, argvs, spawn, root }
}

function openRequest(h: Harness, extra: Partial<ProgramOpenRequest> = {}): ProgramOpenRequest {
  return {
    sessionId: 'child-1' as SessionId, cwd: h.task, runRules: [], harnessTools: [], sharesFolder: () => false, spawn: h.spawn,
    onApproval: () => Promise.resolve('reject'), onLimits: () => {}, signal: new AbortController().signal, ...extra,
  }
}

async function turn(session: ProgramSession): Promise<ProgramEvent[]> {
  const signal = AbortSignal.timeout(45_000)
  const events: ProgramEvent[] = []
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    if (event.kind === 'turn-end') return events
  }
}

async function quiescent(h: Harness): Promise<void> {
  expect(h.handles.length).toBeGreaterThan(0)
  for (const handle of h.handles) await expect(handle.waitForExit()).resolves.toBe(true)
}

function answering(answers: ProgramApprovalAnswer[], asked: ProgramApprovalRequest[]) {
  return (request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer> => {
    asked.push(request)
    return Promise.resolve(answers.shift() ?? 'reject')
  }
}

/** Every file under the scratch home outside the task folder, by relative path, with its SHA-256. */
function homeFiles(h: Harness): Map<string, string> {
  const files = new Map<string, string>()
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (path === h.task) continue
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files.set(relative(h.root, path), createHash('sha256').update(readFileSync(path)).digest('hex'))
    }
  }
  walk(h.root)
  return files
}

describe(`the real Claude Agent SDK ${TESTED_SDK_VERSION} and its pinned Claude Code`, { timeout: 60_000 }, () => {
  it('is the tested version', () => {
    expect(locateSdk().version).toBe(TESTED_SDK_VERSION)
  })

  it('runs a turn through the gate\'s spawn under the watcher and leaves no process after close', async () => {
    const h = await harness([{ text: 'EA1_SENTINEL' }])
    const session = await h.driver.open(openRequest(h))
    await session.send('Say the sentinel.', 'start')
    const events = await turn(session)
    expect(events.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'EA1_SENTINEL' }])
    expect(events.at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'completed' })
    expect(events.some(event => event.kind === 'message-end')).toBe(true)
    if (process.platform !== 'win32') expect(h.argvs[0]?.[1]).toMatch(/watcher\.mjs$/)
    expect(h.fixture.mainRequests).toHaveLength(1)
    expect(JSON.stringify(h.fixture.mainRequests[0])).toContain('Say the sentinel.')
    await session.close()
    await quiescent(h)
  })

  it('relays a question, allows the command for this run, and re-applies that rule after a resume', async () => {
    const h = await harness([
      { tool: 'Bash', input: { command: 'touch a.txt', description: 'Make a file' } },
      { text: 'made' },
      { tool: 'Bash', input: { command: 'touch a.txt', description: 'Make a file' } },
      { text: 'made again' },
    ])
    const asked: ProgramApprovalRequest[] = []
    const first = await h.driver.open(openRequest(h, { onApproval: answering(['allow-run'], asked) }))
    await first.send('Make a.txt.', 'start')
    const events = await turn(first)
    expect(events.map(event => event.kind)).toEqual(['tool-call', 'message-end', 'tool-result', 'text', 'message-end', 'turn-end'])
    expect(asked).toHaveLength(1)
    const rule = asked[0]?.runRule
    expect(rule).toMatchObject({ provider: 'claude-code', summary: 'Bash(touch a.txt)' })
    expect(existsSync(join(h.task, 'a.txt'))).toBe(true)
    await first.close()
    expect(existsSync(join(h.task, '.claude'))).toBe(false)

    const resumed = await h.driver.open(openRequest(h, { resume: first.programSessionId, runRules: rule === undefined ? [] : [rule], onApproval: answering([], asked) }))
    await resumed.send('Make a.txt again.', 'start')
    expect((await turn(resumed)).at(-1)).toMatchObject({ outcome: 'completed' })
    expect(asked).toHaveLength(1)
    expect(resumed.programSessionId).toBe(first.programSessionId)
    await resumed.close()
    await quiescent(h)
  })

  it('does not run a rejected command, and the turn goes on', async () => {
    const h = await harness([{ tool: 'Bash', input: { command: 'touch rejected.txt', description: 'Make a file' } }, { text: 'not made' }])
    const asked: ProgramApprovalRequest[] = []
    const session = await h.driver.open(openRequest(h, { onApproval: answering(['reject'], asked) }))
    await session.send('Make rejected.txt.', 'start')
    const events = await turn(session)
    expect(asked).toHaveLength(1)
    expect(events.find(event => event.kind === 'tool-result')).toMatchObject({ isError: true })
    expect(events.at(-1)).toMatchObject({ outcome: 'completed' })
    expect(existsSync(join(h.task, 'rejected.txt'))).toBe(false)
    await session.close()
    await quiescent(h)
  })

  it('interrupts a turn waiting on the model, then takes another turn on the same process', async () => {
    const h = await harness([{ hold: true }, { text: 'after the interrupt' }])
    const session = await h.driver.open(openRequest(h))
    const requested = h.fixture.nextRequest()
    await session.send('Take your time.', 'start')
    await requested
    await session.interrupt()
    expect((await turn(session)).at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'interrupted' })
    await session.send('Now answer.', 'start')
    const second = await turn(session)
    expect(second.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'after the interrupt' }])
    expect(h.handles).toHaveLength(1)
    await session.close()
    await quiescent(h)
  })

  it('steers the running turn with priority next: the program takes the message at its next tool boundary', async () => {
    const h = await harness([{ tool: 'Bash', input: { command: 'sleep 3', description: 'Wait' } }, { text: 'steered' }])
    const session = await h.driver.open(openRequest(h, { onApproval: () => Promise.resolve('allow-once') }))
    await session.send('Wait three seconds.', 'start')
    const signal = AbortSignal.timeout(45_000)
    const events: ProgramEvent[] = []
    for (;;) {
      const event = await session.next(signal)
      events.push(event)
      // The steer goes in while the command runs, as a person's message would.
      if (event.kind === 'tool-call') await new Promise(resolve => setTimeout(resolve, 1000)).then(() => session.send('Also say banana.', 'steer'))
      if (event.kind === 'turn-end') break
    }
    expect(events.at(-1)).toMatchObject({ outcome: 'completed' })
    expect(events.filter(event => event.kind === 'text')).toEqual([{ kind: 'text', text: 'steered' }])
    expect(h.fixture.mainRequests).toHaveLength(2)
    expect(JSON.stringify(h.fixture.mainRequests[1])).toContain('Also say banana.')
    await session.close()
    await quiescent(h)
  })

  it('reports resume-failed for a program session that does not exist', async () => {
    const h = await harness([{ text: 'never' }])
    const session = await h.driver.open(openRequest(h, { resume: '7d4b3a8e-0000-4000-8000-000000000000' }))
    await session.send('Hello again.', 'start')
    expect((await turn(session)).at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'failed', failure: { category: 'resume-failed' } })
    expect(h.fixture.mainRequests).toHaveLength(0)
    await session.close()
    await quiescent(h)
  })

  it('checks limits with no message and none of the person\'s settings, and leaves no process', async () => {
    const h = await harness([])
    const observation = await h.driver.probe({ spawn: h.spawn, cwd: h.task, signal: AbortSignal.timeout(45_000) })
    expect(observation).toEqual({ provider: 'claude-code', signedIn: 'yes', windows: [], source: 'probe' })
    expect(JSON.stringify(observation)).not.toContain('ea1-fake-key')
    expect(h.fixture.mainRequests).toHaveLength(0)
    await quiescent(h)
  })

  it('reports a program with no sign-in as signed out', async () => {
    const h = await harness([], false)
    const observation = await h.driver.probe({ spawn: h.spawn, cwd: h.task, signal: AbortSignal.timeout(45_000) })
    expect(observation).toMatchObject({ provider: 'claude-code', signedIn: 'no', windows: [] })
    await quiescent(h)
  })

  it('leaves the person\'s Claude Code settings byte-identical and records no trust or rule for the run folder', async () => {
    const h = await harness([
      { tool: 'Bash', input: { command: 'touch a.txt', description: 'Make a file' } },
      { text: 'made' },
    ])
    const global = join(h.root, 'claude-config', '.claude.json')
    const elsewhere = { allowedTools: ['Bash(ls)'], hasTrustDialogAccepted: true }
    writeFileSync(global, `${JSON.stringify({ numStartups: 3, hasCompletedOnboarding: true, projects: { '/elsewhere': elsewhere } }, null, 2)}\n`)
    const before = homeFiles(h)
    const session = await h.driver.open(openRequest(h, { onApproval: answering(['allow-run'], []) }))
    await session.send('Make a.txt.', 'start')
    expect((await turn(session)).at(-1)).toMatchObject({ outcome: 'completed' })
    await session.close()
    await h.driver.probe({ spawn: h.spawn, cwd: h.task, signal: AbortSignal.timeout(30_000) })
    await quiescent(h)
    const after = homeFiles(h)
    expect(after.get('claude-config/settings.json')).toBe(before.get('claude-config/settings.json'))
    const changed = [...after.entries()].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => path)
    // Claude Code's own bookkeeping, a backup of it, and the session history are all it writes.
    for (const path of changed) expect(path).toMatch(/^claude-config\/(?:\.claude\.json|backups\/\.claude\.json\.backup\.\d+|projects\/[^/]+\/[\w-]+\.jsonl)$/)
    const config = JSON.parse(readFileSync(global, 'utf8')) as { projects?: Record<string, unknown> }
    expect(config.projects).toEqual({ '/elsewhere': elsewhere })
    expect(existsSync(join(h.task, '.claude'))).toBe(false)
  })

  it('offers harness tools over its own MCP server, runs a call without asking the seat, and returns the output', async () => {
    const h = await harness([{ toolEndingWith: '__echo', input: { text: 'hello' } }, { text: 'echoed' }])
    const asked: ProgramApprovalRequest[] = []
    const inputs: JsonValue[] = []
    const echo: ProgramHarnessTool = {
      name: 'echo', description: 'Echo the text back.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      call: (input) => { inputs.push(input); return Promise.resolve({ output: 'ECHO_RESULT', isError: false }) },
    }
    const session = await h.driver.open(openRequest(h, { harnessTools: [echo], onApproval: answering([], asked) }))
    await session.send('Echo hello.', 'start')
    const events = await turn(session)
    expect(events.find(event => event.kind === 'tool-call')).toMatchObject({ name: expect.stringMatching(/^mcp__delorun_[0-9a-f]{12}__echo$/) })
    expect(events.find(event => event.kind === 'tool-result')).toMatchObject({ output: 'ECHO_RESULT', isError: false })
    expect(inputs).toEqual([{ text: 'hello' }])
    expect(asked).toEqual([])
    await session.close()
    await quiescent(h)
  })

  it('aborts a harness tool call when Claude Code\'s wait limit passes, and the program sees an error', async () => {
    const h = await harness([{ toolEndingWith: '__wait', input: {} }, { text: 'gave up' }], true, 1500)
    let aborted = false
    const wait: ProgramHarnessTool = {
      name: 'wait', description: 'Wait.', inputSchema: { type: 'object', properties: {} },
      call: (_input, signal) => new Promise((resolve) => {
        signal.addEventListener('abort', () => { aborted = true; resolve({ output: 'late', isError: false }) }, { once: true })
      }),
    }
    const session = await h.driver.open(openRequest(h, { harnessTools: [wait] }))
    await session.send('Wait.', 'start')
    const events = await turn(session)
    expect(events.find(event => event.kind === 'tool-result')).toMatchObject({ isError: true })
    expect(aborted).toBe(true)
    await session.close()
    await quiescent(h)
  })
})

describe('a run rule built from the call', { timeout: 90_000 }, () => {
  const bash = (command: string): MessagesStep => ({ tool: 'Bash', input: { command, description: 'Run it' } })

  it('covers the identical command only, within the turn and, re-applied, after a resume', async () => {
    const h = await harness([
      bash('mkdir -p dir-a'), bash('mkdir -p dir-a'), bash('mkdir -p dir-a && touch w.txt'), bash('mkdir -p dir-b'),
      bash('touch x.txt && touch y.txt'), bash('touch x.txt'), { text: 'first done' },
      bash('mkdir -p dir-a'), bash('touch x.txt && touch y.txt'), bash('mkdir -p dir-b'), bash('mkdir -p dir-a; touch v.txt'), { text: 'second done' },
    ])
    const forRun = new Set(['mkdir -p dir-a', 'touch x.txt && touch y.txt'])
    const asked: ProgramApprovalRequest[] = []
    const onApproval = (request: ProgramApprovalRequest): Promise<ProgramApprovalAnswer> => {
      asked.push(request)
      return Promise.resolve(forRun.has(request.reason.replace(/^Bash: /, '')) && request.runRule !== undefined ? 'allow-run' : 'allow-once')
    }
    const commands = (): string[] => asked.map(request => request.reason.replace(/^Bash: /, ''))
    const first = await h.driver.open(openRequest(h, { onApproval }))
    await first.send('Run the commands.', 'start')
    expect((await turn(first)).at(-1)).toMatchObject({ outcome: 'completed' })
    await first.close()
    expect(commands()).toEqual(['mkdir -p dir-a', 'mkdir -p dir-a && touch w.txt', 'mkdir -p dir-b', 'touch x.txt && touch y.txt', 'touch x.txt'])
    const rules = asked.filter(request => forRun.has(request.reason.replace(/^Bash: /, ''))).flatMap(request => request.runRule === undefined ? [] : [request.runRule])
    expect(rules.map(rule => rule.summary)).toEqual(['Bash(mkdir -p dir-a)', 'Bash(touch x.txt && touch y.txt)'])

    asked.splice(0)
    const resumed = await h.driver.open(openRequest(h, { resume: first.programSessionId, runRules: rules, onApproval }))
    await resumed.send('Run them again.', 'start')
    expect((await turn(resumed)).at(-1)).toMatchObject({ outcome: 'completed' })
    await resumed.close()
    expect(commands()).toEqual(['mkdir -p dir-b', 'mkdir -p dir-a; touch v.txt'])
    await quiescent(h)
  })
})

describe('the person\'s own Claude Code settings in a seat', { timeout: 60_000 }, () => {
  interface Case { readonly user?: string[]; readonly local?: string[]; readonly project?: Record<string, unknown>; readonly asked: number; readonly made: boolean }
  // Claude Code takes only the restricting parts of a run folder's own `.claude/settings.json`: its deny and ask
  // rules hold, its allow rules and an escalating default mode do not.
  it.each<[string, Case]>([
    ['a user allow rule runs the command without asking', { user: ['Bash(touch a.txt)'], asked: 0, made: true }],
    ['a local allow rule runs the command without asking', { local: ['Bash(touch a.txt)'], asked: 0, made: true }],
    ['a project allow rule still asks', { project: { permissions: { allow: ['Bash(touch a.txt)'] } }, asked: 1, made: true }],
    ['a project accept-edits default mode still asks', { project: { permissions: { defaultMode: 'acceptEdits' } }, asked: 1, made: true }],
    ['a project deny rule refuses under a user allow rule', { user: ['Bash'], project: { permissions: { deny: ['Bash(touch a.txt)'] } }, asked: 0, made: false }],
    ['a project ask rule asks under a user allow rule', { user: ['Bash'], project: { permissions: { ask: ['Bash(touch a.txt)'] } }, asked: 1, made: true }],
  ])('%s', async (_case, settings) => {
    const h = await harness([{ tool: 'Bash', input: { command: 'touch a.txt', description: 'Make a file' } }, { text: 'made' }])
    if (settings.user !== undefined) writeFileSync(join(h.root, 'claude-config', 'settings.json'), `${JSON.stringify({ model: 'fixture-model', permissions: { defaultMode: 'default', allow: settings.user } })}\n`)
    if (settings.local !== undefined || settings.project !== undefined) mkdirSync(join(h.task, '.claude'))
    if (settings.local !== undefined) writeFileSync(join(h.task, '.claude', 'settings.local.json'), `${JSON.stringify({ permissions: { allow: settings.local } })}\n`)
    if (settings.project !== undefined) writeFileSync(join(h.task, '.claude', 'settings.json'), `${JSON.stringify(settings.project)}\n`)
    const asked: ProgramApprovalRequest[] = []
    const session = await h.driver.open(openRequest(h, { onApproval: answering(['allow-once'], asked) }))
    await session.send('Make a.txt.', 'start')
    expect((await turn(session)).at(-1)).toMatchObject({ outcome: 'completed' })
    await session.close()
    expect(asked).toHaveLength(settings.asked)
    expect(existsSync(join(h.task, 'a.txt'))).toBe(settings.made)
    await quiescent(h)
  })
})
