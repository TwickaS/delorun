import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ProgramOpenError, type AccountObservation, type ProgramSpawnRequest } from '@delorun/external-agents/contract'
import type { LocatedCodex } from '@delorun/external-agents/locate'
import { CodexDriver, type CodexOpenRequest } from '../src/driver.ts'
import { TESTED_CODEX_VERSION } from '../src/protocol.ts'
import { FakeAppServer, type Frame } from './fake-app-server.ts'
import {
  TASK, THREAD, accountSignedIn, accountSignedOut, initializeResult, modelList, rateLimitsRead, threadOpened,
} from './recorded.ts'

const PINNED: LocatedCodex = { directory: '/pack/node_modules/@openai/codex', script: '/pack/node_modules/@openai/codex/bin/codex.js', version: TESTED_CODEX_VERSION }

interface Setup {
  readonly codex: FakeAppServer
  readonly spawned: ProgramSpawnRequest[]
  readonly limits: AccountObservation[]
  readonly driver: CodexDriver
  request(overrides?: Partial<CodexOpenRequest>): CodexOpenRequest
}

/** What Codex reports for a thread opened with these settings: their approval policy and reviewer, and their sandbox. */
function opened(params: Frame, configuredModel: string, id?: string): Frame {
  return {
    ...threadOpened(typeof params.model === 'string' ? params.model : configuredModel, id),
    approvalPolicy: params.approvalPolicy ?? 'on-request',
    approvalsReviewer: params.approvalsReviewer ?? 'user',
    ...params.sandbox === undefined ? {} : { sandbox: params.sandbox === 'read-only' ? { type: 'readOnly', networkAccess: false } : { type: 'workspaceWrite' } },
  }
}

/** A driver whose spawn returns one fake app-server answering the recorded open sequence. */
function setup(program: LocatedCodex = PINNED, configuredModel = 'gpt-5.6-luna'): Setup {
  const codex = new FakeAppServer()
  codex.answer('initialize', { result: initializeResult })
  codex.answer('account/read', { result: accountSignedIn })
  codex.answer('thread/start', params => ({ result: opened(params, configuredModel) }))
  codex.answer('thread/resume', params => ({ result: opened(params, configuredModel, String(params.threadId)) }))
  codex.answer('config/read', { result: { config: { approval_policy: null }, origins: {} } })
  codex.answer('model/list', { result: modelList })
  codex.answer('account/rateLimits/read', { result: rateLimitsRead })
  const spawned: ProgramSpawnRequest[] = []
  const limits: AccountObservation[] = []
  const spawn = (request: ProgramSpawnRequest) => {
    spawned.push(request)
    return codex.handle
  }
  return {
    codex,
    spawned,
    limits,
    driver: new CodexDriver({ locate: () => program, requestTimeoutMs: 2_000, closeWaitMs: 50, harnessToolTimeoutSeconds: 900, onLateHarnessResult: () => {} }),
    request: overrides => ({
      sessionId: SessionId('seat-child'),
      cwd: TASK,
      level: 'standard', runRules: [],
      harnessTools: [],
      sharesFolder: () => false,
      spawn,
      onApproval: () => Promise.resolve('reject'),
      onLimits: (observation) => { limits.push(observation) },
      signal: new AbortController().signal,
      ...overrides,
    }),
  }
}

async function failureOf(promise: Promise<unknown>): Promise<ProgramOpenError> {
  const error: unknown = await promise.then(() => undefined, (thrown: unknown) => thrown)
  expect(error).toBeInstanceOf(ProgramOpenError)
  return error as ProgramOpenError
}

