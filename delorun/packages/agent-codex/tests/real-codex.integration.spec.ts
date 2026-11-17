/**
 * The real pinned Codex app-server, keyless: a scratch Codex home whose model provider is a loopback Responses
 * fixture, started through a spawn shaped like the gate's. Proves the stable protocol end to end: a turn, a question
 * with each answer that matters, resume in a new process, the model rule, Stop during a command, a limits check, and
 * that nothing is left running.
 */
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProgramApprovalAnswer, ProgramApprovalRequest, ProgramEvent, ProgramOpenRequest, ProgramSpawn } from '../src/contract.ts'
import { ProgramFailureError } from '../src/contract.ts'
import { CodexDriver, type CodexProgram } from '../src/driver.ts'
import type { CodexSession } from '../src/session.ts'
import { startResponsesFixture, type ResponsesFixture, type ResponsesStep } from './responses-fixture.ts'

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..')

/** The pinned program, found the way the gate finds it: through upstream's Codex package. */
function pinnedCodex(): CodexProgram {
  const manifest = createRequire(join(REPO, 'packages/subagent/subagent-codex/package.json')).resolve('@openai/codex/package.json')
  const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { readonly version: string; readonly bin: { readonly codex: string } }
  return { entry: join(dirname(manifest), pkg.bin.codex), version: pkg.version }
}

interface Real {
  readonly codexHome: string
  readonly workspace: string
  readonly fixture: ResponsesFixture
  readonly spawn: ProgramSpawn
  readonly handles: SubprocessHandle[]
  readonly driver: CodexDriver
  readonly questions: ProgramApprovalRequest[]
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
  const r: Real = {
    codexHome,
    workspace,
    fixture,
    spawn,
    handles,
    questions,
    answers: [],
    driver: new CodexDriver({ locate: pinnedCodex, requestTimeoutMs: 60_000, closeWaitMs: 3_000 }),
    request: overrides => ({
      sessionId: 'seat-child',
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
    expect(error).toBeInstanceOf(ProgramFailureError)
    expect((error as ProgramFailureError).failure).toEqual({ category: 'resume-failed' })
    await expectNothingLeft(r)
  }, 100_000)

  it('stops before any turn when the configured model is not offered and no model was picked', async () => {
    const r = await real([])
    const { model: _picked, ...unpicked } = r.request()
    const error: unknown = await r.driver.open(unpicked).catch((thrown: unknown) => thrown)
    expect((error as ProgramFailureError).failure).toMatchObject({ category: 'model-not-offered', configured: 'fixture-model' })
    expect(r.fixture.requests).toEqual([])
    await expectNothingLeft(r)
  }, 100_000)

  it('closes the app-server when Stop leaves a command running, and the command dies with it (L32)', async () => {
    const r = await real([shell('sleep 20 && touch late.txt'), { kind: 'hold' }])
    r.answers = ['allow-once']
    const session = await r.driver.open(r.request())
    await session.send('Sleep, then make late.txt.', 'start')
    const events = await untilTurnEnd(session, async (event) => {
      if (event.kind !== 'tool-call') return
      // Give the approved command time to start before Stop.
      await new Promise(resolveWait => setTimeout(resolveWait, 1_500))
      await session.interrupt()
    })
    expect(events.at(-1)).toMatchObject({ kind: 'turn-end', outcome: 'interrupted' })
    expect(session.closedReason).toBe('interrupted-with-open-command')
    await session.close()
    await expectNothingLeft(r)
    expect(existsSync(join(r.workspace, 'late.txt'))).toBe(false)
  }, 100_000)

  it('leaves the Codex home\'s config.toml as it was', async () => {
    const r = await real([shell('touch made.txt'), { kind: 'text', text: 'done' }])
    r.answers = ['allow-once']
    const before = readFileSync(join(r.codexHome, 'config.toml'), 'utf8')
    const session = await r.driver.open(r.request())
    await session.send('Make made.txt.', 'start')
    await untilTurnEnd(session)
    await session.close()
    expect(readFileSync(join(r.codexHome, 'config.toml'), 'utf8')).toBe(before)
  }, 100_000)

  it('runs a limits check without a thread or a model request', async () => {
    const r = await real([])
    const observation = await r.driver.probe({ spawn: r.spawn, cwd: r.workspace, signal: new AbortController().signal })
    expect(observation).toMatchObject({ provider: 'codex', source: 'probe' })
    expect(r.fixture.requests).toEqual([])
    await expectNothingLeft(r)
  }, 100_000)
})
