/**
 * The fork suite's per-package passes: what each package's key covers, which packages a change reruns, a failed run that
 * still records the packages that passed, and the packages whose passes are shared or served in a strict run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createPassCache, type PassCache, type PassCacheOptions } from '../src/checks/cache.ts'
import type { ForkPackage, ForkTree, Planned, UpstreamPackage } from '../src/checks/plan.ts'
import { runPlan, type Result } from '../src/checks/run.ts'
import { openSharedStore } from '../src/checks/shared-cache.ts'
import { sharingPolicy } from '../src/checks/sharing.ts'
import { commandFor, isForkSuite, SHARED_TEST_INPUTS, suiteUnits, unitOf, upstreamClosure, type Unit, type WithUnits } from '../src/checks/units.ts'

const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * A fresh temporary directory, removed after the test.
 * @param prefix - the name's prefix.
 * @returns the directory.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

const pkg = (dir: string, forkDependencies: string[] = [], upstreamDependencies: string[] = [], extra: Partial<ForkPackage> = {}): ForkPackage => ({ name: `@delo/${dir.split('/').at(-1) ?? ''}`, dir, forkDependencies, upstreamDependencies, ownWorkspace: false, ...extra })
const upstream = (dir: string, dependencies: string[] = [], security = false): UpstreamPackage => ({ name: `@deepseek-ai/${dir.split('/').at(-1) ?? ''}`, dir, dependencies, runtimeDependencies: dependencies, specs: 1, ...security ? { security: true } : {} })

const TREE: ForkTree = {
  packages: [
    pkg('delo/packages/a'),
    pkg('delo/packages/b', ['@delo/a']),
    pkg('delo/packages/c'),
    pkg('delo/packages/d', [], ['@deepseek-ai/u']),
    pkg('delo/apps/docs', [], [], { ownWorkspace: true }),
  ],
  programs: [],
  upstream: [upstream('packages/x/u', ['@deepseek-ai/v'], true), upstream('packages/x/v', ['@deepseek-ai/u']), upstream('packages/x/w')],
}
const SPEC_DIRS = ['delo/packages/a', 'delo/packages/b', 'delo/packages/c', 'delo/packages/d']

describe('a package\'s key', () => {
  it('covers its own files, its Delo and upstream dependencies directly or not, and the shared test configuration, and no documentation outside packages', () => {
    const unit = unitOf(pkg('delo/packages/b', ['@delo/a']), TREE)
    expect(unit).toEqual({ dir: 'delo/packages/b', arg: 'delo/packages/b/', inputs: ['delo/packages/a/**', 'delo/packages/b/**', ...SHARED_TEST_INPUTS] })
    expect(unitOf(pkg('delo/packages/d', [], ['@deepseek-ai/u']), TREE).inputs.slice(0, 3)).toEqual(['delo/packages/d/**', 'packages/x/u/**', 'packages/x/v/**'])
    expect(unit.inputs.some(input => input.startsWith('delo/docs') || input.startsWith('delo/changelog') || input === 'delo/**')).toBe(false)
  })

  it('adds what the audit names, and keys the whole tree for a package that boots a profile or reads state outside any key', () => {
    const logs = unitOf(pkg('delo/packages/logs'), { packages: [...TREE.packages, pkg('delo/apps/relay', ['@delo/c']), pkg('delo/packages/home-process'), pkg('delo/packages/supervisor')], upstream: [] })
    expect(logs.inputs).toEqual(expect.arrayContaining(['delo/apps/relay/**', 'delo/packages/c/**', 'delo/packages/supervisor/**', 'apps/desktop/package.json']))
    expect(unitOf(pkg('delo/packages/bundle-local'), TREE)).toMatchObject({ inputs: expect.arrayContaining(['delo/**', 'packages/**']) })
    expect(unitOf(pkg('delo/packages/bundle-local'), TREE).local).toBeUndefined()
    expect(unitOf(pkg('delo/apps/tools'), TREE)).toMatchObject({ local: true, inputs: expect.arrayContaining(['delo/**']) })
  })

  it('follows upstream dependencies through a cycle and past an unknown name', () => {
    expect(upstreamClosure(TREE.upstream, ['@deepseek-ai/u', '@deepseek-ai/none'])).toEqual(['packages/x/u', 'packages/x/v'])
  })
})

describe('the units of a suite', () => {
  const suite = (scope?: string[]): Planned => ({ id: 'tests:fork', group: 'tests', title: 'fork', cwd: '', command: ['vitest', 'run', '--maxWorkers=4', ...scope ?? []], needs: [], tiers: ['changed'], cpus: 1, memoryBytes: 1, budget: { memoryGiB: 1 }, reason: 'test', ...scope === undefined ? {} : { scope } })

  it('are the packages of the scope with specs, or of every package for the whole suite, never the site\'s own workspace', () => {
    expect(suiteUnits(suite(['delo/packages/a/', 'delo/packages/c/']), TREE, ['delo/packages/a'])?.map(unit => unit.dir)).toEqual(['delo/packages/a'])
    expect(suiteUnits(suite(), TREE, SPEC_DIRS)?.map(unit => unit.dir)).toEqual(SPEC_DIRS)
    expect(isForkSuite('tests:fork:integration')).toBe(true)
  })

  it('are none for another check, a scope of spec files, a scope without specs, and a whole suite with specs outside the packages', () => {
    expect(suiteUnits({ ...suite(), id: 'tests:docker' }, TREE, SPEC_DIRS)).toBeUndefined()
    expect(suiteUnits(suite(['delo/packages/a/tests/x.spec.ts']), TREE, SPEC_DIRS)).toBeUndefined()
    expect(suiteUnits(suite(['delo/packages/c/']), TREE, ['delo/packages/a'])).toBeUndefined()
    expect(suiteUnits(suite(), TREE, [...SPEC_DIRS, 'delo/packages/reach'])).toBeUndefined()
  })

  it('run a subset by replacing the scope with the subset\'s directories', () => {
    const units = suiteUnits(suite(['delo/packages/a/', 'delo/packages/b/']), TREE, SPEC_DIRS) ?? []
    expect(commandFor(suite(['delo/packages/a/', 'delo/packages/b/']), units.slice(1))).toEqual(['vitest', 'run', '--maxWorkers=4', 'delo/packages/b/'])
    expect(commandFor(suite(), units.slice(0, 1))).toEqual(['vitest', 'run', '--maxWorkers=4', 'delo/packages/a/'])
  })

})

/** A fake Vitest: records its arguments and fails when `FAKE_FAIL` names a package or `FAKE_EXIT` is 1. */
const FAKE = `
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args) + '\\n')
const failing = (process.env.FAKE_FAIL || '').split(',').filter(Boolean)
process.exit(failing.length > 0 || process.env.FAKE_EXIT === '1' ? 1 : 0)
`

