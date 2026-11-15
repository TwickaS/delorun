/**
 * The batch against a temporary bare remote and an integrator clone, with a stand-in check runner and pre-push hook:
 * lanes replayed, gated by the batch's own merge-tier run and landed, a failing lane found and set aside while the rest land, lanes that fail only together,
 * conflicts, flaky checks, failures no lane explains, a trunk that moved, `--no-land`, `--plan`, resumption after an
 * interruption, and the refusals before anything changes.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { batchId, main, mergeRecordOf, parseOptions, runBatch, type BatchOptions } from '../../src/batch/batch.ts'
import { BatchError } from '../../src/batch/errors.ts'
import { processPorts, TSX } from '../../src/batch/process.ts'
import { treePassPath, treeRecordsDir } from '../../src/checks/tree-pass.ts'
import { parseState, stateText } from '../../src/batch/state.ts'
import { batchDirOf, cleanUp, depsFor, fakeExec, git, gitEnv, makeSandbox, tempDir, type FakeOptions, type Rule, type Sandbox } from './fixtures.ts'

afterEach(cleanUp)

const ID = '20261110-120000'
// The specs run git many times; on a loaded host a run takes longer, so the limit leaves room above the usual few seconds.
const TIMEOUT = 20_000

/**
 * Start options for lanes.
 * @param lanes - the lane branches.
 * @param extra - further arguments.
 * @returns the options.
 */
function start(lanes: readonly string[], extra: readonly string[] = []): BatchOptions {
  return parseOptions([`--lanes=${lanes.join(',')}`, ...extra])
}

/**
 * Run a batch in the sandbox.
 * @param sandbox - the sandbox.
 * @param options - the batch's options.
 * @param rules - the stand-in checks.
 * @param fakeOptions - interruptions and failures to simulate.
 * @param second - the second of the clock's first reading, which names the batch.
 * @returns the exit status, the stand-in's record and the progress lines.
 */
function runIn(sandbox: Sandbox, options: BatchOptions, rules: readonly Rule[], fakeOptions: FakeOptions = {}, second = 0): { code: number, fake: ReturnType<typeof fakeExec>, said: string[] } {
  const fake = fakeExec(sandbox.root, rules, fakeOptions)
  const said: string[] = []
  const code = runBatch(options, depsFor(sandbox.root, fake, said, second))
  return { code, fake, said }
}

/**
 * A file of the batch's directory.
 * @param sandbox - the sandbox.
 * @param name - the file's name.
 * @returns its text.
 */
function report(sandbox: Sandbox, name: string): string {
  return readFileSync(join(batchDirOf(sandbox.root, ID), name), 'utf8')
}

/**
 * The read file's content, or empty.
 * @param read - reads a worktree file.
 * @param path - the path.
 * @returns the content.
 */
function text(read: (path: string) => string | undefined, path: string): string {
  return read(path) ?? ''
}

const A = 'delorun/apps/a/src/a.ts'
const B = 'delorun/apps/b/src/b.ts'
const C = 'delorun/apps/c/src/c.ts'
const SIGNED = '\n\nSigned-off-by: Lane Author <lane@example.com>'
const FORK_LOG = ' FAIL  |fork| apps/a/tests/a.spec.ts > a > adds\nAssertionError: expected 1 to be 2\n ❯ apps/a/tests/a.spec.ts:3:5\n'
const forkRule: Rule = { check: 'tests:fork', fails: read => text(read, A).includes('BUG'), log: FORK_LOG }
const passing: Rule = { check: 'gates:dco', fails: () => false }

describe('a batch that lands', () => {
  it('replays the lanes with their authors, dates and sign-offs and lands them through the push', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: `feat: one${SIGNED}`, author: 'Ada' }])
    sandbox.lane('lane/two', [{ files: { [B]: 'b2\n' }, message: `feat: two${SIGNED}` }, { files: { [B]: 'b3\n' }, message: `fix: two again${SIGNED}` }])
    const { code, fake } = runIn(sandbox, start(['lane/one', 'lane/two']), [passing, forkRule])
    expect(code).toBe(0)
    expect(fake.pushes).toBe(1)
    const log = git(sandbox.remote, ['log', '--format=%an|%aI|%s|%b', 'main'])
    expect(log).toContain('Ada|2026-01-02T03:04:05+00:00|feat: one|Signed-off-by: Lane Author <lane@example.com>')
    expect(log).toContain('Lane Author|2026-01-02T03:04:05+00:00|fix: two again|')
    expect(sandbox.trunk()).toBe(git(sandbox.root, ['rev-parse', `batch/${ID}`]).trim())
    expect(report(sandbox, 'summary.md')).toContain(`landed: origin/main moved from`)
    expect(report(sandbox, 'summary.md')).toContain('## Landed\n\n- lane/one\n- lane/two')
    expect(parseState(report(sandbox, 'state.json'), 'state.json').outcome).toEqual({ kind: 'landed', commit: sandbox.trunk() })
  })

  it('passes the merge tier with --no-land and pushes nothing', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    const before = sandbox.trunk()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const { code, fake } = runIn(sandbox, start(['lane/one'], ['--no-land']), [passing])
    expect(code).toBe(0)
    expect(fake.pushes).toBe(0)
    expect(fake.runs).toEqual([['--changed', '--base', before, '--tier', 'merge']])
    expect(sandbox.trunk()).toBe(before)
    expect(report(sandbox, 'summary.md')).toContain('nothing was pushed (--no-land)')
  })
})

