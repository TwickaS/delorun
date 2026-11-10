/**
 * A run's priority, the release of its slots on exit and on signals, and the light-plan table.
 */
import { describe, expect, it } from 'vitest'
import { gatePriority, isLightPlan, LIGHT_MEMORY_BYTES, processGuard } from '../src/checks/run-queue.ts'

const GIB = 1024 ** 3

describe('gatePriority', () => {
  it.each([
    [{}, false, 1],
    [{ DELO_GATE_PRIORITY: 'trunk' }, false, 0],
    [{ DELO_GATE_PRIORITY: 'other' }, false, 1],
    [{}, true, 0],
  ] as const)('%j with a trunk push %s is %i', (env, trunk, expected) => {
    expect(gatePriority(env, trunk)).toBe(expected)
  })
})

describe('processGuard', () => {
  it('releases on exit and on each signal before raising it again', () => {
    const handlers = new Map<string, () => void>()
    const events: string[] = []
    const proc = {
      pid: 42,
      once: (event: string, handler: () => void) => { handlers.set(event, handler); return proc },
      kill: (pid: number, signal: string) => { events.push(`kill ${String(pid)} ${signal}`); return true },
    }
    processGuard(proc as never)(() => { events.push('release') })
    handlers.get('exit')?.()
    handlers.get('SIGINT')?.()
    handlers.get('SIGTERM')?.()
    expect(events).toEqual(['release', 'release', 'kill 42 SIGINT', 'release', 'kill 42 SIGTERM'])
  })
})

describe('isLightPlan', () => {
  const check = (memoryGiB: number, flags: { exclusive?: boolean, mergeOnly?: true } = {}) => ({ memoryBytes: memoryGiB * GIB, ...flags })
  it.each([
    ['gates:docs alone', [check(0.5)], true],
    ['boundary and a gate', [check(0.3), check(0.5)], true],
    ['exactly 2 GiB', [check(2)], true],
    ['over 2 GiB in sum', [check(1), check(1), check(0.1)], false],
    ['tests:fork (workers times memory)', [check(8)], false],
    ['build:artifacts', [check(4)], false],
    ['an exclusive check', [check(0.6, { exclusive: true })], false],
    ['parity-replay (merge only, exclusive)', [check(0.6, { exclusive: true, mergeOnly: true })], false],
    ['a small merge-only check', [check(0.1, { mergeOnly: true })], false],
    ['an empty plan', [], true],
  ] as const)('%s is light: %s', (_name, plan, light) => {
    expect(isLightPlan(plan)).toBe(light)
  })

  it('has the limit it documents', () => {
    expect(LIGHT_MEMORY_BYTES).toBe(2 * GIB)
  })
})
