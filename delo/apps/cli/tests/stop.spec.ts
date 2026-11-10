/**
 * `delorun stop`: the request it sends and, for `--now`, the signals it sends a home process that did not stop. The
 * specs run the command in-process with a stand-in update channel, lock, process table, killer and clock, so no
 * process is signalled and no time passes.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HomeLockRecord, RuntimeVersion, StartId } from '@delo/contract-home-layout'
import { START_WAIT_MS, STOP_KILL_WAIT_MS, STOP_NOW_ANSWER_MS, STOP_TERM_GRACE_MS } from '@delo/contract-home-process'
import type { ExchangeOptions, ResponseLine, UnsignedRequest } from '@delo/home-process'
import { EXIT } from '../src/exit.ts'
import { createStopCommand, type StopDependencies, type StopSignal } from '../src/stop.ts'

const BOOT_ID = '01234567-89ab-cdef-0123-456789abcdef'
const PID = 4242
const START = `linux:${BOOT_ID}:1000`
const NAMESPACE = 'pid:[4026531836]'

/** A stand-in operating system: its processes, the profile's lock, the signals sent and the time. */
interface FakeSystem {
  /** Live processes by id, each with its start identity. */
  readonly processes: Map<number, string | undefined>
  /** The profile's lock record, or an error reading it throws. */
  lock: HomeLockRecord | Error | undefined
  /** Each signal sent, with the time it was sent at. */
  readonly signals: Array<{ readonly pid: number, readonly signal: StopSignal, readonly at: number }>
  /** Each request sent with its options. */
  readonly requests: Array<{ readonly request: UnsignedRequest, readonly options: ExchangeOptions | undefined }>
  /** Milliseconds since the stop began. */
  time: number
  /** The lock reads, start identity reads and signals in the order they happened. */
  readonly events: Array<'lock' | 'start' | StopSignal>
}

let deloHome: string

beforeEach(() => {
  deloHome = mkdtempSync(join(tmpdir(), 'delo-stop-'))
})

afterEach(() => {
  rmSync(deloHome, { recursive: true, force: true })
})

/**
 * A lock record.
 * @param identity - the holder's start identity and pid namespace.
 * @returns the record of process {@link PID}.
 */
function lockRecord(identity: Pick<HomeLockRecord, 'processStart' | 'pidNamespace'>): HomeLockRecord {
  return { v: 1, pid: PID, startId: brandString<StartId>('a'.repeat(32)), runtime: brandString<RuntimeVersion>('0.1.0'), startedAt: '2026-11-10T00:00:00Z', ...identity }
}

/**
 * Run `delorun stop` against a stand-in system.
 * @param args - the arguments after `stop`.
 * @param options - the system's platform and pid namespace, whether the holder runs (with the record's start
 *   identity, by default), the lock record, what the update channel does and what a signal does.
 * @returns the exit code, both outputs and the system after the run.
 */
async function stop(args: readonly string[], options: {
  readonly platform?: NodeJS.Platform
  readonly ownNamespace?: string
  readonly running?: boolean
  readonly record: HomeLockRecord
  readonly answer: (system: FakeSystem) => ResponseLine[]
  readonly onSignal?: (system: FakeSystem, signal: StopSignal) => void
  /** Runs at every read of the clock, to change the system between two steps of the command. */
  readonly onNow?: (system: FakeSystem) => void
}): Promise<{ code: number | undefined, stdout: string, stderr: string, system: FakeSystem }> {
  const live: ReadonlyArray<[number, string | undefined]> = options.running === false ? [] : [[PID, options.record.processStart ?? START]]
  const system: FakeSystem = { processes: new Map(live), lock: options.record, signals: [], requests: [], time: 0, events: [] }
  const dependencies: StopDependencies = {
    send: async (_home, _profile, request, exchange) => {
      system.requests.push({ request, options: exchange })
      return options.answer(system)
    },
    readLock: () => {
      system.events.push('lock')
      if (system.lock instanceof Error) throw system.lock
      return system.lock
    },
    processes: {
      platform: options.platform ?? 'linux',
      exists: pid => system.processes.has(pid),
      start: (pid) => {
        system.events.push('start')
        return system.processes.get(pid)
      },
      pidNamespace: () => options.ownNamespace ?? NAMESPACE,
    },
    kill: (pid, signal) => {
      system.events.push(signal)
      system.signals.push({ pid, signal, at: system.time })
      options.onSignal?.(system, signal)
    },
    now: () => {
      options.onNow?.(system)
      return system.time
    },
    sleep: async (ms) => { system.time += ms },
  }
  let stdout = ''
  let stderr = ''
  const code = await createStopCommand(dependencies).run(args, {
    env: { DELO_HOME: deloHome },
    stdout: (text) => { stdout += text },
    stderr: (text) => { stderr += text },
  })
  return { code, stdout, stderr, system }
}

