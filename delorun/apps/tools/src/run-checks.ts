/**
 * The fork's local checks: the commit gate, the push gate, the working-tree
 * check and the full gate. GitHub Actions does not run on this repository, so
 * this is the check a change gets. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delorun/apps/tools/src/run-checks.ts [paths...] [options]
 * ```
 *
 * A change run has a gate tier. The agent tier, the default of `--changed`, leaves out the merge-only checks
 * (`Check.mergeOnly`: the recorded-session replays, the web lane, the Docker lane and the merge-tier gates); the merge tier
 * runs them too, and only its pass lets a commit reach the trunk; the lane tier, a branch push's default, runs the
 * mechanical rules, the changed packages' typecheck and their own specs (`laneKeeps` in `checks/plan.ts`).
 * `--tier lane|agent|merge` chooses it. A push
 * takes the merge tier when a pushed ref is `refs/heads/main` whatever else is set, or when `DELORUN_TIER=merge` is set, and
 * the agent tier with `DELORUN_TIER=agent`. `--preflight` is the lane tier without the test lanes.
 *
 * Heavy runs share the machine's CPU slots, memory and disk-heavy places, first come, first served (`checks/slots.ts`);
 * a push to the trunk or `DELORUN_GATE_PRIORITY=trunk` goes ahead of waiting runs, and a light plan takes no slots.
 * `--queue` prints the machine hold, if any, the holders and the waiting runs. `--hold "<reason>" [--allow <worktree>]...` makes
 * the queue refuse every new run, except those started inside an allowed worktree, until `--unhold`; runs already holding
 * slots are not interrupted, and runs of old worktrees do not read the hold.
 *
 * The invocations, which `lefthook.yml` and `pnpm check` use:
 *
 * - `--pre-commit` runs the repository gates marked `staged` over the staged
 *   paths, and `git diff --cached --check`, within a budget of five seconds
 *   (`budgets.json`).
 * - `--pre-push` runs what changed since the older of the remote branch's tip and
 *   its merge base with `origin/main` (or, for a new branch without `origin/main`, its
 *   merge base with `main`); the full gate when a pushed ref is
 *   not `HEAD` or `DELORUN_FULL_GATE=1` is set.
 * - `--changed` (`pnpm check`, and `pnpm check:merge` with `--tier merge`) runs what changed since `--base` (default `main`).
 * - No argument runs the full gate (`pnpm check:full` adds `--no-cache`).
 *
 * Paths narrow a run to the checks of the packages they lie in and of the
 * packages that depend on them. `--list` prints the catalogue, `--plan` the
 * selection with each check's reason, cache state, expected duration and
 * budget, without running anything. `--only` and `--skip` take check ids or
 * groups, comma-separated.
 *
 * The run happens in a systemd user scope with a memory ceiling and no swap, with
 * temporary files under the system's temporary directory, and with the Linux side
 * of WSL only (`checks/machine.ts`). Logs, the report and each check's last
 * duration go under `node_modules/.cache/delorun-checks/`; a check that declares its
 * inputs and passed under the same key is served from the pass cache
 * (`checks/cache.ts`), from this worktree's passes or from the machine-wide store
 * under the user's cache directory (`checks/shared-cache.ts`) for the checks
 * `checks/sharing.ts` shares; `--no-shared-cache` keeps a run to its worktree. A run of a tree that a record covers reports the record and starts nothing, and a passing
 * pre-push or change run of a clean tree records its pass (`checks/tree-pass.ts`) in the git common directory, shared by
 * every worktree of the clone.
 *
 * @module @delorun/tools/run-checks
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { cacheUse, contentId, createPassCache, type PassCache, type SharedUse } from './checks/cache.ts'
import { FUNDAMENTALS_INPUTS, gatesFor, rangeBase, rangeBaseOverridden, unresolvedRangeBase } from './checks/gates/index.ts'
import { canScope, cgroupBudget, checkEnvironment, ioPressure, memoryReport, readPressure, removeScratch, pnpmExecAnswer, runMemoryBytes, scopeCommand, scratchDir, scratchPlace, statfsOf, workerCounts } from './checks/machine.ts'
import { catalog, criticalPath, declineClosureOffHost, declineUnansweredDocker, declineWebsiteWithoutPictures, dependentsLeftForMerge, leftForMerge, readsPnpmScriptEnvironment, select, selectPreCommit, staleDelorunBuilds, websitePicturesProblem, type Budgets, type Check, type GateTier, type Planned, type UpstreamPackage, unknownSelectors } from './checks/plan.ts'
import { checksToRun, fitToGrant, runDemand, withoutIdleNeeds } from './checks/demand.ts'
import { isLightPlan, gatePriority } from './checks/run-queue.ts'
import { budgetWarning, DISK_RUNS_ENV, diskRotational, machineBudget, MEMORY_ENV, nodeSlotHost, privateSlotPaths, SLOTS_ENV } from './checks/slot-host.ts'
import { describeSlots, GRANT_ENV, grantFromEnv, grantToEnv, holdMachine, readSlots, takeSlots, unholdMachine, type BudgetOrigin, type SlotGrant } from './checks/slots.ts'
import { closureHostProblem } from './checks/closure.ts'
import { gateFailure, logTail, probeDocker, runPlan, type Outcome, type Result } from './checks/run.ts'
import { sharedCheckoutNote, sharedCheckoutRefusal } from './checks/shared-checkout.ts'
import { findTreePass, recordTreePass, treeOfRef, treePassEnabled, treePassPath, treeRecordsDir, treeState, type RunFacts, type TreeState } from './checks/tree-pass.ts'
import { openSharedStore, sharedCacheDir } from './checks/shared-cache.ts'
import { declarationReaders, securityPackageDirs, sharingPolicy } from './checks/sharing.ts'
import { isForkSuite, suiteUnits, type WithUnits } from './checks/units.ts'
import { excerpt } from './checks/failure.ts'
import { readTree } from './checks/tree.ts'
import { nodeWarning, pinnedNodeMajor } from './setup-worktree.ts'
import { git, repositoryRoot, runGit } from './git.ts'

/** Where the runner keeps its state, relative to the repository root. */
const CACHE_DIR = 'node_modules/.cache/delorun-checks'
/** The environment variable a systemd-scoped run sets for the process it re-executes, so that process does not scope again. */
const IN_SCOPE = 'DELORUN_CHECKS_SCOPE'
const GIB = 1024 ** 3
/** The ref a change is measured from when no `--base` names one: the integration branch. */
const DEFAULT_BASE = 'main'
/** The remote ref of the trunk, `DEFAULT_BASE`: a push of it needs the merge tier. */
export const TRUNK_REF = `refs/heads/${DEFAULT_BASE}`
const REPORT = `${CACHE_DIR}/report.json`
/** Where each check's last duration is kept, for the order of the next run. */
const DURATIONS = `${CACHE_DIR}/durations.json`

