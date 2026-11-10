import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUDGETS_SCHEMA, checkBudgets, IO_PRESSURE_LIMIT, proposeBudgets, proposeCeiling, readBudgets, unjudgeable, type BudgetFile } from '../src/harness/budgets.ts'
import { assertIsolated, IsolationRefusal, isolatedCommand, nonLoopbackInterfaces } from '../src/harness/isolation.ts'
import { clonesFiles, fileSystemType, ioPressure, loadAverages, machineFacts } from '../src/harness/machine.ts'
import { parseCommandLine, selection, UsageError } from '../src/harness/options.ts'
import { RESULT_SCHEMA, Samples, Scrubber, type BenchmarkResult, type ScenarioResult } from '../src/harness/result.ts'
import { median, summarize } from '../src/harness/stats.ts'
import type { Suite } from '../src/harness/suite.ts'
import { columns, formatDuration, resultTable } from '../src/harness/table.ts'

const made: string[] = []
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true })
})

/** A suite with two scenarios, for the command line. */
const SUITE: Suite = { id: 'update', title: 'Update', items: { total: 'all' }, scenarios: [{ id: 'a', description: 'A' }, { id: 'b', description: 'B' }], run: () => Promise.reject(new Error('not run')) }
const OTHER: Suite = { ...SUITE, id: 'start', scenarios: [{ id: 'cold', description: 'Cold' }] }

/** A scenario result with one item. */
function scenario(name: string, samples: readonly number[], failures: readonly string[] = []): ScenarioResult {
  const collected = new Samples()
  for (const sample of samples) collected.add('total', sample)
  return { scenario: name, description: name, parameters: { chats: 20 }, completed: samples.length, phases: collected.results(), failures }
}

describe('stats', () => {
  it('takes the middle sample, or the mean of the two middle ones', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
    expect(() => median([])).toThrow(RangeError)
  })

  it('summarises samples in whole milliseconds', () => {
    expect(summarize([10.4, 30.6, 20.2])).toEqual({ n: 3, median: 20, min: 10, max: 31, spread: 20 })
  })
})

describe('samples and scrubbing', () => {
  it('orders items by the declared order, then by first appearance', () => {
    const samples = new Samples()
    samples.addAll({ late: 1, total: 2 })
    samples.add('extra', 3)
    samples.addAll({ total: 4 })
    expect(samples.results(['total', 'late']).map(item => [item.phase, item.samples])).toEqual([['total', [2, 4]], ['late', [1]], ['extra', [3]]])
  })

  it('replaces roots, homes and the user name, roots first', () => {
    const scrubber = new Scrubber(['/home/someone'], 'someone')
    scrubber.addRoot('/home/someone/tmp/delo-bench-1')
    expect(scrubber.scrub('failed in /home/someone/tmp/delo-bench-1/home and /home/someone/x for someone')).toBe('failed in <root>/home and <home>/x for <user>')
  })

  it('does not replace a user name too short to be told from other text', () => {
    expect(new Scrubber([], 'ab').scrub('ab cd')).toBe('ab cd')
  })
})

describe('budgets', () => {
  const budgets: BudgetFile = { schema: BUDGETS_SCHEMA, rule: 'four times', suites: { update: { a: { total: 100 } } } }

  it('passes a median at or under its ceiling', () => {
    expect(checkBudgets({ suites: [{ suite: 'update', scenarios: [scenario('a', [90, 100, 400])], skipped: [] }] }, budgets)).toEqual([])
  })

  it('fails a median over its ceiling', () => {
    expect(checkBudgets({ suites: [{ suite: 'update', scenarios: [scenario('a', [90, 120, 130])], skipped: [] }] }, budgets)).toEqual([{ where: 'update/a/total', problem: 'median 120 ms is over its ceiling of 100 ms' }])
  })

  it('fails a budgeted item that was not measured, a scenario without ceilings and a failed repetition', () => {
    const unmeasured: ScenarioResult = { ...scenario('a', []), phases: [] }
    expect(checkBudgets({ suites: [{ suite: 'update', scenarios: [unmeasured, scenario('b', [1], ['boom\nmore'])], skipped: [] }] }, budgets)).toEqual([
      { where: 'update/a/total', problem: 'has a ceiling but was not measured' },
      { where: 'update/b', problem: 'a repetition failed: boom' },
      { where: 'update/b', problem: 'no ceiling is recorded for this scenario in budgets.json' },
    ])
  })

  it('proposes four times the median, at least a second, rounded up to two significant digits', () => {
    expect(proposeCeiling(10)).toBe(1000)
    expect(proposeCeiling(1234)).toBe(5000)
    expect(proposeCeiling(1260)).toBe(5100)
    expect(proposeCeiling(26_543)).toBe(110_000)
  })

  it('proposes ceilings for every completed scenario and none for a failed or empty one', () => {
    const proposed = proposeBudgets({ suites: [{ suite: 'update', scenarios: [scenario('a', [2000]), scenario('b', [1], ['boom']), { ...scenario('c', []), phases: [] }], skipped: [] }] }, 'rule')
    expect(proposed).toEqual({ schema: BUDGETS_SCHEMA, rule: 'rule', suites: { update: { a: { total: 8000 } } } })
  })

  it('refuses to judge a run whose storage pressure went over the limit, and judges one at or under it', () => {
    expect(unjudgeable({ before: [], after: [], ioBefore: 3, ioAfter: IO_PRESSURE_LIMIT, ioMax: 12 })).toBeUndefined()
    expect(unjudgeable({ before: [], after: [] })).toBeUndefined()
    expect(unjudgeable({ before: [], after: [], ioBefore: 2, ioMax: 75.2 })).toContain('storage pressure reached 75.2%')
    expect(unjudgeable({ before: [], after: [], ioAfter: 21 })).toContain('rerun on a quiet machine')
    expect(unjudgeable({ before: [], after: [], ioBefore: 30 })).toContain('30%')
  })

  it('reads a budget file and refuses one that is not', () => {
    const directory = mkdtempSync(join(tmpdir(), 'delo-bench-spec-'))
    made.push(directory)
    writeFileSync(join(directory, 'good.json'), JSON.stringify(budgets))
    writeFileSync(join(directory, 'bad.json'), JSON.stringify({ ...budgets, suites: { update: { a: { total: -1 } } } }))
    expect(readBudgets(join(directory, 'good.json'))).toEqual(budgets)
    expect(() => readBudgets(join(directory, 'bad.json'))).toThrow()
  })
})