describe('attribution', () => {
  it('faults the lane whose removal fixes a failing spec, reports it with a reproduction, and lands the rest', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/good', [{ files: { [B]: 'b2\n' }, message: 'feat: good' }])
    sandbox.lane('lane/bad', [{ files: { [A]: 'BUG\n' }, message: 'feat: bad' }])
    const { code, fake, said } = runIn(sandbox, start(['lane/good', 'lane/bad']), [passing, forkRule])
    expect(code).toBe(0)
    expect(fake.pushes).toBe(1)
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: good\nchore: the trunk\n')
    const bad = report(sandbox, 'lane/bad.md')
    expect(bad).toContain('removing this lane alone from the candidate made every failing check pass')
    expect(bad).toContain('AssertionError: expected 1 to be 2')
    expect(bad).toContain('node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts --only tests:fork --changed --tier merge')
    expect(bad).toContain('node_modules/.bin/vitest run --config delorun/vitest.config.ts delorun/apps/a/tests/a.spec.ts')
    expect(report(sandbox, 'summary.md')).toContain('- lane/bad: tests:fork (removal-fixes)')
    expect(said.some(line => line.includes('rerunning tests:fork once'))).toBe(true)
  })

  it('reports lanes that fail only together as one interaction and lands the others', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/p', [{ files: { [A]: 'P\n' }, message: 'feat: p' }])
    sandbox.lane('lane/q', [{ files: { [B]: 'Q\n' }, message: 'feat: q' }])
    sandbox.lane('lane/r', [{ files: { [C]: 'r\n' }, message: 'feat: r' }])
    const both: Rule = { check: 'gates:dco', fails: read => text(read, A).includes('P') && text(read, B).includes('Q') }
    const { code } = runIn(sandbox, start(['lane/p', 'lane/q', 'lane/r']), [both])
    expect(code).toBe(0)
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: r\nchore: the trunk\n')
    expect(report(sandbox, 'lane/p.md')).toContain('Fails together with: lane/q.')
    expect(report(sandbox, 'lane/q.md')).toContain('Fails together with: lane/p.')
    expect(report(sandbox, 'summary.md')).toContain('- lane/p, lane/q: gates:dco (together)')
  })

  it('faults each lane that fails alone when no single removal fixes the failure', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/m', [{ files: { [A]: 'M\n' }, message: 'feat: m' }])
    sandbox.lane('lane/n', [{ files: { [B]: 'N\n' }, message: 'feat: n' }])
    sandbox.lane('lane/r', [{ files: { [C]: 'r\n' }, message: 'feat: r' }])
    const either: Rule = { check: 'gates:dco', fails: read => text(read, A).includes('M') || text(read, B).includes('N') }
    const { code } = runIn(sandbox, start(['lane/m', 'lane/n', 'lane/r']), [either])
    expect(code).toBe(0)
    expect(report(sandbox, 'lane/m.md')).toContain('fail on the trunk with this lane alone')
    expect(report(sandbox, 'lane/n.md')).toContain('fail on the trunk with this lane alone')
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: r\nchore: the trunk\n')
  })

  it('reports suspects that fail together when no single removal fixes it and none fails alone', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/m', [{ files: { [A]: 'M\n' }, message: 'feat: m' }])
    sandbox.lane('lane/n', [{ files: { [B]: 'N\n' }, message: 'feat: n' }])
    sandbox.lane('lane/o', [{ files: { [C]: 'O\n' }, message: 'feat: o' }])
    const twoOfThree: Rule = { check: 'gates:dco', fails: read => [text(read, A).includes('M'), text(read, B).includes('N'), text(read, C).includes('O')].filter(Boolean).length >= 2 }
    const { code, said } = runIn(sandbox, start(['lane/m', 'lane/n', 'lane/o']), [twoOfThree])
    expect(code).toBe(1)
    expect(report(sandbox, 'summary.md')).toContain('- lane/m, lane/n, lane/o: gates:dco (together)')
    expect(report(sandbox, 'summary.md')).toContain('every lane was set aside or faulted; nothing landed')
    expect(said.some(line => line.includes('rebuilding the candidate with no lane'))).toBe(true)
  })

  it('faults the one of several fixers that fails alone, then narrows a second failure in a later round', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/m', [{ files: { [A]: 'M\n' }, message: 'feat: m' }])
    sandbox.lane('lane/n', [{ files: { [B]: 'N\n' }, message: 'feat: n' }])
    sandbox.lane('lane/k', [{ files: { [C]: 'K\n' }, message: 'feat: k' }])
    const M = (read: (path: string) => string | undefined): boolean => text(read, A).includes('M')
    const N = (read: (path: string) => string | undefined): boolean => text(read, B).includes('N')
    const K = (read: (path: string) => string | undefined): boolean => text(read, C).includes('K')
    const first: Rule = { check: 'gates:dco', fails: read => M(read) && (N(read) || !K(read)) }
    const second: Rule = { check: 'gates:commits', fails: read => N(read) && !M(read) }
    const { code } = runIn(sandbox, start(['lane/m', 'lane/n', 'lane/k']), [first, second])
    expect(code).toBe(0)
    expect(report(sandbox, 'lane/m.md')).toContain('fail on the trunk with this lane alone')
    expect(report(sandbox, 'lane/n.md')).toContain('removing this lane alone')
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: k\nchore: the trunk\n')
  })

  it('maps a range gate\'s named commit to the lane that contributed it', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/g', [{ files: { [A]: 'g\n' }, message: 'feat: g' }])
    sandbox.lane('lane/h', [{ files: { [B]: 'H\n' }, message: 'feat: h without a sign-off' }])
    const dco: Rule = { check: 'gates:dco', fails: read => text(read, B).includes('H'), log: () => `commit ${git(sandbox.root, ['log', '-1', '--format=%h']).trim()} has no Signed-off-by\n` }
    const { code } = runIn(sandbox, start(['lane/g', 'lane/h']), [dco])
    expect(code).toBe(0)
    expect(report(sandbox, 'lane/h.md')).toContain('has no Signed-off-by')
    expect(existsSync(join(batchDirOf(sandbox.root, ID), 'lane/g.md'))).toBe(false)
  })

  it('counts a candidate on which a lane no longer applies as no evidence', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    // lane/y branched before the trunk changed the line it edits; only lane/x, which restores that line, lets it apply.
    sandbox.lane('lane/y', [{ files: { 'shared.txt': 'one\ny\nthree\n' }, message: 'feat: y' }])
    sandbox.moveTrunk({ 'shared.txt': 'one\nw\nthree\n' })
    git(sandbox.root, ['fetch', '-q', 'origin'])
    sandbox.lane('lane/x', [{ files: { 'shared.txt': 'one\ntwo\nthree\n' }, message: 'fix: x restores the line' }])
    const why: Rule = { check: 'gates:dco', fails: read => text(read, 'shared.txt').includes('y') }
    const { code } = runIn(sandbox, start(['lane/x', 'lane/y']), [why])
    expect(code).toBe(0)
    const state = parseState(report(sandbox, 'state.json'), 'state.json')
    expect(state.steps['round:0:trial:lane/y']).toEqual({ kind: 'trial', lanes: ['lane/y'], result: 'unbuildable', failing: [] })
    expect(report(sandbox, 'lane/y.md')).toContain('removing this lane alone')
    expect(git(sandbox.remote, ['log', '-1', '--format=%s', 'main'])).toBe('fix: x restores the line\n')
  })

  it('lands nothing when the failure persists with every suspect removed', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    const before = sandbox.trunk()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const broken: Rule = { check: 'gates:dco', fails: read => text(read, 'shared.txt').includes('one') }
    const { code, said } = runIn(sandbox, start(['lane/one']), [broken])
    expect(code).toBe(1)
    expect(sandbox.trunk()).toBe(before)
    expect(report(sandbox, 'summary.md')).toContain('gates:dco fail with every suspect lane removed')
    expect(said.some(line => line.includes('on the trunk with no lane'))).toBe(true)
  })

  it('lands nothing when no lane\'s selection picks the failing check', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const { code, fake } = runIn(sandbox, start(['lane/one']), [{ check: 'elsewhere', fails: () => true }])
    expect(code).toBe(1)
    expect(fake.runs).toHaveLength(2)
    expect(report(sandbox, 'summary.md')).toContain('elsewhere fail with every suspect lane removed')
  })
})

