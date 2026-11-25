/**
 * The machine-wide slot budget against an in-memory file system and process table: grants beside other runs, first come
 * first served, the disk-heavy places, the trunk's priority, dead holders and reused process ids reclaimed, claims that
 * overfill the slots, the memory or the disk-heavy places stepping back,
 * old worktrees' queue and lock, the position messages, and the machine hold the queue enforces.
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { QueueFs, QueueHost } from '../src/checks/run-queue.ts'
import { describeOverload, overloadOf, type Pressure } from '../src/checks/machine.ts'
import { decide, describeSlots, grantFromEnv, grantToEnv, holdMachine, readSlots, SLOT_POLL_MILLISECONDS, stepsBack, takeSlots, unholdMachine, WAIT_REPORT_MILLISECONDS, type SlotBudget, type SlotDemand, type SlotGrant, type SlotPaths } from '../src/checks/slots.ts'

const GIB = 1024 ** 3
const paths: SlotPaths = { dir: '/s', oldQueue: '/q', oldLock: '/old.lock' }
const budget: SlotBudget = { slots: 20, memoryBytes: 20 * GIB, diskRuns: 2 }
const demand = (extra: Partial<SlotDemand> = {}): SlotDemand => ({ want: 20, min: 4, memoryBytes: GIB, disk: false, priority: 1, label: 'lane: tests:fork', ...extra })

/** A shared machine: files, live pids, a clock, and the releases each process registered. */
class Machine {
  readonly files = new Map<string, string>()
  readonly live = new Set<number>()
  /** The start time each process reports; a process absent here reports none. */
  readonly starts = new Map<number, string>()
  /** When each process started on the shared clock; a process absent here reports none. */
  readonly startedAt = new Map<number, number>()
  /** When each file was last written; a file absent here reports none. */
  readonly modified = new Map<string, number>()
  /** Ids that are threads of another process. */
  readonly threads = new Set<number>()
  readonly said: string[] = []
  readonly releases = new Map<number, () => void>()
  time = 1000
  sleeps = 0
  /** Run on every sleep, with the number of sleeps so far. */
  onSleep: (count: number) => void = () => undefined

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
    remove: (path) => { this.files.delete(path) },
    read: path => this.files.get(path),
    modified: path => this.modified.get(path),
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
      now: () => this.time,
      pid,
      alive: other => this.live.has(other),
      startOf: other => this.starts.get(other),
      startedAt: other => this.startedAt.get(other),
      isThread: other => this.threads.has(other),
      sleep: async (milliseconds) => {
        expect(milliseconds).toBe(SLOT_POLL_MILLISECONDS)
        this.sleeps += 1
        this.time += 1000
        if (this.sleeps > 200) throw new Error('the slots were never granted')
        this.onSleep(this.sleeps)
      },
      say: (line) => { this.said.push(line) },
      guard: (release) => { this.releases.set(pid, release) },
    }
  }

  /**
   * End a process: its release runs and it leaves the process table.
   * @param pid - the process.
   */
  end(pid: number): void {
    this.releases.get(pid)?.()
    this.live.delete(pid)
  }

  /**
   * A holder's or request's file written by hand, as another run would.
   * @param pid - the process, made live.
   * @param fields - the fields over a holder of 16 slots.
   */
  hold(pid: number, fields: Record<string, unknown> = {}): void {
    this.live.add(pid)
    this.files.set(`/s/held-${String(pid)}.json`, JSON.stringify({ pid, slots: 16, memoryBytes: 4 * GIB, disk: false, priority: 1, label: 'other', since: 0, requested: 0, ...fields }))
  }
}

