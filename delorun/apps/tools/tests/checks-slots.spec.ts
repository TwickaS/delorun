/**
 * The machine-wide slot budget against an in-memory file system and process table: grants beside other runs, first come
 * first served, the disk-heavy places, the trunk's priority, dead holders and reused process ids reclaimed, claims that
 * overfill the slots, the memory or the disk-heavy places stepping back,
 * old worktrees' queue and lock, and the position messages.
 */
import { describe, expect, it } from 'vitest'
import type { QueueFs, QueueHost } from '../src/checks/run-queue.ts'
import { decide, describeSlots, grantFromEnv, grantToEnv, readSlots, SLOT_POLL_MILLISECONDS, stepsBack, takeSlots, WAIT_REPORT_MILLISECONDS, type SlotBudget, type SlotDemand, type SlotGrant, type SlotPaths } from '../src/checks/slots.ts'

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
    expect(await takeSlots(machine.host(1), paths, budget, demand())).toEqual({ slots: 15, memoryBytes: 15 * GIB, waitedMs: 0 })
    expect(machine.files.has('/q/1-000000000001000-1.held')).toBe(true)
    const trunk = new Machine()
    expect((await takeSlots(trunk.host(1), paths, budget, demand({ priority: 0 }))).slots).toBe(20)
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
    const grant = await takeSlots(machine.host(1), paths, budget, demand({ min: 2, memoryBytes: GIB }))
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
    const grant = await takeSlots(machine.host(1), paths, budget, demand())
    expect(machine.sleeps).toBe(1)
    expect(grant).toMatchObject({ slots: 15, memoryBytes: 15 * GIB })
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

  it('hand a grant to the re-executed run and refuse a malformed one', () => {
    const grant: SlotGrant = { slots: 6, memoryBytes: 5.5 * GIB, waitedMs: 1234.4 }
    expect(grantFromEnv(grantToEnv(grant))).toEqual({ slots: 6, memoryBytes: Math.round(5.5 * GIB), waitedMs: 1234 })
    expect(grantFromEnv(undefined)).toBeUndefined()
    expect(() => grantFromEnv('0:1:1')).toThrow('DELORUN_CHECKS_GRANT must be')
    expect(() => grantFromEnv('six')).toThrow('DELORUN_CHECKS_GRANT must be')
  })
})
