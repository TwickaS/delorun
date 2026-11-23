import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TrustSchedule, type TrustScheduleWork } from '../src/trust-schedule.ts'

const IDLE = 45_000
const DEBOUNCE = 5_000

/** Work whose runs the spec finishes by hand. */
function work() {
  const fulls: { signal: AbortSignal, finish: () => void }[] = []
  const refreshes: { finish: () => void }[] = []
  const value: TrustScheduleWork = {
    full: signal => new Promise<void>((resolve) => {
      fulls.push({ signal, finish: resolve })
      signal.addEventListener('abort', () => { resolve() })
    }),
    refresh: () => new Promise<void>((resolve) => { refreshes.push({ finish: resolve }) }),
  }
  return { value, fulls, refreshes }
}

/** Let settled promises run their callbacks. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('TrustSchedule', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('starts the full check only after the studio has been idle for the whole idle wait', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(fulls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fulls).toHaveLength(1)
    schedule.close()
  })

  it('does not start a full check that is not wanted', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(false)
    await vi.advanceTimersByTimeAsync(IDLE * 3)
    expect(fulls).toHaveLength(0)
    expect(schedule.fullPending).toBe(false)
  })

  it('restarts the idle wait when a turn runs, and waits while it runs', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    const agent = {}
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE - 1_000)
    schedule.turn(agent, true)
    await vi.advanceTimersByTimeAsync(IDLE * 2)
    expect(fulls).toHaveLength(0)
    expect(schedule.busy).toBe(true)
    schedule.turn(agent, false)
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(fulls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fulls).toHaveLength(1)
    schedule.close()
  })

  it('waits for every running turn to end', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    const one = {}
    const two = {}
    schedule.turn(one, true)
    schedule.turn(two, true)
    schedule.start(true)
    schedule.turn(one, false)
    await vi.advanceTimersByTimeAsync(IDLE * 2)
    expect(fulls).toHaveLength(0)
    schedule.turn(two, false)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(fulls).toHaveLength(1)
    schedule.close()
  })

  it('stops a running full check when a turn starts, and runs it again after the next idle wait', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    const agent = {}
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(fulls).toHaveLength(1)
    schedule.turn(agent, true)
    expect(fulls[0]?.signal.aborted).toBe(true)
    expect(schedule.fullPending).toBe(true)
    await settle()
    schedule.turn(agent, false)
    await vi.advanceTimersByTimeAsync(IDLE)
    expect(fulls).toHaveLength(2)
    expect(fulls[1]?.signal.aborted).toBe(false)
    schedule.close()
  })

  it('never stops a full check a person joined with Check now', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE)
    schedule.hold()
    schedule.turn({}, true)
    expect(fulls[0]?.signal.aborted).toBe(false)
    fulls[0]?.finish()
    await settle()
    expect(schedule.fullPending).toBe(false)
  })

  it('reads plugins and changes again once, after the last of several key moments', async () => {
    const { value, refreshes, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(false)
    schedule.keyMoment('plugins')
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1_000)
    schedule.keyMoment('changes')
    await vi.advanceTimersByTimeAsync(DEBOUNCE - 1)
    expect(refreshes).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(refreshes).toHaveLength(1)
    refreshes[0]?.finish()
    await vi.advanceTimersByTimeAsync(IDLE * 2)
    expect(refreshes).toHaveLength(1)
    expect(fulls).toHaveLength(0)
  })

  it('holds a key moment\'s re-read until the running turn ends', async () => {
    const { value, refreshes } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    const agent = {}
    schedule.start(false)
    schedule.turn(agent, true)
    schedule.keyMoment('plugins')
    await vi.advanceTimersByTimeAsync(DEBOUNCE * 4)
    expect(refreshes).toHaveLength(0)
    schedule.turn(agent, false)
    await settle()
    expect(refreshes).toHaveLength(1)
  })

  it('re-reads after a running full check ends when a key moment arrived during it', async () => {
    const { value, refreshes, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE)
    schedule.keyMoment('plugins')
    await vi.advanceTimersByTimeAsync(DEBOUNCE)
    expect(refreshes).toHaveLength(0)
    fulls[0]?.finish()
    await settle()
    expect(refreshes).toHaveLength(1)
    schedule.close()
  })

  it('asks for another full check on a release key moment, which waits for idle', async () => {
    const { value, fulls } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(false)
    schedule.keyMoment('release')
    expect(schedule.fullPending).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE - 1)
    expect(fulls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(fulls).toHaveLength(1)
    schedule.close()
  })

  it('runs nothing after it is closed, and stops a running full check', async () => {
    const { value, fulls, refreshes } = work()
    const schedule = new TrustSchedule(value, { idleMs: IDLE, debounceMs: DEBOUNCE })
    schedule.start(true)
    await vi.advanceTimersByTimeAsync(IDLE)
    schedule.keyMoment('plugins')
    schedule.close()
    expect(fulls[0]?.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE * 2)
    expect(fulls).toHaveLength(1)
    expect(refreshes).toHaveLength(0)
  })
})