describe('a grant', () => {
  it('takes what it wants of an idle machine but leaves a quarter of the slots, which a trunk push may take', async () => {
    const machine = new Machine()
    // The declared memory is the ceiling: 15 slots do not buy 15 GiB when the request declares 1 GiB.
    expect(await takeSlots(machine.host(1), paths, budget, demand())).toEqual({ slots: 15, memoryBytes: GIB, waitedMs: 0 })
    expect(machine.files.has('/q/1-000000000001000-1.held')).toBe(true)
    const trunk = new Machine()
    expect((await takeSlots(trunk.host(1), paths, budget, demand({ priority: 0 }))).slots).toBe(20)
  })

  it('reserves what a request declares, not the share of the budget its slots would buy, so a declared 4 GiB is never reserved more', async () => {
    // The machine the brief measured: 9 slots, 20.5 GiB, a build that declares 4 GiB and asks for 8 slots.
    const measured: SlotBudget = { slots: 9, memoryBytes: Math.round(20.5 * GIB), diskRuns: 3 }
    const build = demand({ want: 8, min: 8, memoryBytes: 4 * GIB, disk: true, label: 'build:artifacts' })
    const machine = new Machine()
    const grant = await takeSlots(machine.host(1), paths, measured, build)
    // The old arithmetic reserved max(4, 8 x 20.5/9) = 18.2 GiB, 4.6 times what the check declares.
    expect(grant.memoryBytes).toBe(4 * GIB)
    expect(grant.slots).toBe(8)
    // The 16.5 GiB the build no longer holds is free for the runs that were waiting behind it: a run that needs 5 GiB
    // starts at once, where the old reservation left only 2.3 GiB of the budget free and it waited.
    const beside = new Machine()
    beside.hold(7, { slots: 8, memoryBytes: 4 * GIB, disk: true })
    const tests = await takeSlots(beside.host(1), paths, measured, demand({ want: 1, min: 1, memoryBytes: 5 * GIB }))
    expect(tests).toEqual({ slots: 1, memoryBytes: 5 * GIB, waitedMs: 0 })
    expect(beside.sleeps).toBe(0)
  })

  it('keeps a per-worker check scaling with its workers, whose declared figure is per worker', () => {
    // `plan.ts` multiplies a perWorker budget by the check's CPUs, so the request already declares the total: the ceiling
    // is that total, and a run fitted to fewer workers declares fewer.
    const request = (pid: number, min: number, memoryBytes: number) => ({ file: String(pid), pid, want: min, min, memoryBytes, disk: false, priority: 1 as const, label: '', since: pid })
    const fork = (workers: number) => request(1, workers, Math.round(0.5 * GIB * workers))
    expect(decide({ holders: [], waiting: [fork(8)], oldWaiting: [] }, 1, budget)).toEqual({ slots: 8, memoryBytes: 4 * GIB })
    expect(decide({ holders: [], waiting: [fork(4)], oldWaiting: [] }, 1, budget)).toEqual({ slots: 4, memoryBytes: 2 * GIB })
    // The six per-worker checks of budgets.json keep their figures, so the scaling is theirs and not the queue's.
    expect(['tests:fork', 'tests:fork:integration', 'tests:moved-clock', 'tests:upstream-changed', 'tests:snapshots', 'parity-replay']).toHaveLength(6)
  })

  it('keeps the elastic share for a request that declares no memory, as the wrapper without --memory-gib asks', async () => {
    const machine = new Machine()
    // A request that declares nothing has no ceiling to state, so its slots' share of the budget stands.
    expect(await takeSlots(machine.host(1), paths, budget, demand({ memoryBytes: 0 }))).toEqual({ slots: 15, memoryBytes: 15 * GIB, waitedMs: 0 })
  })

  it('starts a small run beside a large holder, with the memory it needs', async () => {
    const machine = new Machine()
    machine.hold(7)
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ want: 2, min: 2, memoryBytes: 5 * GIB }))
    expect(grant).toEqual({ slots: 2, memoryBytes: 5 * GIB, waitedMs: 0 })
    expect(machine.sleeps).toBe(0)
  })

  it('refuses a start that would exceed the slots or the memory until a holder ends, and reclaims a dead holder\'s slots', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 18 })
    machine.hold(8, { slots: 1, memoryBytes: 19 * GIB })
    machine.onSleep = (count) => {
      if (count === 2) machine.files.delete('/s/held-7.json')
      if (count === 4) machine.live.delete(8)
    }
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ min: 2, memoryBytes: 2 * GIB }))
    expect(machine.sleeps).toBe(4)
    expect(grant.slots).toBe(15)
    expect(machine.files.has('/s/held-8.json')).toBe(false)
    expect(machine.said[0]).toMatch(/^run-checks: waiting for 2 of 20 slots: 1 of 20 slots are free and it needs 2; position 1 of 1, 2 run\(s\) holding slots; waited 0 s/)
    expect(machine.said.at(-1)).toMatch(/: 1.0 GiB of memory is free and it needs 2.0 GiB;/)
  })

  it('serves requests first come, first served: a later small request waits behind an earlier one that does not fit', () => {
    const state = { holders: [], oldWaiting: [], waiting: [
      { file: 'a', pid: 1, want: 20, min: 20, memoryBytes: 0, disk: false, priority: 1 as const, label: '', since: 1 },
      { file: 'b', pid: 2, want: 2, min: 2, memoryBytes: 0, disk: false, priority: 1 as const, label: '', since: 2 },
    ] }
    const held = [{ file: 'h', pid: 9, slots: 4, memoryBytes: 0, disk: false, priority: 1 as const, label: '', since: 0, requested: 0 }]
    expect(decide({ ...state, holders: held }, 2, budget)).toEqual({ waits: 'the request of process 1 is ahead in the queue' })
    expect(decide({ ...state, holders: held }, 1, budget)).toEqual({ waits: '16 of 20 slots are free and it needs 20' })
    // Without the holder the earlier request starts first and keeps its slots; the later one waits for them.
    expect(decide(state, 2, budget)).toEqual({ waits: '0 of 20 slots are free and it needs 2' })
    expect(decide(state, 3, budget)).toEqual({ waits: 'its request is gone' })
  })

  it('lets a request that touches no disk pass one that waits only for a disk-heavy place, and makes a disk-heavy one wait', () => {
    const disk = { file: 'h', memoryBytes: 0, disk: true, priority: 1 as const, label: '', since: 0, requested: 0, slots: 2 }
    const request = (pid: number, extra: { disk: boolean, since: number }) => ({ file: String(pid), pid, want: 2, min: 2, memoryBytes: 0, priority: 1 as const, label: '', ...extra })
    const state = { oldWaiting: [], holders: [{ ...disk, pid: 8 }, { ...disk, pid: 9 }], waiting: [request(1, { disk: true, since: 1 }), request(2, { disk: false, since: 2 }), request(3, { disk: true, since: 3 })] }
    expect(decide(state, 1, budget)).toEqual({ waits: 'the 2 disk-heavy places are taken' })
    expect(decide(state, 2, budget)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(state, 3, budget)).toEqual({ waits: 'the request of process 1 waits ahead for a disk-heavy place' })
  })

  it('puts a trunk push ahead of waiting requests but behind the holders', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 19 })
    const order: number[] = []
    const lane = takeSlots(machine.host(1), paths, budget, demand({ min: 4 })).then(() => { order.push(1) })
    machine.time += 10
    const trunk = takeSlots(machine.host(2), paths, budget, demand({ min: 4, want: 4, priority: 0 })).then(() => { order.push(2) })
    machine.onSleep = (count) => {
      if (count === 3) machine.end(7)
      if (order.length === 1 && order[0] === 2) machine.end(2)
    }
    await Promise.all([lane, trunk])
    expect(order).toEqual([2, 1])
  })

  it('steps back when another run claimed in the same instant and the machine is overfilled', async () => {
    const machine = new Machine()
    const host = machine.host(1)
    const rename = machine.fs.rename
    let injected = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!injected && to === '/s/held-1.json') {
        injected = true
        machine.hold(2, { slots: 10, requested: 0 })
      }
    }
    machine.onSleep = (count) => { if (count === 1) machine.live.delete(2) }
    const grant = await takeSlots(host, paths, budget, demand())
    expect(machine.sleeps).toBe(1)
    expect(grant.slots).toBe(15)
  })

  it('keeps its claim when a later claimant overfills the machine, which steps back instead', async () => {
    const machine = new Machine()
    const rename = machine.fs.rename
    let injected = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!injected && to === '/s/held-1.json') {
        injected = true
        machine.hold(2, { slots: 10, requested: 5000 })
      }
    }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.sleeps).toBe(0)
  })

  describe('a stale old-queue file whose process id is reused', () => {
    const state = (setup: (machine: Machine) => void) => {
      const machine = new Machine()
      machine.live.add(1)
      setup(machine)
      return readSlots(machine.host(1), paths)
    }

    it('is no holder when the process started after the ticket was written', () => {
      const result = state((machine) => {
        machine.live.add(50)
        machine.files.set('/q/1-000000000000005-50.held', '')
        machine.modified.set('/q/1-000000000000005-50.held', 100_000)
        machine.startedAt.set(50, 500_000)
      })
      expect(result.oldHolder).toBeUndefined()
    })

    it('is a holder when the process started before the ticket was written, or its time is unknown', () => {
      expect(state((machine) => {
        machine.live.add(50)
        machine.files.set('/q/1-000000000000005-50.held', '')
        machine.modified.set('/q/1-000000000000005-50.held', 500_000)
        machine.startedAt.set(50, 100_000)
      }).oldHolder).toBe(50)
      expect(state((machine) => {
        machine.live.add(50)
        machine.files.set('/q/1-000000000000005-50.held', '')
      }).oldHolder).toBe(50)
    })

    it('is no waiting ticket and no lock holder when the process is newer than the file', () => {
      const result = state((machine) => {
        machine.live.add(51)
        machine.live.add(52)
        machine.files.set('/q/1-000000000000006-51', '')
        machine.modified.set('/q/1-000000000000006-51', 100_000)
        machine.startedAt.set(51, 500_000)
        machine.files.set('/old.lock', '52')
        machine.modified.set('/old.lock', 100_000)
        machine.startedAt.set(52, 500_000)
      })
      expect(result.oldWaiting).toEqual([])
      expect(result.oldHolder).toBeUndefined()
    })

    it('is no holder when the id is a thread of another process', () => {
      const result = state((machine) => {
        machine.live.add(50)
        machine.threads.add(50)
        machine.files.set('/q/1-000000000000005-50.held', '')
      })
      expect(result.oldHolder).toBeUndefined()
    })

    it('removes a slot file without a start time that a newer process now carries, and keeps one with a matching start', () => {
      const machine = new Machine()
      machine.live.add(1)
      machine.live.add(60)
      machine.live.add(61)
      machine.hold(60)
      machine.modified.set('/s/held-60.json', 100_000)
      machine.startedAt.set(60, 500_000)
      machine.hold(61, { start: '7' })
      machine.starts.set(61, '7')
      machine.startedAt.set(61, 500_000)
      machine.modified.set('/s/held-61.json', 100_000)
      expect(readSlots(machine.host(1), paths).holders.map(holder => holder.pid)).toEqual([61])
      expect(machine.files.has('/s/held-60.json')).toBe(false)
    })
  })

  it('waits while an old worktree holds the previous queue or the lock, or arrived earlier in it, and ignores its own and dead ones', async () => {
    const machine = new Machine()
    machine.live.add(50)
    machine.live.add(51)
    machine.live.add(52)
    machine.files.set('/q/1-000000000000005-50.held', '')
    machine.files.set('/q/1-000000000000006-51', '')
    machine.files.set('/q/1-000000000009999-53', '')
    machine.files.set('/q/notes', '')
    machine.files.set('/old.lock', '52')
    machine.onSleep = (count) => {
      if (count === 1) machine.live.delete(50)
      if (count === 2) machine.live.delete(52)
      if (count === 3) machine.live.delete(51)
    }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.sleeps).toBe(3)
    expect(machine.said.map(line => line.split(';')[0])).toEqual([
      'run-checks: waiting for 4 of 20 slots: an old worktree\'s run in process 50 holds the machine',
      'run-checks: waiting for 4 of 20 slots: an old worktree\'s run in process 52 holds the machine',
      'run-checks: waiting for 4 of 20 slots: an old worktree\'s run in process 51 arrived earlier and waits in the previous queue',
    ])
    const own = new Machine()
    own.files.set('/old.lock', '1')
    own.files.set('/q/1-000000000000001-1', '')
    await takeSlots(own.host(1), paths, budget, demand())
    expect(own.sleeps).toBe(0)
  })

  it('steps back when an old worktree takes the previous queue during the claim', async () => {
    const machine = new Machine()
    const rename = machine.fs.rename
    let appeared = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!appeared && to === '/s/held-1.json') { appeared = true; machine.live.add(55); machine.files.set('/old.lock', '55') }
    }
    machine.onSleep = () => { machine.live.delete(55) }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.sleeps).toBe(1)
  })

  it('repeats its position and the time it has waited every half minute, and releases every file when it ends', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 20 })
    machine.onSleep = (count) => { if (count === 45) machine.live.delete(7) }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.said).toHaveLength(2)
    expect(machine.said[1]).toMatch(new RegExp(`waited ${String(WAIT_REPORT_MILLISECONDS / 1000)} s`))
    machine.end(1)
    expect([...machine.files.keys()]).toEqual([])
  })

  it('clamps the request to the machine and to at least one slot', async () => {
    const machine = new Machine()
    expect((await takeSlots(machine.host(1), paths, { ...budget, slots: 3 }, demand({ want: 0, min: 0 }))).slots).toBe(1)
  })
})