describe('the table', () => {
  it('shows milliseconds below ten seconds and seconds above', () => {
    expect(formatDuration(850.4)).toBe('850 ms')
    expect(formatDuration(12_345)).toBe('12.3 s')
  })

  it('pads the first column left and the others right', () => {
    expect(columns([['item', 'n'], ['total', '10']])).toEqual(['item    n', 'total  10'])
  })

  it('prints the machine, the load, each scenario\'s items, its failures and the skipped items', () => {
    const result: BenchmarkResult = {
      schema: RESULT_SCHEMA, startedAt: '2026-11-10T00:00:00.000Z', commit: '0123456789abcdef0123', options: {},
      machine: { platform: 'linux', arch: 'x64', kernel: '6.6', cpus: 8, cpuModel: 'CPU', memoryGiB: 16, node: 'v24.22.0', fileSystem: 'ext2/ext3', clone: false },
      load: { before: [1, 2, 3], after: [4, 5, 6], ioBefore: 1.5, ioMax: 7 },
      suites: [{ suite: 'update', scenarios: [scenario('a', [1000]), { ...scenario('b', [], ['boom']), parameters: {} }], skipped: [{ item: 'clone', reason: 'no clones' }] }],
    }
    expect(resultTable(result)).toEqual([
      'Delo benchmarks at 0123456789ab, 2026-11-10T00:00:00.000Z',
      'Machine: 8 CPUs (CPU), 16 GiB, linux-x64 6.6, Node v24.22.0, ext2/ext3 without clones',
      'Load average before 1 / 2 / 3, after 4 / 5 / 6; storage pressure before 1.5%, after unknown, highest 7%',
      '',
      'update / a (1 run; chats=20)',
      '  item    median      min      max  n',
      '  total  1000 ms  1000 ms  1000 ms  1',
      '',
      'update / b (0 runs)',
      '  item  median  min  max  n',
      '  failed: boom',
      'update: skipped clone: no clones',
    ])
    expect(resultTable({ ...result, machine: { ...result.machine, clone: true }, suites: [] })[1]).toContain('with clones')
  })
})

