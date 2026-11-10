/**
 * The tree pass record. A pre-push run that passes every check it planned leaves a record under HEAD's tree. A later
 * run of the same tree reports that pass and starts nothing when the record covers every planned check. A record names
 * its checks, the scope each narrowed check ran over, the lockfile, Node and pnpm versions and the environment variables
 * the checks read, and the HEAD commit and range base the run measured.
 *
 * A record names the gate tier it passed (`GateTier`); a record without one is an agent-tier pass. A record serves a run of
 * its own tier or a lighter one (lane, then agent, then merge): a lane-tier pass serves only a lane-tier run, and only a
 * merge-tier pass serves the merge tier, which alone lets a commit reach the trunk.
 *
 * The record covers a planned check when it names the check with a scope that includes the planned scope. A check that
 * reads commits beyond the tree (`Check.history`, such as the range gates) is covered only at the HEAD commit and range
 * base the record was made at, because commit messages and history are not part of the tree. A dirty working tree
 * neither reads nor writes a record, since the checks then read the working tree instead of HEAD's tree.
 *
 * Records live in the git common directory, so every worktree of a clone reads and writes the same ones. A record file is
 * named by the tree and the Node major, so a pass on one major never serves another.
 *
 * @module @delo/tools/checks/tree-pass
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { git, runGit } from '../git.ts'
import { passCacheEnabled } from './cache.ts'
import { RANGE_BASE } from './gates/index.ts'
import type { Check, GateTier } from './plan.ts'
import type { Result } from './run.ts'

/** A commit or tree id as git prints it, in SHA-1 or SHA-256 form. */
const ObjectId = z.string().regex(/^[0-9a-f]{40,64}$/)

const TreePassFile = z.object({
  tree: ObjectId,
  base: ObjectId.nullable(),
  head: ObjectId,
  rangeBase: ObjectId.nullable(),
  passedAt: z.string(),
  tier: z.enum(['lane', 'agent', 'merge']).default('agent'),
  checks: z.array(z.string()),
  scopes: z.record(z.string(), z.array(z.string())),
  lockfile: z.string(),
  node: z.string(),
  pnpm: z.string(),
  env: z.record(z.string(), z.string().nullable()),
})

/** The order of the gate tiers: a record serves a run of its own tier or a lighter one. */
const TIER_RANK: Readonly<Record<GateTier, number>> = { lane: 0, agent: 1, merge: 2 }

/** One record: the checks that passed for a tree, and the facts those passes depend on beyond the tree. */
export type TreePass = z.infer<typeof TreePassFile>

/** The repository state a record is keyed on. */
export interface TreeState {
  /** HEAD's tree, `HEAD^{tree}`. */
  readonly tree: string
  /** HEAD's commit, which the history-reading checks depend on. */
  readonly head: string
  /** The commit the range gates compare HEAD with, or null when the clone has no such ref. */
  readonly rangeBase: string | null
  /** Whether the working tree equals HEAD: no tracked file differs and no untracked file outside git's ignore rules exists. */
  readonly clean: boolean
}

/** The facts a record must still match, beyond the tree. */
export interface RunFacts {
  /** The lockfile's content id, `sha256:<hex>` or `absent`, as {@link contentId} gives it. */
  readonly lockfile: string
  /** The Node version, `process.version`. */
  readonly node: string
  /**
   * The pnpm version. Called only when a record exists for the tree.
   * @returns the version.
   */
  readonly pnpm: () => string
  /** The environment the checks run in; the variables the planned checks list are compared by value. */
  readonly env: NodeJS.ProcessEnv
  /** The tier the run is for; a record of a lower tier does not cover it. */
  readonly tier: GateTier
}

/** A finished run, for {@link recordTreePass}. */
export interface TreePassRun {
  /** The repository state before the run started. */
  readonly before: TreeState
  /** The repository state after the run ended. */
  readonly after: TreeState
  /** The tree of the revision the changed paths were measured from, or null. */
  readonly base: string | null
  /** The checks the run started, in plan order. */
  readonly plan: readonly Check[]
  /** Each check's result. */
  readonly results: readonly Result[]
}

/** The outcome of {@link findTreePass}: a record that covers the run, or a miss with a reason when a record exists for the tree. */
export type TreePassLookup =
  | { readonly hit: true; readonly record: TreePass }
  | { readonly hit: false; readonly reason?: string | undefined }

/** Whether {@link recordTreePass} stored a record, and why it did not. */
export type TreePassWrite =
  | { readonly recorded: true; readonly record: TreePass }
  | { readonly recorded: false; readonly reason: string }

