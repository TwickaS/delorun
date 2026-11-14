/**
 * The pass cache and the git-backed parts of the runner, against temporary
 * git repositories: a stored pass serves an unchanged check, an input change
 * or a changed key re-runs it, corrupt entries count as absent, and the
 * `--plan` mode runs nothing.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cacheUse, createPassCache, keyedEnvironment, passCacheEnabled, type PassCache, type PassCacheOptions } from '../src/checks/cache.ts'
import type { Planned } from '../src/checks/plan.ts'
import { openSharedStore } from '../src/checks/shared-cache.ts'
import { sharingPolicy } from '../src/checks/sharing.ts'
import { runPlan, type Result } from '../src/checks/run.ts'
import { cacheCounts, changeTier, invocationDir, main, refuseTrunkNarrowing, prePushBase, pushesTrunk, pushTier, TRUNK_REF, withoutSeparator } from '../src/run-checks.ts'

const ZERO = '0'.repeat(40)
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx')

const temporary: string[] = []

/**
 * A fresh temporary directory, removed after the test.
 * @param prefix - the directory name's prefix.
 * @returns the directory.
 */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * The environment git runs in: the process's, without the repository variables a hook exports.
 * @returns a new environment.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')))
}

/**
 * Run git in a directory with a fixed identity and no hooks.
 * @param cwd - the directory.
 * @param args - git's arguments.
 * @returns git's standard output.
 */
function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(), encoding: 'utf8', timeout: 30_000 })
}

/**
 * A repository on branch `v5` with two tracked input trees and a lockfile, committed once.
 * @returns its root.
 */
function makeRepo(): string {
  const root = tempDir('delorun-cache-repo-')
  git(root, ['init', '-q', '-b', 'v5'])
  mkdirSync(join(root, 'src'))
  mkdirSync(join(root, 'lib'))
  writeFileSync(join(root, 'src', 'a.txt'), 'a\n')
  writeFileSync(join(root, 'lib', 'b.txt'), 'b\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init'])
  return root
}

/**
 * The file-backed pass cache of a repository, with the versions fixed.
 * @param root - the repository.
 * @param options - the Node version, the pnpm version and the environment.
 * @returns the cache.
 */
function cacheFor(root: string, options: { pnpmVersion?: string } & Partial<Omit<PassCacheOptions, 'pnpmVersion' | 'shared'>> & { shared?: PassCacheOptions['shared'] } = {}): PassCache {
  return createPassCache({
    root,
    dir: join(root, 'node_modules', '.cache', 'delorun-checks', 'pass'),
    nodeVersion: options.nodeVersion ?? 'v24.9.0',
    platform: 'linux-x64',
    policy: sharingPolicy({ packages: [], upstream: [], securityPackages: [], declarationReaders: [] }),
    strict: false,
    warn: () => undefined,
    ...options,
    env: options.env ?? {},
    pnpmVersion: () => options.pnpmVersion ?? '11.28.5',
    shared: options.shared,
  })
}

/**
 * A planned check that appends one character to its marker file each time it runs.
 * @param id - the check's id.
 * @param marker - the file it appends to.
 * @param extra - fields beyond the defaults, such as its inputs.
 * @returns the planned check.
 */
function markedCheck(id: string, marker: string, extra: Partial<Planned> = {}): Planned {
  const script = `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x')`
  return { id, group: 'tests', title: id, cwd: '', command: [process.execPath, '-e', script], needs: [], cpus: 1, memoryBytes: 1024 ** 2, tiers: ['changed'], budget: { memoryGiB: 0.001 }, reason: 'test', ...extra }
}

/**
 * How many times a marked check has run.
 * @param marker - its marker file.
 * @returns the count.
 */
function runs(marker: string): number {
  return existsSync(marker) ? readFileSync(marker, 'utf8').length : 0
}

/**
 * Run a plan against a repository with a cache.
 * @param root - the repository.
 * @param plan - the checks.
 * @param cache - the cache, or none.
 * @returns each check's result.
 */
async function runWith(root: string, plan: Planned[], cache: PassCache | undefined): Promise<Result[]> {
  const logDir = tempDir('delorun-cache-logs-')
  return runPlan(plan, { root, env: process.env, logDir, cpus: 4, memoryBytes: 1024 ** 3, bail: false, ...cache === undefined ? {} : { cache }, report: () => undefined })
}

