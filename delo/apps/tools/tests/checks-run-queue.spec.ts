/**
 * The check runner's queue against an in-memory file system and process table: first-come order, priority behind a holder,
 * dead tickets swept, release on exit and on signals, the position message, the old lock file and the light-plan table.
 */
import { describe, expect, it } from 'vitest'
import { gatePriority, isLightPlan, LIGHT_MEMORY_BYTES, POLL_MILLISECONDS, processGuard, takeTurn, type QueueFs, type QueueHost, type QueuePaths } from '../src/checks/run-queue.ts'

const GIB = 1024 ** 3
const paths: QueuePaths = { dir: '/q', oldLock: '/old.lock' }

/** A shared machine: files, live pids, a clock and the releases each process registered. */
class Machine {
  readonly files = new Map<string, string>()
  readonly live = new Set<number>()
  readonly said: string[] = []
  readonly releases = new Map<number, () => void>()
  time = 1000
  /** Run on every sleep, with the number of sleeps so far. */
  onSleep: (count: number) => void = () => undefined
  sleeps = 0

  readonly fs: QueueFs = {
    ensureDir: () => undefined,
    list: dir => [...this.files.keys()].filter(path => path.startsWith(`${dir}/`)).map(path => path.slice(dir.length + 1)),
    create: (path, text) => {
      if (this.files.has(path)) throw new Error('exists')
      this.files.set(path, text)
    },
    rename: (from, to) => {
      const text = this.files.get(from)
      if (text === undefined) throw new Error('missing')
      this.files.delete(from)
      this.files.set(to, text)
    },
    remove: path => { this.files.delete(path) },
    read: path => this.files.get(path),
  }

  /**
   * A process of this machine.
   * @param pid - its id.
   * @returns its host.
   */
  host(pid: number): QueueHost {
    this.live.add(pid)
    return {
      fs: this.fs,
      now: () => this.time++,
      pid,
      alive: other => this.live.has(other),
      sleep: async () => {
        this.sleeps += 1
        if (this.sleeps > 40) throw new Error('the queue never gave the turn')
        this.onSleep(this.sleeps)
      },
      say: line => { this.said.push(line) },
      guard: release => { this.releases.set(pid, release) },
    }
  }

  /** @returns the ticket files now in the queue directory, sorted. */
  tickets(): string[] {
    return this.fs.list('/q').sort()
  }
}

describe('takeTurn', () => {
  it('takes the turn at once on an empty queue and marks its ticket held', async () => {
    const machine = new Machine()
    await takeTurn(machine.host(10), paths, 1)
    expect(machine.tickets()).toEqual([`1-${'1000'.padStart(15, '0')}-10.held`])
    expect(machine.said).toEqual([])
  })

  it('serves runs in the order they arrived, not in the order they poll', async () => {
    const machine = new Machine()
    const order: number[] = []
    await takeTurn(machine.host(1), paths, 1)
    const second = machine.host(2)
    const third = machine.host(3)
    const waiters = [takeTurn(second, paths, 1).then(() => { order.push(2) }), takeTurn(third, paths, 1).then(() => { order.push(3) })]
    // The newer run polls first on every release; the older ticket still goes first.
    machine.onSleep = count => {
      if (count === 3) { machine.releases.get(1)?.(); machine.live.delete(1) }
      if (count >= 6 && order.length === 1) { machine.releases.get(2)?.(); machine.live.delete(2) }
    }
    await Promise.all(waiters)
    expect(order).toEqual([2, 3])
  })

  it('puts a priority 0 ticket ahead of waiting tickets but behind the holder', async () => {
    const machine = new Machine()
    const order: number[] = []
    await takeTurn(machine.host(1), paths, 1)
    const waiters = [takeTurn(machine.host(2), paths, 1).then(() => { order.push(2) }), takeTurn(machine.host(3), paths, 0).then(() => { order.push(3) })]
    machine.onSleep = count => {
      expect(order).toEqual(count > 4 ? order : [])
      if (count === 4) { machine.releases.get(1)?.(); machine.live.delete(1) }
      if (count >= 6 && order.length === 1) { machine.releases.get(3)?.(); machine.live.delete(3) }
    }
    await Promise.all(waiters)
    expect(order).toEqual([3, 2])
  })

  it('sweeps the ticket of a dead process, held or waiting, and takes the turn', async () => {
    const machine = new Machine()
    machine.live.add(7)
    machine.files.set('/q/1-000000000000500-7.held', '')
    machine.files.set('/q/1-000000000000600-8', '')
    machine.files.set('/q/notes.txt', '')
    machine.live.delete(7)
    await takeTurn(machine.host(9), paths, 1)
    expect(machine.tickets()).toEqual(['1-000000000001000-9.held', 'notes.txt'])
  })

  it('removes its ticket on exit and, for a signal, before raising it again', async () => {
    const machine = new Machine()
    await takeTurn(machine.host(4), paths, 1)
    machine.releases.get(4)?.()
    expect(machine.tickets()).toEqual([])
  })

  it('says who it waits for and how many runs are ahead, once per change of position', async () => {
    const machine = new Machine()
    machine.files.set('/q/1-000000000000001-1.held', '')
    machine.files.set('/q/1-000000000000002-5', '')
    machine.live.add(1)
    machine.live.add(5)
    machine.onSleep = count => {
      if (count === 2) { machine.files.delete('/q/1-000000000000001-1.held'); machine.live.delete(1) }
      if (count === 4) machine.live.delete(5)
    }
    await takeTurn(machine.host(6), paths, 1)
    expect(machine.said).toEqual([
      'run-checks: waiting for the run in process 1 to finish; 2 run(s) ahead in the queue\n',
      'run-checks: waiting for the run in process 5 to finish; 1 run(s) ahead in the queue\n',
    ])
  })

  it('waits for a live old-style lock file and ignores a dead, malformed or its own', async () => {
    const machine = new Machine()
    machine.files.set('/old.lock', '99')
    machine.live.add(99)
    machine.onSleep = count => { if (count === 2) machine.live.delete(99) }
    await takeTurn(machine.host(1), paths, 1)
    expect(machine.said).toEqual(['run-checks: waiting for the run in process 99 to finish; 1 run(s) ahead in the queue\n'])
    expect(machine.sleeps).toBe(2)
    for (const text of ['', 'abc', '2']) {
      const other = new Machine()
      other.files.set('/old.lock', text)
      await takeTurn(other.host(2), paths, 1)
      expect(other.sleeps).toBe(0)
    }
  })

  it('steps back when another run promoted itself in the same instant', async () => {
    const machine = new Machine()
    const host = machine.host(1)
    const rename = machine.fs.rename
    let injected = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!injected) {
        injected = true
        machine.live.add(2)
        machine.files.set('/q/1-000000000000009-2.held', '')
      }
    }
    machine.onSleep = count => { if (count === 1) { machine.live.delete(2) } }
    await takeTurn(host, paths, 1)
    expect(machine.sleeps).toBe(1)
    expect(machine.tickets()).toEqual([`1-${'1000'.padStart(15, '0')}-1.held`])
  })

  it('steps back when the old lock appears during promotion', async () => {
    const machine = new Machine()
    const rename = machine.fs.rename
    let appeared = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!appeared) { appeared = true; machine.files.set('/old.lock', '55'); machine.live.add(55) }
    }
    machine.onSleep = () => { machine.live.delete(55) }
    await takeTurn(machine.host(1), paths, 1)
    expect(machine.sleeps).toBe(1)
  })
})

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
    expect(POLL_MILLISECONDS).toBe(2000)
  })
})