describe('open', () => {
  it('starts the pinned app-server through the gate\'s spawn, on the stable protocol', async () => {
    const s = setup()
    const session = await s.driver.open(s.request())
    expect(s.spawned).toEqual([{ argv: [process.execPath, PINNED.script, 'app-server', '--stdio'], env: expect.any(Object), stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }])
    expect(s.codex.requests('initialize')).toEqual([{ clientInfo: { name: 'delorun', title: 'Delorun', version: '0.1.0' }, capabilities: { experimentalApi: false, requestAttestation: false } }])
    expect(s.codex.received.some(frame => frame.method === 'initialized')).toBe(true)
    expect(session.programSessionId).toBe(THREAD)
    await session.close()
  })

  it('withholds NODE_OPTIONS and every DELORUN_ name from the app-server (D16)', async () => {
    vi.stubEnv('DELORUN_EA1_SPEC', 'host-only')
    vi.stubEnv('NODE_OPTIONS', '--require /host/hook.cjs')
    try {
      const s = setup()
      await (await s.driver.open(s.request())).close()
      const env = s.spawned[0]?.env ?? {}
      expect(Object.keys(env)).toEqual(expect.arrayContaining(['NODE_OPTIONS', 'DELORUN_EA1_SPEC']))
      expect(Object.values(env).every(value => value === undefined)).toBe(true)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('starts a lasting thread at the driver\'s level, Standard: on-request with the automatic reviewer on a read-only base (EA34)', async () => {
    const s = setup()
    await (await s.driver.open(s.request())).close()
    expect(s.codex.requests('thread/start')).toEqual([{ cwd: TASK, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'read-only', ephemeral: false }])
    expect(s.codex.requests('config/read')).toEqual([])
  })

  it.for([['standard', 'on'], ['careful', 'on'], ['unrestricted', 'off'], ['own', 'own']] as const)('reports the %s level\'s sandbox as %s', async ([level, sandbox]) => {
    const s = setup()
    s.codex.answer('config/read', { result: { config: { approval_policy: 'on-request' }, origins: {} } })
    const session = await s.driver.open(s.request({ level }))
    expect(session.sandbox).toBe(sandbox)
    await session.close()
  })

  it.each([
    ['careful', { approvalPolicy: 'on-request', sandbox: 'read-only' }],
    ['unrestricted', { approvalPolicy: 'on-request', sandbox: 'read-only' }],
  ] as const)('starts a %s thread with its own settings and never a writable thread sandbox', async (level, thread) => {
    const s = setup()
    await (await s.driver.open(s.request({ level }))).close()
    expect(s.codex.requests('thread/start')).toEqual([{ cwd: TASK, ...thread, ephemeral: false }])
  })

  it.each([
    ['untrusted', 'untrusted'],
    ['on-request', 'on-request'],
    ['never', 'on-request'],
    [null, 'on-request'],
    [{ granular: { mcp_elicitations: false, rules: false, sandbox_approval: false } }, 'on-request'],
  ] as const)('runs the own level under the person\'s approval policy %j as %s, with no sandbox of its own', async (configured, used) => {
    const s = setup()
    s.codex.answer('config/read', { result: { config: { approval_policy: configured }, origins: {} } })
    await (await s.driver.open(s.request({ level: 'own' }))).close()
    expect(s.codex.requests('config/read')).toEqual([{ cwd: TASK, includeLayers: false }])
    expect(s.codex.requests('thread/start')).toEqual([{ cwd: TASK, approvalPolicy: used, ephemeral: false }])
  })

  it.each([
    ['another approval policy', { approvalPolicy: 'never' }],
    ['another reviewer', { approvalsReviewer: 'user' }],
    ['a writable thread sandbox', { sandbox: { type: 'workspaceWrite', writableRoots: [], networkAccess: false } }],
  ])('refuses a thread Codex reports with %s, and ends the process', async (_name, change) => {
    const s = setup()
    s.codex.answer('thread/start', params => ({ result: { ...opened(params, 'gpt-5.6-luna'), ...change } }))
    expect((await failureOf(s.driver.open(s.request()))).failure).toMatchObject({ category: 'program' })
    expect(s.codex.exited).toBe(true)
  })

  it('passes a picked model on thread/start and thread/resume (L33)', async () => {
    const start = setup()
    await (await start.driver.open(start.request({ model: 'gpt-5.6-terra' }))).close()
    expect(start.codex.requests('thread/start')[0]).toMatchObject({ model: 'gpt-5.6-terra' })
    const resume = setup()
    const session = await resume.driver.open(resume.request({ model: 'gpt-5.6-terra', resume: THREAD }))
    expect(resume.codex.requests('thread/resume')).toEqual([{ cwd: TASK, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'read-only', model: 'gpt-5.6-terra', threadId: THREAD }])
    expect(session.programSessionId).toBe(THREAD)
    await session.close()
  })

  it('fails model-not-offered before any turn when the configured model is not on the plan (EA22)', async () => {
    const s = setup(PINNED, 'gpt-6-astra')
    const error = await failureOf(s.driver.open(s.request()))
    expect(error.failure).toEqual({
      category: 'model-not-offered',
      configured: 'gpt-6-astra',
      offered: [
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: true },
        { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false },
      ],
    })
    expect(s.codex.requests('turn/start')).toEqual([])
    expect(s.codex.exited).toBe(true)
  })

  it('reports the offered models once the thread is open, without the email', async () => {
    const s = setup()
    await (await s.driver.open(s.request())).close()
    expect(s.limits).toEqual([{ provider: 'codex', signedIn: 'yes', plan: 'free', windows: [], source: 'run', offeredModels: expect.any(Array) }])
    expect(JSON.stringify(s.limits)).not.toContain('example.invalid')
  })

  it('fails resume-failed when the thread is gone', async () => {
    const s = setup()
    s.codex.answer('thread/resume', { error: { code: -32600, message: 'thread not found' } })
    expect((await failureOf(s.driver.open(s.request({ resume: 'gone' })))).failure).toEqual({ category: 'resume-failed' })
    expect(s.codex.exited).toBe(true)
  })

  it('fails signed-out before opening a thread when Codex has no sign-in', async () => {
    const s = setup()
    s.codex.answer('account/read', { result: accountSignedOut })
    expect((await failureOf(s.driver.open(s.request()))).failure).toEqual({ category: 'signed-out' })
    expect(s.codex.requests('thread/start')).toEqual([])
  })

  it('refuses an untested Codex version without starting it', async () => {
    const s = setup({ ...PINNED, version: '0.154.0' })
    const error = await failureOf(s.driver.open(s.request()))
    expect(error.failure).toMatchObject({ category: 'program' })
    expect(s.spawned).toEqual([])
  })

  it('fails without starting anything when the Codex pack has no program', async () => {
    const s = setup()
    const driver = new CodexDriver({ locate: () => undefined, requestTimeoutMs: 2_000, closeWaitMs: 50, harnessToolTimeoutSeconds: 900, onLateHarnessResult: () => {} })
    expect((await failureOf(driver.open(s.request()))).failure).toMatchObject({ category: 'program' })
    expect(s.spawned).toEqual([])
  })

  it('fails with a program failure when Codex does not answer in time, and ends the process', async () => {
    const s = setup()
    s.codex.answers.delete('thread/start')
    const driver = new CodexDriver({ locate: () => PINNED, requestTimeoutMs: 100, closeWaitMs: 50, harnessToolTimeoutSeconds: 900, onLateHarnessResult: () => {} })
    const error = await failureOf(driver.open(s.request()))
    expect(error.failure).toEqual({ category: 'program', detail: 'Codex did not answer in time during the open.' })
    expect(s.codex.exited).toBe(true)
  })

  it('ends the process when the gate aborts the open', async () => {
    const s = setup()
    s.codex.answers.delete('thread/start')
    const controller = new AbortController()
    const opening = s.driver.open(s.request({ signal: controller.signal }))
    await s.codex.waitFor(frame => frame.method === 'thread/start')
    controller.abort(new Error('stopped'))
    await failureOf(opening)
    expect(s.codex.exited).toBe(true)
  })
})

describe('probe', () => {
  it('reads sign-in, plan, windows and offered models, starts no thread, and closes', async () => {
    const s = setup()
    const observation = await s.driver.probe({ spawn: s.request().spawn, cwd: '/home/delorun/probe', signal: new AbortController().signal })
    expect(observation).toEqual({
      provider: 'codex',
      signedIn: 'yes',
      plan: 'free',
      windows: [
        { kind: 'window_43200m', usedPercent: 2, resetsAt: 1797520635000, status: 'allowed' },
        { kind: 'five_hour', usedPercent: 12, resetsAt: 1794940000000, status: 'allowed' },
      ],
      offeredModels: [
        { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', isDefault: true },
        { id: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', isDefault: false },
      ],
      source: 'probe',
    })
    expect(JSON.stringify(observation)).not.toMatch(/acct-person|example\.invalid/)
    expect(s.codex.requests('thread/start')).toEqual([])
    expect(s.codex.exited).toBe(true)
  })

  it('reports signed out without reading limits', async () => {
    const s = setup()
    s.codex.answer('account/read', { result: accountSignedOut })
    const observation = await s.driver.probe({ spawn: s.request().spawn, cwd: '/home/delorun/probe', signal: new AbortController().signal })
    expect(observation).toEqual({ provider: 'codex', signedIn: 'no', windows: [], source: 'probe' })
    expect(s.codex.requests('account/rateLimits/read')).toEqual([])
  })

  it('reports no windows for a sign-in without plan limits', async () => {
    const s = setup()
    s.codex.answer('account/read', { result: { account: { type: 'apiKey' }, requiresOpenaiAuth: true } })
    s.codex.answer('account/rateLimits/read', { error: { code: -32600, message: 'chatgpt authentication required' } })
    const observation = await s.driver.probe({ spawn: s.request().spawn, cwd: '/home/delorun/probe', signal: new AbortController().signal })
    expect(observation).toMatchObject({ signedIn: 'yes', windows: [] })
    expect(observation.plan).toBeUndefined()
  })
})
