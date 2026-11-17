/**
 * The real pinned Codex app-server, keyless: a scratch Codex home whose model provider is a loopback Responses
 * fixture, started through a spawn shaped like the gate's. Proves the stable protocol end to end: a turn, a question
 * with each answer that matters, resume in a new process, the model rule, Stop during a command, a limits check, and
 * that nothing is left running.
 */
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonValue, ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramHarnessTool, ProgramOpenRequest, ProgramSpawn } from '@delorun/external-agents/contract'
import { ProgramOpenError } from '@delorun/external-agents/contract'
import { locateCodex } from '@delorun/external-agents/locate'
import { CodexDriver } from '../src/driver.ts'
import type { CodexSession } from '../src/session.ts'
import { startResponsesFixture, type ResponsesFixture, type ResponsesStep } from './responses-fixture.ts'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/** The pinned program, found by the gate's locator from the repository's installed packs. */
const pinnedCodex = () => locateCodex(REPO)

interface Real {
  readonly codexHome: string
  readonly workspace: string
  readonly fixture: ResponsesFixture
  readonly spawn: ProgramSpawn
  readonly handles: SubprocessHandle[]
  readonly driver: CodexDriver
  readonly questions: ProgramApprovalRequest[]
  /** Harness tool results that arrived after Codex failed the call. */
  readonly lateResults: string[]
  /** Every frame the driver sent, as JSON. */
  readonly sent: string[]
  answers: ProgramApprovalAnswer[]
  request(overrides?: Partial<ProgramOpenRequest>): ProgramOpenRequest
}

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function real(script: readonly ResponsesStep[]): Promise<Real> {
  const root = mkdtempSync(join(tmpdir(), 'ea1-codex-real-'))
  cleanups.push(() => { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
  const workspace = join(root, 'workspace')
  const codexHome = join(root, 'codex-home')
  mkdirSync(workspace)
  mkdirSync(codexHome)
  const fixture = await startResponsesFixture(script)
  cleanups.push(() => fixture.close())
  writeFileSync(join(codexHome, 'config.toml'), [
    'model = "fixture-model"',
    'model_provider = "fixture"',
    'check_for_update_on_startup = false',
    '',
    '[model_providers.fixture]',
    'name = "Fixture Responses"',
    `base_url = "${fixture.baseUrl}"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
  ].join('\n'))
  const env = {
    OPENAI_API_KEY: 'ea1-codex-fake-key',
    CODEX_HOME: codexHome,
    HOME: root,
    XDG_CONFIG_HOME: join(root, 'xdg'),
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '127.0.0.1,localhost',
  }
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => ctx.fiber.dispose())
  const handles: SubprocessHandle[] = []
  // The gate's spawn: the driver's argv and pipes, with the gate's folder, grace and environment.
  const spawn: ProgramSpawn = (request) => {
    const handle = ctx.subprocess.spawn({ argv: request.argv, cwd: workspace, stdio: request.stdio, graceMs: 2_000, env: { ...env, ...request.env } })
    handles.push(handle)
    return handle
  }
  const questions: ProgramApprovalRequest[] = []
  const lateResults: string[] = []
  const sent: string[] = []
  const r: Real = {
    codexHome,
    workspace,
    fixture,
    spawn,
    handles,
    questions,
    answers: [],
    lateResults,
    sent,
    driver: new CodexDriver({
      locate: pinnedCodex, requestTimeoutMs: 60_000, closeWaitMs: 3_000, harnessToolTimeoutSeconds: 5,
      onLateHarnessResult: (tool) => { lateResults.push(tool) },
      tap: (direction, frame) => { if (direction === '>') sent.push(JSON.stringify(frame)) },
    }),
    request: overrides => ({
      sessionId: SessionId('seat-child'),
      cwd: workspace,
      model: 'fixture-model',
      runRules: [],
      harnessTools: [],
      spawn,
      onApproval: (question) => {
        questions.push(question)
        return Promise.resolve(r.answers.shift() ?? 'reject')
      },
      onLimits: () => {},
      signal: new AbortController().signal,
      ...overrides,
    }),
  }
  return r
}

async function untilTurnEnd(session: CodexSession, onEvent?: (event: ProgramEvent) => Promise<void> | void): Promise<ProgramEvent[]> {
  const events: ProgramEvent[] = []
  const signal = AbortSignal.timeout(90_000)
  for (;;) {
    const event = await session.next(signal)
    events.push(event)
    await onEvent?.(event)
    if (event.kind === 'turn-end') return events
  }
}

const text = (events: readonly ProgramEvent[]): string => events.flatMap(event => event.kind === 'text' ? [event.text] : []).join('')

/** A shell command as either of the shell tools Codex 0.153.4 may advertise. */
const shell = (command: string): ResponsesStep => ({ kind: 'call', choices: { exec_command: { cmd: command }, shell_command: { command } } })

/** Codex's own state that a first start creates in an empty home: databases, logs, caches and thread rollouts. */
const CODEX_STATE = /^(?:[a-z_]+_\d+\.sqlite(?:-shm|-wal)?|logs_\d+\.sqlite.*|models_cache\.json|sessions|shell_snapshots|\.tmp|tmp|thread-writer-locks|version\.json|installation_id|memories|log|cache|archived_sessions|\.personality_migration|\.sandbox_migration|plugins|skills)$/

/** Every file under a folder, recursively; none when it does not exist. */
function filesUnder(folder: string): string[] {
  if (!existsSync(folder)) return []
  return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
}

/** Processes whose working directory is the folder; Linux only. */
function processesIn(folder: string): number[] {
  if (process.platform !== 'linux') return []
  return readdirSync('/proc').filter(entry => /^\d+$/.test(entry)).flatMap((pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`) === folder ? [Number(pid)] : []
    } catch (_gone) {
      // The process exited or belongs to someone else: not one this spec started.
      return []
    }
  })
}