describe('flaky checks', () => {
  it('reports a check that passes on its rerun as flaky and gates again', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    let calls = 0
    const once: Rule = { check: 'gates:dco', fails: () => (calls += 1) === 1 }
    const { code, fake } = runIn(sandbox, start(['lane/one']), [once])
    expect(code).toBe(0)
    expect(fake.pushes).toBe(1)
    expect(report(sandbox, 'summary.md')).toContain('## Flaky\n\n- gates:dco')
  })

  it('stops when a second round fails only on checks that pass when rerun', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    const before = sandbox.trunk()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    let calls = 0
    const alternating: Rule = { check: 'gates:dco', fails: () => (calls += 1) % 2 === 1 }
    const { code } = runIn(sandbox, start(['lane/one']), [alternating])
    expect(code).toBe(1)
    expect(sandbox.trunk()).toBe(before)
    expect(report(sandbox, 'summary.md')).toContain('gates:dco failed again after passing on a rerun')
  })
})

describe('lanes set aside', () => {
  it('sets aside a conflicting lane with its paths, a merge lane and an empty lane, and lands the rest', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/first', [{ files: { 'shared.txt': 'one\nTWO\nthree\n' }, message: 'feat: first' }])
    sandbox.lane('lane/clash', [{ files: { 'shared.txt': 'one\ndeux\nthree\n' }, message: 'feat: clash' }])
    sandbox.lane('lane/side', [{ files: { [C]: 'side\n' }, message: 'feat: side' }])
    sandbox.lane('lane/merged', [{ files: { [B]: 'merged\n' }, message: 'feat: merged' }])
    git(sandbox.root, ['checkout', '-q', 'lane/merged'])
    git(sandbox.root, ['merge', '-q', '--no-ff', '-m', 'merge side', 'lane/side'])
    git(sandbox.root, ['checkout', '-q', 'main'])
    git(sandbox.root, ['branch', 'lane/empty', 'origin/main'])
    const { code } = runIn(sandbox, start(['lane/first', 'lane/clash', 'lane/merged', 'lane/empty']), [passing])
    expect(code).toBe(0)
    expect(report(sandbox, 'lane/clash.md')).toMatch(/conflicts with the candidate in shared\.txt/)
    expect(report(sandbox, 'lane/clash.md')).toContain('git fetch origin && git rebase origin/main')
    expect(report(sandbox, 'lane/merged.md')).toContain('holds merge commits')
    expect(report(sandbox, 'lane/empty.md')).toContain('no commit beyond the trunk')
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: first\nchore: the trunk\n')
  })

  it('drops a commit the candidate already holds, and still attributes the lane by its own commits', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/base', [{ files: { [A]: 'shared change\n' }, message: 'feat: base' }])
    sandbox.lane('lane/stacked', [{ files: { [B]: 'stacked\n' }, message: 'feat: stacked' }], 'lane/base')
    const stackedFails: Rule = { check: 'gates:dco', fails: read => text(read, B).includes('stacked') }
    const { code } = runIn(sandbox, start(['lane/base', 'lane/stacked']), [stackedFails])
    expect(code).toBe(0)
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: base\nchore: the trunk\n')
    expect(report(sandbox, 'lane/stacked.md')).toContain('removing this lane alone')
    const state = parseState(report(sandbox, 'state.json'), 'state.json')
    const stacked = state.steps['lane:lane/stacked']
    expect(stacked?.kind === 'applied' ? stacked.application.commits.map(commit => commit.applied === null) : []).toEqual([true, false])
  })
})