/**
 * Whether tree passes apply to a run. They are off wherever the pass cache is, with `--no-cache` or in CI, and off when
 * `DELO_FULL_GATE=1` asks for the whole gate.
 * @param options - `noCache` for the flag.
 * @param env - the environment the run starts with.
 * @returns true when the run reads and writes tree passes.
 */
export function treePassEnabled(options: { readonly noCache: boolean }, env: NodeJS.ProcessEnv): boolean {
  return passCacheEnabled({ noCache: options.noCache, fullGate: env['DELO_FULL_GATE'] === '1' }, env)
}

/**
 * The repository state a record is keyed on, read from the repository.
 * @param root - the repository root.
 * @returns HEAD's tree and commit, the range base's commit, and whether the working tree equals HEAD.
 */
export function treeState(root: string): TreeState {
  const base = runGit(root, ['rev-parse', '--verify', '-q', `${RANGE_BASE}^{commit}`])
  return {
    tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    head: git(root, ['rev-parse', 'HEAD^{commit}']).trim(),
    rangeBase: base.status === 0 ? base.stdout.trim() : null,
    clean: git(root, ['status', '--porcelain', '-z', '--untracked-files=all']) === '',
  }
}

/**
 * The directory of tree records for a clone: `delo-checks/trees` under the git common directory, which every worktree of
 * the clone shares.
 * @param root - the repository root of any worktree of the clone.
 * @returns the directory, which may not exist yet.
 */
export function treeRecordsDir(root: string): string {
  return join(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim(), 'delo-checks', 'trees')
}

/**
 * The file a tree's record is stored in: the tree id and the Node major of the run, so a pass recorded under one major
 * is never read under another.
 * @param dir - the directory of tree records.
 * @param tree - the tree's id.
 * @param node - the Node version, `process.version`, such as `v24.9.0`.
 * @returns the file path.
 */
export function treePassPath(dir: string, tree: string, node: string): string {
  const major = node.replace(/^v/, '').split('.')[0] ?? ''
  return join(dir, `${tree}-node${major}.json`)
}

/**
 * The tree a revision names, for a record's base.
 * @param root - the repository root.
 * @param ref - a commit id, a branch, or another revision.
 * @returns the tree id, or null when the revision names no commit.
 */
export function treeOfRef(root: string, ref: string): string | null {
  const run = runGit(root, ['rev-parse', '--verify', '-q', `${ref}^{tree}`])
  return run.status === 0 ? run.stdout.trim() : null
}

/**
 * The record stored for a tree under a Node major. A file that cannot be read or parsed is treated as absent, so its checks
 * run again.
 * @param dir - the directory of tree records.
 * @param tree - the tree's id.
 * @param node - the Node version of the run, `process.version`.
 * @returns the record, or undefined when there is none.
 */
export function readTreePass(dir: string, tree: string, node: string): TreePass | undefined {
  try {
    const parsed = TreePassFile.safeParse(JSON.parse(readFileSync(treePassPath(dir, tree, node), 'utf8')))
    return parsed.success && parsed.data.tree === tree ? parsed.data : undefined
  } catch (error) {
    // A missing file, or one that is not JSON: no record covers the tree.
    void error
    return undefined
  }
}

/**
 * The record that covers a run of the planned checks on HEAD's tree. A dirty working tree and an empty plan never hit. A
 * miss carries a reason only when a record exists for the tree, so the caller can say why the checks run again.
 * @param dir - the directory of tree records.
 * @param state - the repository state, from {@link treeState}.
 * @param plan - the checks the run would start.
 * @param facts - the facts the record must still match.
 * @returns the covering record on a hit, otherwise the miss.
 */
export function findTreePass(dir: string, state: TreeState, plan: readonly Check[], facts: RunFacts): TreePassLookup {
  if (!state.clean || plan.length === 0) return { hit: false }
  const record = readTreePass(dir, state.tree, facts.node)
  if (record === undefined) return { hit: false }
  const reason = uncovered(record, state, plan, facts)
  return reason === undefined ? { hit: true, record } : { hit: false, reason }
}

/**
 * Why a record does not cover a plan.
 * @param record - the record for the tree.
 * @param state - the repository state.
 * @param plan - the checks the run would start.
 * @param facts - the facts the record must still match.
 * @returns the first mismatch, or undefined when the record covers the plan.
 */