describe('the command line', () => {
  it('takes the defaults, and a leading -- from the package manager', () => {
    expect(parseCommandLine(['--'], [SUITE])).toEqual({
      prepare: false, list: false, suites: [], scenarios: [], repeat: 3, chatsSmall: 20, chatsLarge: 400, plugins: 20,
      rootBase: undefined, closureFrom: undefined, out: undefined, checkBudgets: false, proposeBudgets: undefined, keepRoots: false,
    })
  })

  it('reads every option', () => {
    expect(parseCommandLine(['--suite', 'update', '--scenario', 'b', '--repeat', '5', '--chats-small', '2', '--chats-large', '9', '--plugins', '7', '--root-base', '/r', '--closure-from', '/c', '--out', '/o', '--check-budgets', '--propose-budgets', '/p', '--prepare', '--list', '--keep-roots'], [SUITE])).toEqual({
      prepare: true, list: true, suites: ['update'], scenarios: ['b'], repeat: 5, chatsSmall: 2, chatsLarge: 9, plugins: 7,
      rootBase: '/r', closureFrom: '/c', out: '/o', checkBudgets: true, proposeBudgets: '/p', keepRoots: true,
    })
  })

  it('refuses an unknown option, suite or scenario and a count that is not positive', () => {
    expect(() => parseCommandLine(['--fast'], [SUITE])).toThrow(UsageError)
    expect(() => parseCommandLine(['--suite', 'nope'], [SUITE])).toThrow('no suite is called "nope"')
    expect(() => parseCommandLine(['--suite', 'start', '--scenario', 'a'], [SUITE, OTHER])).toThrow('no selected suite has a scenario called "a"')
    expect(() => parseCommandLine(['--repeat', '0'], [SUITE])).toThrow('--repeat takes a positive whole number')
    expect(() => parseCommandLine(['--plugins', '1.5'], [SUITE])).toThrow(UsageError)
  })

  it('selects every suite by default, and only the scenarios named', () => {
    expect(selection({ suites: [], scenarios: [] }, [SUITE, OTHER]).map(entry => [entry.suite.id, entry.scenarios])).toEqual([['update', ['a', 'b']], ['start', ['cold']]])
    expect(selection({ suites: [], scenarios: ['b'] }, [SUITE, OTHER]).map(entry => [entry.suite.id, entry.scenarios])).toEqual([['update', ['b']]])
    expect(selection({ suites: ['start'], scenarios: [] }, [SUITE, OTHER]).map(entry => entry.suite.id)).toEqual(['start'])
  })
})

describe('the isolated network', () => {
  const lo = { address: '127.0.0.1', netmask: 'ff00::', family: 'IPv4' as const, mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }
  const eth = { ...lo, address: '192.0.2.2', internal: false, cidr: '192.0.2.2/24' }

  it('runs the command in a new network namespace that brings up loopback and maps the person back', () => {
    expect(isolatedCommand('/usr/bin/node', ['run.ts', '--x'], { uid: 1000, gid: 1001 })).toEqual({
      command: 'unshare',
      args: ['--user', '--map-root-user', '--net', 'sh', '-c', 'ip link set lo up && exec unshare --user --map-user=1000 --map-group=1001 "$@"', 'sh', '/usr/bin/node', 'run.ts', '--x'],
    })
  })

  it('refuses to measure outside the re-run', () => {
    expect(() => { assertIsolated({}, { lo: [lo] }) }).toThrow(IsolationRefusal)
  })

  it('refuses to measure where an interface other than loopback is up', () => {
    expect(nonLoopbackInterfaces({ lo: [lo], eth0: [eth], down: undefined })).toEqual(['eth0'])
    expect(() => { assertIsolated({ DELO_BENCHMARK_NETNS: '1' }, { lo: [lo], eth0: [eth] }) }).toThrow('other than loopback (eth0)')
  })

  it('accepts a run inside the namespace with loopback only', () => {
    expect(() => { assertIsolated({ DELO_BENCHMARK_NETNS: '1' }, { lo: [lo] }) }).not.toThrow()
  })
})

describe('machine facts', () => {
  it('records the file system and whether it clones, and nothing that names the machine', () => {
    const directory = mkdtempSync(join(tmpdir(), 'delo-bench-spec-'))
    made.push(directory)
    const facts = machineFacts(directory)
    expect(Object.keys(facts).sort()).toEqual(['arch', 'clone', 'cpuModel', 'cpus', 'fileSystem', 'kernel', 'memoryGiB', 'node', 'platform'])
    expect(facts.fileSystem).toBe(fileSystemType(directory))
    expect(facts.clone).toBe(clonesFiles(directory))
    expect(fileSystemType(join(directory, 'absent'))).toBe('unknown')
    expect(loadAverages()).toHaveLength(3)
  })

  it('reads the storage pressure of the last ten seconds, and nothing where the kernel reports none', () => {
    expect(ioPressure('some avg10=75.23 avg60=69.39 avg300=71.27 total=1\nfull avg10=69.41 avg60=63.31 avg300=63.72 total=1\n')).toBe(75.23)
    expect(ioPressure('some avg10=0 avg60=0.00 avg300=0.00 total=0\n')).toBe(0)
    expect(ioPressure('nothing here')).toBeUndefined()
    const live = ioPressure()
    expect(live === undefined || live >= 0).toBe(true)
  })
})

describe('the base closure build', () => {
  it('waits while another closure build runs, and not at all when none does', async () => {
    const { waitForOtherClosureBuilds } = await import('../src/fixtures/closure.ts')
    const logged: string[] = []
    const answers = [[41, 42], [42], []]
    let pauses = 0
    await waitForOtherClosureBuilds(text => { logged.push(text) }, () => answers.shift()!, async () => { pauses++ })
    expect(pauses).toBe(2)
    expect(logged).toEqual(['waiting for the closure build in process 41, 42, which uses the same build root', 'waiting for the closure build in process 42, which uses the same build root'])
    await waitForOtherClosureBuilds(() => { throw new Error('no wait expected') }, () => [], async () => { throw new Error('no pause expected') })
  })
})