describe('gate failures that stop the batch', () => {
  it('stops without rewriting anything when the trunk moved before the push', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    let moved = ''
    const { code } = runIn(sandbox, start(['lane/one']), [passing], { beforePush: () => { moved = sandbox.moveTrunk({ 'elsewhere.txt': 'x\n' }) } })
    expect(code).toBe(1)
    expect(sandbox.trunk()).toBe(moved)
    expect(report(sandbox, 'summary.md')).toMatch(/moved while the batch ran and the push was refused \(.*\[rejected\]/)
  })

  it('stops on a push that fails with no report, naming git\'s last lines', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const { code } = runIn(sandbox, start(['lane/one']), [passing], { pushError: 'fatal: the remote hung up\n' })
    expect(code).toBe(1)
    expect(report(sandbox, 'summary.md')).toContain('the gate failed without a failing check (fatal: the remote hung up)')
  })

  it('names the exit status when a push fails silently', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    runIn(sandbox, start(['lane/one']), [passing], { pushError: '' })
    expect(report(sandbox, 'summary.md')).toContain('(git push exited 1)')
  })

  it('stops when the merge tier fails on a declined check, or leaves no report', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    expect(runIn(sandbox, start(['lane/one'], ['--no-land']), [passing], { declined: [{ check: 'tests:docker', reason: 'no Docker engine answers' }, { check: 'tests:web-changed', reason: null }] }).code).toBe(1)
    expect(report(sandbox, 'summary.md')).toContain('tests:docker declined: no Docker engine answers; tests:web-changed declined: no reason given; the merge tier exited 1')
    git(sandbox.root, ['checkout', '-q', 'main'])
    expect(runIn(sandbox, start(['lane/one'], ['--no-land']), [passing], { declined: [{ check: 'tests:docker', reason: null }], noReport: true }, 1).code).toBe(1)
    expect(readFileSync(join(batchDirOf(sandbox.root, '20261110-120001'), 'summary.md'), 'utf8')).toContain('(the merge tier exited 1)')
  })

  it('treats a rerun that leaves no report as still failing', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'BUG\n' }, message: 'feat: one' }])
    const fake = fakeExec(sandbox.root, [forkRule])
    const deps = depsFor(sandbox.root, fake)
    // The gate's run leaves its report; every rerun leaves none, so a failing rerun counts every check as failing.
    const checks = deps.ports.checks
    const code = runBatch(start(['lane/one']), { ...deps, ports: { ...deps.ports, checks: args => {
      const status = checks(args)
      if (args.includes('--only')) deps.files.remove(join(sandbox.root, 'node_modules/.cache/delorun-checks/report.json'))
      return status
    } } })
    expect(code).toBe(1)
    expect(report(sandbox, 'summary.md')).toContain('- lane/one: tests:fork (removal-fixes)')
  })
})

