/**
 * The handshake's session-data copy and its way back (contract C3, "Data formats" and "Rollback"): the copy is taken
 * after the Host stopped and before the switch; `targetStarted` is recorded before the successor starts; an
 * automatic rollback goes through the one rollback function, which may refuse; the person's `rollback` reads the
 * update record; a rollback marks the record `rolling-back` before its first step and never runs the Host it left
 * once a step may have run; the previous update's committed record survives an update that does not commit; and
 * another process on the chat data refuses an update both before its record is written and right before the Host stops.
 */
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoverMessage, UpdateJournal } from '@delo/contract-home-process'
import { CountingChatGate, HomeProcessError, journalPath, readJournal, stashPath, startSuccessor, UpdateHandshake, writeJournal, type HandoverLine, type HandshakeSubject, type Successor } from '../src/index.ts'
import type { HostProtection } from '../src/index.ts'
import { FixtureCopies, FixtureSnapshots, FixtureStore, installFixture, MemoryLogger, PROFILE, readPointer, REPOSITORY, tempHome, V0, V1, V2, type TempHome } from './support.ts'

/** The sandbox protection the running Host booted with. */
const PROTECTION: HostProtection = { protectedHome: '/h', protectedHomeReadable: ['runtimes'], deniedSockets: ['/h/run/default/update.sock'], escapeSocketDirectories: ['/run/WSL'] }

let temp: TempHome | undefined
const successors: Successor[] = []
afterEach(async () => {
  for (const successor of successors.splice(0)) await successor.stop()
  temp?.remove()
  temp = undefined
})

/** How the fake successor behaves: it answers as told, or the spec starts a real process. */
interface SetUpOptions {
  readonly running?: typeof V1
  readonly answer?: HandoverMessage['type']
  readonly dataDiffers?: boolean
  readonly successor?: (handover: HandoverLine) => Successor
  /** The Host's teardown for the switch, which the subject's `suspend` runs after it records the call. */
  readonly hostStop?: () => Promise<void>
  /** The Host's boot after a failed switch, which the subject's `resume` runs after it records the call. */
  readonly hostBoot?: () => Promise<void>
}

/** A handshake over a fixture store and copies, with a successor that answers as told. */
async function setUp(options: SetUpOptions = {}) {
  temp = await tempHome()
  const home = temp.home
  const running = options.running ?? V1
  installFixture(home, V0)
  installFixture(home, V1)
  installFixture(home, V2, { dataDiffers: options.dataDiffers ?? true })
  await FixtureStore.seed(home, running, running === V1 ? V0 : V1)
  const events: string[] = []
  const handovers: HandoverLine[] = []
  const gate = new CountingChatGate()
  const store = new FixtureStore(home, PROFILE)
  const snapshots = new FixtureSnapshots()
  const copies = new FixtureCopies(snapshots)
  const journal = journalPath(home, PROFILE)
  // As in the home process, the Host's rows are known only while it runs.
  let hostRuns = true
  const logger = new MemoryLogger()
  const subject: HandshakeSubject = {
    running, home, profile: PROFILE, journal, logger,
    chats: () => gate,
    setState: (state) => { events.push(`state:${state}`) },
    suspend: async (limitS) => {
      hostRuns = false
      events.push(`suspend copies=${copies.calls.join(',')} limit=${String(limitS)}`)
      await options.hostStop?.()
    },
    resume: async () => {
      hostRuns = true
      events.push('resume')
      await options.hostBoot?.()
    },
    startSuccessor: (handover): Successor => {
      handovers.push(handover)
      const record = (existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : {}) as { readonly targetStarted?: boolean }
      events.push(`start ${handover.to} targetStarted=${String(record.targetStarted)} switches=${store.switches.join(',')} copies=${copies.calls.join(',')}`)
      if (options.successor !== undefined) return options.successor(handover)
      const answer: HandoverMessage = (options.answer ?? 'ready') === 'ready' ? { type: 'ready' } : { type: 'failed', reason: 'HEALTH_CHECK_FAILED' }
      return { pid: 4242, result: Promise.resolve(answer), commit: async () => {}, stop: async () => { events.push('stop successor') } }
    },
    handOver: () => { events.push('handOver') },
    failedRows: () => (hostRuns ? [{ id: 'row-that-failed-before', name: 'plugin-f', generated: false }] : []),
    rows: () => (hostRuns ? [{ id: 'row-a', name: 'plugin-a', generated: false }, { id: 'b08ab057', name: 'plugin-b', generated: true }] : []),
    protection: () => (hostRuns ? PROTECTION : undefined),
  }
  const handshake = new UpdateHandshake(subject, { store, snapshots, copies })
  return { home, events, handovers, store, snapshots, copies, handshake, journal, gate, logger }
}

