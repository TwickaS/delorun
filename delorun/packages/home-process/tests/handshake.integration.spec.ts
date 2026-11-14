/**
 * The handshake's waiting phase on a fake clock: `drain` ends `aborted` with `DRAIN_TIMEOUT` after `drainTimeoutS`
 * with `current` unchanged, and a chat that begins while the gate is held is refused, so the switch never runs while
 * a chat runs. And the harness carry: a change waiting for review refuses the prepare, and a carry that fails before
 * the switch ends the update with nothing switched and the Host running again.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CountingChatGate, HomeProcessError, UpdateHandshake, type HandshakeSubject, type Successor } from '../src/index.ts'
import { FixtureCopies, FixtureHarness, FixtureSnapshots, FixtureStore, installFixture, MemoryLogger, PROFILE, readPointer, tempHome, V1, V2, type TempHome } from './support.ts'

let temp: TempHome | undefined
afterEach(() => {
  vi.useRealTimers()
  temp?.remove()
  temp = undefined
})

/** A subject whose switch is recorded and whose successor is never started. */
function subject(home: string, gate: CountingChatGate, events: string[]): HandshakeSubject {
  return {
    running: V1, home, profile: PROFILE, journal: `${home}/run/${PROFILE}/update.json`, logger: new MemoryLogger(),
    chats: () => gate,
    setState: (state) => { events.push(`state:${state}`) },
    suspend: async () => { events.push('suspend') },
    resume: async () => { events.push('resume') },
    startSuccessor: (): Successor => { throw new Error('the switch ran') },
    handOver: () => { events.push('handOver') },
    failedRows: () => [],
    rows: () => [],
    protection: () => undefined,
  }
}

describe('the waiting phase', () => {
  it('drain ends aborted with DRAIN_TIMEOUT after drainTimeoutS and leaves current unchanged', async () => {
    temp = await tempHome()
    installFixture(temp.home, V2)
    await FixtureStore.seed(temp.home, V1)
    const gate = new CountingChatGate()
    const events: string[] = []
    const store = new FixtureStore(temp.home, PROFILE)
    const snapshots = new FixtureSnapshots()
    const handshake = new UpdateHandshake(subject(temp.home, gate, events), { store, snapshots, copies: new FixtureCopies(snapshots), harness: new FixtureHarness() })
    const end = gate.begin(() => {})
    const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const phases: unknown[] = []
    const applying = handshake.apply(reportId, 'drain', 60, false, (fields) => { phases.push(fields.phase) })
    // The journal is written with real file I/O; the drain's timer starts once `waiting` is announced.
    while (!phases.includes('waiting')) await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setImmediate(resolve))
    expect(events).toContain('state:waiting')
    await vi.advanceTimersByTimeAsync(59_000)
    expect(handshake.update?.phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await applying).toEqual({ outcome: 'aborted', reason: 'DRAIN_TIMEOUT' })
    expect(events).not.toContain('suspend')
    expect(store.switches).toEqual([])
    expect(readPointer(temp.home, 'current')).toBe(V1)
    end()
  })

  it('refuses a chat that begins while the gate is held, and the gate counts only registered chats', () => {
    const gate = new CountingChatGate()
    const release = gate.hold()
    expect(() => gate.begin(() => {})).toThrow(HomeProcessError)
    expect(gate.running()).toBe(0)
    release()
    release()
    const end = gate.begin(() => {})
    expect(gate.running()).toBe(1)
    end()
    end()
    expect(gate.running()).toBe(0)
  })

  it('counts a chat the Host reports as already running even while held, and says whether it is held', () => {
    const gate = new CountingChatGate()
    expect(gate.held).toBe(false)
    const release = gate.hold()
    expect(gate.held).toBe(true)
    const end = gate.track(() => {})
    expect(gate.running()).toBe(1)
    end()
    release()
    expect(gate.held).toBe(false)
  })
})

describe('the harness carry', () => {
  /**
   * A handshake from V1 to V2 over fixture parts.
   * @param harness - the harness carry.
   * @returns the handshake, its events and its store.
   */
  async function handshakeWith(harness: FixtureHarness): Promise<{ handshake: UpdateHandshake, events: string[], store: FixtureStore, copies: FixtureCopies }> {
    temp = await tempHome()
    installFixture(temp.home, V2)
    await FixtureStore.seed(temp.home, V1)
    const events: string[] = []
    const store = new FixtureStore(temp.home, PROFILE)
    const snapshots = new FixtureSnapshots()
    const copies = new FixtureCopies(snapshots)
    return { handshake: new UpdateHandshake(subject(temp.home, new CountingChatGate(), events), { store, snapshots, copies, harness }), events, store, copies }
  }

  it('refuses a prepare with HARNESS_CHANGES_PENDING while a change waits for review, before anything is fetched', async () => {
    const harness = new FixtureHarness()
    harness.pending = true
    const { handshake } = await handshakeWith(harness)
    const phases: unknown[] = []

    await expect(handshake.prepare(V2, (fields) => { phases.push(fields.phase) })).rejects.toMatchObject({ code: 'HARNESS_CHANGES_PENDING' })
    expect(harness.calls).toEqual([`check:${V1}`])
    expect(phases).toEqual([])
    expect(handshake.update).toBeUndefined()
  })

  it('ends an update whose carry fails before the switch with nothing switched, the copy removed and the Host running again', async () => {
    const harness = new FixtureHarness()
    const { handshake, events, store, copies } = await handshakeWith(harness)
    const { reportId } = await handshake.prepare(V2, () => {}) as { readonly reportId: string }
    harness.failCarry = true

    await expect(handshake.apply(reportId, 'drain', 60, true, () => {})).rejects.toThrow('the carry failed')
    expect(harness.calls).toEqual([`check:${V1}`, `carry:${V1}>${V2}`])
    expect(store.switches).toEqual([])
    expect(readPointer(temp!.home, 'current')).toBe(V1)
    expect(events.indexOf('resume')).toBeGreaterThan(events.indexOf('suspend'))
    expect(copies.calls).toContain(`save:${V1}>${V2}`)
    expect(copies.calls).toContain(`discard:${V2}`)
    expect(handshake.update).toBeUndefined()
  })

  it('switches inside the carry, after the session-data copy is written, and hands the carry the report it kept', async () => {
    const harness = new FixtureHarness()
    const { handshake, store, copies } = await handshakeWith(harness)
    const { reportId, report } = await handshake.prepare(V2, () => {}) as { readonly reportId: string, readonly report: unknown }

    // The fixture subject starts no successor, so the update rolls back after the switch; the carry ran it first.
    await expect(handshake.apply(reportId, 'drain', 60, true, () => {})).rejects.toThrow('the switch ran')
    expect(harness.calls).toEqual([`check:${V1}`, `carry:${V1}>${V2}`, 'switched'])
    expect(store.switches[0]).toBe(`${V1}>${V2}`)
    expect(copies.calls.indexOf(`save:${V1}>${V2}`)).toBeGreaterThanOrEqual(0)
    expect(report).toBeDefined()
    expect(harness.reports).toEqual([report])
    expect(harness.reports[0]).toBe(report)
  })
})