/** The shape of `checks/budgets.json`. */
const BudgetsFile = z.strictObject({
  $comment: z.string().optional(),
  tiers: z.record(z.string(), z.strictObject({ seconds: z.number().positive() })),
  checks: z.record(z.string(), z.strictObject({ memoryGiB: z.number().positive(), perWorker: z.boolean().optional(), exclusive: z.boolean().optional(), seconds: z.number().positive().optional() })),
})

const durationsSchema = z.record(z.string(), z.number())

function lines(text: string): string[] {
  return text.split('\n').filter(line => line.length > 0)
}

function list(values: readonly string[] | undefined): string[] {
  return (values ?? []).flatMap(value => value.split(',')).map(value => value.trim()).filter(value => value.length > 0)
}

const SPEC = /\.(?:spec|test)\.[cm]?[jt]sx?$/

/**
 * The directories under `delorun/apps` and `delorun/packages` whose `tests/` holds a spec file, which the fork suite's units cover.
 * @param root - the repository root.
 * @returns the repository-relative directories, sorted.
 */
function forkSpecDirs(root: string): string[] {
  return ['delorun/apps', 'delorun/packages'].flatMap((parent) => {
    if (!existsSync(join(root, parent))) return []
    return readdirSync(join(root, parent)).sort().map(name => `${parent}/${name}`).filter((dir) => {
      const tests = join(root, dir, 'tests')
      return existsSync(tests) && readdirSync(tests, { recursive: true, encoding: 'utf8' }).some(entry => SPEC.test(entry) && !entry.includes('node_modules'))
    })
  })
}

/**
 * The newest file's modification time under a directory.
 * @param dir - the directory.
 * @param withoutTypes - whether to leave out `types/`, which the typecheck writes without building anything that runs.
 * @returns the time in milliseconds, or 0 when the directory holds no file or does not exist.
 */
function newestFile(dir: string, withoutTypes: boolean): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    if (withoutTypes && relative(dir, path).startsWith(`types${sep}`)) continue
    newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

/**
 * Upstream packages whose runtime bundles are missing or older than their
 * sources, so a lane that runs upstream's built code would fail on the build
 * rather than on the change. A checkout that never ran `build:artifacts` has
 * no `apps/cli/lib/bin.js`; a package whose build emits only declarations is
 * not part of the runtime build.
 * @param root - the repository root.
 * @param upstream - upstream's packages.
 * @returns their directories, empty when the build is current.
 */
function staleRuntime(root: string, upstream: readonly UpstreamPackage[]): string[] {
  if (!existsSync(join(root, 'apps', 'cli', 'lib', 'bin.js'))) return ['apps/cli has never been built']
  return upstream.filter(pkg => {
    if (!existsSync(join(root, pkg.dir, 'src'))) return false
    const built = newestFile(join(root, pkg.dir, 'lib'), true)
    return built > 0 && newestFile(join(root, pkg.dir, 'src'), false) > built
  }).map(pkg => `${pkg.dir} is older than its sources`)
}

/**
 * The environment `pnpm run` gives a script: the repository's pinned pnpm
 * first on `PATH` and as `npm_execpath`, and no dependency install before
 * nested scripts. Tests that start pnpm in fixtures rely on it, as they do in
 * upstream's CI, where every suite runs through `pnpm run`.
 * @param root - the repository root.
 * @param path - the `PATH` to extend.
 * @returns the variables to add.
 */
function pnpmScriptEnvironment(root: string, path: string): Record<string, string> {
  const answer = execFileSync('pnpm', ['exec', 'node', '-e', 'process.stdout.write(JSON.stringify([process.env.npm_execpath ?? "", process.env.pnpm_config_verify_deps_before_run ?? "false"]))'], { cwd: root, encoding: 'utf8' })
  const { execpath, verify } = pnpmExecAnswer(answer)
  return { npm_execpath: execpath, pnpm_config_verify_deps_before_run: verify, PATH: `${dirname(execpath)}:${path}` }
}

/**
 * The pnpm version the repository's pinned pnpm reports, which a pass key records.
 * @param root - the repository root.
 * @returns the version.
 */
function pnpmVersionOf(root: string): string {
  return execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim().split('\n').at(-1) ?? ''
}

const ZERO = /^0+$/

/**
 * The commit a push's checks start from, from the lines git's pre-push hook reads (`<local ref> <local sha> <remote ref> <remote sha>`).
 * A push of `main` starts from the remote `main` tip. A push of any other branch starts from the older of its remote tip and its
 * merge base with `origin/main`, so the record it leaves covers the later fast-forward of `main` to the same tree.
 * @param root - the repository root.
 * @param input - the hook's standard input.
 * @param base - the integration branch a new branch is measured from when `origin/main` is absent.
 * @param fullGate - whether the environment asks for the full gate.
 * @returns the start commit; undefined for the full gate.
 */
export function prePushBase(root: string, input: string, base: string, fullGate: boolean): string | undefined {
  if (fullGate) return undefined
  const head = git(root, ['rev-parse', 'HEAD']).trim()
  const pushes = lines(input).map(line => line.split(' ')).filter(fields => fields.length === 4 && !ZERO.test(fields[1] ?? ''))
  if (pushes.length !== 1 || pushes[0]?.[1] !== head) return undefined
  const [, , remoteRef = '', remote = ''] = pushes[0]
  // A remote tip this clone lacks, such as one pushed from elsewhere, cannot be diffed against.
  const tip = ZERO.test(remote) || !commitExists(root, remote) ? undefined : remote
  const trunkBase = remoteRef === TRUNK_REF ? undefined : mergeBase(root, 'origin/main')
  if (trunkBase === undefined) return tip ?? (ZERO.test(remote) ? mergeBase(root, base) : undefined)
  // The older of the two starts the wider range, which the later fast-forward of main needs.
  if (tip !== undefined && runGit(root, ['merge-base', '--is-ancestor', tip, trunkBase]).status === 0) return tip
  return trunkBase
}