/**
 * Run git in a directory with a fixed identity and no hooks.
 * @param cwd - the directory.
 * @param args - git's arguments.
 * @returns git's output.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))) })
}

describe('a run of a unitised suite', { timeout: 30_000 }, () => {
  /**
   * A repository with the tree's packages, each with one source file, and a fake Vitest.
   * @returns its root, the fake's script and the file the fake logs its arguments to.
   */
  function makeRepo(): { root: string, fake: string, log: string } {
    const root = tempDir('delo-units-repo-')
    git(root, ['init', '-q', '-b', 'v5'])
    for (const dir of [...SPEC_DIRS, 'packages/x/u', 'packages/x/v', 'delo/docs']) {
      mkdirSync(join(root, dir), { recursive: true })
      writeFileSync(join(root, dir, 'index.ts'), `export const at = '${dir}'\n`)
    }
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'init'])
    const scripts = tempDir('delo-units-fake-')
    writeFileSync(join(scripts, 'vitest.cjs'), FAKE)
    return { root, fake: join(scripts, 'vitest.cjs'), log: join(scripts, 'args.log') }
  }

  /**
   * The fork suite over the given packages, as the plan narrows it, with its units.
   * @param fake - the fake Vitest.
   * @param dirs - the package directories.
   * @returns the planned check.
   */
  function suite(fake: string, dirs: readonly string[] = SPEC_DIRS): WithUnits<Planned> {
    const scope = dirs.map(dir => `${dir}/`)
    const check: Planned = { id: 'tests:fork', group: 'tests', title: 'fork', cwd: '', command: [process.execPath, fake, '--maxWorkers=2', ...scope], needs: [], inputs: ['delo/**', 'packages/**'], tiers: ['changed'], cpus: 1, memoryBytes: 1, budget: { memoryGiB: 1 }, reason: 'test', scope }
    return { ...check, units: suiteUnits(check, TREE, SPEC_DIRS) ?? [] }
  }

  /**
   * A cache of the repository.
   * @param root - the repository.
   * @param extra - options over the defaults.
   * @returns the cache.
   */
  function cacheFor(root: string, extra: Partial<PassCacheOptions> = {}): PassCache {
    return createPassCache({ root, dir: join(root, 'node_modules', '.cache', 'delo-checks', 'pass'), env: {}, nodeVersion: 'v24.9.0', pnpmVersion: () => '11.28.5', platform: 'linux-x64', policy: sharingPolicy({ packages: TREE.packages, upstream: TREE.upstream, securityPackages: ['delo/packages/d'], declarationReaders: [] }), strict: false, warn: () => undefined, ...extra })
  }

  /**
   * Run the suite and return its result and the package arguments the fake received.
   * @param repo - the repository and its fake.
   * @param cache - the cache.
   * @param env - variables for the fake.
   * @param check - the suite.
   * @returns the result and the packages that ran.
   */
  async function run(repo: { root: string, fake: string, log: string }, cache: PassCache, env: Record<string, string> = {}, check = suite(repo.fake)): Promise<{ result: Result | undefined, ran: string[] }> {
    rmSync(repo.log, { force: true })
    const [result] = await runPlan([check], { root: repo.root, env: { ...process.env, FAKE_LOG: repo.log, ...env }, logDir: tempDir('delo-units-logs-'), cpus: 4, memoryBytes: 1024 ** 3, bail: false, cache, report: () => undefined })
    const args = existsSync(repo.log) ? JSON.parse(readFileSync(repo.log, 'utf8').trim()) as string[] : []
    return { result, ran: args.filter(arg => arg.startsWith('delo/')) }
  }

  it('reruns a changed package and its dependents, and serves the others from their stored passes', async () => {
    const repo = makeRepo()
    expect((await run(repo, cacheFor(repo.root))).ran).toEqual(['delo/packages/a/', 'delo/packages/b/', 'delo/packages/c/', 'delo/packages/d/'])
    writeFileSync(join(repo.root, 'delo/packages/a/index.ts'), 'export const at = 2\n')
    const { result, ran } = await run(repo, cacheFor(repo.root))
    expect(ran).toEqual(['delo/packages/a/', 'delo/packages/b/'])
    expect(result).toMatchObject({ outcome: 'passed', units: { total: 4, ran: 2, local: 2, shared: 0 }, detail: '2 of 4 packages ran, 2 served from this worktree and 0 shared' })
  })

  it('reruns no package for a change to documentation outside the packages', async () => {
    const repo = makeRepo()
    await run(repo, cacheFor(repo.root))
    writeFileSync(join(repo.root, 'delo/docs/index.ts'), 'export const changed = 1\n')
    mkdirSync(join(repo.root, 'delo/changelog/unreleased'), { recursive: true })
    writeFileSync(join(repo.root, 'delo/changelog/unreleased/x.md'), '- x\n')
    const { result, ran } = await run(repo, cacheFor(repo.root))
    expect(ran).toEqual([])
    expect(result).toMatchObject({ outcome: 'passed', cached: true, cacheSource: 'local', detail: 'cached pass of all 4 packages (4 in this worktree, 0 shared)' })
  })

  it('reruns a package when an upstream package it depends on through another changes, a security-ledger package among them', async () => {
    const repo = makeRepo()
    await run(repo, cacheFor(repo.root))
    writeFileSync(join(repo.root, 'packages/x/v/index.ts'), 'export const changed = 1\n')
    expect((await run(repo, cacheFor(repo.root))).ran).toEqual(['delo/packages/d/'])
    writeFileSync(join(repo.root, 'packages/x/u/index.ts'), 'export const changed = 1\n')
    expect((await run(repo, cacheFor(repo.root))).ran).toEqual(['delo/packages/d/'])
  })

  it('records no package from a failed run, even one whose spec files all report a pass, so the next run reruns them all', async () => {
    const repo = makeRepo()
    const failed = await run(repo, cacheFor(repo.root), { FAKE_FAIL: 'delo/packages/c/' })
    expect(failed.result).toMatchObject({ outcome: 'failed', detail: 'exit 1; 4 of 4 packages ran, 0 served from this worktree and 0 shared' })
    // An error Vitest attributes to no spec file: every file passed, and the run failed.
    await run(repo, cacheFor(repo.root), { FAKE_EXIT: '1' })
    expect((await run(repo, cacheFor(repo.root))).ran).toHaveLength(4)
    expect((await run(repo, cacheFor(repo.root))).ran).toEqual([])
  })

  it('serves another worktree\'s package passes from the store, and runs a security package in a strict run', async () => {
    const repo = makeRepo()
    const store = tempDir('delo-units-store-')
    const shared = (root: string): PassCacheOptions['shared'] => ({ store: openSharedStore(store, { root, uid: process.getuid?.() ?? 0, now: () => Date.now() }) })
    await run(repo, cacheFor(repo.root, { shared: shared(repo.root) }))
    const second = join(tempDir('delo-units-worktree-'), 'tree')
    git(repo.root, ['worktree', 'add', '-q', '--detach', second, 'HEAD'])
    const other = { ...repo, root: second }
    // A documentation change misses the whole suite's key; every package's key still matches.
    writeFileSync(join(second, 'delo/docs/index.ts'), 'export const changed = 1\n')
    const served = await run(other, cacheFor(second, { shared: shared(second) }))
    expect(served.result).toMatchObject({ cached: true, cacheSource: 'shared', units: { total: 4, ran: 0, local: 0, shared: 4 } })
    expect((await run(other, cacheFor(second, { shared: shared(second), strict: true }))).ran).toEqual(['delo/packages/d/'])
  })

  it('warns, and keeps the result, when the store cannot write a package\'s pass', async () => {
    const repo = makeRepo()
    const store = tempDir('delo-units-store-')
    const warnings: string[] = []
    const cache = cacheFor(repo.root, { warn: line => { warnings.push(line) }, shared: { store: openSharedStore(store, { root: repo.root, uid: process.getuid?.() ?? 0, now: () => Date.now() }) } })
    writeFileSync(join(store, 'passes'), 'not a directory')
    expect((await run(repo, cache)).result?.outcome).toBe('passed')
    expect(warnings).toHaveLength(4)
    expect(warnings[0]).toMatch(/^delo checks: the pass of tests:fork@delo\/packages\/a is not shared: Error: /)
  })

  it('gives a package the same key whatever other packages the run is narrowed to, so another run shares it', () => {
    const repo = makeRepo()
    const cache = cacheFor(repo.root)
    const narrow = suite(repo.fake, ['delo/packages/c'])
    const wide = suite(repo.fake, SPEC_DIRS)
    const unitC = (check: WithUnits<Planned>): Unit => (check.units ?? []).find(unit => unit.dir === 'delo/packages/c') ?? { dir: '', arg: '', inputs: [] }
    expect(cache.unitKey(narrow, unitC(narrow))).toBe(cache.unitKey(wide, unitC(wide)))
  })

  it('keeps a local package\'s pass in its worktree, keyed on HEAD', async () => {
    const tree: ForkTree = { ...TREE, packages: [...TREE.packages, pkg('delo/apps/tools')] }
    const repo = makeRepo()
    mkdirSync(join(repo.root, 'delo/apps/tools'), { recursive: true })
    writeFileSync(join(repo.root, 'delo/apps/tools/index.ts'), 'export {}\n')
    const base = suite(repo.fake, ['delo/apps/tools'])
    const check = { ...base, units: [unitOf(pkg('delo/apps/tools'), tree)] satisfies Unit[] }
    const store = tempDir('delo-units-store-')
    const policy = sharingPolicy({ packages: tree.packages, upstream: [], securityPackages: [], declarationReaders: [] })
    const cache = (): PassCache => cacheFor(repo.root, { policy, shared: { store: openSharedStore(store, { root: repo.root, uid: process.getuid?.() ?? 0, now: () => Date.now() }) } })
    await run(repo, cache(), {}, check)
    expect((await run(repo, cache(), {}, check)).ran).toEqual([])
    expect(existsSync(join(store, 'passes'))).toBe(false)
    git(repo.root, ['commit', '-q', '--allow-empty', '-m', 'next'])
    expect((await run(repo, cache(), {}, check)).ran).toEqual(['delo/apps/tools/'])
  })
})
