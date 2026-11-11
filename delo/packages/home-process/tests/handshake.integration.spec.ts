/**
 * The handshake's waiting phase on a fake clock: `drain` ends `aborted` with `DRAIN_TIMEOUT` after `drainTimeoutS`
 * with `current` unchanged, and a chat that begins while the gate is held is refused, so the switch never runs while
 * a chat runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CountingChatGate, HomeProcessError, UpdateHandshake, type HandshakeSubject, type Successor } from '../src/index.ts'
import { FixtureCopies, FixtureSnapshots, FixtureStore, installFixture, MemoryLogger, PROFILE, readPointer, tempHome, V1, V2, type TempHome } from './support.ts'

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
    const handshake = new UpdateHandshake(subject(temp.home, gate, events), { store, snapshots, copies: new FixtureCopies(snapshots) })
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