/**
 * The tier a push needs: the merge tier when any pushed ref is the trunk or `DELORUN_TIER=merge` is set, whatever else is set;
 * the agent tier when `DELORUN_TIER=agent` is set; otherwise the lane tier.
 * @param input - the hook's standard input, `<local ref> <local sha> <remote ref> <remote sha>` per line.
 * @param env - the environment the run starts with.
 * @returns the tier.
 */
export function pushTier(input: string, env: NodeJS.ProcessEnv): GateTier {
  if (env['DELORUN_TIER'] === 'merge' || pushesTrunk(input)) return 'merge'
  return env['DELORUN_TIER'] === 'agent' ? 'agent' : 'lane'
}

/**
 * The gate tier of a change run: the merge tier for a push of the trunk whatever `--tier` or `DELORUN_TIER` says, then the
 * `--tier` option, then the push's tier ({@link pushTier}), and the agent tier for a run that is not a push.
 * @param option - the `--tier` value, already validated.
 * @param pushInput - the pre-push hook's standard input, or undefined when the run is not a push.
 * @param env - the environment the run starts with.
 * @returns the tier.
 */
export function changeTier(option: string | undefined, pushInput: string | undefined, env: NodeJS.ProcessEnv): GateTier {
  if (pushInput !== undefined && pushesTrunk(pushInput)) return 'merge'
  if (option === 'lane' || option === 'agent' || option === 'merge') return option
  return pushInput === undefined ? 'agent' : pushTier(pushInput, env)
}

/**
 * Refuse a push of the trunk that leaves checks out: `--skip` (which the pre-push hook fills from `DELORUN_PUSH_SKIP`) or
 * `--only` would let a commit reach the trunk without a check of the merge tier, a security-class one among them.
 * @param pushInput - the pre-push hook's standard input, or undefined when the run is not a push.
 * @param skip - the `--skip` names.
 * @param only - the `--only` names.
 * @throws Error when a pushed ref updates the trunk and either list is not empty.
 */
export function refuseTrunkNarrowing(pushInput: string | undefined, skip: readonly string[], only: readonly string[]): void {
  if (pushInput === undefined || !pushesTrunk(pushInput)) return
  if (skip.length > 0) throw new Error(`a push of the trunk runs every check of the merge tier; unset DELORUN_PUSH_SKIP and drop --skip (${skip.join(', ')})`)
  if (only.length > 0) throw new Error(`a push of the trunk runs every check of the merge tier; drop --only (${only.join(', ')})`)
}

/**
 * Refuse a push from a linked worktree while the clone's shared checkout holds changes to tracked content. The refusal
 * sits before the plan, so no gate can be skipped with `DELORUN_PUSH_SKIP` and no stored tree pass can cover it, and the
 * shared tree is what every worktree of the clone reads.
 * @param root - the repository root of the worktree the push happens in.
 * @param warn - told about untracked files in the shared checkout, which do not refuse the push.
 * @throws Error naming the shared checkout and its changed paths.
 */
export function refuseSharedCheckout(root: string, warn: (line: string) => void = line => { console.warn(line) }): void {
  const refusal = sharedCheckoutRefusal(root)
  if (refusal !== undefined) throw new Error(refusal)
  const note = sharedCheckoutNote(root)
  if (note !== undefined) warn(`delorun checks: ${note}`)
}

/**
 * Whether a push updates the trunk.
 * @param input - the lines git's pre-push hook reads.
 * @returns true when a pushed ref is the trunk and is not being deleted.
 */
export function pushesTrunk(input: string): boolean {
  return lines(input).some(line => line.split(' ')[2] === TRUNK_REF && !ZERO.test(line.split(' ')[1] ?? ''))
}

/**
 * Whether a revision names a commit this clone has.
 * @param root - the repository root.
 * @param ref - the revision.
 * @returns true when `ref^{commit}` resolves.
 */
function commitExists(root: string, ref: string): boolean {
  return runGit(root, ['cat-file', '-e', `${ref}^{commit}`]).status === 0
}

/**
 * The merge base of a ref and HEAD.
 * @param root - the repository root.
 * @param ref - the ref to merge with HEAD.
 * @returns the merge base, or undefined when the ref does not exist or shares no history with HEAD.
 */
function mergeBase(root: string, ref: string): string | undefined {
  const run = runGit(root, ['merge-base', ref, 'HEAD'])
  return run.status === 0 ? run.stdout.trim() : undefined
}

/**
 * Every path that differs from the merge base with `base`, committed or not, and every untracked path.
 * @param root - the repository root.
 * @param base - the ref to measure from.
 * @returns the sorted paths.
 */
function changedPaths(root: string, base: string): string[] {
  const mergeBase = git(root, ['merge-base', base, 'HEAD']).trim()
  return [...new Set([...lines(git(root, ['diff', '--name-only', mergeBase])), ...lines(git(root, ['ls-files', '--others', '--exclude-standard']))])].sort()
}

/**
 * The paths a commit would add, copy, modify or rename: what the pre-commit tier checks.
 * @param root - the repository root.
 * @returns the staged paths, repository-relative.
 */
function stagedPaths(root: string): string[] {
  return git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(path => path.length > 0)
}

/**
 * The last recorded durations by check id; without them every check counts one second.
 * @param root - the repository root.
 * @returns the durations in seconds.
 */
function readDurations(root: string): Record<string, number> {
  let text: string
  try {
    text = readFileSync(join(root, DURATIONS), 'utf8')
  } catch (error) {
    // ENOENT: no run has finished on this checkout yet.
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {}
    throw error
  }
  try {
    return durationsSchema.parse(JSON.parse(text))
  } catch (error) {
    // The record only orders the run, so a hand-edited or foreign file is ignored and rewritten at the end.
    if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error
    console.warn(`delorun checks: ignoring ${DURATIONS}, which is not a map of durations`)
    return {}
  }
}

/**
 * Record the passed checks' durations, through a temporary file so an interrupted write leaves the old record. A
 * check served from the pass cache did not run, so its zero is not recorded.
 * @param root - the repository root.
 * @param previous - the durations before the run.
 * @param results - the run's results.
 */