describe('resumption', () => {
  it('continues after an interruption from the first unfinished step, without repeating the recorded gate', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/good', [{ files: { [B]: 'b2\n' }, message: 'feat: good' }])
    sandbox.lane('lane/bad', [{ files: { [A]: 'BUG\n' }, message: 'feat: bad' }])
    expect(() => runIn(sandbox, start(['lane/good', 'lane/bad']), [passing, forkRule], { interruptAt: 2 })).toThrow('interrupted')
    const recorded = parseState(report(sandbox, 'state.json'), 'state.json')
    expect(Object.keys(recorded.steps)).toEqual(['lane:lane/good', 'lane:lane/bad', 'round:0:gate'])
    git(sandbox.root, ['checkout', '-q', 'main'])
    const resumed = runIn(sandbox, parseOptions(['--resume', ID]), [passing, forkRule])
    expect(resumed.code).toBe(0)
    expect(resumed.fake.pushes).toBe(1)
    expect(git(sandbox.remote, ['log', '--format=%s', 'main'])).toBe('feat: good\nchore: the trunk\n')
    const again = runIn(sandbox, parseOptions(['--resume', ID]), [passing, forkRule])
    expect(again.code).toBe(0)
    expect(again.fake.pushes + again.fake.runs.length).toBe(0)
  })

  it('ends a cherry-pick an interruption left on the candidate branch and replays the lane', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/first', [{ files: { 'shared.txt': 'one\nTWO\nthree\n' }, message: 'feat: first' }])
    sandbox.lane('lane/clash', [{ files: { 'shared.txt': 'one\ndeux\nthree\n' }, message: 'feat: clash' }])
    let picks = 0
    expect(() => runIn(sandbox, start(['lane/first', 'lane/clash']), [passing], { interruptAfterGit: args => args[0] === 'cherry-pick' && args[1] === '--allow-empty' && (picks += 1) === 2 })).toThrow('interrupted')
    expect(existsSync(join(sandbox.root, '.git', 'CHERRY_PICK_HEAD'))).toBe(true)
    const resumed = runIn(sandbox, parseOptions(['--resume', ID]), [passing])
    expect(resumed.code).toBe(0)
    expect(report(sandbox, 'lane/clash.md')).toContain('conflicts with the candidate in shared.txt')
  })

  it('reports a lane a rebuild could not replay, as the recorded build names it', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/good', [{ files: { [B]: 'b2\n' }, message: 'feat: good' }])
    sandbox.lane('lane/bad', [{ files: { [A]: 'BUG\n' }, message: 'feat: bad' }])
    runIn(sandbox, start(['lane/good', 'lane/bad']), [passing, forkRule])
    const path = join(batchDirOf(sandbox.root, ID), 'state.json')
    const state = parseState(readFileSync(path, 'utf8'), path)
    const build = state.steps['round:1:build']
    if (build?.kind !== 'build') throw new Error('the batch recorded no rebuild')
    build.setAside.push({ lane: 'lane/late', reason: { kind: 'pick-failed', commit: state.start, detail: 'error: could not apply' } })
    state.outcome = null
    writeFileSync(path, stateText(state))
    expect(runIn(sandbox, parseOptions(['--resume', ID]), [passing, forkRule]).code).toBe(0)
    expect(report(sandbox, 'lane/late.md')).toContain('when the candidate was rebuilt without the faulted lanes: error: could not apply')
  })

  it('refuses a missing batch, a state whose step has another kind, and a worktree it cannot reset', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    expect(() => runIn(sandbox, parseOptions(['--resume', ID]), [])).toThrow(/no batch 20261110-120000/)
    runIn(sandbox, start(['lane/one']), [passing])
    const path = join(batchDirOf(sandbox.root, ID), 'state.json')
    const state = parseState(readFileSync(path, 'utf8'), path)
    const original = stateText(state)
    state.steps['lane:lane/one'] = { kind: 'rerun', failing: [], flaky: [] }
    writeFileSync(path, stateText(state))
    expect(() => runIn(sandbox, parseOptions(['--resume', ID]), [passing])).toThrow(/step lane:lane\/one is recorded as rerun/)
    writeFileSync(path, original)
    sandbox.write({ 'stray.txt': 'x\n' })
    expect(() => runIn(sandbox, parseOptions(['--resume', ID]), [passing])).toThrow(/untracked files remain/)
    git(sandbox.root, ['checkout', '-q', 'main'])
    expect(() => runIn(sandbox, parseOptions(['--resume', ID]), [passing])).toThrow(/uncommitted or untracked/)
    writeFileSync(join(sandbox.root, 'stray.txt'), '')
    git(sandbox.root, ['add', 'stray.txt'])
    git(sandbox.root, ['commit', '-q', '-m', 'chore: stray'])
    git(sandbox.root, ['checkout', '-q', '--detach'])
    expect(() => runIn(sandbox, parseOptions(['--resume', ID]), [passing])).toThrow(/HEAD is detached/)
  })
})