describe('the order of requests', () => {
  const request = (pid: number, extra: { min?: number, disk?: boolean, since?: number } = {}) => ({ file: String(pid), pid, want: extra.min ?? 2, min: extra.min ?? 2, memoryBytes: 0, disk: extra.disk ?? false, priority: 1 as const, label: '', since: extra.since ?? pid })

  it('holds back a later request that would fit behind an earlier one that does not, and counts disk places the earlier requests take', () => {
    expect(decide({ holders: [], oldWaiting: [], waiting: [request(1, { min: 30 }), request(2), request(3)] }, 3, budget)).toEqual({ waits: 'the request of process 1 is ahead in the queue' })
    const disk = { holders: [], oldWaiting: [], waiting: [request(1, { disk: true }), request(2, { disk: true }), request(3, { disk: true })] }
    expect(decide(disk, 3, budget)).toEqual({ waits: 'the 2 disk-heavy places are taken' })
  })

  it('keeps for an earlier request the whole grant it asks for, so a later one polling first cannot take it', () => {
    const big = (pid: number) => ({ ...request(pid, { min: 4, since: pid }), want: 20 })
    const state = { holders: [], oldWaiting: [], waiting: [big(1), big(2)] }
    expect(decide(state, 1, budget)).toEqual({ slots: 15, memoryBytes: 15 * GIB })
    expect(decide(state, 2, budget)).toEqual({ slots: 5, memoryBytes: 5 * GIB })
  })

  it('orders requests of the same time by process id', () => {
    const machine = new Machine()
    const host = machine.host(1)
    for (const pid of [5, 4]) {
      machine.live.add(pid)
      machine.files.set(`/s/req-${String(pid)}.json`, JSON.stringify({ pid, want: 1, min: 1, memoryBytes: 0, disk: false, priority: 1, label: '', since: 7 }))
    }
    expect(readSlots(host, paths).waiting.map(each => each.pid)).toEqual([4, 5])
  })

  it('treats a file that vanished between the listing and the read as no request', () => {
    const machine = new Machine()
    const host = machine.host(1)
    machine.files.set('/s/req-gone.json', '{}')
    const read = machine.fs.read
    machine.fs.read = path => path === '/s/req-gone.json' ? undefined : read(path)
    expect(readSlots(host, paths).waiting).toEqual([])
    // Its process may have replaced it in the meantime, so the reader leaves the path alone.
    expect(machine.files.has('/s/req-gone.json')).toBe(true)
  })

  it('records its start time, and reclaims a holder whose process id a later process reuses', async () => {
    const machine = new Machine()
    machine.starts.set(1, '100')
    machine.hold(7, { slots: 20, start: 'before' })
    machine.starts.set(7, 'after')
    machine.hold(8, { slots: 1, start: '5' })
    machine.starts.set(8, '5')
    machine.hold(9, { slots: 1 })
    const host = machine.host(1)
    expect(readSlots(host, paths).holders.map(holder => holder.pid)).toEqual([8, 9])
    expect(machine.files.has('/s/held-7.json')).toBe(false)
    await takeSlots(host, paths, budget, demand({ want: 2, min: 2 }))
    expect(JSON.parse(machine.files.get('/s/held-1.json') ?? '{}')).toMatchObject({ pid: 1, start: '100' })
  })

  it('steps back when a claim in the same instant overfills the memory, and waits until it fits', async () => {
    const machine = new Machine()
    const rename = machine.fs.rename
    let injected = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!injected && to === '/s/held-1.json') {
        injected = true
        machine.hold(2, { slots: 1, memoryBytes: 10 * GIB, requested: 0 })
      }
    }
    machine.onSleep = (count) => { if (count === 1) machine.live.delete(2) }
    // The request declares 11 GiB, so its grant and the 10 GiB holder overfill the 20 GiB budget.
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ memoryBytes: 11 * GIB }))
    expect(machine.sleeps).toBe(1)
    expect(grant).toMatchObject({ slots: 15, memoryBytes: 11 * GIB })
  })

  it('keeps the claim of the lower process id when two claims carry the same request time', async () => {
    const machine = new Machine()
    const rename = machine.fs.rename
    let injected = false
    machine.fs.rename = (from, to) => {
      rename(from, to)
      if (!injected && to === '/s/held-1.json') {
        injected = true
        machine.hold(2, { slots: 10, requested: 1000 })
      }
    }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.sleeps).toBe(0)
  })
})