function writeDurations(root: string, previous: Record<string, number>, results: readonly Result[]): void {
  const durations = { ...previous }
  for (const result of results) if (result.outcome === 'passed' && result.cached !== true) durations[result.id] = Math.round(result.seconds * 10) / 10
  const path = join(root, DURATIONS)
  writeFileSync(`${path}.tmp`, `${JSON.stringify(durations, null, 2)}\n`)
  renameSync(`${path}.tmp`, path)
}

/**
 * A duration as the run prints it.
 * @param seconds - the duration.
 * @returns such as `12.3s` or `2m05s`.
 */
function formatSeconds(seconds: number): string {
  return seconds >= 60 ? `${String(Math.floor(seconds / 60))}m${String(Math.round(seconds % 60)).padStart(2, '0')}s` : `${seconds.toFixed(1)}s`
}

const MARK: Record<Outcome, string> = { passed: '✓', failed: '✗', declined: '○', skipped: '–' }

/**
 * Whether a check's result is served from the pass cache, so the run's output names the pass rather than a duration.
 * @param check - the check.
 * @param cache - the cache, or undefined when the run has none.
 * @returns the cache state, for `--plan`.
 */
function cacheState(check: WithUnits<Check>, cache: PassCache | undefined): string {
  if (cache === undefined) return 'off (--no-cache, CI, or a full pre-push gate)'
  const key = cache.keyOf(check)
  if (key === undefined) return 'always runs (no declared inputs)'
  if (check.units !== undefined) {
    const sources = check.units.map(unit => cache.lookupUnit(check, unit, cache.unitKey(check, unit)))
    const run = check.units.filter((_unit, index) => sources[index] === undefined).map(unit => unit.dir)
    return `per package: ${String(sources.filter(source => source === 'local').length)} in this worktree, ${String(sources.filter(source => source === 'shared').length)} shared, ${String(run.length)} to run${run.length === 0 ? '' : ` (${run.join(', ')})`}`
  }
  const source = cache.lookup(check, key)
  const unshared = cache.unshared(check)
  const sharing = unshared === undefined ? 'shared across worktrees' : `not shared: ${unshared}`
  return source === undefined ? `runs (no stored pass for its key; ${sharing})` : `cached pass (${source}, ${key.slice(0, 12)}; ${sharing})`
}

/**
 * Where the machine's budget came from, for `--queue` to show the derivation rather than a bare number.
 * @param machine - the machine's CPUs and memory, before the headroom.
 * @param memory - the memory the runs may hold together, from `runMemoryBytes`.
 * @param cpus - the CPUs this process may use.
 * @param env - the environment, for the variables that override a measured figure.
 * @returns the origin.
 */
function budgetOrigin(machine: { readonly cpus: number, readonly memoryBytes: number }, memory: number, cpus: number, env: NodeJS.ProcessEnv): BudgetOrigin {
  const overrides = [SLOTS_ENV, MEMORY_ENV, DISK_RUNS_ENV].flatMap((name) => {
    const value = env[name]
    return value === undefined || value === '' ? [] : [`${name}=${value}`]
  })
  const rotational = diskRotational(tmpdir())
  const warning = budgetWarning(machineBudget(cpus, memory, env, rotational), cpus)
  return { machineBytes: machine.memoryBytes, headroomBytes: machine.memoryBytes - memory, cpus, overrides, ...rotational === undefined ? {} : { rotational }, ...warning === undefined ? {} : { warning } }
}

/**
 * The budget a check's line names: its memory, its CPUs and whether it runs alone.
 * @param check - the check.
 * @returns such as `0.3 GiB, 1 CPU`.
 */
function budgetText(check: Check): string {
  return `${(check.memoryBytes / GIB).toFixed(1)} GiB, ${String(check.cpus)} CPU${check.cpus === 1 ? '' : 's'}${check.exclusive === true ? ', alone' : ''}`
}

/**
 * The run's command, or why it does not run.
 * @param check - the check.
 * @returns the command line, or the reason it is declined.
 */
function commandText(check: Check): string {
  return check.declined !== undefined ? `declined: ${check.declined}` : `runs: ${check.command.join(' ')}${check.bounded === undefined ? '' : ` (${check.bounded})`}`
}

/**
 * The run's results for tools and agents: one entry per check with its status, reason, log, duration and peak memory.
 * @param root - the repository root.
 * @param results - the run's results.
 */
function writeReport(root: string, results: readonly Result[], sharedDir: string | undefined, machine: Readonly<Record<string, number | null>>): void {
  const memory = memoryReport()
  const report = {
    ...machine,
    peakBytes: memory?.peakBytes ?? null,
    oomKills: memory?.oomKills ?? null,
    passCache: { ...cacheCounts(results), sharedDir: sharedDir ?? null },
    checks: results.map(result => ({
      check: result.id, status: result.outcome, cached: result.cached === true, cacheSource: result.cacheSource ?? null, units: result.units ?? null, firstFailure: result.outcome === 'failed' && result.log !== undefined ? excerpt(logTail(result.log, 2000)) : null, reason: result.detail ?? null, logPath: result.log === undefined ? null : relative(root, result.log),
      durationSeconds: Math.round(result.seconds * 10) / 10, peakBytes: result.peakBytes ?? null, oomKilled: result.oomKilled === true,
    })),
  }
  writeFileSync(join(root, REPORT), `${JSON.stringify(report, null, 2)}\n`)
}

/**
 * How the run's checks were served: from this worktree's passes, from the machine-wide store, or run.
 * @param results - the run's results.
 * @returns the counts.
 */
export function cacheCounts(results: readonly Result[]): { readonly local: number, readonly shared: number, readonly ran: number, readonly packages: { readonly local: number, readonly shared: number, readonly ran: number } } {
  const sum = (field: 'local' | 'shared' | 'ran'): number => results.reduce((total, result) => total + (result.units?.[field] ?? 0), 0)
  return {
    local: results.filter(result => result.cacheSource === 'local').length,
    shared: results.filter(result => result.cacheSource === 'shared').length,
    ran: results.filter(result => result.cached !== true && (result.outcome === 'passed' || result.outcome === 'failed')).length,
    packages: { local: sum('local'), shared: sum('shared'), ran: sum('ran') },
  }
}