async function expectNothingLeft(r: Real): Promise<void> {
  for (const handle of r.handles) await expect(handle.waitForExit()).resolves.toBe(true)
  expect(processesIn(r.workspace)).toEqual([])
}

describe('the real pinned Codex app-server', () => {
  it('runs a turn through the gate\'s spawn and leaves no process', async () => {
    const r = await real([{ kind: 'text', text: 'fixture answer' }])
    const session = await r.driver.open(r.request())
    await session.send('Say the fixture answer.', 'start')
    const events = await untilTurnEnd(session)
    expect(text(events)).toBe('fixture answer')
    expect(events.at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'completed' })
    await session.close()
    await expectNothingLeft(r)
  }, 100_000)

  it('asks before an untrusted command and runs it only when allowed', async () => {
    const r = await real([shell('touch allowed.txt'), { kind: 'text', text: 'made it' }, shell('touch declined.txt'), { kind: 'text', text: 'did not' }])
    r.answers = ['allow-once', 'reject']
    const session = await r.driver.open(r.request())
    await session.send('Make allowed.txt.', 'start')
    const first = await untilTurnEnd(session)
    const call = first.find(event => event.kind === 'tool-call')
    expect(call).toMatchObject({ kind: 'tool-call', name: 'shell' })
    expect(r.questions[0]?.callId).toBe(call?.kind === 'tool-call' ? call.id : undefined)
    expect(r.questions[0]?.runRule).toMatchObject({ provider: 'codex', data: { kind: 'command' } })
    expect(first.indexOf(call as ProgramEvent)).toBeLessThan(first.findIndex(event => event.kind === 'tool-result'))
    expect(existsSync(join(r.workspace, 'allowed.txt'))).toBe(true)
    await session.send('Make declined.txt.', 'start')
    const second = await untilTurnEnd(session)
    expect(second.find(event => event.kind === 'tool-result')).toMatchObject({ isError: true })
    expect(existsSync(join(r.workspace, 'declined.txt'))).toBe(false)
    await session.close()
    await expectNothingLeft(r)
  }, 100_000)

  it('resumes the thread in a new process', async () => {
    const r = await real([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }])
    const first = await r.driver.open(r.request())
    await first.send('First.', 'start')
    await untilTurnEnd(first)
    const threadId = first.programSessionId
    await first.close()
    const resumed = await r.driver.open(r.request({ resume: threadId }))
    expect(resumed.programSessionId).toBe(threadId)
    await resumed.send('Second.', 'start')
    expect(text(await untilTurnEnd(resumed))).toBe('two')
    // The second model request carries the first turn: Codex resumed the same conversation.
    expect(JSON.stringify(r.fixture.requests[1]?.input)).toContain('First.')
    await resumed.close()
    await expectNothingLeft(r)
    // Two processes and two turns: the budget allows for a machine busy with other lanes.
  }, 150_000)

  it('fails resume-failed for a thread that does not exist', async () => {
    const r = await real([])
    const error: unknown = await r.driver.open(r.request({ resume: '01a1ea16-0000-7000-8000-000000000000' })).catch((thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(ProgramOpenError)
    expect((error as ProgramOpenError).failure).toEqual({ category: 'resume-failed' })
    await expectNothingLeft(r)
  }, 100_000)

  it('stops before any turn when the configured model is not offered and no model was picked', async () => {
    const r = await real([])
    const { model: _picked, ...unpicked } = r.request()
    const error: unknown = await r.driver.open(unpicked).catch((thrown: unknown) => thrown)
    expect((error as ProgramOpenError).failure).toMatchObject({ category: 'model-not-offered', configured: 'fixture-model' })
    expect(r.fixture.requests).toEqual([])
    await expectNothingLeft(r)
  }, 100_000)

  it('closes the app-server when Stop leaves a command running, and the command dies with it (L32)', async () => {
    const r = await real([shell('sleep 20 && touch late.txt'), { kind: 'hold' }])
    r.answers = ['allow-once']
    const session = await r.driver.open(r.request())
    await session.send('Sleep, then make late.txt.', 'start')
    let outcome: string | undefined
    const events = await untilTurnEnd(session, async (event) => {
      if (event.kind !== 'tool-call') return
      // Give the approved command time to start before Stop.
      await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
      outcome = await session.interrupt()
    })
    expect(outcome).toBe('closed')
    expect(events.at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'interrupted' })
    expect(session.closedReason).toBe('interrupted-with-open-command')
    await session.close()
    await expectNothingLeft(r)
    expect(existsSync(join(r.workspace, 'late.txt'))).toBe(false)
    // The sandbox's mount points in the workspace were removed with the process (decision 5).
    expect(['.git', '.agents', '.codex'].filter(name => existsSync(join(r.workspace, name)))).toEqual([])
  }, 100_000)

  it('answers the same command again after "Allow for this run" and asks about another (D4)', async () => {
    const r = await real([shell('touch a.txt'), shell('touch a.txt'), shell('touch b.txt'), { kind: 'text', text: 'done' }])
    r.answers = ['allow-run', 'reject']
    const session = await r.driver.open(r.request())
    await session.send('Touch a.txt twice, then b.txt.', 'start')
    const events = await untilTurnEnd(session)
    expect(events.filter(event => event.kind === 'tool-call')).toHaveLength(3)
    expect(r.questions.map(question => question.reason)).toEqual([expect.stringContaining('a.txt'), expect.stringContaining('b.txt')])
    expect([existsSync(join(r.workspace, 'a.txt')), existsSync(join(r.workspace, 'b.txt'))]).toEqual([true, false])
    await session.close()
    await expectNothingLeft(r)
  }, 100_000)

  it('leaves the Codex home\'s config.toml byte-identical through a turn, a question and a resume (decision 4)', async () => {
    const r = await real([shell('touch made.txt'), { kind: 'text', text: 'done' }, shell('touch again.txt'), { kind: 'text', text: 'done' }])
    r.answers = ['allow-once', 'allow-once']
    const config = join(r.codexHome, 'config.toml')
    const before = readFileSync(config)
    const session = await r.driver.open(r.request())
    await session.send('Make made.txt.', 'start')
    await untilTurnEnd(session)
    await session.close()
    expect(readFileSync(config).equals(before)).toBe(true)
    const resumed = await r.driver.open(r.request({ resume: session.programSessionId }))
    await resumed.send('Make again.txt.', 'start')
    await untilTurnEnd(resumed)
    await resumed.close()
    expect(readFileSync(config).equals(before)).toBe(true)
    expect(existsSync(join(r.workspace, 'again.txt'))).toBe(true)
    await expectNothingLeft(r)
  }, 150_000)

  it('offers harness tools on a loopback server named in the thread config only, and revokes it at exit (task 5, D14)', async () => {
    const harnessCall: ResponsesStep = { kind: 'call-matching', pattern: /^mcp__delorun_[0-9a-f]{12}\/harness_echo$/, args: { text: 'from codex' } }
    const r = await real([harnessCall, { kind: 'text', text: 'done' }, harnessCall, { kind: 'text', text: 'done again' }])
    const config = join(r.codexHome, 'config.toml')
    const before = readFileSync(config)
    const listing = readdirSync(r.codexHome).sort()
    const received: JsonValue[] = []
    const echo: ProgramHarnessTool = {
      name: 'harness_echo',
      description: 'Echo the text back. Use it when asked to.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      call: (input) => {
        received.push(input)
        return Promise.resolve({ output: 'echoed', isError: false })
      },
    }
    const session = await r.driver.open(r.request({ harnessTools: [echo] }))
    await session.send('Call harness_echo with the text "from codex".', 'start')
    const events = await untilTurnEnd(session)
    const advertised = JSON.stringify(r.fixture.requests[0]?.tools)
    const server = /delorun_[0-9a-f]{12}/.exec(advertised)?.[0]
    expect(server).toBeDefined()
    expect(events.find(event => event.kind === 'tool-call')).toMatchObject({ name: `mcp__${server ?? ''}__harness_echo` })
    expect(events.find(event => event.kind === 'tool-result')).toMatchObject({ isError: false })
    expect(received).toEqual([{ text: 'from codex' }])
    // The program's own approval of the call was answered by the driver, never asked.
    expect(r.questions).toEqual([])
    await session.close()
    // A resumed thread gets a new server, name and token, again only in its thread config.
    const resumed = await r.driver.open(r.request({ harnessTools: [echo], resume: session.programSessionId }))
    await resumed.send('Call harness_echo again.', 'start')
    const again = await untilTurnEnd(resumed)
    expect(again.find(event => event.kind === 'tool-result')).toMatchObject({ isError: false })
    expect(received).toHaveLength(2)
    await resumed.close()
    await expectNothingLeft(r)
    expect(readFileSync(config).equals(before)).toBe(true)
    expect(readdirSync(r.codexHome).filter(name => !listing.includes(name) && !CODEX_STATE.test(name))).toEqual([])
    // The token reaches the program only in the thread config, and Codex keeps it in no file of its home: not the
    // rollout, not its databases or logs.
    const tokens = r.sent.filter(frame => /"thread\/(start|resume)"/.test(frame)).flatMap(frame => [...frame.matchAll(/Bearer ([A-Za-z0-9_-]{43})/g)].map(match => match[1] ?? ''))
    expect(new Set(tokens).size).toBe(2)
    expect(filesUnder(join(r.codexHome, 'sessions')).length).toBeGreaterThan(0)
    expect(filesUnder(r.codexHome).filter(file => tokens.some(token => readFileSync(file).includes(token)))).toEqual([])
  }, 150_000)

  it('runs a limits check without a thread or a model request', async () => {
    const r = await real([])
    const observation = await r.driver.probe({ spawn: r.spawn, cwd: r.workspace, signal: new AbortController().signal })
    expect(observation).toMatchObject({ provider: 'codex', source: 'probe' })
    expect(r.fixture.requests).toEqual([])
    await expectNothingLeft(r)
  }, 100_000)
})