/**
 * An update channel that does not answer.
 * @returns never; it throws the client's deadline error.
 */
function silent(): ResponseLine[] {
  throw new Error(`the home process did not answer within ${String(STOP_NOW_ANSWER_MS)} ms`)
}

/**
 * A process that exits on the given signal and releases the lock as its exit listener does.
 * @param exitOn - the signal it exits on.
 * @returns the signal handler.
 */
function exitsOn(exitOn: StopSignal): (system: FakeSystem, signal: StopSignal) => void {
  return (system, signal) => {
    if (signal !== exitOn) return
    system.processes.delete(PID)
    system.lock = undefined
  }
}

describe('delorun stop --now', () => {
  it('ends a confirmed lock holder that does not answer with SIGTERM, and reports that it exited', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent, onSignal: exitsOn('SIGTERM') })
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.requests).toEqual([{ request: { op: 'stop', args: { mode: 'cancel' } }, options: expect.objectContaining({ timeoutMs: STOP_NOW_ANSWER_MS }) as ExchangeOptions }])
    expect(run.system.signals).toEqual([{ pid: PID, signal: 'SIGTERM', at: 0 }])
    expect(run.stdout).toContain(`Process ${String(PID)} did not answer the stop over its update channel`)
    expect(run.stdout).toContain(`Process ${String(PID)} exited after SIGTERM. Delo stopped for the profile default.`)
  })

  it('sends SIGKILL once the grace after SIGTERM passes for a confirmed holder that ignores SIGTERM', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent, onSignal: exitsOn('SIGKILL') })
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(run.system.signals[1]!.at).toBeGreaterThanOrEqual(STOP_TERM_GRACE_MS)
    expect(run.system.signals[1]!.at).toBeLessThan(STOP_TERM_GRACE_MS + 1_000)
    expect(run.stdout).toContain(`had not exited ${String(STOP_TERM_GRACE_MS / 1000)} seconds after SIGTERM; sent it SIGKILL.`)
    expect(run.stdout).toContain('exited after SIGKILL. Delo stopped for the profile default.')
  })

  it('reports a confirmed holder that survives SIGKILL as a failure', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals.map(({ signal }) => signal)).toEqual(['SIGTERM', 'SIGKILL'])
    expect(run.stderr).toContain(`process ${String(PID)} still runs ${String(STOP_KILL_WAIT_MS / 1000)} seconds after SIGKILL`)
  })

  it('ends by signal a confirmed holder that accepted the stop but had not exited after the stop\'s wait', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => [{ ok: true }], onSignal: exitsOn('SIGTERM') })
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.signals).toEqual([{ pid: PID, signal: 'SIGTERM', at: expect.any(Number) as number }])
    expect(run.system.signals[0]!.at).toBeGreaterThanOrEqual(START_WAIT_MS)
    expect(run.stdout).toContain(`accepted the stop but had not exited ${String(START_WAIT_MS / 1000)} seconds later; sent it SIGTERM.`)
  })

  it('ends by signal a confirmed holder that closes its update channel without answering', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => [], onSignal: exitsOn('SIGTERM') })
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.signals.map(({ signal }) => signal)).toEqual(['SIGTERM'])
    expect(run.stdout).toContain('closed its update channel without answering the stop; sent it SIGTERM.')
  })

  it('sends no signal when the home process answers and exits', async () => {
    const run = await stop(['--now'], {
      record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }),
      answer: (system) => {
        system.processes.delete(PID)
        system.lock = undefined
        return [{ ok: true, state: 'stopping', chats: 0 }, { ok: true }]
      },
    })
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.signals).toEqual([])
    expect(run.stdout).toBe('Delo stopped for the profile default.\n')
  })

  it('refuses to signal a live process whose start identity differs from the lock\'s', async () => {
    const run = await stop(['--now'], {
      record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }),
      answer: (system) => {
        // The holder exits and another process takes its id while the request waits.
        system.processes.set(PID, `linux:${BOOT_ID}:2000`)
        return silent()
      },
    })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`process ${String(PID)} did not answer the stop over its update channel`)
    expect(run.stderr).toContain(`Delo did not send it SIGTERM: process ${String(PID)} has another start identity than the profile's lock records`)
  })

  // The property this change guards: without a recorded start identity a reused process id cannot be told apart, so
  // this spec fails if a holder is signalled on its process id alone.
  it('refuses to signal a holder whose lock records no start identity, on a platform that reads one', async () => {
    const run = await stop(['--now'], { record: lockRecord({ pidNamespace: NAMESPACE }), answer: silent })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`Delo did not send it SIGTERM: the profile's lock records no start identity for process ${String(PID)}`)
    expect(run.stderr).toContain(`Check that process ${String(PID)} is delorun's home process before ending it yourself.`)
  })

  it('refuses to signal a holder recorded in another pid namespace', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: 'pid:[1]' }), answer: silent })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`records process ${String(PID)} in the pid namespace pid:[1], and this command's is ${NAMESPACE}`)
  })

  it('refuses to signal on Windows, which records no start identity', async () => {
    const run = await stop(['--now'], { platform: 'win32', record: lockRecord({}), answer: silent })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`on win32 Delo records no start identity for a process, so it cannot tell the home process from another process that reuses the id ${String(PID)}`)
  })

  it('refuses to signal a holder whose lock cannot be read', async () => {
    const run = await stop(['--now'], {
      record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }),
      answer: (system) => {
        system.lock = new Error('not a home lock record')
        return silent()
      },
    })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain('the profile\'s lock cannot be read: not a home lock record')
  })

  it('does not send SIGKILL once the lock no longer names the holder that ignored SIGTERM', async () => {
    const record = lockRecord({ processStart: START, pidNamespace: NAMESPACE })
    const run = await stop(['--now'], {
      record,
      answer: silent,
      onSignal: (system) => { system.lock = { ...record, pid: PID + 1, startId: brandString<StartId>('b'.repeat(32)) } },
    })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals.map(({ signal }) => signal)).toEqual(['SIGTERM'])
    expect(run.stderr).toContain(`Delo did not send it SIGKILL: the profile's lock no longer names process ${String(PID)}; it names process ${String(PID + 1)}`)
  })

  it('sends no signal to a home process that refuses the stop', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => [{ ok: false, error: 'UPDATE_IN_PROGRESS' }] })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain('the home process refused to stop: UPDATE_IN_PROGRESS')
  })
})