describe('refusals before anything changes', () => {
  it('refuses a dirty worktree, a detached HEAD, an unknown lane and an existing candidate branch', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const refusal = (options: BatchOptions): BatchError => {
      try {
        runIn(sandbox, options, [passing])
      } catch (error) {
        if (error instanceof BatchError) return error
        throw error
      }
      throw new Error('the batch ran')
    }
    git(sandbox.root, ['branch', `batch/${ID}`])
    expect(refusal(start(['lane/one'])).code).toBe('branch-exists')
    expect(refusal(start(['lane/none'])).code).toBe('unknown-lane')
    expect(refusal(start(['-x'])).code).toBe('unknown-lane')
    sandbox.write({ 'stray.txt': 'x\n' })
    expect(refusal(start(['lane/one'])).code).toBe('dirty-tree')
    git(sandbox.root, ['checkout', '-q', '--detach'])
    expect(refusal(start(['lane/one'])).code).toBe('detached')
    expect(refusal(start(['lane/one'], ['--trunk', 'missing', '--plan'])).code).toBe('git')
    expect(git(sandbox.remote, ['branch', '--list']).trim()).toBe('* main')
  })
})

describe('--plan', () => {
  it('prints the order, commit counts, packages and suspects without changing anything', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }, { files: { [B]: 'b2\n' }, message: 'feat: one more' }])
    sandbox.lane('lane/shared', [{ files: { 'shared.txt': 'x\n' }, message: 'feat: shared' }])
    const branches = git(sandbox.root, ['branch', '--list'])
    const { code, said, fake } = runIn(sandbox, start(['lane/one', 'lane/shared'], ['--plan']), [])
    expect(code).toBe(0)
    expect(said.join('\n')).toBe([
      `delorun batch (plan): 2 lane(s) onto origin/main at ${sandbox.trunk().slice(0, 12)}`,
      '  1. lane/one: 2 commit(s); packages: delorun/apps/a, delorun/apps/b',
      '  2. lane/shared: 1 commit(s); packages: none',
      'suspects by check (merge tier, each lane\'s own changed paths):',
      '  gates:dco: lane/one, lane/shared',
      '  gates:commits: lane/one, lane/shared',
      '  tests:fork: lane/one',
      '  typecheck:delorun:a: lane/one',
      '  typecheck:delorun:b: lane/one',
      '  shared: lane/shared',
      '',
    ].join('\n'))
    expect(git(sandbox.root, ['branch', '--list'])).toBe(branches)
    expect(fake.calls.some(call => call.args[0] === 'fetch' || call.args[0] === 'checkout')).toBe(false)
    expect(existsSync(join(sandbox.root, '.git', 'delorun-batch'))).toBe(false)
  })
})

