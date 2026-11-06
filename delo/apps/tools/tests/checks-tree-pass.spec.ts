/**
 * The tree pass record against temporary git repositories: a passing pre-push run records its pass, a repeat of the
 * same tree is covered, a commit with the same tree and other history reruns the checks that read commits, and a plan
 * the record does not cover, a dirty tree, a failing run or a changed fact leaves the checks to run.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { contentId } from '../src/checks/cache.ts'
import type { Planned } from '../src/checks/plan.ts'
import { runPlan } from '../src/checks/run.ts'
import { findTreePass, readTreePass, recordTreePass, treeOfRef, treePassEnabled, treeState, type RunFacts, type TreePassWrite } from '../src/checks/tree-pass.ts'

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
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, env: gitEnv(), encoding: 'utf8' })
}

/**
 * A repository on branch `v5` with a lockfile and an ignored `node_modules`, committed once. Its `origin/v5` ref names
 * that commit, as a clone has after a fetch, which the range gates compare HEAD with.
 * @returns its root.
 */
function makeRepo(): string {
  const root = tempDir('delo-tree-repo-')
  git(root, ['init', '-q', '-b', 'v5'])
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(root, 'src', 'a.txt'), 'a\n')
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '-q', '-m', 'init'])
  git(root, ['update-ref', 'refs/remotes/origin/v5', 'HEAD'])
  return root
}

/**
 * The directory of tree records under a repository.
 * @param root - the repository.
 * @returns the directory.
 */
function treesOf(root: string): string {
  return join(root, 'node_modules', '.cache', 'delo-checks', 'trees')
}

/**
 * The facts a record stores and a lookup matches, with some of them replaced.
 * @param root - the repository.
 * @param overrides - the facts to replace.
 * @returns the facts.
 */
function factsFor(root: string, overrides: Partial<RunFacts> = {}): RunFacts {
  return { lockfile: contentId(root, 'pnpm-lock.yaml'), node: 'v24.9.0', pnpm: () => '11.28.5', env: {}, ...overrides }
}

/**
 * A planned check that runs a script.
 * @param id - the check's id.
 * @param script - the script `node -e` runs.
 * @param extra - fields beyond the defaults.
 * @returns the planned check.
 */
function check(id: string, script: string, extra: Partial<Planned> = {}): Planned {
  return { id, group: 'tests', title: id, cwd: '', command: [process.execPath, '-e', script], needs: [], cpus: 1, memoryBytes: 1024 ** 2, tiers: ['changed'], budget: { memoryGiB: 0.001 }, reason: 'test', ...extra }
}

const PASS = 'process.exit(0)'

/**
 * Run a plan from the repository's current state, as a pre-push run does, and record what passed.
 * @param root - the repository.
 * @param plan - the checks.
 * @param facts - the facts the record stores.
 * @returns the recording outcome.
 */
async function runAndRecord(root: string, plan: Planned[], facts: RunFacts): Promise<TreePassWrite> {
  const before = treeState(root)
  const results = await runPlan(plan, { root, env: process.env, logDir: tempDir('delo-tree-logs-'), cpus: 4, memoryBytes: 1024 ** 3, bail: false, report: () => undefined })
  return recordTreePass(treesOf(root), { before, after: treeState(root), base: treeOfRef(root, 'origin/v5'), plan, results }, facts, new Date('2026-11-06T07:00:00.000Z'))
}

/**
 * The lookup a run would make now.
 * @param root - the repository.
 * @param plan - the checks the run would start.
 * @param facts - the facts the record must match.
 * @returns the lookup's outcome.
 */
function lookup(root: string, plan: Planned[], facts: RunFacts): ReturnType<typeof findTreePass> {
  return findTreePass(treesOf(root), treeState(root), plan, facts)
}

/**
 * The head commit of a repository.
 * @param root - the repository.
 * @returns the commit id.
 */
function headOf(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim()
}

/**
 * The tree of a repository's head.
 * @param root - the repository.
 * @returns the tree id.
 */
function treeOf(root: string): string {
  return git(root, ['rev-parse', 'HEAD^{tree}']).trim()
}

