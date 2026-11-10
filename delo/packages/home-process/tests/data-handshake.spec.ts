/**
 * The handshake's session-data copy and its way back (contract C3, "Data formats" and "Rollback"): the copy is taken
 * after the Host stopped and before the switch; `targetStarted` is recorded before the successor starts; an
 * automatic rollback goes through the one rollback function, which may refuse; and the person's `rollback` reads the
 * update record.
 */
import { existsSync, readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import type { HandoverMessage } from '@delo/contract-home-process'
import { CountingChatGate, journalPath, readJournal, UpdateHandshake, writeJournal, type HandoverLine, type HandshakeSubject, type Successor } from '../src/index.ts'
import { FixtureCopies, FixtureSnapshots, FixtureStore, installFixture, MemoryLogger, PROFILE, readPointer, tempHome, V0, V1, V2, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  temp?.remove()
  temp = undefined
})

/** A handshake over a fixture store and copies, with a successor that answers as told. */
async function setUp(options: { readonly running?: typeof V1, readonly answer?: HandoverMessage['type'], readonly dataDiffers?: boolean } = {}) {
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
  const subject: HandshakeSubject = {
    running, home, profile: PROFILE, journal, logger: new MemoryLogger(),
    chats: () => gate,
    setState: (state) => { events.push(`state:${state}`) },
    suspend: async () => { events.push(`suspend copies=${copies.calls.join(',')}`) },
    resume: async () => { events.push('resume') },
    startSuccessor: (handover): Successor => {
      handovers.push(handover)
      const record = (existsSync(journal) ? JSON.parse(readFileSync(journal, 'utf8')) : {}) as { readonly targetStarted?: boolean }
      events.push(`start ${handover.to} targetStarted=${String(record.targetStarted)} switches=${store.switches.join(',')} copies=${copies.calls.join(',')}`)
      const answer: HandoverMessage = (options.answer ?? 'ready') === 'ready' ? { type: 'ready' } : { type: 'failed', reason: 'HEALTH_CHECK_FAILED' }
      return { pid: 4242, result: Promise.resolve(answer), commit: async () => {}, stop: async () => { events.push('stop successor') } }
    },
    handOver: () => { events.push('handOver') },
    failedRows: () => ['row-that-failed-before'],
  }
  const handshake = new UpdateHandshake(subject, { store, snapshots, copies })
  return { home, events, handovers, store, snapshots, copies, handshake, journal, gate }
}

/** Prepare and apply an update to V2. */
async function update(handshake: UpdateHandshake, dataCopy: boolean) {
  const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
  return handshake.apply(reportId, 'drain', undefined, dataCopy, () => {})
}

describe('an update with a session-data copy', () => {
  it('takes the copy after the Host stopped and before the switch, and records targetStarted before the successor starts', async () => {
    const { handshake, events, handovers, journal } = await setUp()
    expect(await update(handshake, true)).toEqual({ outcome: 'committed' })
    expect(events).toContain('suspend copies=plan')
    expect(events).toContain(`start ${V2} targetStarted=true switches=${V1}>${V2} copies=plan,save:${V1}>${V2}`)
    expect(handovers[0]?.health).toEqual({ disabledPlugins: [], namedRows: [], previousFailures: ['row-that-failed-before'] })
    expect(await readJournal(journal)).toMatchObject({ dataDiffers: true, copy: true, targetStarted: true })
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

  it('runs the Host again and ends aborted when the copy cannot be written', async () => {
    const { handshake, copies, events, store } = await setUp()
    copies.save = async () => { throw new Error('disk gone') }
    await expect(update(handshake, true)).rejects.toThrow('disk gone')
    expect(events).toContain('resume')
    expect(store.switches).toEqual([])
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

  it('is refused by the table when the data differs and no copy was taken: the target stays and the process stops serving', async () => {
    const { handshake, events, home, journal } = await setUp({ answer: 'failed' })
    expect(await update(handshake, false)).toEqual({ outcome: 'failed', reason: 'ROLLBACK_NEEDS_DATA_COPY' })
    expect(handshake.failed).toBe(true)
    expect(events).not.toContain('resume')
    expect(events).toContain('state:stopping')
    expect(readPointer(home, 'current')).toBe(V2)
    expect(await readJournal(journal)).toMatchObject({ phase: 'health-check', targetStarted: true, copy: false })
  })

  it('needs no copy when the data does not differ', async () => {
    const { handshake, home } = await setUp({ answer: 'failed', dataDiffers: false })
    expect(await update(handshake, false)).toEqual({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    expect(readPointer(home, 'current')).toBe(V1)
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

  it('applies the table, removes the record and starts the version rolled back to', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2 })
    copies.copies.add(V2)
    await committed(journal, true)
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'rolled-back' })
    expect(copies.calls).toEqual([`rollback:${V1}>${V2}`])
    expect(readPointer(home, 'current')).toBe(V1)
    expect(readPointer(home, 'previous')).toBe(V2)
    expect(events).toContain('handOver')
    expect(await readJournal(journal)).toBeUndefined()
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

  it('with profileOnly restores the profile, keeps the runtime and runs the Host again', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2 })
    await committed(journal, false)
    expect(await handshake.rollback('drain', undefined, true, () => {})).toEqual({ outcome: 'rolled-back' })
    expect(copies.calls).toEqual([`rollback:${V1}>${V2}:profile-only`])
    expect(readPointer(home, 'current')).toBe(V2)
    expect(events.at(-2)).toBe('resume')
    expect(await readJournal(journal)).toBeUndefined()
  })

  it('runs this runtime again when the version rolled back to fails its health check', async () => {
    const { handshake, copies, events, home, journal } = await setUp({ running: V2, answer: 'failed' })
    copies.copies.add(V2)
    await committed(journal, true)
    expect(await handshake.rollback('drain', undefined, false, () => {})).toEqual({ outcome: 'aborted', reason: 'HEALTH_CHECK_FAILED' })
    expect(events).toContain('stop successor')
    expect(readPointer(home, 'current')).toBe(V2)
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