describe('delorun stop --now, after a signal', () => {
  it('reads a holder whose process id another process took after SIGTERM as gone, and sends it no SIGKILL', async () => {
    let replaced = false
    const run = await stop(['--now'], {
      record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }),
      answer: silent,
      // The process id changes hands at the last clock read of the SIGTERM wait, after the wait saw the holder run.
      onNow: (system) => {
        if (replaced || system.time < STOP_TERM_GRACE_MS || system.signals.length === 0) return
        replaced = true
        system.processes.set(PID, `linux:${BOOT_ID}:2000`)
      },
    })
    expect(replaced).toBe(true)
    expect(run.code).toBe(EXIT.ok)
    expect(run.system.signals.map(({ signal }) => signal)).toEqual(['SIGTERM'])
    expect(run.stdout).toContain('Delo stopped for the profile default.')
    expect(run.stderr).toBe('')
  })

  it('reads the lock first and checks the holder immediately before each signal', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent, onSignal: exitsOn('SIGKILL') })
    const events = run.system.events
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const at = events.indexOf(signal)
      expect(events.slice(at - 2, at + 1)).toEqual(['lock', 'start', signal])
    }
  })

  it('says after SIGKILL that commands Delorun started may still be running', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent, onSignal: exitsOn('SIGKILL') })
    expect(run.stdout).toContain('sent it SIGKILL.\nCommands Delorun started may still be running: a command started in its own systemd scope survives the home process')
  })

  it('does not say it after SIGTERM alone', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent, onSignal: exitsOn('SIGTERM') })
    expect(run.stdout).not.toContain('Commands Delorun started')
  })
})