describe('a run that starts beside a blocked head', () => {
  const small: SlotBudget = { slots: 16, memoryBytes: 16 * GIB, diskRuns: 2 }
  const request = (pid: number, extra: { min?: number, want?: number, memoryBytes?: number, disk?: boolean, since: number }) => ({ file: String(pid), pid, want: extra.want ?? extra.min ?? 2, min: extra.min ?? 2, memoryBytes: extra.memoryBytes ?? 0, disk: extra.disk ?? false, priority: 1 as const, label: '', since: extra.since })
  const holder = (pid: number, slots: number, since: number, extra: { memoryBytes?: number } = {}) => ({ file: `h${String(pid)}`, pid, slots, memoryBytes: extra.memoryBytes ?? 0, disk: false, priority: 1 as const, label: '', since, requested: since })
  const head = request(1, { min: 8, since: 10 })
  const waits = { waits: 'the request of process 1 is ahead in the queue' }

  it('starts two 2-slot requests behind an 8-slot head beside a 12-slot holder, and makes a third wait, each with its minimum', () => {
    const state = { oldWaiting: [], holders: [holder(9, 12, 0)], waiting: [head, request(2, { want: 4, since: 11 }), request(3, { since: 12 }), request(4, { since: 13 })] }
    expect(decide(state, 1, small)).toEqual({ waits: '4 of 16 slots are free and it needs 8' })
    expect(decide(state, 2, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(state, 3, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(state, 4, small)).toEqual(waits)
  })

  it('does not delay the head: runs granted after it began to wait never hold more than the machine less its minimum', () => {
    // 4 slots are free, but 6 are held by runs granted after the head waits and the head needs 8 of 16.
    const state = { oldWaiting: [], holders: [holder(9, 6, 0), holder(8, 6, 11)], waiting: [head, request(2, { since: 12 })] }
    expect(decide(state, 2, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    const full = { ...state, holders: [holder(9, 4, 0), holder(8, 6, 11)], waiting: [head, request(2, { since: 12 }), request(3, { since: 13 })] }
    // 6 late slots plus this one's 2 reach the 8 allowed; the next small request waits though 6 slots are free.
    expect(decide(full, 2, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(full, 3, small)).toEqual(waits)
    expect(decide({ ...full, holders: [holder(9, 4, 0), holder(8, 7, 11)] }, 2, small)).toEqual(waits)
    // Holders that were there before the head do not count against the bound.
    expect(decide({ ...full, holders: [holder(9, 4, 0), holder(8, 6, 5)] }, 3, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
  })

  it('bounds the memory the same way against the head\'s need', () => {
    const memoryHead = request(1, { min: 2, memoryBytes: 10 * GIB, since: 10 })
    const state = { oldWaiting: [], holders: [holder(9, 2, 0, { memoryBytes: 8 * GIB }), holder(8, 2, 11, { memoryBytes: 3 * GIB })], waiting: [memoryHead, request(2, { memoryBytes: 3 * GIB, since: 12 }), request(3, { memoryBytes: 4 * GIB, since: 13 })] }
    // 16 - 10 = 6 GiB may be held by later runs: 3 GiB held and 3 GiB more fit, then 4 GiB more would not.
    expect(decide(state, 1, small)).toEqual({ waits: '5.0 GiB of memory is free and it needs 10.0 GiB' })
    expect(decide(state, 2, small)).toEqual({ slots: 2, memoryBytes: 3 * GIB })
    expect(decide(state, 3, small)).toEqual(waits)
  })

  it('still makes a disk-heavy request behind the head wait', () => {
    const state = { oldWaiting: [], holders: [holder(9, 12, 0)], waiting: [head, request(2, { disk: true, since: 11 })] }
    expect(decide(state, 2, small)).toEqual(waits)
  })

  it('starts the head as soon as the earlier holder leaves, with the backfilled runs still holding', () => {
    const state = { oldWaiting: [], holders: [holder(9, 12, 0)], waiting: [head, request(2, { since: 11 }), request(3, { since: 12 })] }
    const backfilled = [holder(2, 2, 13), holder(3, 2, 14)]
    expect(decide({ ...state, holders: [holder(9, 12, 0), ...backfilled], waiting: [head] }, 1, small)).toEqual({ waits: '0 of 16 slots are free and it needs 8' })
    expect(decide({ ...state, holders: backfilled, waiting: [head] }, 1, small)).toEqual({ slots: 8, memoryBytes: 8 * GIB })
  })

  it('leaves requests ahead of the head as they were, and counts what they take against the bound', () => {
    const state = { oldWaiting: [], holders: [holder(9, 10, 0)], waiting: [request(2, { since: 5 }), head, request(3, { since: 12 })] }
    // The earlier small request starts as it always did; the head waits for slots; the later one backfills beside both.
    expect(decide(state, 2, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(state, 3, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    // A grant the earlier request takes counts against the bound, so no more slots go to later ones than the head can spare.
    const wideHead = request(1, { min: 10, since: 10 })
    const wide = { ...state, holders: [holder(9, 8, 0)], waiting: [{ ...request(2, { since: 5 }), want: 4 }, wideHead, request(3, { since: 12 }), request(4, { since: 13 })] }
    expect(decide(wide, 2, small)).toEqual({ slots: 4, memoryBytes: 4 * GIB })
    expect(decide(wide, 3, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
    expect(decide(wide, 4, small)).toEqual(waits)
  })

  it('grants a backfilled request through takeSlots, and the head then waits only for the earlier holder', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 12 })
    const headHost = machine.host(1)
    const headRun = takeSlots(headHost, paths, small, demand({ want: 8, min: 8 }))
    machine.time += 10
    const grant = await takeSlots(machine.host(2), paths, small, demand({ want: 4, min: 2 }))
    expect(grant.slots).toBe(2)
    machine.onSleep = (count) => { if (count === 3) machine.end(7) }
    expect((await headRun).slots).toBe(8)
    expect(machine.files.has('/s/held-2.json')).toBe(true)
  })
})

describe('a claim that overfills the machine', () => {
  const holder = (pid: number, requested: number, extra: Partial<{ slots: number, memoryBytes: number, disk: boolean, priority: 0 | 1 }> = {}) => ({ pid, slots: 1, memoryBytes: GIB, disk: false, priority: 1 as const, label: '', since: 0, requested, file: `held-${String(pid)}.json`, ...extra })

  it('gives back the latest grant among the holders of each overfilled resource, and no other', () => {
    const memory = { waiting: [], oldWaiting: [], holders: [holder(1, 0, { memoryBytes: 15 * GIB }), holder(2, 5, { memoryBytes: 10 * GIB })] }
    expect([stepsBack(memory, 1, budget), stepsBack(memory, 2, budget)]).toEqual([false, true])
    const disk = { waiting: [], oldWaiting: [], holders: [holder(1, 0, { disk: true }), holder(2, 5, { disk: true }), holder(3, 7, { disk: true }), holder(4, 9)] }
    expect([1, 2, 3, 4].map(pid => stepsBack(disk, pid, budget))).toEqual([false, false, true, false])
    const slots = { waiting: [], oldWaiting: [], holders: [holder(1, 0, { slots: 15 }), holder(2, 5, { slots: 15, priority: 0 })] }
    expect([stepsBack(slots, 1, budget), stepsBack(slots, 2, budget)]).toEqual([true, false])
    const fits = { waiting: [], oldWaiting: [], holders: [holder(1, 0, { slots: 10, disk: true }), holder(2, 5, { slots: 10, disk: true })] }
    expect([stepsBack(fits, 1, budget), stepsBack(fits, 2, budget)]).toEqual([false, false])
    expect(stepsBack({ ...fits, oldHolder: 9 }, 1, budget)).toBe(true)
  })
})

describe('the previous queue', () => {
  it('holds a waiting ticket there while the request waits, so an old run that arrived later waits behind it, and holds it once granted', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 20 })
    let seen: string[] = []
    machine.onSleep = (count) => {
      if (count === 1) seen = machine.fs.list('/q')
      if (count === 2) machine.live.delete(7)
    }
    await takeSlots(machine.host(1), paths, budget, demand())
    expect(seen).toEqual(['1-000000000001000-1'])
    expect(machine.fs.list('/q')).toEqual(['1-000000000001000-1.held'])
  })

  it('does not count a new run\'s ticket there as an old run\'s', () => {
    const machine = new Machine()
    const host = machine.host(1)
    machine.live.add(2)
    machine.files.set('/s/req-2.json', JSON.stringify({ pid: 2, want: 1, min: 1, memoryBytes: 0, disk: false, priority: 1, label: '', since: 5 }))
    machine.files.set('/q/1-000000000000005-2', '')
    expect(readSlots(host, paths).oldWaiting).toEqual([])
  })
})

describe('the files', () => {
  it('ignore a file being written, and remove one that is not a request or a holder and one of a dead process', () => {
    const machine = new Machine()
    const host = machine.host(1)
    machine.files.set('/s/req-x.json.tmp', '{')
    machine.files.set('/s/held-x.json.tmp', '{')
    machine.files.set('/s/req-bad.json', '{')
    machine.files.set('/s/held-bad.json', JSON.stringify({ pid: 3 }))
    machine.files.set('/s/req-dead.json', JSON.stringify({ pid: 4, want: 1, min: 1, memoryBytes: 0, disk: false, priority: 1, label: '', since: 0 }))
    machine.files.set('/s/other', '')
    const state = readSlots(host, paths)
    expect(state).toEqual({ waiting: [], holders: [], oldWaiting: [] })
    expect([...machine.files.keys()].sort()).toEqual(['/s/held-x.json.tmp', '/s/other', '/s/req-x.json.tmp'])
  })

  it('describe the holders and the waiting requests for --queue', () => {
    const lines = describeSlots({
      holders: [{ file: 'h', pid: 7, slots: 15, memoryBytes: 2 * GIB, disk: true, priority: 0, label: 'trunk: tests:fork', since: 1000, requested: 0 }],
      waiting: [{ file: 'r', pid: 8, want: 20, min: 4, memoryBytes: 0, disk: true, priority: 1, label: 'lane: gates', since: 2000 }, { file: 's', pid: 9, want: 2, min: 2, memoryBytes: 0, disk: false, priority: 0, label: 'with-slots: tsc', since: 3000 }],
      oldHolder: 5,
      oldWaiting: [{ pid: 6, priority: 1, since: 0 }],
    }, budget, 61_000)
    expect(lines).toEqual([
      'slots: 15 of 20 held, 2 disk-heavy places, 20.0 GiB of memory; 2 waiting',
      '  an old worktree\'s run in process 5 holds the whole machine',
      '  1 run(s) of old worktrees wait in the previous queue',
      '  holding: process 7, 15 slots, 2.0 GiB, disk-heavy, trunk, for 60 s: trunk: tests:fork',
      '  waiting 1: process 8, 4-20 slots, disk-heavy, for 59 s: lane: gates',
      '  waiting 2: process 9, 2-2 slots, trunk, for 58 s: with-slots: tsc',
    ])
    expect(describeSlots({ holders: [{ file: 'h', pid: 7, slots: 1, memoryBytes: 0, disk: false, priority: 1, label: 'x', since: 0, requested: 0 }], waiting: [], oldWaiting: [] }, budget, 0)[1]).toBe('  holding: process 7, 1 slots, 0.0 GiB, for 0 s: x')
  })

  it('shows how the budget was derived, so a person can see where the figures came from', () => {
    const lines = describeSlots({ holders: [], waiting: [], oldWaiting: [] }, budget, 0, { machineBytes: 23 * GIB, headroomBytes: Math.floor(23 * GIB / 8), cpus: 12, overrides: [], rotational: false })
    // The budget is the test's own 20 GiB, not the 23 GiB less the headroom: the line reports the figures it is given.
    expect(lines[1]).toBe('  budget: 12 CPUs, 23.0 GiB of memory less 2.9 GiB of headroom is 20.0 GiB, 2 disk-heavy places (a disk that reports no seek cost)')
    // Each variable that overrode a measured figure is named with its value.
    const overridden = describeSlots({ holders: [], waiting: [], oldWaiting: [] }, budget, 0, { machineBytes: 23 * GIB, headroomBytes: 3 * GIB, cpus: 12, overrides: ['DELORUN_CHECKS_SLOTS=9', 'DELORUN_CHECKS_MEMORY_GIB=20'], rotational: true })
    expect(overridden[1]).toBe('  budget: 12 CPUs, 23.0 GiB of memory less 3.0 GiB of headroom is 20.0 GiB, 2 disk-heavy places (a spinning disk); overridden by DELORUN_CHECKS_SLOTS=9, DELORUN_CHECKS_MEMORY_GIB=20')
    // A machine that reports no disk says so rather than guessing one.
    expect(describeSlots({ holders: [], waiting: [], oldWaiting: [] }, budget, 0, { machineBytes: 23 * GIB, headroomBytes: 3 * GIB, cpus: 12, overrides: [] })[1]).toContain('(no disk reported)')
  })

  it('hand a grant to the re-executed run and refuse a malformed one', () => {
    const grant: SlotGrant = { slots: 6, memoryBytes: 5.5 * GIB, waitedMs: 1234.4 }
    expect(grantFromEnv(grantToEnv(grant))).toEqual({ slots: 6, memoryBytes: Math.round(5.5 * GIB), waitedMs: 1234 })
    expect(grantFromEnv(undefined)).toBeUndefined()
    expect(() => grantFromEnv('0:1:1')).toThrow('DELORUN_CHECKS_GRANT must be')
    expect(() => grantFromEnv('six')).toThrow('DELORUN_CHECKS_GRANT must be')
  })
})

describe('a machine hold', () => {
  const small: SlotBudget = { slots: 16, memoryBytes: 16 * GIB, diskRuns: 2 }
  const hold = (machine: Machine, fields: Record<string, unknown> = {}): void => {
    machine.files.set('/s/hold.json', JSON.stringify({ reason: 'cleanup', since: 500, allow: [], ...fields }))
  }
  /** A waiting request written by hand, as another run would. */
  const ask = (machine: Machine, pid: number, fields: { cwd?: string, since?: number, priority?: 0 | 1, min?: number, want?: number } = {}): void => {
    const priority = fields.priority ?? 1
    const since = fields.since ?? 1000
    machine.live.add(pid)
    const { cwd, ...rest } = fields
    if (cwd !== undefined) machine.files.set(`/s/cwd-${String(pid)}.json`, JSON.stringify({ pid, cwd }))
    machine.files.set(`/s/req-${String(priority)}-${String(since).padStart(15, '0')}-${String(pid)}.json`, JSON.stringify({ pid, want: 4, min: 4, memoryBytes: 0, disk: false, label: 'x', ...rest, priority, since }))
  }
  const decision = (machine: Machine, pid: number, within: SlotBudget = budget) => decide(readSlots(machine.host(pid), paths), pid, within)

  it('makes a request that fits wait with the reason, and grants the same request when the hold is removed', async () => {
    const machine = new Machine()
    hold(machine, { reason: 'tests are running' })
    machine.onSleep = (count) => { if (count === 3) machine.files.delete('/s/hold.json') }
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ want: 2, min: 2 }))
    expect(grant.slots).toBe(2)
    expect(grant.waitedMs).toBe(3000)
    expect(machine.said).toHaveLength(1)
    expect(machine.said[0]).toContain('waiting for 2 of 20 slots: machine held: tests are running; position 1 of 1, 0 run(s) holding slots')
  })

  it('records the working directory beside the request, not in it, and removes it on the grant', async () => {
    const machine = new Machine()
    hold(machine)
    let request: unknown
    let sidecar: unknown
    machine.onSleep = () => {
      request = JSON.parse(machine.files.get('/s/req-1-000000000001000-1.json') ?? '{}')
      sidecar = JSON.parse(machine.files.get('/s/cwd-1.json') ?? '{}')
      machine.files.delete('/s/hold.json')
    }
    await takeSlots(machine.host(1), paths, budget, demand({ cwd: '/w/a/sub' }))
    expect(request).not.toHaveProperty('cwd')
    expect(sidecar).toMatchObject({ pid: 1, cwd: '/w/a/sub' })
    expect(machine.files.has('/s/cwd-1.json')).toBe(false)
    expect(machine.files.has('/s/held-1.json')).toBe(true)
  })

  it('keeps a new request file for a reader of the previous request format, which rejects an unknown key', async () => {
    const Previous = z.strictObject({ pid: z.number().int(), start: z.string().optional(), want: z.number().int().positive(), min: z.number().int().positive(), memoryBytes: z.number().nonnegative(), disk: z.boolean(), priority: z.union([z.literal(0), z.literal(1)]), label: z.string(), since: z.number() })
    const machine = new Machine()
    hold(machine)
    const seen: boolean[] = []
    machine.onSleep = () => {
      for (const file of machine.files.keys()) if (file.startsWith('/s/req-')) seen.push(Previous.safeParse(JSON.parse(machine.files.get(file) ?? '{}')).success)
      machine.files.delete('/s/hold.json')
    }
    await takeSlots(machine.host(1), paths, budget, demand({ cwd: '/w/a' }))
    expect(seen).toEqual([true])
  })

  it('reads a request\'s working directory from its sidecar and removes the sidecar of a dead process', () => {
    const machine = new Machine()
    ask(machine, 1, { cwd: '/w/a' })
    machine.files.set('/s/cwd-5.json', JSON.stringify({ pid: 5, cwd: '/w/dead' }))
    const state = readSlots(machine.host(2), paths)
    expect(state.waiting.map(each => each.cwd)).toEqual(['/w/a'])
    expect(machine.files.has('/s/cwd-5.json')).toBe(false)
    expect(machine.files.has('/s/cwd-1.json')).toBe(true)
  })

  it('grants a request inside an allowed worktree, and not one in a sibling folder whose name starts the same', () => {
    const machine = new Machine()
    hold(machine, { allow: ['/w/a', '/v/'] })
    ask(machine, 1, { cwd: '/w/a', since: 1000 })
    ask(machine, 2, { cwd: '/w/a/delorun/apps', since: 1001 })
    ask(machine, 3, { cwd: '/w/ab', since: 1002 })
    ask(machine, 4, { cwd: '/v/sub', since: 1003 })
    expect('slots' in decision(machine, 1)).toBe(true)
    expect('slots' in decision(machine, 2)).toBe(true)
    expect(decision(machine, 3)).toEqual({ waits: 'machine held: cleanup' })
    expect('slots' in decision(machine, 4)).toBe(true)
  })

  it('does not let a request the hold blocks take slots or become the head ahead of an allowed request', () => {
    const machine = new Machine()
    machine.hold(9, { slots: 14 })
    hold(machine, { allow: ['/w/a'] })
    ask(machine, 1, { cwd: '/w/b', since: 1000 })
    ask(machine, 2, { cwd: '/w/b', min: 8, want: 8, since: 1001 })
    ask(machine, 3, { cwd: '/w/a', min: 2, want: 6, since: 1002 })
    expect(decision(machine, 3)).toEqual({ slots: 6, memoryBytes: 6 * GIB })
    expect(decision(machine, 1)).toEqual({ waits: 'machine held: cleanup' })
    expect(decision(machine, 2)).toEqual({ waits: 'machine held: cleanup' })
  })

  it('makes a request without a working directory wait, as an old request file records none', () => {
    const machine = new Machine()
    hold(machine, { allow: ['/w/a'] })
    ask(machine, 1)
    expect(decision(machine, 1)).toEqual({ waits: 'machine held: cleanup' })
    machine.files.delete('/s/hold.json')
    expect('slots' in decision(machine, 1)).toBe(true)
  })

  it('lets a holder that is running when the hold starts keep its grant, while a new request waits', async () => {
    const machine = new Machine()
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ want: 4, min: 4 }))
    expect(grant.slots).toBe(4)
    hold(machine)
    ask(machine, 2)
    const state = readSlots(machine.host(2), paths)
    expect(state.holders.map(each => each.pid)).toEqual([1])
    expect(stepsBack(state, 1, budget)).toBe(false)
    expect(decide(state, 2, budget)).toEqual({ waits: 'machine held: cleanup' })
    expect(machine.files.has('/s/held-1.json')).toBe(true)
  })

  it('counts a hold file that is damaged or unreadable as a hold', () => {
    for (const text of ['{', '', '[]', JSON.stringify({ reason: 7, since: 1, allow: [] }), JSON.stringify({ reason: 'x', since: 1, allow: [], extra: true }), JSON.stringify({ reason: 'x', since: 1e300, allow: [] })]) {
      const machine = new Machine()
      machine.files.set('/s/hold.json', text)
      ask(machine, 1, { cwd: '/w/a' })
      expect(decision(machine, 1)).toEqual({ waits: 'machine held: hold file unreadable' })
    }
    const machine = new Machine()
    ask(machine, 1)
    const host = machine.host(1)
    const failing: QueueHost = { ...host, fs: { ...host.fs, read: path => { if (path === '/s/hold.json') throw new Error('EACCES'); return host.fs.read(path) } } }
    machine.files.set('/s/hold.json', '')
    expect(decide(readSlots(failing, paths), 1, budget)).toEqual({ waits: 'machine held: hold file unreadable' })
  })

  it('keeps the priority and the backfill rule when the hold lifts', () => {
    const machine = new Machine()
    hold(machine)
    ask(machine, 1, { since: 1000, want: 20 })
    ask(machine, 2, { since: 2000, priority: 0, want: 20 })
    expect(decision(machine, 1)).toEqual({ waits: 'machine held: cleanup' })
    expect(decision(machine, 2)).toEqual({ waits: 'machine held: cleanup' })
    machine.files.delete('/s/hold.json')
    expect('slots' in decision(machine, 2)).toBe(true)
    expect(decision(machine, 1)).toEqual({ waits: '0 of 20 slots are free and it needs 4' })

    const beside = new Machine()
    beside.hold(9, { slots: 12, since: 0 })
    hold(beside)
    ask(beside, 1, { min: 8, want: 8, since: 10 })
    ask(beside, 2, { min: 2, want: 4, since: 11 })
    expect(decision(beside, 2, small)).toEqual({ waits: 'machine held: cleanup' })
    beside.files.delete('/s/hold.json')
    expect(decision(beside, 1, small)).toEqual({ waits: '4 of 16 slots are free and it needs 8' })
    expect(decision(beside, 2, small)).toEqual({ slots: 2, memoryBytes: 2 * GIB })
  })

  it('is written by --hold in one step and printed, replaced by a later --hold, and removed by --unhold', () => {
    const machine = new Machine()
    const host = machine.host(1)
    expect(holdMachine(host, paths, 'tests are running', ['/w/a', '/w/b'])).toEqual([
      'machine held: tests are running; since 1970-01-01T00:00:01.000Z, 0 s ago',
      '  allowed worktree: /w/a',
      '  allowed worktree: /w/b',
    ])
    expect(JSON.parse(machine.files.get('/s/hold.json') ?? '')).toEqual({ reason: 'tests are running', since: 1000, allow: ['/w/a', '/w/b'] })
    expect([...machine.files.keys()]).toEqual(['/s/hold.json'])
    machine.time = 5000
    expect(holdMachine(host, paths, 'again', [])).toEqual(['machine held: again; since 1970-01-01T00:00:05.000Z, 0 s ago', '  allowed worktrees: none'])
    expect(JSON.parse(machine.files.get('/s/hold.json') ?? '')).toMatchObject({ reason: 'again', allow: [] })
    expect(unholdMachine(host, paths)).toEqual(['machine hold removed; waiting requests proceed in their order'])
    expect([...machine.files.keys()]).toEqual([])
    expect(unholdMachine(host, paths)).toEqual(['no machine hold was in force'])
  })

  it('removes a damaged hold file with --unhold', () => {
    const machine = new Machine()
    machine.files.set('/s/hold.json', '{')
    machine.files.set('/s/hold.json.tmp', '{')
    expect(unholdMachine(machine.host(1), paths)).toEqual(['machine hold removed; waiting requests proceed in their order'])
    expect([...machine.files.keys()]).toEqual([])
  })

  it('is printed first by --queue, with the reason, the time and the allowed worktrees', () => {
    const machine = new Machine()
    machine.time = 1000
    holdMachine(machine.host(1), paths, 'tests are running', ['/w/a'])
    const lines = describeSlots(readSlots(machine.host(1), paths), budget, 61_000)
    expect(lines.slice(0, 3)).toEqual([
      'machine held: tests are running; since 1970-01-01T00:00:01.000Z, 60 s ago',
      '  allowed worktree: /w/a',
      'slots: 0 of 20 held, 2 disk-heavy places, 20.0 GiB of memory; 0 waiting',
    ])
    expect(describeSlots({ holders: [], waiting: [], oldWaiting: [] }, budget, 0)[0]).toBe('slots: 0 of 20 held, 2 disk-heavy places, 20.0 GiB of memory; 0 waiting')
  })
})