describe('the invariant: nothing reaches the trunk without the batch\'s own merge-tier run', () => {
  const FORBIDDEN = ['--force', '-f', '--no-verify', '--force-if-includes']

  it('starts no process with a forced push, a skipped hook, skipped checks or the agent tier, whatever the integrator\'s environment', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/good', [{ files: { [B]: 'b2\n' }, message: 'feat: good' }])
    sandbox.lane('lane/bad', [{ files: { [A]: 'BUG\n' }, message: 'feat: bad' }])
    const fake = fakeExec(sandbox.root, [passing, forkRule])
    const hostile = { ...gitEnv(), DELORUN_PUSH_SKIP: 'tests', DELORUN_TIER: 'agent', LEFTHOOK: '0', LEFTHOOK_EXCLUDE: 'pre-push', LEFTHOOK_BIN: '/bin/true', GIT_CONFIG_COUNT: '1' }
    const code = runBatch(start(['lane/good', 'lane/bad']), { ...depsFor(sandbox.root, fake), ports: processPorts(fake.exec, sandbox.root, hostile) })
    expect(code).toBe(0)
    expect(fake.calls.length).toBeGreaterThan(10)
    for (const call of fake.calls) {
      expect(call.args.filter(arg => FORBIDDEN.includes(arg) || arg.startsWith('--force-with-lease') || arg.startsWith('+'))).toEqual([])
      expect(call.args.join(' ')).not.toMatch(/--tier(?:=| )agent/)
      expect(call.env['DELORUN_PUSH_SKIP']).toBeUndefined()
      expect(call.env['DELORUN_TIER']).not.toBe('agent')
      expect(Object.keys(call.env).filter(name => name.startsWith('LEFTHOOK') || name.startsWith('GIT_CONFIG'))).toEqual([])
    }
    const pushes = fake.calls.filter(call => call.args[0] === 'push')
    expect(pushes.map(call => call.args)).toEqual([['push', 'origin', `batch/${ID}:refs/heads/main`]])
    expect(pushes.every(call => call.env['DELORUN_TIER'] === 'merge')).toBe(true)
    expect(fake.runs.every(args => args.includes('--tier') && args[args.indexOf('--tier') + 1] === 'merge')).toBe(true)
  })

  it('never pushes a candidate whose gate failed', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    const before = sandbox.trunk()
    sandbox.lane('lane/bad', [{ files: { [A]: 'BUG\n' }, message: 'feat: bad' }])
    const noLand = runIn(sandbox, start(['lane/bad'], ['--no-land']), [forkRule])
    expect(noLand.code).toBe(1)
    expect(noLand.fake.pushes).toBe(0)
    git(sandbox.root, ['checkout', '-q', 'main'])
    const land = runIn(sandbox, start(['lane/bad']), [forkRule], {}, 1)
    expect(land.code).toBe(1)
    expect(land.fake.pushes).toBe(0)
    expect(sandbox.trunk()).toBe(before)
  })
})

describe('the gate does not trust the push', () => {
  const lane = (): Sandbox => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    return sandbox
  }

  it.each([
    ['a runner that exits 0 and leaves no record', 'none'],
    ['a record of the agent tier', 'agent'],
    ['a record whose head is another commit', 'other'],
  ] as const)('does not land after %s, and pushes nothing', (_name, record) => {
    const sandbox = lane()
    const before = sandbox.trunk()
    const { code, fake } = runIn(sandbox, start(['lane/one']), [passing], { record })
    expect(code).toBe(1)
    expect(fake.pushes).toBe(0)
    expect(sandbox.trunk()).toBe(before)
    const commit = git(sandbox.root, ['rev-parse', `batch/${ID}`]).trim()
    expect(report(sandbox, 'summary.md')).toContain(`the merge tier left no merge-tier tree-pass record for ${commit.slice(0, 12)}`)
    expect(parseState(report(sandbox, 'state.json'), 'state.json').outcome?.kind).toBe('gate-error')
  }, TIMEOUT)

  it('pushes and lands when the runner left a merge record for the candidate, after the runner ran', { timeout: TIMEOUT }, () => {
    const sandbox = lane()
    const { code, fake } = runIn(sandbox, start(['lane/one']), [passing])
    expect(code).toBe(0)
    expect(fake.pushes).toBe(1)
    const order = fake.calls.map(call => call.args[0] === 'push' ? 'push' : call.command === TSX ? 'runner' : '').filter(name => name !== '')
    expect(order).toEqual(['runner', 'push'])
    expect(sandbox.trunk()).toBe(git(sandbox.root, ['rev-parse', `batch/${ID}`]).trim())
  })

  it('reads the record the check runner stores for a commit\'s tree, and none for another', { timeout: TIMEOUT }, () => {
    const sandbox = lane()
    const commit = git(sandbox.root, ['rev-parse', 'lane/one']).trim()
    const tree = git(sandbox.root, ['rev-parse', 'lane/one^{tree}']).trim()
    const read = mergeRecordOf(sandbox.root)
    expect(read(commit)).toBeUndefined()
    const dir = treeRecordsDir(sandbox.root)
    mkdirSync(dir, { recursive: true })
    const record = { tree, base: null, head: commit, rangeBase: null, passedAt: 'now', tier: 'merge', checks: [], scopes: {}, lockfile: 'l', node: process.version, pnpm: 'p', env: {} }
    writeFileSync(treePassPath(dir, tree, process.version), JSON.stringify(record))
    expect(read(commit)).toMatchObject({ tier: 'merge', head: commit })
    expect(read('main')).toBeUndefined()
  })
})

