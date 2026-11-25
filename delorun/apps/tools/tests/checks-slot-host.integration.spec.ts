/**
 * The slot budget on this machine, what a run asks of it, a plan fitted to its grant, the wrapper for ad-hoc commands,
 * and the disk pressure the run reports.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { PassCache } from '../src/checks/cache.ts'
import { checksToRun, diskHeavy, fitToGrant, MIN_RUN_SLOTS, runDemand, withoutIdleNeeds } from '../src/checks/demand.ts'
import { ioPressure } from '../src/checks/machine.ts'
import type { Planned } from '../src/checks/plan.ts'
import { diskRotational, diskRunsFor, machineBudget, nodeSlotHost, privateSlotPaths, processAlive, processIsThread, processStart, processStartedAt, slotPaths } from '../src/checks/slot-host.ts'
import { takeSlots } from '../src/checks/slots.ts'
import type { Unit } from '../src/checks/units.ts'
import { runInherited, withSlots, type WrapperHost } from '../src/with-slots.ts'

const GIB = 1024 ** 3
const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const check = (id: string, extra: Partial<Planned> = {}): Planned => ({ id, group: id.split(':')[0] ?? id, title: id, cwd: '', command: ['x'], needs: [], tiers: ['changed'], cpus: 1, memoryBytes: GIB, budget: { memoryGiB: 1 }, reason: 'test', ...extra })

describe('the machine\'s budget', () => {
  it('takes the CPUs and the disk\'s own count of disk-heavy places unless the environment names other counts, and refuses a count that is not one', () => {
    expect(machineBudget(22, 18 * GIB, {})).toEqual({ slots: 22, memoryBytes: 18 * GIB, diskRuns: 3 })
    expect(machineBudget(22, 18 * GIB, { DELORUN_CHECKS_SLOTS: '8', DELORUN_CHECKS_DISK_RUNS: '1' })).toEqual({ slots: 8, memoryBytes: 18 * GIB, diskRuns: 1 })
    expect(machineBudget(22, GIB, { DELORUN_CHECKS_SLOTS: '' }).slots).toBe(22)
    expect(() => machineBudget(22, GIB, { DELORUN_CHECKS_SLOTS: '0' })).toThrow('DELORUN_CHECKS_SLOTS must be a positive whole number, got 0')
    expect(() => machineBudget(22, GIB, { DELORUN_CHECKS_DISK_RUNS: 'two' })).toThrow('DELORUN_CHECKS_DISK_RUNS must be a positive whole number, got two')
  })

  it('takes more disk-heavy places on a disk that reports no seek cost, and the measured count where it reports none', () => {
    // The constant was measured on an NVMe-backed WSL disk; a spinning disk keeps the figure it was measured with.
    expect(diskRunsFor(false)).toBe(4)
    expect(diskRunsFor(true)).toBe(3)
    expect(diskRunsFor(undefined)).toBe(3)
    expect(machineBudget(22, 18 * GIB, {}, false).diskRuns).toBe(4)
    expect(machineBudget(22, 18 * GIB, {}, true).diskRuns).toBe(3)
    // The environment still wins over the measurement.
    expect(machineBudget(22, 18 * GIB, { DELORUN_CHECKS_DISK_RUNS: '2' }, false).diskRuns).toBe(2)
  })

  it('reads the disk\'s rotational flag for the file system a directory lies on, and none where the machine reports none', () => {
    const read = (path: string): string => path === '/sys/block/sda/queue/rotational' ? '0\n' : (() => { throw new Error('ENOENT') })()
    // A partition's entry links to `.../block/<disk>/<partition>`, and only the disk has a queue.
    const partition = (): string => '../../devices/pci0000:00/0000:00:1e.0/virtio2/host0/target0:0:0/0:0:0:0/block/sda/sda1'
    expect(diskRotational(tmpdir(), read, partition)).toBe(false)
    expect(diskRotational(tmpdir(), () => '1\n', partition)).toBe(true)
    // A whole disk's entry links to `.../block/<disk>`.
    expect(diskRotational(tmpdir(), read, () => '../../devices/pci0000:00/0000:00:1e.0/virtio2/host0/target0:0:0/0:0:0:0/block/sda')).toBe(false)
    // No /sys/dev/block entry for the device, or no such directory: the machine reports no disk.
    expect(diskRotational(tmpdir(), read, () => { throw new Error('ENOENT') })).toBeUndefined()
    expect(diskRotational('/no/such/directory', read, partition)).toBeUndefined()
    // The machine this runs on reports its own disk, and the flag is one of the two.
    expect([true, false, undefined]).toContain(diskRotational(tmpdir()))
  })

  it('overrides the measured memory with DELORUN_CHECKS_MEMORY_GIB, and refuses a figure that is not a positive number', () => {
    expect(machineBudget(22, 18 * GIB, { DELORUN_CHECKS_MEMORY_GIB: '12' }).memoryBytes).toBe(12 * GIB)
    expect(machineBudget(22, 18 * GIB, { DELORUN_CHECKS_MEMORY_GIB: '12.5' }).memoryBytes).toBe(Math.round(12.5 * GIB))
    expect(machineBudget(22, 18 * GIB, { DELORUN_CHECKS_MEMORY_GIB: '' }).memoryBytes).toBe(18 * GIB)
    expect(() => machineBudget(22, 18 * GIB, { DELORUN_CHECKS_MEMORY_GIB: 'lots' })).toThrow('DELORUN_CHECKS_MEMORY_GIB must be a positive number of GiB, got lots')
    expect(() => machineBudget(22, 18 * GIB, { DELORUN_CHECKS_MEMORY_GIB: '0' })).toThrow('DELORUN_CHECKS_MEMORY_GIB must be a positive number of GiB, got 0')
  })

  it('lives in the user\'s own directory under the temporary directory, beside the previous queue and lock', () => {
    expect(slotPaths('/t', 1000)).toEqual({ dir: '/t/delorun-checks-1000.slots', oldQueue: '/t/delorun-checks.queue', oldLock: '/t/delorun-checks.lock' })
  })

  it('creates the user\'s directory with mode 0700, and refuses one other users can reach, a link, or another user\'s', () => {
    const base = mkdtempSync(join(tmpdir(), 'delorun-slot-dir-'))
    temporary.push(base)
    const uid = process.getuid?.() ?? -1
    const { dir } = privateSlotPaths(base, uid)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    chmodSync(dir, 0o755)
    expect(() => privateSlotPaths(base, uid)).toThrow(`the slot budget ${dir} has mode 755, which other users can reach; remove ${dir} while no run holds or waits for slots`)
    expect(() => privateSlotPaths(base, uid + 1)).toThrow(/is not a directory|belongs to user/)
    const linked = mkdtempSync(join(tmpdir(), 'delorun-slot-link-'))
    temporary.push(linked)
    mkdirSync(join(linked, 'target'), { mode: 0o700 })
    symlinkSync(join(linked, 'target'), slotPaths(linked, uid).dir)
    expect(() => privateSlotPaths(linked, uid)).toThrow('is not a directory (a symbolic link is refused)')
  })

  it('reads a process\'s start time past a command name with spaces and parentheses, and none for a gone process', () => {
    expect(processStart(1, () => `1 (a ) b) S ${Array.from({ length: 18 }, (_, index) => String(index + 1)).join(' ')} 4242 99`)).toBe('4242')
    expect(processStart(process.pid)).toMatch(/^\d+$/)
    expect(processStart(process.pid)).toBe(nodeSlotHost(() => undefined).startOf(process.pid))
    expect(processStart(2 ** 22 + 1)).toBeUndefined()
  })

  it('places a process\'s start on the shared clock from the boot time, and none without /proc', () => {
    const stat = `1 (a) S ${Array.from({ length: 18 }, (_, index) => String(index + 1)).join(' ')} 4242 99`
    expect(processStartedAt(1, path => path === '/proc/stat' ? 'cpu 1\nbtime 1000\n' : stat)).toBe(1_000_000 + 42_420)
    expect(processStartedAt(1, () => { throw new Error('ENOENT') })).toBeUndefined()
    const now = Date.now()
    expect(Math.abs((processStartedAt(process.pid) ?? 0) - now)).toBeLessThan(24 * 3600 * 1000 * 365)
    expect(nodeSlotHost(() => undefined).startedAt(process.pid)).toBe(processStartedAt(process.pid))
  })

  it('knows an id that is a thread of another process from its thread group', () => {
    expect(processIsThread(7, () => 'Name:\tnode\nTgid:\t3\nPid:\t7\n')).toBe(true)
    expect(processIsThread(7, () => 'Name:\tnode\nTgid:\t7\nPid:\t7\n')).toBe(false)
    expect(processIsThread(7, () => { throw new Error('ENOENT') })).toBe(false)
    expect(processIsThread(process.pid)).toBe(false)
    expect(nodeSlotHost(() => undefined).isThread(process.pid)).toBe(false)
  })

  it('takes and releases a grant on the real file system', async () => {
    const base = mkdtempSync(join(tmpdir(), 'delorun-slot-host-'))
    temporary.push(base)
    const said: string[] = []
    const host = nodeSlotHost(line => { said.push(line) })
    const grant = await takeSlots({ ...host, guard: () => undefined }, slotPaths(base, process.getuid?.() ?? -1), { slots: 4, memoryBytes: 4 * GIB, diskRuns: 1 }, { want: 2, min: 2, memoryBytes: 0, disk: true, priority: 1, label: 'spec' })
    expect(grant.slots).toBe(2)
    expect(existsSync(join(slotPaths(base, process.getuid?.() ?? -1).dir, `held-${String(process.pid)}.json`))).toBe(true)
    expect(host.fs.read(join(base, 'missing'))).toBeUndefined()
    expect(host.fs.list(join(base, 'missing'))).toEqual([])
    host.say('x')
    expect(said).toEqual(['x'])
    await host.sleep(1)
    expect(host.now()).toBeGreaterThan(0)
  })

  it('knows a running process, one of another user, and a gone one', () => {
    expect(processAlive(process.pid)).toBe(true)
    expect(processAlive(1)).toBe(true)
    expect(processAlive(2 ** 22 + 1)).toBe(false)
  })

  it('reads the disk pressure, and none where the kernel reports none', () => {
    expect(ioPressure(() => 'some avg10=45.57 avg60=52.73 avg300=53.03 total=1\nfull avg10=1.00 avg60=0 avg300=0 total=1\n')).toBe(45.57)
    expect(ioPressure(() => 'nothing')).toBeUndefined()
    expect(ioPressure(() => { throw new Error('ENOENT') })).toBeUndefined()
  })
})

describe('what a run asks for', () => {
  it('drops a check planned only as a need when no check that will run needs it, and keeps every other check', () => {
    const native = check('generate:native', { reason: 'needed by tests:fork' })
    const build = check('build:artifacts', { reason: 'needed by tests:fork', needs: [] })
    const delorun = check('build:delorun', { reason: 'needed by tests:fork', needs: ['build:artifacts'] })
    const fork = check('tests:fork', { needs: ['generate:native', 'build:delorun'] })
    const gate = check('gates:dco')
    const plan = [native, build, delorun, fork, gate]
    // The suite is served from stored passes: its needs do not run.
    expect(withoutIdleNeeds(plan, [native, build, delorun, gate]).map(each => each.id)).toEqual(['tests:fork', 'gates:dco'])
    // The suite no longer waits for the needs that were dropped.
    expect(withoutIdleNeeds(plan, [native, build, delorun, gate]).map(each => each.needs)).toEqual([[], []])
    // The suite runs: so do its needs, and their needs.
    expect(withoutIdleNeeds(plan, plan).map(each => each.id)).toEqual(['generate:native', 'build:artifacts', 'build:delorun', 'tests:fork', 'gates:dco'])
    // Two checks that need one build, and a need outside the plan, are walked once each.
    const snapshots = check('tests:snapshots', { needs: ['generate:native', 'build:delorun', 'gone'] })
    expect(withoutIdleNeeds([...plan, snapshots], [native, build, delorun, fork, snapshots]).map(each => each.id)).toEqual(['generate:native', 'build:artifacts', 'build:delorun', 'tests:fork', 'gates:dco', 'tests:snapshots'])
    // A need that a stored pass serves is kept, to report it.
    expect(withoutIdleNeeds(plan, [gate]).map(each => each.id)).toEqual(['generate:native', 'build:artifacts', 'build:delorun', 'tests:fork', 'gates:dco'])
  })

  it('names the disk-heavy checks', () => {
    expect(['build:artifacts', 'generate:native', 'docs-site', 'tests:fork', 'tests:fork:integration', 'jsdoc', 'tests:snapshots'].map(id => diskHeavy(check(id, { group: id === 'build:artifacts' ? 'generate' : id.split(':')[0] ?? id })))).toEqual([true, true, true, true, true, false, false])
  })

  it('leaves out the declined checks and those a stored pass serves, whole or for every package', () => {
    const units: Unit[] = [{ dir: 'a', arg: 'a/', inputs: [] }, { dir: 'b', arg: 'b/', inputs: [] }]
    const cached = new Set(['jsdoc', 'tests:fork@a', 'tests:fork@b', 'tests:other@a'])
    const cache: Pick<PassCache, 'keyOf' | 'lookup' | 'unitKey' | 'lookupUnit'> = {
      keyOf: each => each.inputs === undefined ? undefined : each.id,
      lookup: (_each, key) => cached.has(key) ? 'local' : undefined,
      unitKey: (each, unit) => `${each.id}@${unit.dir}`,
      lookupUnit: (_each, _unit, key) => cached.has(key) ? 'shared' : undefined,
    }
    const plan = [check('jsdoc', { inputs: ['x'] }), check('gates:docs', { inputs: ['x'] }), check('boundary'), check('tests:docker', { declined: 'no engine' }), { ...check('tests:fork'), units }, { ...check('tests:other'), units }, { ...check('tests:none'), units: [] }]
    expect(checksToRun(plan, cache).map(each => each.id)).toEqual(['gates:docs', 'boundary', 'tests:other', 'tests:none'])
    expect(checksToRun(plan, undefined)).toHaveLength(6)
  })

  it('asks for the slots its checks keep busy, at least four of them when it can use them, its largest check\'s memory and a disk place when it needs one', () => {
    const running = [check('tests:fork', { cpus: 20, memoryBytes: 10 * GIB, budget: { memoryGiB: 0.5, perWorker: true } }), check('typecheck:upstream', { cpus: 2, memoryBytes: 2.5 * GIB, budget: { memoryGiB: 2.5 } })]
    expect(runDemand(running, 22, 1, 'lane')).toEqual({ want: 22, min: MIN_RUN_SLOTS, memoryBytes: 2.5 * GIB, disk: true, priority: 1, label: 'lane' })
    expect(runDemand([check('gates:docs', { cpus: 1 })], 22, 0, 'trunk')).toEqual({ want: 1, min: 1, memoryBytes: GIB, disk: false, priority: 0, label: 'trunk' })
  })

  it('fits the test runners to the grant and leaves every other check as it is', () => {
    const fork = check('tests:fork', { command: ['vitest', 'run', '--maxWorkers=20', 'a/'], cpus: 20, memoryBytes: 10 * GIB, budget: { memoryGiB: 0.5, perWorker: true } })
    const upstream = check('tests:upstream-changed', { command: ['vitest', '--maxWorkers=8'], cpus: 8, memoryBytes: 8 * GIB, budget: { memoryGiB: 1 } })
    const small = check('tests:x', { command: ['vitest', '--maxWorkers=2'], cpus: 2 })
    const plain = check('jsdoc')
    const [fitFork, fitUpstream, fitSmall, fitPlain] = fitToGrant([fork, upstream, small, plain], 6)
    expect(fitFork).toMatchObject({ command: ['vitest', 'run', '--maxWorkers=6', 'a/'], cpus: 6, memoryBytes: 3 * GIB })
    expect(fitUpstream).toMatchObject({ command: ['vitest', '--maxWorkers=6'], cpus: 6, memoryBytes: 8 * GIB })
    expect(fitSmall).toBe(small)
    expect(fitPlain).toBe(plain)
    expect(fitToGrant([fork], 12)[0]?.command[2]).toBe('--maxWorkers=10')
    expect(fitToGrant([fork], 0)[0]?.command[2]).toBe('--maxWorkers=1')
  })
})

describe('the wrapper for ad-hoc commands', () => {
  /**
   * A wrapper host on a temporary budget whose runner records the command.
   * @returns the host and what it ran.
   */
  function wrapper(): { host: WrapperHost, ran: Array<{ argv: readonly string[], slots: string | undefined }>, said: string[] } {
    const base = mkdtempSync(join(tmpdir(), 'delorun-with-slots-'))
    temporary.push(base)
    const ran: Array<{ argv: readonly string[], slots: string | undefined }> = []
    const said: string[] = []
    const real = nodeSlotHost(line => { said.push(line) })
    let clock = 0
    return {
      ran,
      said,
      host: {
        slots: { ...real, guard: () => undefined, now: () => (clock += 1500) },
        paths: slotPaths(base, process.getuid?.() ?? -1),
        budget: { slots: 8, memoryBytes: 8 * GIB, diskRuns: 1 },
        env: { KEEP: '1' },
        run: async (argv, env) => { ran.push({ argv, slots: env['DELORUN_SLOTS'] }); return 3 },
      },
    }
  }

  it('takes the slots, runs the command with the grant in DELORUN_SLOTS and returns its status', async () => {
    const { host, ran, said } = wrapper()
    expect(await withSlots(['--slots', '2', '--disk', '--memory-gib', '1', '--', 'tsc', '-p', 'x\n'], host)).toBe(3)
    expect(ran).toEqual([{ argv: ['tsc', '-p', 'x\n'], slots: '2' }])
    expect(said).toEqual(['with-slots: waited 3 s for 2 slots\n'])
    expect(readFileSync(join(host.paths.dir, `held-${String(process.pid)}.json`), 'utf8')).toContain('"label":"with-slots: tsc -p x "')
  })

  it('takes four slots by default', async () => {
    const { host, ran } = wrapper()
    await withSlots(['--', 'vitest'], host)
    expect(ran[0]?.slots).toBe('4')
  })

  it('refuses a bad count, a bad memory figure and a missing command', async () => {
    const { host } = wrapper()
    await expect(withSlots(['--slots', '0', '--', 'x'], host)).rejects.toThrow('--slots takes a positive whole number, got 0')
    await expect(withSlots(['--memory-gib', 'lots', '--', 'x'], host)).rejects.toThrow('--memory-gib takes a number of GiB, got lots')
    await expect(withSlots(['--slots', '1'], host)).rejects.toThrow('give the command after --')
  })

  it('runs a command with inherited streams and reports its status, and 1 for one that does not start', async () => {
    expect(await runInherited([process.execPath, '-e', 'process.exit(3)'], process.env)).toBe(3)
    expect(await runInherited(['delorun-no-such-command'], process.env)).toBe(1)
    expect(await runInherited([process.execPath, '-e', 'process.kill(process.pid, "SIGTERM")'], process.env)).toBe(1)
  })
})