/**
 * Whether each result was served from the cache, by id.
 * @param results - the results.
 * @returns the cached flags, in result order.
 */
function cachedFlags(results: readonly Result[]): Array<[string, boolean]> {
  return results.map(result => [result.id, result.cached === true])
}

describe('the pass cache', () => {
  let root: string
  let markers: string
  let plan: Planned[]

  beforeEach(() => {
    root = makeRepo()
    markers = tempDir('delorun-cache-markers-')
    plan = [
      markedCheck('a', join(markers, 'a'), { inputs: ['src/**'] }),
      markedCheck('b', join(markers, 'b'), { inputs: ['lib/**'] }),
      markedCheck('c', join(markers, 'c')),
    ]
  })

  it('serves every cacheable check from the cache on a second run with no change, and always runs a check without inputs', async () => {
    const first = await runWith(root, plan, cacheFor(root))
    const second = await runWith(root, plan, cacheFor(root))
    expect(cachedFlags(first)).toEqual([['a', false], ['b', false], ['c', false]])
    expect(cachedFlags(second)).toEqual([['a', true], ['b', true], ['c', false]])
    expect([runs(join(markers, 'a')), runs(join(markers, 'b')), runs(join(markers, 'c'))]).toEqual([1, 1, 2])
    expect(second[0]?.detail).toMatch(/^cached pass \([0-9a-f]{12}\)$/)
  })

  it('re-runs exactly the checks that declare an input file when that file changes', async () => {
    await runWith(root, plan, cacheFor(root))
    writeFileSync(join(root, 'src', 'a.txt'), 'changed\n')
    const after = await runWith(root, plan, cacheFor(root))
    expect(cachedFlags(after)).toEqual([['a', false], ['b', true], ['c', false]])
    expect([runs(join(markers, 'a')), runs(join(markers, 'b'))]).toEqual([2, 1])
  })

  it('re-runs a check when an input file is added, and again when that file is committed, since its id changes from a content hash to a blob id', async () => {
    await runWith(root, plan, cacheFor(root))
    writeFileSync(join(root, 'lib', 'new.txt'), 'new\n')
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', true], ['b', false], ['c', false]])
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'add'])
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', true], ['b', false], ['c', false]])
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', true], ['b', true], ['c', false]])
  })

  it('invalidates every keyed check when the lockfile changes', async () => {
    await runWith(root, plan, cacheFor(root))
    writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# changed\n')
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('invalidates when the Node version changes, which the run injects', async () => {
    await runWith(root, plan, cacheFor(root, { nodeVersion: 'v24.9.0' }))
    expect(cachedFlags(await runWith(root, plan, cacheFor(root, { nodeVersion: 'v26.0.0' })))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('invalidates when the pnpm version changes', async () => {
    await runWith(root, plan, cacheFor(root, { pnpmVersion: '11.28.5' }))
    expect(cachedFlags(await runWith(root, plan, cacheFor(root, { pnpmVersion: '11.28.6' })))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('invalidates only the check whose command changed', async () => {
    await runWith(root, plan, cacheFor(root))
    const changed = plan.map(check => check.id === 'a' ? { ...check, command: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(join(markers, 'a'))}, 'y')`] } : check)
    expect(cachedFlags(await runWith(root, changed, cacheFor(root)))).toEqual([['a', false], ['b', true], ['c', false]])
  })

  it('invalidates when a listed environment variable changes, and not when an unlisted one does', async () => {
    const listed = plan.map(check => check.id === 'a' ? { ...check, env: ['CACHE_TEST_VALUE'] } : check)
    await runWith(root, listed, cacheFor(root, { env: { CACHE_TEST_VALUE: '1' } }))
    expect(cachedFlags(await runWith(root, listed, cacheFor(root, { env: { CACHE_TEST_VALUE: '2' } })))).toEqual([['a', false], ['b', true], ['c', false]])
    expect(cachedFlags(await runWith(root, listed, cacheFor(root, { env: { CACHE_TEST_VALUE: '2', UNLISTED: 'x' } })))).toEqual([['a', true], ['b', true], ['c', false]])
    expect(cachedFlags(await runWith(root, listed, cacheFor(root, { env: {} })))).toEqual([['a', false], ['b', true], ['c', false]])
  })

  it('treats a corrupt or foreign pass entry as absent, so its check runs again', async () => {
    await runWith(root, plan, cacheFor(root))
    const passes = join(root, 'node_modules', '.cache', 'delorun-checks', 'pass')
    writeFileSync(join(passes, 'a.json'), '{ not json')
    writeFileSync(join(passes, 'b.json'), '{"id":"b","key":42}')
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('writes each pass through a temporary file that is renamed into place', async () => {
    await runWith(root, plan, cacheFor(root))
    const passes = join(root, 'node_modules', '.cache', 'delorun-checks', 'pass')
    expect(readdirSync(passes).sort()).toEqual(['a.json', 'b.json'])
    expect(JSON.parse(readFileSync(join(passes, 'a.json'), 'utf8'))).toEqual({ id: 'a', key: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('serves nothing from the cache when the run has none, as with --no-cache', async () => {
    await runWith(root, plan, cacheFor(root))
    expect(cachedFlags(await runWith(root, plan, undefined))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('computes no key for a check whose inputs are empty, so it always runs', () => {
    expect(cacheFor(root).keyOf(markedCheck('empty', join(markers, 'empty'), { inputs: [] }))).toBeUndefined()
  })
})

describe('when the cache serves a run', () => {
  it('is off with --no-cache, in CI, and for a pre-push run that asks for the full gate', () => {
    expect(passCacheEnabled({ noCache: false, fullGate: false }, {})).toBe(true)
    expect(passCacheEnabled({ noCache: true, fullGate: false }, {})).toBe(false)
    expect(passCacheEnabled({ noCache: false, fullGate: false }, { CI: '1' })).toBe(false)
    expect(passCacheEnabled({ noCache: false, fullGate: false }, { CI: '' })).toBe(true)
    expect(passCacheEnabled({ noCache: false, fullGate: true }, {})).toBe(false)
  })
})

describe('the checks that write upstream\'s declarations', { timeout: 30_000 }, () => {
  it('run one at a time, the typecheck first, while the other checks run beside them', async () => {
    const root = makeRepo()
    const log = join(tempDir('delorun-cache-writers-'), 'log')
    const step = (id: string): Planned => markedCheck(id, log, { command: [process.execPath, '-e', `const fs = require('node:fs'); fs.appendFileSync(${JSON.stringify(log)}, 'start ${id}\\n'); setTimeout(() => fs.appendFileSync(${JSON.stringify(log)}, 'end ${id}\\n'), 300)`] })
    await runWith(root, [step('gates:docs'), step('build:artifacts'), step('jsdoc'), step('typecheck:upstream')], undefined)
    const lines = readFileSync(log, 'utf8').trim().split('\n').filter(line => !line.endsWith('jsdoc'))
    expect(lines).toEqual(['start typecheck:upstream', 'end typecheck:upstream', 'start build:artifacts', 'end build:artifacts', 'start gates:docs', 'end gates:docs'])
    expect(readFileSync(log, 'utf8').indexOf('start jsdoc')).toBeLessThan(readFileSync(log, 'utf8').indexOf('end typecheck:upstream'))
  })
})

describe('how a run uses the cache', () => {
  const run = { preCommit: false, tier: 'agent' as const, only: [], noCache: false, noSharedCache: false, fullGate: false }

  it('reads shared passes in the agent tier and in an --only run without a tier', () => {
    expect(cacheUse(run, {})).toEqual({ on: true, shared: true, strict: false })
    expect(cacheUse({ ...run, tier: undefined, only: ['tests:fork'] }, {})).toEqual({ on: true, shared: true, strict: false })
  })

  it('reads no shared pass and serves security-class and merge-only checks from no cache in the merge tier, a trunk-priority run and the full gate', () => {
    const last = { on: true, shared: true, strict: true, noReads: 'the merge tier and the full gate read no shared pass' }
    expect(cacheUse({ ...run, tier: 'merge' }, {})).toEqual(last)
    expect(cacheUse(run, { DELORUN_GATE_PRIORITY: 'trunk' })).toEqual(last)
    expect(cacheUse({ ...run, tier: undefined }, {})).toEqual(last)
  })

  it('reads no shared pass in the pre-commit tier, and shares nothing with --no-shared-cache, --no-cache, CI or a full pre-push gate', () => {
    expect(cacheUse({ ...run, tier: undefined, preCommit: true }, {})).toEqual({ on: true, shared: true, strict: false, noReads: 'the pre-commit tier reads no shared pass' })
    expect(cacheUse({ ...run, noSharedCache: true }, {})).toEqual({ on: true, shared: false, strict: false })
    expect(cacheUse({ ...run, noCache: true }, {})).toMatchObject({ on: false, shared: false })
    expect(cacheUse(run, { CI: '1' })).toMatchObject({ on: false, shared: false })
    expect(cacheUse({ ...run, fullGate: true }, {})).toMatchObject({ on: false, shared: false })
  })
})

describe('the pre-push base', () => {
  it('measures a new branch from its merge base with v5, and a pushed branch from its remote tip, and runs the full gate when asked', () => {
    const root = makeRepo()
    git(root, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(root, 'src', 'a.txt'), 'feature\n')
    git(root, ['commit', '-q', '-am', 'feature'])
    const head = git(root, ['rev-parse', 'HEAD']).trim()
    const base = git(root, ['rev-parse', 'v5']).trim()
    expect(prePushBase(root, `refs/heads/feature ${head} refs/heads/feature ${ZERO}\n`, 'v5', false)).toBe(base)
    expect(prePushBase(root, `refs/heads/feature ${head} refs/heads/feature ${base}\n`, 'v5', false)).toBe(base)
    expect(prePushBase(root, `refs/heads/feature ${head} refs/heads/feature ${ZERO}\n`, 'v5', true)).toBeUndefined()
    expect(prePushBase(root, `refs/heads/other ${base} refs/heads/other ${ZERO}\n`, 'v5', false)).toBeUndefined()
  })
})

describe('the paths a command line names', () => {
  it('are relative to INIT_CWD only under a pnpm script, and to the run\'s own directory otherwise', () => {
    expect(invocationDir({ npm_lifecycle_event: 'check', INIT_CWD: '/repo/delorun' }, '/repo/delorun/apps/tools')).toBe('/repo/delorun')
    expect(invocationDir({ INIT_CWD: '/elsewhere' }, '/repo')).toBe('/repo')
    expect(invocationDir({ npm_lifecycle_event: 'check' }, '/repo')).toBe('/repo')
  })
})

describe('the --plan mode', () => {
  it('removes only the first separator that pnpm forwards, so the flags after it still parse', () => {
    expect(withoutSeparator(['--changed', '--', '--plan'])).toEqual(['--changed', '--plan'])
    expect(withoutSeparator(['--', '--', 'x'])).toEqual(['--', 'x'])
    expect(withoutSeparator(['--plan'])).toEqual(['--plan'])
  })

  const invocations: Array<readonly [string[]]> = [[['--plan']], [['--', '--plan']], [['--changed', '--', '--plan']]]
  it.each(invocations)('prints the selection and runs nothing for the arguments %j: no log directory, no report, and no pass cache', (args: string[]) => {
    const root = makeRepo()
    const store = join(tempDir('delorun-cache-plan-store-'), 'store')
    const output = execFileSync(tsx, [join(repoRoot, 'delorun', 'apps', 'tools', 'src', 'run-checks.ts'), ...args], { cwd: root, env: { ...gitEnv(), DELORUN_CHECKS_SHARED_CACHE: store }, encoding: 'utf8', timeout: 60_000 })
    expect(output).toMatch(/^delorun checks \(plan\): \d+ checks/m)
    expect(output).toContain('pass cache:')
    expect(existsSync(join(root, 'node_modules', '.cache', 'delorun-checks', 'logs'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', '.cache', 'delorun-checks', 'report.json'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', '.cache', 'delorun-checks', 'pass'))).toBe(false)
  }, 60_000)
})

describe('the gate tier of a run', () => {
  const sha = 'a'.repeat(40)
  const zero = '0'.repeat(40)
  const push = (remoteRef: string, local = sha): string => `refs/heads/x ${local} ${remoteRef} ${zero}\n`

  it('is the merge tier for a push of the trunk, alone or with another ref, and the lane tier for any other branch', () => {
    expect(TRUNK_REF).toBe('refs/heads/v5')
    expect(pushTier(push('refs/heads/lane'), {})).toBe('lane')
    expect(pushTier(push(TRUNK_REF), {})).toBe('merge')
    expect(pushTier(push('refs/heads/lane') + push(TRUNK_REF), {})).toBe('merge')
    expect(pushTier('', {})).toBe('lane')
  })

  it('is the lane tier for any other push unless DELORUN_TIER asks for the agent tier, and never lighter than merge for the trunk', () => {
    expect(pushTier(push('refs/heads/lane'), {})).toBe('lane')
    expect(pushTier(push('refs/heads/lane'), { DELORUN_TIER: 'agent' })).toBe('agent')
    expect(pushTier(push(TRUNK_REF), { DELORUN_TIER: 'agent' })).toBe('merge')
    expect(pushTier(push(TRUNK_REF), { DELORUN_TIER: 'lane' })).toBe('merge')
    expect(changeTier('lane', push(TRUNK_REF), {})).toBe('merge')
    expect(changeTier('agent', push(TRUNK_REF), { DELORUN_TIER: 'agent' })).toBe('merge')
    expect(changeTier('lane', push('refs/heads/lane'), {})).toBe('lane')
    expect(changeTier(undefined, push('refs/heads/lane'), {})).toBe('lane')
    expect(changeTier(undefined, undefined, { DELORUN_TIER: 'lane' })).toBe('agent')
    expect(changeTier('merge', undefined, {})).toBe('merge')
  })

  it('refuses a push of the trunk that skips or narrows checks, and lets a lane push skip them', () => {
    expect(() => { refuseTrunkNarrowing(push(TRUNK_REF), ['gates:secrets'], []) }).toThrow('unset DELORUN_PUSH_SKIP and drop --skip (gates:secrets)')
    expect(() => { refuseTrunkNarrowing(push('refs/heads/lane') + push(TRUNK_REF), [], ['jsdoc']) }).toThrow('drop --only (jsdoc)')
    expect(() => { refuseTrunkNarrowing(push(TRUNK_REF), [], []) }).not.toThrow()
    expect(() => { refuseTrunkNarrowing(push('refs/heads/lane'), ['tests:snapshots'], []) }).not.toThrow()
    expect(() => { refuseTrunkNarrowing(undefined, ['x'], ['y']) }).not.toThrow()
  })

  it('names a push of the trunk for the queue priority, but not DELORUN_TIER=merge or a deletion', () => {
    expect(pushesTrunk(push(TRUNK_REF))).toBe(true)
    expect(pushesTrunk(push('refs/heads/lane'))).toBe(false)
    expect(pushesTrunk(push(TRUNK_REF, zero))).toBe(false)
  })

  it('does not count the deletion of the trunk, and takes the merge tier from DELORUN_TIER=merge', () => {
    expect(pushTier(push(TRUNK_REF, zero), {})).toBe('lane')
    expect(pushTier(push('refs/heads/lane'), { DELORUN_TIER: 'merge' })).toBe('merge')
    expect(pushTier(push('refs/heads/lane'), { DELORUN_TIER: 'agent' })).toBe('agent')
  })

  it('is a usage error when --tier has another value, or comes with --pre-commit or the full gate', async () => {
    await expect(main(['--changed', '--tier', 'full'])).rejects.toThrow('--tier takes lane, agent or merge, got full')
    await expect(main(['--preflight', '--changed'])).rejects.toThrow('--preflight is a change run of its own')
    await expect(main(['--pre-commit', '--tier', 'merge'])).rejects.toThrow('does not apply to --pre-commit or the full gate')
    await expect(main(['--tier', 'merge'])).rejects.toThrow('does not apply to --pre-commit or the full gate')
  })
})

describe('the machine-wide pass store', { timeout: 30_000 }, () => {
  let store: string
  let markers: string
  const ID = 'gates:package-states'
  const shareable = (marker: string, extra: Partial<Planned> = {}): Planned => markedCheck(ID, marker, { inputs: ['src/**'], ...extra })

  /**
   * A second worktree of a repository, detached at its HEAD.
   * @param root - the repository.
   * @returns the worktree's root.
   */
  function worktreeOf(root: string): string {
    const dir = join(tempDir('delorun-cache-worktree-'), 'tree')
    git(root, ['worktree', 'add', '-q', '--detach', dir, 'HEAD'])
    return dir
  }

  beforeEach(() => {
    store = tempDir('delorun-cache-store-')
    markers = tempDir('delorun-cache-markers-')
  })

  /**
   * A cache of a repository that shares through the test's store.
   * @param root - the repository, standing for one worktree.
   * @param extra - options over the defaults, such as `strict` or the store's `noReads`.
   * @returns the cache.
   */
  function sharing(root: string, extra: Partial<Omit<PassCacheOptions, 'shared' | 'pnpmVersion'>> & { noReads?: string } = {}): PassCache {
    const { noReads, ...rest } = extra
    return cacheFor(root, { shared: { store: openSharedStore(store, { root, uid: process.getuid?.() ?? 0, now: () => Date.now() }), ...noReads === undefined ? {} : { noReads } }, ...rest })
  }

  it('serves a pass proven in one worktree to another worktree with the same inputs, and names the source', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first))
    const results = await runWith(second, [shareable(marker)], sharing(second))
    expect(results.map(result => [result.cached, result.cacheSource])).toEqual([[true, 'shared']])
    expect(results[0]?.detail).toMatch(/^cached pass \(shared, [0-9a-f]{12}\)$/)
    expect(runs(marker)).toBe(1)
    expect(cacheCounts(results)).toEqual({ local: 0, shared: 1, ran: 0, packages: { local: 0, shared: 0, ran: 0 } })
  })

  it('refuses a pass that another clone with the same files stored', async () => {
    const first = makeRepo()
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first))
    const clone = makeRepo()
    expect(cachedFlags(await runWith(clone, [shareable(marker)], sharing(clone)))).toEqual([[ID, false]])
  })

  it('keys HEAD for a check that reads history, so a new commit with the same files runs it again in the same worktree', async () => {
    const root = makeRepo()
    const marker = join(markers, 'history')
    const check = markedCheck('gates:history', marker, { inputs: ['src/**'], history: true })
    await runWith(root, [check], cacheFor(root))
    expect(cachedFlags(await runWith(root, [check], cacheFor(root)))).toEqual([['gates:history', true]])
    git(root, ['commit', '-q', '--allow-empty', '-m', 'empty'])
    expect(cachedFlags(await runWith(root, [check], cacheFor(root)))).toEqual([['gates:history', false]])
  })

  it('refuses the changed-upstream lane\'s pass once the generated file it reads appears', async () => {
    const root = makeRepo()
    const lane = markedCheck('tests:upstream-changed', join(markers, 'upstream'), { inputs: ['src/**'] })
    await runWith(root, [lane], sharing(root))
    expect(cachedFlags(await runWith(root, [lane], sharing(root)))).toEqual([['tests:upstream-changed', true]])
    mkdirSync(join(root, 'packages', 'experimental', 'liveshare', 'lib'), { recursive: true })
    writeFileSync(join(root, 'packages', 'experimental', 'liveshare', 'lib', 'typert.remote-client.js'), 'export {}\n')
    expect(cachedFlags(await runWith(root, [lane], sharing(root)))).toEqual([['tests:upstream-changed', false]])
  })

  it('refuses the shared pass to a worktree whose input differs, and runs the check', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    writeFileSync(join(second, 'src', 'a.txt'), 'different\n')
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first))
    expect(cachedFlags(await runWith(second, [shareable(marker)], sharing(second)))).toEqual([[ID, false]])
    expect(runs(marker)).toBe(2)
  })

  it('refuses the shared pass when the install differs from the other worktree\'s', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    mkdirSync(join(second, 'node_modules', '.pnpm'), { recursive: true })
    writeFileSync(join(second, 'node_modules', '.pnpm', 'lock.yaml'), 'lockfileVersion: 8\n')
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first))
    expect(cachedFlags(await runWith(second, [shareable(marker)], sharing(second)))).toEqual([[ID, false]])
  })

  it('refuses the shared pass when a keyed variable differs, and writes each worktree\'s root as <root>', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first, { env: { NODE_OPTIONS: `--require ${first}/x.cjs`, PATH: '/a' } }))
    expect(cachedFlags(await runWith(second, [shareable(marker)], sharing(second, { env: { NODE_OPTIONS: `--require ${second}/x.cjs`, PATH: '/b', DELORUN_TIER: 'merge' } })))).toEqual([[ID, true]])
    expect(cachedFlags(await runWith(second, [shareable(marker)], sharing(second, { env: { NODE_OPTIONS: '--inspect' } })))).toEqual([[ID, false]])
    expect(keyedEnvironment({ DSH_X: '1', LANG: 'C', HOME: '/h', DELORUN_GATE_PRIORITY: 'trunk', LC_ALL: undefined, DEEPSEEK_API_KEY: 'secret', DOCKER_HOST: 'unix:///r/d.sock' }, '/r')).toEqual([['DEEPSEEK_API_KEY', 'set'], ['DOCKER_HOST', 'unix://<root>/d.sock'], ['DSH_X', '1'], ['LANG', 'C']])
  })

  it('invalidates a check when the code its command runs changes, though its declared inputs did not', async () => {
    const root = makeRepo()
    mkdirSync(join(root, 'delorun', 'apps', 'tools', 'src'), { recursive: true })
    writeFileSync(join(root, 'delorun', 'apps', 'tools', 'src', 'gate.ts'), 'export {}\n')
    const policy = sharingPolicy({ packages: [{ name: '@delorun/tools', dir: 'delorun/apps/tools', forkDependencies: [], upstreamDependencies: [], ownWorkspace: false }], upstream: [], securityPackages: [], declarationReaders: [] })
    const marker = join(markers, 'shared')
    const check = shareable(marker, { command: [...shareable(marker).command, 'delorun/apps/tools/src/gate.ts'] })
    await runWith(root, [check], cacheFor(root, { policy }))
    expect(cachedFlags(await runWith(root, [check], cacheFor(root, { policy })))).toEqual([[ID, true]])
    writeFileSync(join(root, 'delorun', 'apps', 'tools', 'src', 'gate.ts'), 'export const changed = 1\n')
    expect(cachedFlags(await runWith(root, [check], cacheFor(root, { policy })))).toEqual([[ID, false]])
  })

  it('never shares a check the rules do not name or refuse, and says why in its plan state', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    const unaudited = markedCheck('a', join(markers, 'a'), { inputs: ['src/**'] })
    const history = markedCheck('boundary', join(markers, 'boundary'), { inputs: ['src/**'] })
    await runWith(first, [unaudited, history], sharing(first))
    expect(cachedFlags(await runWith(second, [unaudited, history], sharing(second)))).toEqual([['a', false], ['boundary', false]])
    expect(sharing(second).unshared(unaudited)).toBe('its inputs have not been audited for sharing')
    expect(sharing(second).unshared(history)).toMatch(/^reads git history/)
    expect(existsSync(join(store, 'passes'))).toBe(false)
  })

  it('reads no shared pass in the merge tier and the full gate, but stores the passes it proves', async () => {
    const first = makeRepo()
    const second = worktreeOf(first)
    const marker = join(markers, 'shared')
    await runWith(first, [shareable(marker)], sharing(first, { noReads: 'the merge tier and the full gate read no shared pass' }))
    expect(sharing(first, { noReads: 'merge' }).unshared(shareable(marker))).toBe('merge')
    expect(cachedFlags(await runWith(second, [shareable(marker)], sharing(second, { noReads: 'merge' })))).toEqual([[ID, false]])
    expect(cachedFlags(await runWith(worktreeOf(first), [shareable(marker)], sharing(second)))).toEqual([[ID, true]])
  })

  it('runs a security-class or merge-only check in a strict run even when this worktree stored its pass', async () => {
    const root = makeRepo()
    const security = markedCheck('gates:fundamentals', join(markers, 'fundamentals'), { inputs: ['src/**'] })
    const mergeOnly = markedCheck('tests:docker', join(markers, 'docker'), { inputs: ['src/**'], mergeOnly: true })
    const plain = shareable(join(markers, 'shared'))
    await runWith(root, [security, mergeOnly, plain], cacheFor(root))
    expect(cachedFlags(await runWith(root, [security, mergeOnly, plain], cacheFor(root)))).toEqual([['gates:fundamentals', true], ['tests:docker', true], [ID, true]])
    expect(cachedFlags(await runWith(root, [security, mergeOnly, plain], cacheFor(root, { strict: true })))).toEqual([['gates:fundamentals', false], ['tests:docker', false], [ID, true]])
  })

  it('warns and keeps the result when the store cannot write a pass', async () => {
    const root = makeRepo()
    const warnings: string[] = []
    const cache = sharing(root, { warn: line => { warnings.push(line) } })
    writeFileSync(join(store, 'passes'), 'not a directory')
    const results = await runWith(root, [shareable(join(markers, 'shared'))], cache)
    expect(results.map(result => result.outcome)).toEqual(['passed'])
    expect(warnings).toEqual([expect.stringMatching(/^delorun checks: the pass of gates:package-states is not shared: Error: (EEXIST|ENOTDIR)/)])
  })

  it('shares nothing for a run without a store, as with --no-shared-cache', () => {
    const root = makeRepo()
    expect(cacheFor(root).unshared(shareable(join(markers, 'shared')))).toBe('the run shares no pass (--no-shared-cache, --no-cache or CI)')
  })
})