describe('the pressure alarm', () => {
  /** A machine's pressure at one figure for every resource and window, so a spec states only what it is about. */
  const at = (some: number, full = 0): Pressure => ({
    cpu: { 10: { some, full }, 60: { some, full }, 300: { some, full } },
    memory: { 10: { some, full }, 60: { some, full }, 300: { some, full } },
    io: { 10: { some, full }, 60: { some, full }, 300: { some, full } },
  })
  /** The pressure this machine runs at, measured: cpu some avg300 12%, memory full avg300 0.11%, io some avg300 0.27%. */
  const baseline: Pressure = {
    cpu: { 10: { some: 0.66, full: 0 }, 60: { some: 1.29, full: 0 }, 300: { some: 12, full: 0 } },
    memory: { 10: { some: 0, full: 0 }, 60: { some: 0, full: 0 }, 300: { some: 0.04, full: 0.11 } },
    io: { 10: { some: 0, full: 0 }, 60: { some: 0.09, full: 0.09 }, 300: { some: 0.27, full: 0.24 } },
  }
  const request = (pid: number, since: number) => ({ file: String(pid), pid, want: 4, min: 4, memoryBytes: 0, disk: false, priority: 1 as const, label: '', since })

  it('does not fire on the pressure this machine runs at, so ordinary work is never held', () => {
    expect(overloadOf(baseline)).toBeUndefined()
    expect(decide({ holders: [], waiting: [request(1, 1)], oldWaiting: [], pressure: baseline }, 1, budget)).toEqual({ slots: 4, memoryBytes: 4 * GIB })
  })

  it('fires only on the five-minute window, so a spike of the last ten seconds never trips it', () => {
    // A burst that has just started: the ten-second average is saturated, the one-minute one has not caught up.
    const spike: Pressure = {
      cpu: { 10: { some: 99, full: 90 }, 60: { some: 40, full: 20 }, 300: { some: 12, full: 0 } },
      memory: { 10: { some: 99, full: 99 }, 60: { some: 30, full: 15 }, 300: { some: 0.04, full: 0.11 } },
      io: { 10: { some: 99, full: 99 }, 60: { some: 45, full: 40 }, 300: { some: 0.27, full: 0.24 } },
    }
    expect(overloadOf(spike)).toBeUndefined()
    expect('slots' in decide({ holders: [], waiting: [request(1, 1)], oldWaiting: [], pressure: spike }, 1, budget)).toBe(true)
  })

  it('fires when a resource has been over its threshold for the window, and names it', () => {
    const overloaded = overloadOf({ ...at(0), cpu: { 10: { some: 0, full: 0 }, 60: { some: 97.4, full: 0 }, 300: { some: 0, full: 0 } } })
    expect(overloaded).toEqual({ resources: [{ resource: 'cpu', percent: 97.4, threshold: 90 }], window: 60 })
    expect(describeOverload(overloaded!)).toBe('the machine is overloaded: cpu 97.4% of the last 60 s (over 90%)')
    // Memory and io are read the same way, on their `some` figure.
    expect(overloadOf({ ...at(0), memory: { 10: { some: 0, full: 0 }, 60: { some: 91, full: 90 }, 300: { some: 0, full: 0 } } })?.resources).toEqual([{ resource: 'memory', percent: 91, threshold: 90 }])
    // A machine that is busy but still serving work is not overloaded: the alarm is for saturation, not for load. A merge
    // tier at half the CPUs, and a disk at three quarters, are both well under it.
    expect(overloadOf({ ...at(0), cpu: { 10: { some: 0, full: 0 }, 60: { some: 50, full: 0 }, 300: { some: 50, full: 0 } } })).toBeUndefined()
    expect(overloadOf({ ...at(0), io: { 10: { some: 0, full: 0 }, 60: { some: 89.9, full: 0 }, 300: { some: 89.9, full: 0 } } })).toBeUndefined()
  })

  it('holds every new grant while it is on, and never interrupts a holder', async () => {
    const machine = new Machine()
    machine.hold(7, { slots: 4 })
    let pressure: Pressure | undefined = at(99)
    const grant = takeSlots(machine.host(1), paths, budget, demand({ want: 2, min: 2 }), () => pressure)
    machine.onSleep = (count) => {
      // The holder keeps its grant throughout, and the alarm lifts when the pressure falls.
      if (count === 2) expect(machine.files.has('/s/held-7.json')).toBe(true)
      if (count === 3) pressure = baseline
    }
    expect(await grant).toEqual({ slots: 2, memoryBytes: GIB, waitedMs: 3000 })
    expect(machine.said[0]).toContain('waiting for 2 of 20 slots: the machine is overloaded: cpu 99.0% of the last 60 s (over 90%)')
  })

  it('grants as before where the kernel reports no pressure, so a machine without it is never held', () => {
    expect(overloadOf(undefined)).toBeUndefined()
    expect(decide({ holders: [], waiting: [request(1, 1)], oldWaiting: [] }, 1, budget)).toEqual({ slots: 4, memoryBytes: 4 * GIB })
  })

  it('catches a burst: twenty lanes arriving at once start only what the ceiling allows, and the rest wait in order', () => {
    // The ceiling the brief asks for: near the hardware, so a burst cannot start twenty lanes and then trip the alarm.
    const ceiling: SlotBudget = { slots: 16, memoryBytes: 20 * GIB, diskRuns: 3 }
    const lanes = Array.from({ length: 20 }, (_unused, index) => request(index + 1, 1000 + index))
    const state = { holders: [], waiting: lanes, oldWaiting: [], pressure: baseline }
    // Each lane asks for four slots: four start, and the fifth waits behind them rather than overfilling the machine.
    const started = lanes.filter(lane => 'slots' in decide(state, lane.pid, ceiling))
    expect(started.map(lane => lane.pid)).toEqual([1, 2, 3, 4])
    expect(decide(state, 5, ceiling)).toEqual({ waits: '0 of 16 slots are free and it needs 4' })
    // The alarm is the second line of defence: a burst that gets past the ceiling still stops new grants once the machine
    // has been overloaded for the window, and the holders it started keep their grants.
    const overloaded = { ...state, pressure: at(99) }
    expect(decide(overloaded, 1, ceiling)).toEqual({ waits: 'the machine is overloaded: cpu 99.0% of the last 60 s (over 90%), memory 99.0% of the last 60 s (over 90%), io 99.0% of the last 60 s (over 90%)' })
  })

  it('is printed by --queue above the slots, so a person sees why new grants wait', () => {
    const lines = describeSlots({ holders: [], waiting: [], oldWaiting: [], pressure: at(99) }, budget, 0)
    expect(lines[0]).toBe('alarm: the machine is overloaded: cpu 99.0% of the last 60 s (over 90%), memory 99.0% of the last 60 s (over 90%), io 99.0% of the last 60 s (over 90%); new grants wait, holders keep theirs')
    expect(lines[1]).toBe('slots: 0 of 20 held, 2 disk-heavy places, 20.0 GiB of memory; 0 waiting')
    expect(describeSlots({ holders: [], waiting: [], oldWaiting: [], pressure: baseline }, budget, 0)).toHaveLength(1)
  })
})