function uncovered(record: TreePass, state: TreeState, plan: readonly Check[], facts: RunFacts): string | undefined {
  if (TIER_RANK[record.tier] < TIER_RANK[facts.tier]) return `the record passed the ${record.tier} tier and this run needs the ${facts.tier} tier`
  if (record.lockfile !== facts.lockfile) return 'the lockfile changed'
  if (record.node !== facts.node) return 'the Node version changed'
  for (const name of envNames(plan)) {
    if (record.env[name] === undefined) return `the record does not name ${name}`
    if (record.env[name] !== (facts.env[name] ?? null)) return `${name} changed`
  }
  for (const check of plan) {
    if (check.declined !== undefined) return `${check.id} is declined on this host`
    if (!record.checks.includes(check.id)) return `the record has no ${check.id}`
    if (!scopeCovers(record.scopes[check.id], check.scope)) return `the record does not cover the scope of ${check.id}`
    if (check.history === true && !sameHistory(record, state)) return `${check.id} reads commits, and HEAD or ${RANGE_BASE} differs from the record`
  }
  return record.pnpm === facts.pnpm() ? undefined : 'the pnpm version changed'
}

/**
 * Whether the record was made at the HEAD commit and range base the state names, which the history-reading checks depend on.
 * @param record - the record.
 * @param state - the repository state.
 * @returns true when both match and the clone has the range base.
 */
function sameHistory(record: TreePass, state: TreeState): boolean {
  return state.rangeBase !== null && record.head === state.head && record.rangeBase === state.rangeBase
}

/**
 * Whether a recorded scope covers a planned one. A recorded whole command covers any scope, and a recorded directory covers
 * the paths beneath it, as the fork suite's path filters match them.
 * @param recorded - the scope the record ran, or undefined for the whole command.
 * @param wanted - the planned scope, or undefined for the whole command.
 * @returns true when every path the planned run names is one the record ran.
 */
function scopeCovers(recorded: readonly string[] | undefined, wanted: readonly string[] | undefined): boolean {
  if (recorded === undefined) return true
  if (wanted === undefined) return false
  return wanted.every(path => recorded.some(entry => path === entry || (entry.endsWith('/') && path.startsWith(entry))))
}

/**
 * The environment variables the planned checks read, sorted.
 * @param plan - the checks.
 * @returns the names.
 */
function envNames(plan: readonly Check[]): string[] {
  return [...new Set(plan.flatMap(check => check.env ?? []))].sort()
}

/**
 * Store the pass of a run that started from a clean tree and passed every planned check, when HEAD, the range base and
 * the working tree did not change while it ran.
 * @param dir - the directory of tree records.
 * @param run - the run: the states before and after it, the range base's tree, the plan and each check's result.
 * @param facts - the lockfile, Node and pnpm versions and the environment the run used.
 * @param now - the time the pass is recorded at.
 * @returns the record that was stored, or the reason none was.
 */
export function recordTreePass(dir: string, run: TreePassRun, facts: RunFacts, now: Date): TreePassWrite {
  const { before, after, plan, results } = run
  if (!before.clean) return { recorded: false, reason: 'the working tree differed from HEAD before the run' }
  if (before.tree !== after.tree || before.head !== after.head || before.rangeBase !== after.rangeBase || !after.clean) {
    return { recorded: false, reason: 'HEAD, the range base or the working tree changed during the run' }
  }
  if (plan.length === 0 || results.length !== plan.length || results.some(result => result.outcome !== 'passed')) {
    return { recorded: false, reason: 'not every planned check passed' }
  }
  const scopes: Record<string, string[]> = {}
  for (const check of plan) if (check.scope !== undefined) scopes[check.id] = [...check.scope]
  const env: Record<string, string | null> = {}
  for (const name of envNames(plan)) env[name] = facts.env[name] ?? null
  const record: TreePass = {
    tree: before.tree,
    base: run.base,
    head: before.head,
    rangeBase: before.rangeBase,
    passedAt: now.toISOString(),
    tier: facts.tier,
    checks: plan.map(check => check.id).sort(),
    scopes,
    lockfile: facts.lockfile,
    node: facts.node,
    pnpm: facts.pnpm(),
    env,
  }
  writeTreePass(dir, record)
  return { recorded: true, record }
}

/**
 * Write a record through a temporary file in the same directory, renamed into place, so an interrupted write and a write
 * from another worktree that finishes at the same time each leave a whole record.
 * @param dir - the directory of tree records.
 * @param record - the record.
 */
function writeTreePass(dir: string, record: TreePass): void {
  mkdirSync(dir, { recursive: true })
  const path = treePassPath(dir, record.tree, record.node)
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(temporary, path)
}