/** Prepare and apply an update to V2. */
async function update(handshake: UpdateHandshake, dataCopy: boolean, wait: 'drain' | 'abort-if-busy' = 'drain') {
  const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
  return handshake.apply(reportId, wait, undefined, dataCopy, () => {})
}

/** The committed record of an update from V0 to V1, which a process on V1 keeps for a later rollback. */
const EARLIER: UpdateJournal = { v: 1, from: V0, to: V1, phase: 'committed', startedAt: '2026-11-01T00:00:00.000Z', dataDiffers: false, copy: false, targetStarted: true }

async function recordEarlierUpdate(journal: string): Promise<void> {
  await writeJournal(journal, { ...EARLIER, previous: undefined }, 'committed')
}

describe('an update with a session-data copy', () => {
  it('takes the copy after the Host stopped and before the switch, and records targetStarted before the successor starts', async () => {
    const { handshake, events, journal } = await setUp()
    expect(await update(handshake, true)).toEqual({ outcome: 'committed' })
    expect(events).toContain('suspend copies=plan limit=1800')
    expect(events).toContain(`start ${V2} targetStarted=true switches=${V1}>${V2} copies=plan,save:${V1}>${V2}`)
    expect(await readJournal(journal)).toMatchObject({ dataDiffers: true, copy: true, targetStarted: true })
  })

  it('holds the successor to what the running Host had at boot, read before that Host stopped', async () => {
    const { handshake, handovers } = await setUp()
    await update(handshake, true)
    expect(handovers[0]?.health).toEqual({ disabledPlugins: [], namedRows: [], previousFailures: [{ id: 'row-that-failed-before', name: 'plugin-f', generated: false }], previousRows: [{ id: 'row-a', name: 'plugin-a', generated: false }, { id: 'b08ab057', name: 'plugin-b', generated: true }], previousProtection: PROTECTION })
  })

  it('records the profile history version and the health expectations, so a start that finishes it runs H1 to H5', async () => {
    const { handshake, journal } = await setUp()
    await update(handshake, true)
    expect(await readJournal(journal)).toMatchObject({ snapshot: `snapshot-${V1}-${V2}`, health: { disabledPlugins: [], namedRows: [] } })
  })

  it('refuses before anything changes when the copy does not fit', async () => {
    const { handshake, copies, snapshots, store, home, journal } = await setUp()
    copies.noSpace = true
    await expect(update(handshake, true)).rejects.toMatchObject({ code: 'DATA_COPY_NO_SPACE' })
    expect(snapshots.calls).toEqual([])
    expect(store.switches).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(await readJournal(journal)).toBeUndefined()
    expect(handshake.running()).toBe(false)
  })

  it('runs the Host again, discards the unfinished copy and ends aborted when the copy cannot be written', async () => {
    const { handshake, copies, events, store } = await setUp()
    copies.save = async () => { throw new Error('disk gone') }
    await expect(update(handshake, true)).rejects.toThrow('disk gone')
    expect(events).toContain('resume')
    expect(copies.calls).toContain(`discard:${V2}`)
    expect(store.switches).toEqual([])
  })
})