describe('the tree pass record', () => {
  it('records a passing run with its facts, leaves it under the tree through a rename, and covers a repeat of the same tree', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS), check('b', PASS, { env: ['TZ'] })]
    const facts = factsFor(root, { env: { TZ: 'UTC' } })
    const written = await runAndRecord(root, plan, facts)
    expect(written.recorded).toBe(true)
    expect(readTreePass(treesOf(root), treeOf(root))).toEqual({
      tree: treeOf(root),
      base: treeOfRef(root, 'origin/v5'),
      head: headOf(root),
      rangeBase: headOf(root),
      passedAt: '2026-11-06T07:00:00.000Z',
      checks: ['a', 'b'],
      scopes: {},
      lockfile: contentId(root, 'pnpm-lock.yaml'),
      node: 'v24.9.0',
      pnpm: '11.28.5',
      env: { TZ: 'UTC' },
    })
    expect(readdirSync(treesOf(root))).toEqual([`${treeOf(root)}.json`])
    expect(lookup(root, plan, facts)).toMatchObject({ hit: true })
  })

  it('covers a fast-forward of v5 to the commit that passed on its branch, whatever the branch was called', async () => {
    const root = makeRepo()
    git(root, ['checkout', '-q', '-b', 'wave0/feature'])
    writeFileSync(join(root, 'src', 'a.txt'), 'feature\n')
    git(root, ['commit', '-q', '-am', 'feature'])
    const plan = [check('a', PASS), check('boundary', PASS, { history: true })]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    git(root, ['checkout', '-q', 'v5'])
    git(root, ['merge', '-q', '--ff-only', 'wave0/feature'])
    expect(lookup(root, plan, facts)).toMatchObject({ hit: true })
  })

  it('reruns the checks that read commits for a commit with the same tree and other history, and covers the rest', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS), check('boundary', PASS, { history: true })]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    git(root, ['commit', '-q', '--allow-empty', '-m', 'the same tree with other history'])
    expect(lookup(root, plan, facts)).toEqual({ hit: false, reason: 'boundary reads commits, and HEAD or origin/v5 differs from the record' })
    expect(lookup(root, [check('a', PASS)], facts)).toMatchObject({ hit: true })
  })

  it('reruns the commit-reading checks when the range base moves, and covers the rest', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS), check('boundary', PASS, { history: true })]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    git(root, ['commit', '-q', '--allow-empty', '-m', 'the range base moves'])
    git(root, ['update-ref', 'refs/remotes/origin/v5', 'HEAD'])
    git(root, ['reset', '-q', '--hard', 'HEAD~1'])
    expect(lookup(root, plan, facts)).toMatchObject({ hit: false, reason: expect.stringContaining('boundary reads commits') })
    expect(lookup(root, [check('a', PASS)], facts)).toMatchObject({ hit: true })
  })

  it('leaves a different tree to the checks, since no record names it', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS)]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    writeFileSync(join(root, 'src', 'a.txt'), 'changed\n')
    git(root, ['commit', '-q', '-am', 'change'])
    expect(lookup(root, plan, facts)).toEqual({ hit: false })
  })

  it('runs the checks when the lockfile, the Node or pnpm version, or a listed environment variable differs', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS, { env: ['TZ'] })]
    const facts = factsFor(root, { env: { TZ: 'UTC' } })
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    expect(lookup(root, plan, factsFor(root, { env: { TZ: 'UTC' }, lockfile: 'sha256:other' }))).toEqual({ hit: false, reason: 'the lockfile changed' })
    expect(lookup(root, plan, factsFor(root, { env: { TZ: 'UTC' }, node: 'v26.0.0' }))).toEqual({ hit: false, reason: 'the Node version changed' })
    expect(lookup(root, plan, factsFor(root, { env: { TZ: 'UTC' }, pnpm: () => '11.28.6' }))).toEqual({ hit: false, reason: 'the pnpm version changed' })
    expect(lookup(root, plan, factsFor(root, { env: { TZ: 'Europe/Berlin' } }))).toEqual({ hit: false, reason: 'TZ changed' })
    expect(lookup(root, plan, facts)).toMatchObject({ hit: true })
  })

  it('runs the checks when the plan selects a check the record lacks, or a scope the record does not cover', async () => {
    const root = makeRepo()
    const facts = factsFor(root)
    expect((await runAndRecord(root, [check('a', PASS, { scope: ['delo/apps/x/'] })], facts)).recorded).toBe(true)
    expect(lookup(root, [check('a', PASS, { scope: ['delo/apps/x/'] }), check('b', PASS)], facts)).toEqual({ hit: false, reason: 'the record has no b' })
    expect(lookup(root, [check('a', PASS)], facts)).toEqual({ hit: false, reason: 'the record does not cover the scope of a' })
    expect(lookup(root, [check('a', PASS, { scope: ['delo/apps/y/'] })], facts)).toEqual({ hit: false, reason: 'the record does not cover the scope of a' })
    expect(lookup(root, [check('a', PASS, { scope: ['delo/apps/x/tests/a.spec.ts'] })], facts)).toMatchObject({ hit: true })
  })

  it('stores nothing for a failing run, and nothing when HEAD moves while the run is under way', async () => {
    const root = makeRepo()
    const facts = factsFor(root)
    expect(await runAndRecord(root, [check('a', 'process.exit(1)')], facts)).toEqual({ recorded: false, reason: 'not every planned check passed' })
    expect(existsSync(treesOf(root))).toBe(false)
    const before = treeState(root)
    git(root, ['commit', '-q', '--allow-empty', '-m', 'during the run'])
    const moved = recordTreePass(treesOf(root), { before, after: treeState(root), base: null, plan: [check('a', PASS)], results: [{ id: 'a', outcome: 'passed', seconds: 0 }] }, facts, new Date())
    expect(moved).toEqual({ recorded: false, reason: 'HEAD, the range base or the working tree changed during the run' })
    expect(existsSync(treesOf(root))).toBe(false)
  })

  it('neither reads nor writes a record while the working tree differs from HEAD', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS)]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    writeFileSync(join(root, 'scratch.txt'), 'untracked\n')
    expect(lookup(root, plan, facts)).toEqual({ hit: false })
    expect(await runAndRecord(root, plan, facts)).toEqual({ recorded: false, reason: 'the working tree differed from HEAD before the run' })
  })

  it('treats a corrupt record as absent, so its checks run again', async () => {
    const root = makeRepo()
    const plan = [check('a', PASS)]
    const facts = factsFor(root)
    expect((await runAndRecord(root, plan, facts)).recorded).toBe(true)
    writeFileSync(join(treesOf(root), `${treeOf(root)}.json`), '{ not json')
    expect(lookup(root, plan, facts)).toEqual({ hit: false })
  })

  it('is off with --no-cache, in CI, and when DELO_FULL_GATE=1 asks for the full gate', () => {
    expect(treePassEnabled({ noCache: false }, {})).toBe(true)
    expect(treePassEnabled({ noCache: true }, {})).toBe(false)
    expect(treePassEnabled({ noCache: false }, { CI: '1' })).toBe(false)
    expect(treePassEnabled({ noCache: false }, { DELO_FULL_GATE: '1' })).toBe(false)
    expect(treePassEnabled({ noCache: false }, { DELO_FULL_GATE: '0' })).toBe(true)
  })
})