describe('a batch refuses to start or resume with the hook bypassed', () => {
  it('refuses before anything changes, in a new batch and in a resumed one', { timeout: TIMEOUT }, () => {
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    const branches = git(sandbox.root, ['branch', '--list'])
    const fake = fakeExec(sandbox.root, [passing])
    const bypassed = { ...depsFor(sandbox.root, fake), env: { LEFTHOOK: '0' } }
    for (const options of [start(['lane/one']), parseOptions(['--resume', ID])]) {
      expect(() => runBatch(options, bypassed)).toThrow(expect.objectContaining({ code: 'hooks-bypassed' }))
    }
    expect(git(sandbox.root, ['branch', '--list'])).toBe(branches)
    expect(fake.calls.filter(call => call.args[0] === 'fetch' || call.args[0] === 'checkout')).toEqual([])
    expect(existsSync(join(sandbox.root, '.git', 'delorun-batch'))).toBe(false)
  })
})

describe('the command line', () => {
  it('parses lanes, defaults and refuses conflicting or malformed options', () => {
    expect(parseOptions(['--lanes', 'lane/a, lane/b'])).toEqual({ kind: 'start', lanes: ['lane/a', 'lane/b'], trunk: 'main', remote: 'origin', land: true, plan: false })
    expect(parseOptions(['--lanes', 'x', '--trunk', 'main', '--remote', 'up', '--no-land', '--plan'])).toEqual({ kind: 'start', lanes: ['x'], trunk: 'main', remote: 'up', land: false, plan: true })
    expect(parseOptions(['--resume', ID])).toEqual({ kind: 'resume', id: ID })
    for (const argv of [['--resume', ID, '--lanes', 'x'], ['--resume', ID, '--trunk', 'main'], ['--resume', ID, '--remote', 'o'], ['--resume', ID, '--plan'], ['--resume', ID, '--no-land'], ['--resume', 'latest'], [], ['--lanes', ','], ['--lanes', 'x,x'], ['--lanes', 'x', '--trunk=-x'], ['--lanes', 'x', '--remote', '+o'], ['--bogus'], ['positional']]) {
      expect(() => parseOptions(argv)).toThrow(BatchError)
    }
  })

  it('names a batch by the UTC second it starts', () => {
    expect(batchId(new Date(Date.UTC(2026, 10, 10, 9, 8, 7)))).toBe('20261110-090807')
  })

  it('exits 2 on a refusal, rethrows any other failure, and runs --plan over the real selection', { timeout: TIMEOUT }, () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    expect(main(['--bogus'])).toBe(2)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('delorun batch: '))
    expect(() => main(['--lanes', 'x', '--plan'], gitEnv(), tempDir('delorun-batch-norepo-'))).toThrow(/rev-parse/)
    const sandbox = makeSandbox()
    sandbox.lane('lane/one', [{ files: { [A]: 'a2\n' }, message: 'feat: one' }])
    expect(main(['--lanes', 'lane/one', '--plan'], gitEnv(), sandbox.root)).toBe(0)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1. lane/one: 1 commit(s)'))
    // The sandbox has no installed hooks, so the batch is refused before it starts.
    const env = { PATH: process.env['PATH'] ?? '' }
    expect(main(['--lanes', 'lane/one', '--no-land'], env, sandbox.root)).toBe(2)
    expect(error).toHaveBeenLastCalledWith(expect.stringContaining('pre-push'))
    // With the hook files in place the batch starts, and fails when it reaches the real check runner, absent from the sandbox.
    writeFileSync(join(sandbox.root, '.git', 'dsh-hooks', 'pre-push'), '#!/bin/sh\nlefthook run pre-push\n')
    writeFileSync(join(sandbox.root, 'lefthook-local.yml'), 'extends:\n  - delorun/lefthook.yml\n')
    mkdirSync(join(sandbox.root, 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(sandbox.root, 'node_modules', '.bin', 'lefthook'), '')
    writeFileSync(join(sandbox.root, '.git', 'info', 'exclude'), 'lefthook-local.yml\n')
    expect(() => main(['--lanes', 'lane/one', '--no-land'], env, sandbox.root)).toThrow(/ENOENT/)
    error.mockRestore()
    log.mockRestore()
  })
})