describe('the previous update\'s committed record', () => {
  it('returns when an update ends before the switch', async () => {
    const { handshake, journal, gate } = await setUp()
    await recordEarlierUpdate(journal)
    const end = gate.begin(() => {})
    expect(await update(handshake, false, 'abort-if-busy')).toEqual({ outcome: 'aborted', reason: 'CHATS_RUNNING' })
    end()
    expect(await readJournal(journal)).toEqual(EARLIER)
    expect(existsSync(stashPath(journal))).toBe(false)
  })

  it('returns when an update is rolled back automatically', async () => {
    const { handshake, journal } = await setUp({ answer: 'failed' })
    await recordEarlierUpdate(journal)
    expect(await update(handshake, true)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(await readJournal(journal)).toEqual(EARLIER)
    expect(existsSync(stashPath(journal))).toBe(false)
  })

  it('waits in the stash while the successor takes over', async () => {
    const { handshake, journal } = await setUp()
    await recordEarlierUpdate(journal)
    expect(await update(handshake, false)).toEqual({ outcome: 'committed' })
    expect(await readJournal(journal)).toMatchObject({ from: V1, to: V2, phase: 'health-check' })
    expect(await readJournal(stashPath(journal))).toEqual(EARLIER)
  })
})

describe('the automatic rollback', () => {
  it('runs when the switch itself fails, and the failure reaches the requester', async () => {
    const { handshake, store, copies, home } = await setUp()
    store.switchTo = async () => { throw new Error('the pointer write failed') }
    await expect(update(handshake, true)).rejects.toThrow('the pointer write failed')
    expect(copies.calls.at(-1)).toBe(`rollback:${V1}>${V2}`)
    expect(readPointer(home, 'current')).toBe(V1)
  })

  it('goes through the rollback function and restores the pointers when the copy exists', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ answer: 'failed' })
    expect(await update(handshake, true)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(copies.calls.at(-1)).toBe(`rollback:${V1}>${V2}`)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V0)
    expect(events.at(-2)).toBe('resume')
    expect(await readJournal(journal)).toBeUndefined()
  })

  it('is refused by the table when the data differs and no copy was taken: the record says so, the target stays and the process stops serving', async () => {
    const { handshake, events, home, journal } = await setUp({ answer: 'failed' })
    expect(await update(handshake, false)).toEqual({ outcome: 'failed', reason: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect(handshake.failed).toBe(true)
    expect(events).not.toContain('resume')
    expect(events).toContain('state:stopping')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'health-check', targetStarted: true, copy: false, refused: true })
  })

  it('marks the record rolling-back before its first step, and stops serving without running the Host when a step fails', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ answer: 'failed' })
    copies.failAt = 'data'
    expect(await update(handshake, true)).toEqual({ outcome: 'failed' })
    expect(handshake.failed).toBe(true)
    expect(events).not.toContain('resume')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'rolling-back', from: V1, to: V2 })
  })

  it('needs no copy when the data does not differ', async () => {
    const { handshake, home } = await setUp({ answer: 'failed', dataDiffers: false })
    expect(await update(handshake, false)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
  })
})

