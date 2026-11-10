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
import { createPassCache, passCacheEnabled, type PassCache } from '../src/checks/cache.ts'
import type { Planned } from '../src/checks/plan.ts'
import { runPlan, type Result } from '../src/checks/run.ts'
import { main, prePushBase, pushesTrunk, pushTier, TRUNK_REF, withoutSeparator } from '../src/run-checks.ts'

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
  const root = tempDir('delo-cache-repo-')
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
function cacheFor(root: string, options: { nodeVersion?: string, pnpmVersion?: string, env?: NodeJS.ProcessEnv } = {}): PassCache {
  return createPassCache({ root, dir: join(root, 'node_modules', '.cache', 'delo-checks', 'pass'), env: options.env ?? {}, nodeVersion: options.nodeVersion ?? 'v24.9.0', pnpmVersion: () => options.pnpmVersion ?? '11.28.5' })
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
  const logDir = tempDir('delo-cache-logs-')
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
    markers = tempDir('delo-cache-markers-')
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
    const listed = plan.map(check => check.id === 'a' ? { ...check, env: ['DELO_CACHE_TEST_VALUE'] } : check)
    await runWith(root, listed, cacheFor(root, { env: { DELO_CACHE_TEST_VALUE: '1' } }))
    expect(cachedFlags(await runWith(root, listed, cacheFor(root, { env: { DELO_CACHE_TEST_VALUE: '2' } })))).toEqual([['a', false], ['b', true], ['c', false]])
    expect(cachedFlags(await runWith(root, listed, cacheFor(root, { env: { DELO_CACHE_TEST_VALUE: '2', UNLISTED: 'x' } })))).toEqual([['a', true], ['b', true], ['c', false]])
  })

  it('treats a corrupt or foreign pass entry as absent, so its check runs again', async () => {
    await runWith(root, plan, cacheFor(root))
    const passes = join(root, 'node_modules', '.cache', 'delo-checks', 'pass')
    writeFileSync(join(passes, 'a.json'), '{ not json')
    writeFileSync(join(passes, 'b.json'), '{"id":"b","key":42}')
    expect(cachedFlags(await runWith(root, plan, cacheFor(root)))).toEqual([['a', false], ['b', false], ['c', false]])
  })

  it('writes each pass through a temporary file that is renamed into place', async () => {
    await runWith(root, plan, cacheFor(root))
    const passes = join(root, 'node_modules', '.cache', 'delo-checks', 'pass')
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

describe('the --plan mode', () => {
  it('removes only the first separator that pnpm forwards, so the flags after it still parse', () => {
    expect(withoutSeparator(['--changed', '--', '--plan'])).toEqual(['--changed', '--plan'])
    expect(withoutSeparator(['--', '--', 'x'])).toEqual(['--', 'x'])
    expect(withoutSeparator(['--plan'])).toEqual(['--plan'])
  })

  const invocations: Array<readonly [string[]]> = [[['--plan']], [['--', '--plan']], [['--changed', '--', '--plan']]]
  it.each(invocations)('prints the selection and runs nothing for the arguments %j: no log directory, no report, and no pass cache', (args: string[]) => {
    const root = makeRepo()
    const output = execFileSync(tsx, [join(repoRoot, 'delo', 'apps', 'tools', 'src', 'run-checks.ts'), ...args], { cwd: root, env: gitEnv(), encoding: 'utf8', timeout: 60_000 })
    expect(output).toMatch(/^delo checks \(plan\): \d+ checks/m)
    expect(output).toContain('pass cache:')
    expect(existsSync(join(root, 'node_modules', '.cache', 'delo-checks', 'logs'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', '.cache', 'delo-checks', 'report.json'))).toBe(false)
    expect(existsSync(join(root, 'node_modules', '.cache', 'delo-checks', 'pass'))).toBe(false)
  }, 60_000)
})

describe('the gate tier of a run', () => {
  const sha = 'a'.repeat(40)
  const zero = '0'.repeat(40)
  const push = (remoteRef: string, local = sha): string => `refs/heads/x ${local} ${remoteRef} ${zero}\n`

  it('is the merge tier for a push of the trunk, alone or with another ref, and the agent tier for any other branch', () => {
    expect(TRUNK_REF).toBe('refs/heads/v5')
    expect(pushTier(push('refs/heads/lane'), {})).toBe('agent')
    expect(pushTier(push(TRUNK_REF), {})).toBe('merge')
    expect(pushTier(push('refs/heads/lane') + push(TRUNK_REF), {})).toBe('merge')
    expect(pushTier('', {})).toBe('agent')
  })

  it('names a push of the trunk for the queue priority, but not DELO_TIER=merge or a deletion', () => {
    expect(pushesTrunk(push(TRUNK_REF))).toBe(true)
    expect(pushesTrunk(push('refs/heads/lane'))).toBe(false)
    expect(pushesTrunk(push(TRUNK_REF, zero))).toBe(false)
  })

  it('does not count the deletion of the trunk, and takes the merge tier from DELO_TIER=merge', () => {
    expect(pushTier(push(TRUNK_REF, zero), {})).toBe('agent')
    expect(pushTier(push('refs/heads/lane'), { DELO_TIER: 'merge' })).toBe('merge')
    expect(pushTier(push('refs/heads/lane'), { DELO_TIER: 'agent' })).toBe('agent')
  })

  it('is a usage error when --tier has another value, or comes with --pre-commit or the full gate', async () => {
    await expect(main(['--changed', '--tier', 'full'])).rejects.toThrow('--tier takes agent or merge, got full')
    await expect(main(['--pre-commit', '--tier', 'merge'])).rejects.toThrow('does not apply to --pre-commit or the full gate')
    await expect(main(['--tier', 'merge'])).rejects.toThrow('does not apply to --pre-commit or the full gate')
  })
})