/**
 * Print each failure's log tail and the run's summary.
 * @param results - the run's results.
 * @param milliseconds - the run's wall time.
 * @param root - the repository root, for the paths printed.
 * @param tier - the run's gate tier, which decides whether a declined merge-only check fails it.
 * @param bounded - one line per check that ran a bounded selection, naming what it left out.
 * @returns 0 when no check failed, otherwise 1.
 */
function summarize(results: readonly Result[], milliseconds: number, root: string, tier: GateTier | undefined, bounded: readonly string[]): number {
  const failures = results.filter(result => gateFailure(result, tier))
  const declined = results.filter(result => result.outcome === 'declined' && !failures.includes(result))
  for (const failure of failures) {
    console.log(`\n── ${failure.id}: ${failure.outcome === 'declined' ? 'declined, which fails the merge tier: ' : ''}${failure.detail ?? failure.outcome}${failure.log === undefined ? '' : ` (full log: ${relative(root, failure.log)})`}`)
    if (failure.log !== undefined) console.log(logTail(failure.log, 60))
  }
  // The first failure of each failed check again, last, where a reader of the summary sees it without the log.
  for (const failure of failures) {
    const first = failure.log === undefined ? [] : excerpt(logTail(failure.log, 2000))
    if (first.length > 0) console.log(`\n── first failure of ${failure.id}:\n${first.map(line => `   ${line}`).join('\n')}`)
  }
  const memory = memoryReport()
  const count = (predicate: (result: Result) => boolean): number => results.filter(predicate).length
  const passed = count(result => result.outcome === 'passed' && result.cached !== true)
  const cached = count(result => result.cached === true)
  const sources = cacheCounts(results)
  const skipped = count(result => result.outcome === 'skipped')
  const peak = memory?.peakBytes === undefined ? '' : `, peak memory ${(memory.peakBytes / GIB).toFixed(1)} GiB`
  const oom = memory !== undefined && memory.oomKills > 0 ? `, ${String(memory.oomKills)} process(es) stopped at the memory ceiling` : ''
  for (const each of declined) console.log(`\n── ${each.id} declined: ${each.detail ?? 'this host cannot run it'}`)
  for (const line of bounded) console.log(`\n── ${line}`)
  const named = failures.length === 0 ? '' : ` (${failures.map(failure => failure.id).join(', ')})`
  console.log(`\ndelorun checks: ${String(passed)} passed, ${String(cached)} cached (${String(sources.local)} in this worktree, ${String(sources.shared)} shared), ${String(failures.length)} failed${named}, ${String(declined.length)} declined, ${String(skipped)} skipped in ${formatSeconds(milliseconds / 1000)}${peak}${oom}; report: ${REPORT}`)
  return failures.length === 0 ? 0 : 1
}

/**
 * The directory a command line's paths are relative to. Under `pnpm run`, which runs a script in its package, it is
 * `INIT_CWD`, where pnpm was invoked; a run started by any other means resolves its paths against its own directory, so an
 * `INIT_CWD` an agent's shell kept from an earlier pnpm script does not move them.
 * @param env - the environment the run starts with.
 * @param cwd - the run's working directory.
 * @returns the directory.
 */
export function invocationDir(env: NodeJS.ProcessEnv, cwd: string): string {
  return env['npm_lifecycle_event'] !== undefined && env['INIT_CWD'] !== undefined ? env['INIT_CWD'] : cwd
}

/**
 * The arguments without the first `--`. pnpm forwards the separator it reads before a script's own arguments, so
 * `pnpm check -- --plan` reaches the runner as `--changed -- --plan`, where `util.parseArgs` reads `--plan` as a path.
 * @param argv - the arguments.
 * @returns the arguments with that separator removed.
 */
export function withoutSeparator(argv: readonly string[]): string[] {
  const at = argv.indexOf('--')
  return at < 0 ? [...argv] : [...argv.slice(0, at), ...argv.slice(at + 1)]
}