describe('C3\'s rollback triggers T2 and T3', () => {
  /**
   * A real successor process from a script, given a short time to answer.
   * @param script - what the process runs.
   * @param timeoutMs - the time it has to answer.
   */
  function realSuccessor(script: string, timeoutMs: number): (handover: HandoverLine) => Successor {
    return (handover) => {
      const successor = startSuccessor({ command: process.execPath, args: ['-e', script], cwd: REPOSITORY }, handover, timeoutMs)
      successors.push(successor)
      return successor
    }
  }

  it('T2: a successor silent past the limit is stopped and rolled back through the rollback function', async () => {
    const { handshake, copies, home, events } = await setUp({ successor: realSuccessor('setInterval(() => {}, 1000)', 500) })
    expect(await update(handshake, true)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(copies.calls.at(-1)).toBe(`rollback:${V1}>${V2}`)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(events.at(-2)).toBe('resume')
  })

  it('T3: a successor whose process exits during the health check is rolled back through the rollback function', async () => {
    const { handshake, copies, home, events } = await setUp({ successor: realSuccessor('setTimeout(() => process.exit(3), 100)', 60_000) })
    expect(await update(handshake, true)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(copies.calls.at(-1)).toBe(`rollback:${V1}>${V2}`)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(events.at(-2)).toBe('resume')
  })
})

describe('the person\'s rollback', () => {
  /** Record a committed update from V1 to V2 that this process, on V2, runs. */
  async function committed(journal: string, copy: boolean): Promise<void> {
    await writeJournal(journal, { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: true, copy, targetStarted: true }, 'committed')
  }

  it('without a committed update record is refused with NO_UPDATE_RECORD', async () => {
    const { handshake } = await setUp({ running: V2 })
    await expect(handshake.rollback('drain', undefined, false, () => {})).rejects.toMatchObject({ code: 'NO_UPDATE_RECORD' })
    expect(handshake.running()).toBe(false)
  })

  it('applies the table, starts the version rolled back to and passes on what the table tells the person, leaving the record rolling-back for that version to remove', async () => {
    const { handshake, copies, events, home, journal, handovers, logger } = await setUp({ running: V2 })
    copies.copies.add(V2)
    await committed(journal, true)
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'rolled-back', lines: ['Went back to 1.0.0; 1 chat(s) set aside.'] })
    // The version rolled back to may protect less than the one it replaced; it is not held to the running Host's protection.
    expect(handovers[0]?.health).not.toHaveProperty('previousProtection')
    // The home log records each phase of the rollback, as it does an update's, and the commit.
    expect(logger.records.filter(record => record.startsWith('info rollback '))).toEqual([
      ...['reporting', 'waiting', 'switching', 'health-check'].map(phase => `info rollback phase ${JSON.stringify({ phase, from: V2, to: V1 })}`),
      `info rollback committed ${JSON.stringify({ from: V2, to: V1, successor: 4242 })}`,
    ])
    expect(copies.calls).toEqual([`rollback:${V1}>${V2}`])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V2)
    expect(events).toContain('handOver')
    expect(await readJournal(journal)).toMatchObject({ from: V1, to: V2, phase: 'rolling-back' })
    expect(handshake.committed?.pid).toBe(4242)
  })

  it('is refused by the table without a copy, and the Host runs again with nothing changed', async () => {
    const { handshake, events, home, journal } = await setUp({ running: V2 })
    await committed(journal, false)
    await expect(handshake.rollback('drain', undefined, false, () => {})).rejects.toMatchObject({ code: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect(events.at(-2)).toBe('resume')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'committed' })
  })

  it('is refused when the version rolled back to is unusable, and the Host runs again with nothing changed', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2 })
    copies.copies.add(V2)
    copies.unusable = true
    await committed(journal, true)
    await expect(handshake.rollback('drain', undefined, false, () => {})).rejects.toMatchObject({ code: 'ROLLBACK_TARGET_UNUSABLE' })
    expect(events.at(-2)).toBe('resume')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'committed' })
  })

  it('stops this process without running its Host again when a step fails after the rollback began', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2 })
    copies.copies.add(V2)
    copies.failAt = 'data'
    await committed(journal, true)
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'failed' })
    expect(handshake.failed).toBe(true)
    expect(events).not.toContain('resume')
    expect(events).toContain('state:stopping')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'rolling-back' })
  })

  it('with profileOnly restores the profile, keeps the runtime and runs the Host again', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2 })
    await committed(journal, false)
    expect(await handshake.rollback('drain', undefined, true, () => {})).toEqual({ outcome: 'rolled-back', lines: ['Went back on the profile alone to 1.0.0.'] })
    expect(copies.calls).toEqual([`rollback:${V1}>${V2}:profile-only`])
    expect(readPointer(home, 'current')).toBe(V2)
    expect(events.at(-2)).toBe('resume')
    expect(await readJournal(journal)).toBeUndefined()
  })

  it('stops with the pointers on the version rolled back to when that version fails its health check', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2, answer: 'failed' })
    copies.copies.add(V2)
    await committed(journal, true)
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'failed', reason: 'HEALTH_CHECK_FAILED' })
    expect(events).toContain('stop successor')
    expect(events).not.toContain('resume')
    expect(handshake.failed).toBe(true)
    expect(readPointer(home, 'current')).toBe(V1)
    expect(await readJournal(journal)).toMatchObject({ phase: 'rolling-back' })
  })

  it('with abort-if-busy ends aborted while a chat runs, changing nothing', async () => {
    const { handshake, journal, gate, copies } = await setUp({ running: V2 })
    await committed(journal, true)
    const end = gate.begin(() => {})
    expect(await handshake.rollback('abort-if-busy', undefined, false, () => {})).toEqual({ outcome: 'aborted', reason: 'CHATS_RUNNING' })
    expect(copies.calls).toEqual([])
    end()
  })
})

