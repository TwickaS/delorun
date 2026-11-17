/**
 * The real consent row with the real start gate: turning the consent off while a seat's turn runs ends the program
 * (review P2). Read-only turned on mid-turn takes effect at the next turn's review, which `seat.spec.ts` covers.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  DELEGATION_CONSENT_ROW_ID, ExternalAgentsService, type ExternalAgentDriver, type ProgramEvent, type ProgramOpenRequest,
  type ProgramSession,
} from '@delorun/external-agents'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { changeGrantStore, grantStorePath } from '../src/store.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A program process that exits when it is terminated or its signal aborts. */
interface FakeProcess extends SubprocessHandle {
  readonly terminated: boolean
}

/**
 * @param spec - the spawn request.
 * @returns a fake handle.
 */
function fakeProcess(spec: SubprocessSpawnSpec): FakeProcess {
  const exit = Promise.withResolvers<{ exitCode: number | null, signal: NodeJS.Signals | null }>()
  let terminated = false
  const terminate = (): void => {
    terminated = true
    exit.resolve({ exitCode: null, signal: 'SIGTERM' })
  }
  spec.signal?.addEventListener('abort', terminate, { once: true })
  return {
    get terminated() { return terminated },
    stdin: undefined, stdout: undefined, stderr: undefined, control: undefined,
    collected: {} as never,
    done: exit.promise,
    terminate,
    waitForExit: async () => { await exit.promise; return true },
  }
}

/** A program whose turn runs until it is interrupted or closed. */
class RunningSession implements ProgramSession {
  readonly programSessionId = 'program-1'
  readonly sent: string[] = []
  turnRunning = false
  closed = false

  send(text: string): Promise<void> {
    this.sent.push(text)
    this.turnRunning = true
    return Promise.resolve()
  }

  interrupt(): Promise<'interrupted'> {
    return Promise.resolve('interrupted')
  }

  next(signal: AbortSignal): Promise<ProgramEvent> {
    return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) })
  }

  close(): Promise<void> {
    this.closed = true
    return Promise.resolve()
  }
}

/** A driver that starts one fake process per open. */
class OneProgramDriver implements ExternalAgentDriver {
  readonly provider = 'claude-code' as const
  readonly processes: FakeProcess[] = []
  readonly sessions: RunningSession[] = []

  open(request: ProgramOpenRequest): Promise<ProgramSession> {
    this.processes.push(request.spawn({ argv: ['/bin/program'], stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } }) as FakeProcess)
    const session = new RunningSession()
    this.sessions.push(session)
    return Promise.resolve(session)
  }

  probe(): Promise<never> {
    return Promise.reject(new Error('no limits check in this spec'))
  }
}

describe('the consent and the start gate together', () => {
  it('ends a seat\'s running program when the consent is turned off mid-turn', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'delorun-live-gate-')))
    roots.push(base)
    const home = join(base, 'home')
    const workspace = join(base, 'work')
    for (const path of [home, workspace]) mkdirSync(path)
    vi.stubEnv('DELORUN_HOME', home)
    await changeGrantStore(grantStorePath(home), grants => [...grants, { workspace, provider: 'claude-code', grantedAt: 5 }])

    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    const harness = await mountAgentLoopTestHarness(ctx)
    const root: Agent = await harness.create(SessionId('root'), {}, { cwd: workspace })
    const seat: Agent = await harness.create(SessionId('seat'), {}, { cwd: workspace })
    ctx.provide('sandboxPolicy', { resolve: () => ({ mode: 'workspace-write' }) } as never)
    ctx.provide('subprocess', { spawn: fakeProcess } as never)
    ctx.provide('subagents', { rootOf: () => root } as never)
    const saved = { enabled: true }
    ctx.provide('loader', {
      entries: () => [{ id: DELEGATION_CONSENT_ROW_ID, options: { id: DELEGATION_CONSENT_ROW_ID, config: { enabled: true } }, disabled: false }],
      unwrapExports: (exports: unknown) => exports,
    } as never)
    apply(ctx, { enabled: { get: () => saved.enabled }, runTimeoutMinutes: { get: () => 30 } })
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeDefined() })
    await ctx.plugin(ExternalAgentsService, {
      maxLivePrograms: 4, graceMs: 100, limitRefusal: false, env: {}, now: Date.now,
      probeFolder: () => Promise.reject(new Error('no limits check in this spec')),
      programRecords: undefined, processTable: undefined, programExecutables: () => [],
    })
    const driver = new OneProgramDriver()
    ctx.get('externalAgents')!.registerDriver(driver)

    const session = await ctx.get('externalAgents')!.start({
      purpose: 'seat', provider: 'claude-code', creator: root.id, child: seat.id, cwd: workspace, harnessTools: [],
      onApproval: () => Promise.resolve('allow-once'), signal: new AbortController().signal,
    })
    expect(session.allowedBy).toBe('granted')
    await session.send('work', 'start')
    expect(driver.sessions[0]?.sent).toEqual(['work'])
    expect(driver.processes[0]?.terminated).toBe(false)

    saved.enabled = false
    ctx.emit('loader/volatile-update', [['enabled']])
    await vi.waitFor(() => { expect(ctx.get('delegationConsent')).toBeUndefined() })
    await vi.waitFor(() => { expect(driver.processes[0]?.terminated).toBe(true) })
    expect(driver.sessions[0]?.closed).toBe(true)
  })
})