/**
 * Run the checks the command line selects, or print them with `--list` or `--plan`.
 * @param argv - the command line's arguments, without the script.
 * @param env - the environment the run starts with.
 * @returns the exit status: 0 when no check failed.
 * @throws Error on a malformed option, such as `--workers` with no positive count.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const { values, positionals } = parseArgs({
    args: withoutSeparator(argv),
    allowPositionals: true,
    options: {
      'changed': { type: 'boolean', default: false },
      'pre-commit': { type: 'boolean', default: false },
      'pre-push': { type: 'boolean', default: false },
      'base': { type: 'string' },
      'only': { type: 'string', multiple: true },
      'skip': { type: 'string', multiple: true },
      'list': { type: 'boolean', default: false },
      'plan': { type: 'boolean', default: false },
      'bail': { type: 'boolean', default: false },
      'workers': { type: 'string' },
      'no-scope': { type: 'boolean', default: false },
      'no-cache': { type: 'boolean', default: false },
      'no-shared-cache': { type: 'boolean', default: false },
      'tier': { type: 'string' },
      'preflight': { type: 'boolean', default: false },
      'queue': { type: 'boolean', default: false },
      'hold': { type: 'string' },
      'allow': { type: 'string', multiple: true },
      'unhold': { type: 'boolean', default: false },
    },
  })
  // The machine hold only edits the queue's hold file; it needs neither the repository nor the pinned Node.
  if (values.hold !== undefined || values.unhold || values.allow !== undefined) {
    if (values.hold !== undefined && values.unhold) throw new Error('--hold and --unhold are separate commands; give one')
    if (values.hold === undefined && !values.unhold) throw new Error('--allow names a worktree the hold exempts; give it with --hold "<reason>"')
    if (values.unhold && values.allow !== undefined) throw new Error('--unhold takes no --allow')
    if (values.hold?.trim() === '') throw new Error('--hold takes a reason: --hold "<reason>"')
    const host = nodeSlotHost(text => process.stderr.write(text))
    const paths = privateSlotPaths(tmpdir(), process.getuid?.() ?? -1)
    for (const line of values.hold === undefined ? unholdMachine(host, paths) : holdMachine(host, paths, values.hold, (values.allow ?? []).map(root => existsSync(root) ? realpathSync(root) : resolve(root)))) console.log(line)
    return 0
  }
  // The pre-flight is the lane tier of a change run without its test lanes, and it waits in no queue.
  const preflight = values.preflight
  if (preflight && (values['pre-commit'] || values['pre-push'] || values.changed || values.tier !== undefined)) throw new Error('--preflight is a change run of its own; give it without --pre-commit, --pre-push, --changed or --tier')
  if (preflight) {
    values.changed = true
    values.tier = 'lane'
    values.skip = [...values.skip ?? [], 'tests']
  }
  const tiers = [values['pre-commit'], values['pre-push'], values.changed].filter(flag => flag).length
  if (tiers > 1) throw new Error('--pre-commit, --pre-push and --changed each select a tier; give one of them')
  if (values.tier !== undefined && values.tier !== 'lane' && values.tier !== 'agent' && values.tier !== 'merge') throw new Error(`--tier takes lane, agent or merge, got ${values.tier}`)
  if (values.tier !== undefined && (values['pre-commit'] || !(values['pre-push'] || values.changed || values.base !== undefined || positionals.length > 0))) {
    throw new Error('--tier applies to --changed, --base, explicit paths and --pre-push; it does not apply to --pre-commit or the full gate')
  }
  const root = repositoryRoot(process.cwd())
  const budget = cgroupBudget(availableParallelism(), totalmem(), name => readFileSync(join('/sys/fs/cgroup', name), 'utf8'))
  const memory = runMemoryBytes(budget.memoryBytes)
  const cpus = budget.cpus
  const reads = values.list || values.plan
  // The pre-commit tier runs only light staged gates, so it neither waits for a running gate nor takes a memory scope.
  const light = reads || values['pre-commit']
  // A pass on another Node major is not evidence for the pinned one, and tree-pass records are keyed by the major.
  const pinned = pinnedNodeMajor(root)
  if (!light && nodeWarning(process.version, pinned) !== undefined) {
    throw new Error(`run-checks: Node ${process.version} is running and the repository pins Node ${String(pinned)} (.nvmrc); run \`nvm use\` and retry`)
  }

  if (values.queue) {
    const budgetNow = machineBudget(cpus, memory, env, diskRotational(tmpdir()))
    for (const line of describeSlots(readSlots(nodeSlotHost(text => process.stderr.write(text)), privateSlotPaths(tmpdir(), process.getuid?.() ?? -1), () => readPressure(name => readFileSync(name, 'utf8'))), budgetNow, Date.now(), budgetOrigin(budget, memory, cpus, env))) console.log(line)
    return 0
  }
  const workers = workerCounts(cpus, memory)
  const forkWorkers = values.workers === undefined ? workers.fork : Number(values.workers)
  if (!Number.isSafeInteger(forkWorkers) || forkWorkers < 1) throw new Error(`--workers must be a positive integer, got ${String(values.workers)}`)
  const rangeRef = rangeBase(env)
  const tree = readTree(root)
  const budgets: Budgets = BudgetsFile.parse(JSON.parse(readFileSync(new URL('./checks/budgets.json', import.meta.url), 'utf8')))
  const checks = catalog(tree, { workers: { ...workers, fork: forkWorkers }, cacheDir: CACHE_DIR, budgets, staleRuntime: staleRuntime(root, tree.upstream), staleDelorunBuilds: staleDelorunBuilds(tree.packages, { exists: path => existsSync(join(root, path)), newestOutput: dir => newestFile(join(root, dir, 'lib'), true), newestSource: dir => newestFile(join(root, dir, 'src'), false) }), gates: gatesFor(rangeRef) })
  // A name that selects or skips nothing would turn a typo into a pass, so the run stops before any check starts.
  const unknown = unknownSelectors(checks, [...list(values.only), ...list(values.skip)])
  if (unknown.length > 0) throw new Error(`--only and --skip name no check: ${unknown.join(', ')}; the catalogue is printed by --list`)
  const scoped = env[IN_SCOPE] !== undefined
  const header = `${String(cpus)} CPUs, fork suite ${String(forkWorkers)} workers, ${(memory / GIB).toFixed(1)} GiB budget${scoped ? ' enforced without swap' : ' scheduled (no systemd user scope to enforce it)'}`

  if (values.list) {
    console.log(`delorun checks (catalogue): ${String(checks.length)} checks, ${header}`)
    for (const check of checks) {
      console.log(`  ${check.id}${check.needs.length > 0 ? ` (after ${check.needs.join(', ')})` : ''}: ${check.title}`)
      console.log(`      tiers: ${check.tiers.length === 0 ? 'named with --only' : check.tiers.join(', ')}`)
      console.log(`      budget: ${budgetText(check)}`)
      console.log(`      ${commandText(check)}`)
    }
    for (const [tier, limit] of Object.entries(budgets.tiers)) if (limit !== undefined) console.log(`  tier budget: ${tier} ${String(limit.seconds)} s`)
    return 0
  }

  // A pre-push run reads the push lines once; a scoped child gets them on its standard input.
  const pushInput = values['pre-push'] ? readFileSync(0, 'utf8') : undefined
  refuseTrunkNarrowing(pushInput, list(values.skip), list(values.only))
  if (values['pre-push']) refuseSharedCheckout(root)
  const fullGate = values['pre-push'] && env['DELORUN_FULL_GATE'] === '1'
  let plan: WithUnits<Planned>[]
  let mode: string
  // The gate tier of a change run; the pre-commit tier and the full gate have none.
  let gateTier: GateTier | undefined
  let left: string[] = []
  // The base a pre-push run measures from and the changed paths it selects by; the tree pass below reads both.
  let pushBase: string | undefined
  let changed: { readonly base: string, readonly paths: string[] } | undefined
  if (values['pre-commit']) {
    const staged = stagedPaths(root)
    plan = selectPreCommit(checks, staged)
    mode = `pre-commit tier, ${String(staged.length)} staged path(s)`
  } else {
    pushBase = values['pre-push'] ? prePushBase(root, pushInput ?? '', values.base ?? DEFAULT_BASE, fullGate) : undefined
    const base = values.base ?? pushBase ?? DEFAULT_BASE
    changed = values.changed || values.base !== undefined || pushBase !== undefined ? { base, paths: changedPaths(root, base) } : undefined
    const targets = positionals.map(path => relative(root, resolve(invocationDir(env, process.cwd()), path)))
    const fullRun = changed === undefined && targets.length === 0
    gateTier = fullRun || fullGate ? undefined : changeTier(values.tier, pushInput, env)
    const selection = { targets, ...changed === undefined ? {} : { changed }, ...gateTier === undefined ? {} : { tier: gateTier }, only: list(values.only), skip: list(values.skip) }
    plan = declineWebsiteWithoutPictures(declineClosureOffHost(declineUnansweredDocker(select(checks, tree, selection), () => probeDocker((command, args, timeout) => spawnSync(command, [...args], { encoding: 'utf8', timeout }))), closureHostProblem(process.platform, process.arch)), websitePicturesProblem(env, path => existsSync(resolve(path))))
    // The fork suite remembers a pass per package (`checks/units.ts`).
    const specDirs = plan.some(check => isForkSuite(check.id)) ? forkSpecDirs(root) : []
    plan = plan.map((check) => {
      const units = suiteUnits(check, tree, specDirs)
      return units === undefined ? check : { ...check, units }
    })
    left = [...leftForMerge(checks, tree, selection), ...dependentsLeftForMerge(tree, selection)]
    mode = changed === undefined ? (targets.length === 0 ? 'full gate' : `targets ${targets.join(', ')}`) : `${String(changed.paths.length)} paths changed since ${changed.base}`
    if (gateTier !== undefined) mode += `, ${gateTier} tier`
    if (values['pre-push']) console.log(pushBase === undefined ? 'delorun checks: the full gate for this push' : `delorun checks: what changed since ${pushBase.slice(0, 10)} for this push (DELORUN_FULL_GATE=1 for the full gate)`)
  }
  // A range gate with no base fails on its own with a git error; one refusal before any check starts names the ref instead.
  // `--plan` runs nothing, so it prints the plan whatever the base.
  if (!values.plan && plan.some(check => check.history === true) && !commitExists(root, rangeRef)) throw new Error(unresolvedRangeBase(rangeRef))
  const use = cacheUse({ preCommit: values['pre-commit'], tier: gateTier, only: list(values.only), noCache: values['no-cache'], noSharedCache: values['no-shared-cache'], fullGate }, env)
  const shared: SharedUse | undefined = use.shared
    ? { store: openSharedStore(sharedCacheDir(env), { root, uid: process.getuid?.() ?? -1, now: () => Date.now() }), noReads: use.noReads }
    : undefined
  const configs = tree.programs.map(program => ({ config: program.config, references: /"references"\s*:/.test(readFileSync(join(root, program.config), 'utf8')) }))
  const policy = sharingPolicy({ packages: tree.packages, upstream: tree.upstream, securityPackages: securityPackageDirs(FUNDAMENTALS_INPUTS), declarationReaders: declarationReaders(configs, tree.packages) })
  const cache = use.on
    ? createPassCache({ root, dir: join(root, CACHE_DIR, 'pass'), env, nodeVersion: process.version, pnpmVersion: () => pnpmVersionOf(root), platform: `${process.platform}-${process.arch}`, policy, shared, strict: use.strict, warn: line => { console.warn(line) } })
    : undefined

  if (values.plan) {
    const durations = readDurations(root)
    console.log(`delorun checks (plan): ${String(plan.length)} checks, ${mode}, ${header}`)
    for (const check of plan) {
      console.log(`  ${check.id}${check.needs.length > 0 ? ` (after ${check.needs.join(', ')})` : ''}: ${check.title}`)
      console.log(`      why: ${check.reason}`)
      console.log(`      pass cache: ${cacheState(check, cache)}`)
      console.log(`      expected: ${durations[check.id] === undefined ? 'no earlier run' : `${formatSeconds(durations[check.id] ?? 0)} on its last run`}`)
      console.log(`      budget: ${budgetText(check)}`)
      console.log(`      ${commandText(check)}`)
    }
    if (left.length > 0) console.log(`  left for the merge tier: ${left.join(', ')}`)
    const tierSeconds = values['pre-commit'] ? budgets.tiers['pre-commit']?.seconds : undefined
    if (tierSeconds !== undefined) console.log(`  the pre-commit tier's budget: ${String(tierSeconds)} s`)
    return 0
  }

  // A pre-push run of the pushed HEAD, or a change run, measures HEAD's tree, which a tree record can cover.
  const measuresHead = values['pre-push'] ? pushBase !== undefined : changed !== undefined
  const treeRecords = treeRecordsDir(root)
  const treeRecordsOn = measuresHead && treePassEnabled({ noCache: values['no-cache'] }, env)
  const facts: RunFacts = { lockfile: contentId(root, 'pnpm-lock.yaml'), node: process.version, pnpm: () => pnpmVersionOf(root), env, tier: gateTier ?? 'merge' }
  // Whether the record covers this run, which then starts nothing; `announce` names the reason a record does not cover it.
  const covered = (state: TreeState | undefined, announce: boolean): boolean => {
    if (state?.clean !== true) return false
    const lookup = findTreePass(treeRecords, state, plan, facts)
    if (lookup.hit) {
      console.log(`delorun checks: this tree passed these checks at ${lookup.record.passedAt}: ${plan.map(check => check.id).join(', ')}; nothing ran`)
      return true
    }
    if (announce && lookup.reason !== undefined) console.log(`delorun checks: the record for this tree does not cover this run (${lookup.reason}); the checks run`)
    return false
  }
  // Answered before the lock: a covered tree starts nothing, so it does not wait for a gate running on this machine.
  if (covered(treeRecordsOn ? treeState(root, rangeRef) : undefined, false)) return 0

  // Heavy runs share the machine's slots, first come, first served (`checks/slots.ts`); a light plan, the pre-flight and a
  // plan whose every check a stored pass serves take none.
  // A check planned only as a need of checks that stored passes serve does not run, and the run asks for slots only for
  // what will really run.
  plan = withoutIdleNeeds(plan, checksToRun(plan, cache))
  const running = checksToRun(plan, cache)
  const slotBudget = machineBudget(cpus, memory, env, diskRotational(tmpdir()))
  const inherited = grantFromEnv(env[GRANT_ENV])
  let grant: SlotGrant | undefined = inherited
  if (!light && !preflight && inherited === undefined && running.length > 0 && !isLightPlan(running)) {
    const demand = runDemand(running, slotBudget, gatePriority(env, pushInput !== undefined && pushesTrunk(pushInput)), `${relative(dirname(root), root)}: ${running.map(check => check.id).slice(0, 6).join(', ')}${running.length > 6 ? ', ...' : ''}`)
    grant = await takeSlots(nodeSlotHost(line => process.stderr.write(line)), privateSlotPaths(tmpdir(), process.getuid?.() ?? -1), slotBudget, { ...demand, cwd: process.cwd() }, () => readPressure(name => readFileSync(name, 'utf8')))
  }
  if (!light && !preflight && !values['no-scope'] && env[IN_SCOPE] === undefined && canScope()) {
    const [command = '', ...args] = scopeCommand([process.execPath, ...process.execArgv, ...process.argv.slice(1)], memory)
    const child = spawnSync(command, args, { stdio: [pushInput === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env: { ...env, [IN_SCOPE]: '1', ...grant === undefined ? {} : { [GRANT_ENV]: grantToEnv(grant) } }, ...pushInput === undefined ? {} : { input: pushInput } })
    return child.status ?? 1
  }
  // A granted run fits its test runners to its slots and schedules its checks inside its share of the memory.
  if (grant !== undefined) plan = fitToGrant(plan, grant.slots)
  const runCpus = grant?.slots ?? cpus
  // Temporary files on a memory file system take memory from the run's budget.
  const place = scratchPlace(env, { tmpdir: tmpdir(), statfs: statfsOf })
  const runMemory = Math.max(GIB, (grant === undefined ? memory : Math.min(memory, grant.memoryBytes)) - place.capBytes)
  const ioAtStart = ioPressure(name => readFileSync(name, 'utf8'))
  // A gate that ran while this run waited for the lock may have recorded the tree, so the record is read again here.
  const startState = treeRecordsOn ? treeState(root, rangeRef) : undefined
  if (covered(startState, true)) return 0
  // A pre-push or change run of HEAD's tree records its pass, and only from a clean tree.
  const before = startState?.clean === true ? startState : undefined

  if (place.fallback !== undefined) console.log(`delorun checks: temporary files go to the disk: ${place.fallback}`)
  const scratch = scratchDir(place.base)
  const childEnv = checkEnvironment(env, scratch)
  // The environment `pnpm run` gives a script is read from pnpm only when a planned check needs it.
  if (plan.some(readsPnpmScriptEnvironment)) Object.assign(childEnv, pnpmScriptEnvironment(root, childEnv['PATH'] ?? ''))
  const logDir = join(root, CACHE_DIR, 'logs')
  rmSync(logDir, { recursive: true, force: true })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(root, CACHE_DIR, 'tsbuildinfo'), { recursive: true })
  console.log(`delorun checks: ${String(plan.length)} checks, ${mode}, ${header}${grant === undefined ? '' : `; granted ${String(grant.slots)} of ${String(slotBudget.slots)} slots and ${(runMemory / GIB).toFixed(1)} GiB after waiting ${formatSeconds(grant.waitedMs / 1000)}`}; temporary files in ${scratch}`)
  if (rangeBaseOverridden(env)) console.log(`delorun checks: range base: ${rangeRef} (DELORUN_RANGE_BASE)`)
  if (left.length > 0) console.log(`delorun checks: left for the merge tier: ${left.join(', ')}`)

  const started = performance.now()
  const durations = readDurations(root)
  const results = await runPlan(plan, {
    root,
    env: childEnv,
    logDir,
    cpus: runCpus,
    memoryBytes: runMemory,
    oomKills: () => memoryReport()?.oomKills,
    bail: values.bail,
    ...gateTier === undefined ? {} : { tier: gateTier },
    priority: criticalPath(plan, durations),
    ...cache === undefined ? {} : { cache },
    report: event => {
      if (event.kind !== 'end') return
      const { check, result } = event
      const timing = result.cached === true || !(result.outcome === 'passed' || result.outcome === 'failed') ? '' : ` ${formatSeconds(result.seconds)}`
      const memoryNote = result.peakBytes === undefined ? '' : `, ${(result.peakBytes / GIB).toFixed(1)} GiB`
      const detail = result.detail === undefined ? '' : result.cached === true ? ` ${result.detail}` : ` (${result.detail})`
      console.log(`  ${MARK[result.outcome]} ${check.id}${timing}${memoryNote}${result.outcome === 'declined' ? ' declined' : ''}${detail}`)
    },
  })
  const leftScratch = removeScratch(scratch)
  if (leftScratch !== undefined) console.warn(`delorun checks: the temporary directory ${scratch} is left behind: ${leftScratch}`)
  writeDurations(root, durations, results)
  const ioAtEnd = ioPressure(name => readFileSync(name, 'utf8'))
  const machine = { waitedSeconds: Math.round((grant?.waitedMs ?? 0) / 100) / 10, slots: grant?.slots ?? null, ioPressureAtStart: ioAtStart ?? null, ioPressureAtEnd: ioAtEnd ?? null }
  writeReport(root, results, shared?.store.dir, machine)
  if (before !== undefined && !results.some(result => gateFailure(result, gateTier))) {
    const written = recordTreePass(treeRecords, { before, after: treeState(root, rangeRef), base: changed === undefined ? null : treeOfRef(root, changed.base), plan, results }, facts, new Date())
    console.log(written.recorded ? `delorun checks: this tree's pass is recorded in ${treePassPath(treeRecords, before.tree, process.version)}` : `delorun checks: this tree's pass is not recorded: ${written.reason}`)
  }
  const elapsed = (performance.now() - started) / 1000
  const tierSeconds = values['pre-commit'] ? budgets.tiers['pre-commit']?.seconds : undefined
  if (tierSeconds !== undefined && elapsed > tierSeconds) console.log(`  the pre-commit tier took ${formatSeconds(elapsed)}, over its ${String(tierSeconds)} s budget (budgets.json)`)
  if (grant !== undefined || ioAtStart !== undefined) console.log(`delorun checks: waited ${formatSeconds(machine.waitedSeconds)} for slots${ioAtStart === undefined ? '' : `; disk pressure (some, avg10) ${String(ioAtStart)}% at the start and ${String(ioAtEnd ?? '?')}% at the end`}`)
  return summarize(results, performance.now() - started, root, gateTier, plan.flatMap(check => check.bounded === undefined ? [] : [`${check.id}: ${check.bounded}`]))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`delorun checks: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  })
}