describe('a Host that does not stop for the switch', () => {
  const notStopped = (): Promise<void> => Promise.reject(new HomeProcessError('HOST_STOP_FAILED', 'the Host did not stop within 1800 seconds; nothing was switched'))

  it('ends the update aborted with HOST_STOP_FAILED before any copy or switch, removes its record and runs the Host again', async () => {
    const { handshake, copies, events, store, home, journal } = await setUp({ hostStop: notStopped })
    await recordEarlierUpdate(journal)
    expect(await update(handshake, true)).toEqual({ outcome: 'aborted', reason: 'HOST_STOP_FAILED' })
    expect(copies.calls).toEqual(['plan'])
    expect(store.switches).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(events.at(-1)).toBe('resume')
    // The previous update's committed record returns, as for an update that ended before the switch.
    expect(await readJournal(journal)).toEqual(EARLIER)
    expect(existsSync(stashPath(journal))).toBe(false)
    expect(handshake.running()).toBe(false)
  })

  it('still ends the update with nothing switched when the Host does not boot again either', async () => {
    const { handshake, store, journal } = await setUp({ hostStop: notStopped, hostBoot: () => Promise.reject(new Error('the port is still held')) })
    expect(await update(handshake, false)).toEqual({ outcome: 'aborted', reason: 'HOST_STOP_FAILED' })
    expect(store.switches).toEqual([])
    expect(await readJournal(journal)).toBeUndefined()
  })

  it('ends the person\'s rollback aborted with HOST_STOP_FAILED before any step, keeping the committed record', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2, hostStop: notStopped })
    await writeJournal(journal, { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: true, copy: true, targetStarted: true }, 'committed')
    expect(await handshake.rollback('drain', 600, false, () => {})).toEqual({ outcome: 'aborted', reason: 'HOST_STOP_FAILED' })
    expect(events).toContain(`suspend copies= limit=600`)
    expect(copies.calls).toEqual([])
    expect(readPointer(home, 'current')).toBe(V2)
    expect(events.at(-1)).toBe('resume')
    expect(await readJournal(journal)).toMatchObject({ from: V1, to: V2, phase: 'committed' })
    expect(handshake.running()).toBe(false)
  })
})

describe('a version that fails its check before a start', () => {
  it('ends an update aborted with VERIFY_FAILED before the Host stops, with nothing switched', async () => {
    const { handshake, events, home, store, journal } = await setUp()
    store.launchRefused = V2
    await recordEarlierUpdate(journal)
    expect(await update(handshake, true)).toEqual({ outcome: 'aborted', reason: 'VERIFY_FAILED' })
    expect(store.switches).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(events.some(event => event.startsWith('suspend'))).toBe(false)
    expect(await readJournal(journal)).toEqual(EARLIER)
  })

  it('ends the person\'s rollback aborted with VERIFY_FAILED before any step, keeping the committed record', async () => {
    const { handshake, journal, store, events } = await setUp({ running: V2 })
    store.launchRefused = V1
    await writeJournal(journal, { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'aborted', reason: 'VERIFY_FAILED' })
    expect(events.some(event => event.startsWith('suspend'))).toBe(false)
    expect(await readJournal(journal)).toMatchObject({ phase: 'committed' })
  })
})