describe('delorun stop with a holder whose start identity cannot be read', () => {
  it('sends the request, signals nothing and names the unreadable start identity once the home process does not answer', async () => {
    const run = await stop(['--now'], {
      record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }),
      answer: (system) => {
        // The process still exists, but reading its start identity fails now.
        system.processes.set(PID, undefined)
        return silent()
      },
    })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.requests).toHaveLength(1)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`Delo did not send it SIGTERM: the start identity of process ${String(PID)} cannot be read now`)
    expect(run.stderr).toContain(`Check that process ${String(PID)} is delorun's home process before ending it yourself.`)
  })
})

describe('delorun stop output from the home process', () => {
  const KEY = ['sk', '0123456789abcdef0123456789abcdef'].join('-')

  it('redacts a provider key in the error and the detail of a refused stop', async () => {
    const run = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => [{ ok: false, error: `BAD ${KEY}`, detail: `key ${KEY}` }] })
    expect(run.code).toBe(EXIT.failed)
    expect(run.stderr).toContain('the home process refused to stop: BAD [redacted:provider-key] (key [redacted:provider-key])')
    expect(run.stderr).not.toContain(KEY)
  })

  it('redacts a provider key in the error of a stop request that fails', async () => {
    const drain = await stop([], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => { throw new Error(`socket said ${KEY}`) } })
    expect(drain.stderr).toContain('its update channel did not answer: socket said [redacted:provider-key]')
    expect(drain.stderr).not.toContain(KEY)
    const now = await stop(['--now'], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => { throw new Error(`socket said ${KEY}`) }, onSignal: exitsOn('SIGTERM') })
    expect(now.stdout).toContain('(socket said [redacted:provider-key])')
    expect(now.stdout).not.toContain(KEY)
  })
})

describe('delorun stop', () => {
  it('sends no signal and sets no answer deadline when a drain stop is not answered', async () => {
    const run = await stop([], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.requests[0]!.request).toEqual({ op: 'stop', args: { mode: 'drain' } })
    expect(run.system.requests[0]!.options?.timeoutMs).toBeUndefined()
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`process ${String(PID)} holds the profile's lock but its update channel did not answer`)
  })

  it('sends no signal when a drain stop is accepted but the home process has not exited after the stop\'s wait', async () => {
    const run = await stop([], { record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: () => [{ ok: true }] })
    expect(run.code).toBe(EXIT.failed)
    expect(run.system.signals).toEqual([])
    expect(run.stderr).toContain(`process ${String(PID)} accepted the stop but has not exited`)
  })

  it('prints that Delo is not running, and sends nothing, when the lock\'s holder has exited', async () => {
    const run = await stop(['--now'], { running: false, record: lockRecord({ processStart: START, pidNamespace: NAMESPACE }), answer: silent })
    expect(run.code).toBe(EXIT.ok)
    expect(run.stdout).toBe('Delo is not running for the profile default.\n')
    expect(run.system.requests).toEqual([])
    expect(run.system.signals).toEqual([])
  })
})
