import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { ClaudeCodeDriver } from '../src/driver.ts'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramOpenRequest, ProgramSession, ProgramSpawn, SessionId } from '@delorun/external-agents/contract'
import { loadClaudeSdk, TESTED_SDK_VERSION } from '../src/sdk.ts'
import { startMessagesFixture, type MessagesFixture, type MessagesStep } from './messages-fixture.ts'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The SDK as upstream's Claude Code package brings it; its `package.json` is not exported, so the folder is found from the entry. */
function locateSdk(): { entry: string, version: string } {
  const entry = realpathSync(createRequire(join(REPO, 'packages/subagent/subagent-claude-code/package.json')).resolve('@anthropic-ai/claude-agent-sdk'))
  const manifest = JSON.parse(readFileSync(join(dirname(entry), 'package.json'), 'utf8')) as { version: string }
  return { entry, version: manifest.version }
}

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
async function harness(script: readonly MessagesStep[], signedIn = true): Promise<Harness> {
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
    harnessToolTimeoutMs: () => 900_000,
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
    sessionId: 'child-1' as SessionId, cwd: h.task, runRules: [], harnessTools: [], spawn: h.spawn,
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
})