describe('another process on the chat data', () => {
  it('refuses an update without a copy before anything is written', async () => {
    const { handshake, copies, store, journal } = await setUp()
    copies.othersRunning = true
    await expect(update(handshake, false)).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
    expect(store.switches).toEqual([])
    expect(await readJournal(journal)).toBeUndefined()
  })

  it.each([true, false])('refuses an update with dataCopy %s when a process registered after the plan check, before the Host stops, and unwinds the record', async (dataCopy) => {
    const { handshake, copies, events, store, snapshots, home, journal } = await setUp()
    await recordEarlierUpdate(journal)
    const plan = copies.plan.bind(copies)
    copies.plan = async (copy) => {
      await plan(copy)
      copies.othersRunning = true
    }
    let recordAtCheck: UpdateJournal | undefined
    copies.beforeConfirm = async () => { recordAtCheck = await readJournal(journal) }

    await expect(update(handshake, dataCopy)).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
    expect(recordAtCheck).toMatchObject({ from: V1, to: V2, phase: 'switching', copy: dataCopy })
    expect(snapshots.calls).toEqual([`save:${V1}>${V2}`])
    expect(events.some(event => event.startsWith('suspend'))).toBe(false)
    expect(events.at(-1)).toBe('state:running')
    expect(store.switches).toEqual([])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(copies.calls).toEqual(dataCopy ? ['plan'] : [])
    expect(await readJournal(journal)).toEqual(EARLIER)
    expect(existsSync(stashPath(journal))).toBe(false)
    expect(handshake.running()).toBe(false)
  })

  it('refuses the person\'s rollback before any step, and the Host runs again', async () => {
    const { handshake, copies, events, journal } = await setUp({ running: V2 })
    await writeJournal(journal, { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    copies.othersRunning = true
    await expect(handshake.rollback('drain', undefined, false, () => {})).rejects.toMatchObject({ code: 'CHATS_RUNNING' })
    expect(events.at(-2)).toBe('resume')
    expect(await readJournal(journal)).toMatchObject({ phase: 'committed' })
  })

  it('refuses the person\'s rollback, the profile-only one too, before any step when git cannot run, and the Host runs again', async () => {
    const { handshake, copies, events, journal } = await setUp({ running: V2 })
    await writeJournal(journal, { from: V1, to: V2, previous: V0, startedAt: new Date().toISOString(), dataDiffers: false, copy: false, targetStarted: true }, 'committed')
    copies.gitMissing = true
    for (const profileOnly of [false, true]) {
      await expect(handshake.rollback('drain', undefined, profileOnly, () => {})).rejects.toMatchObject({ code: 'GIT_UNAVAILABLE' })
      expect(events.at(-2)).toBe('resume')
      expect(await readJournal(journal)).toMatchObject({ phase: 'committed' })
    }
  })

  it('stops an automatic rollback before any step, leaving the record for the next start', async () => {
    const { handshake, copies, journal } = await setUp({ answer: 'failed', dataDiffers: false })
    const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
    copies.save = async () => { copies.othersRunning = true }
    expect(await handshake.apply(reportId, 'drain', undefined, true, () => {})).toEqual({ outcome: 'failed', reason: 'CHATS_RUNNING' })
    expect(await readJournal(journal)).toMatchObject({ phase: 'health-check' })
  })

  it('stops an automatic rollback before any step when git cannot run, leaving the record for the next start', async () => {
    const { handshake, copies, journal } = await setUp({ answer: 'failed', dataDiffers: false })
    const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
    copies.save = async () => { copies.gitMissing = true }
    expect(await handshake.apply(reportId, 'drain', undefined, true, () => {})).toEqual({ outcome: 'failed', reason: 'GIT_UNAVAILABLE' })
    expect(await readJournal(journal)).toMatchObject({ phase: 'health-check' })
  })
})
