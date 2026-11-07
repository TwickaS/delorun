/**
 * The fork's local checks: the commit gate, the push gate, the working-tree
 * check and the full gate. GitHub Actions does not run on this repository, so
 * this is the check a change gets. Run from anywhere inside the repository:
 *
 * ```sh
 * node_modules/.bin/tsx delo/apps/tools/src/run-checks.ts [paths...] [options]
 * ```
 *
 * The tiers, which `lefthook.yml` and `pnpm check` use:
 *
 * - `--pre-commit` runs the repository gates marked `staged` over the staged
 *   paths, and `git diff --cached --check`, within a budget of five seconds
 *   (`budgets.json`).
 * - `--pre-push` runs what changed since the older of the remote branch's tip and
 *   its merge base with `origin/v5` (or, for a new branch without `origin/v5`, its
 *   merge base with `v5`); the full gate when a pushed ref is
 *   not `HEAD` or `DELO_FULL_GATE=1` is set.
 * - `--changed` (`pnpm check`) runs what changed since `--base` (default `v5`).
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
 * duration go under `node_modules/.cache/delo-checks/`; a check that declares its
 * inputs and passed under the same key is served from the pass cache
 * (`checks/cache.ts`). A run of a tree that a record covers reports the record and starts nothing, and a passing
 * pre-push run records its pass (`checks/tree-pass.ts`) in the git common directory, shared by every worktree of the clone.
 *
 * @module @delo/tools/run-checks
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir, totalmem } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { contentId, createPassCache, passCacheEnabled, type PassCache } from './checks/cache.ts'
import { GATES } from './checks/gates/index.ts'
import { canScope, cgroupBudget, checkEnvironment, memoryReport, pnpmExecAnswer, runMemoryBytes, scopeCommand, scratchDir, workerCounts } from './checks/machine.ts'
import { catalog, criticalPath, readsPnpmScriptEnvironment, select, selectPreCommit, type Budgets, type Check, type ForkPackage, type ForkTree, type Planned, type Program, type UpstreamPackage, unknownSelectors } from './checks/plan.ts'
import { failing, logTail, runPlan, type Outcome, type Result } from './checks/run.ts'
import { findTreePass, recordTreePass, treeOfRef, treePassEnabled, treePassPath, treeRecordsDir, treeState, type RunFacts, type TreeState } from './checks/tree-pass.ts'
import { readWebSpecs } from './checks/web.ts'
import { nodeWarning, pinnedNodeMajor } from './setup-worktree.ts'
import { git, repositoryRoot, runGit } from './git.ts'

/** Where the runner keeps its state, relative to the repository root. */
const CACHE_DIR = 'node_modules/.cache/delo-checks'
/** The environment variable a systemd-scoped run sets for the process it re-executes, so that process does not scope again. */
const IN_SCOPE = 'DELO_CHECKS_SCOPE'
const GIB = 1024 ** 3
/** The ref a change is measured from when no `--base` names one: the integration branch. */
const DEFAULT_BASE = 'v5'
const REPORT = `${CACHE_DIR}/report.json`
/** Where each check's last duration is kept, for the order of the next run. */
const DURATIONS = `${CACHE_DIR}/durations.json`

/** The fields of a workspace package's `package.json` the plan reads, fork or upstream. */
const manifestSchema = z.object({
  name: z.string(),
  dependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
})

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

/**
 * The fork's packages and programs, read from the tree.
 * @param root - the repository root.
 * @returns the packages, the tsconfig programs and upstream's packages.
 */
function readTree(root: string): ForkTree {
  const packages: ForkPackage[] = []
  const programs: Program[] = []
  for (const parent of ['delo/apps', 'delo/packages']) {
    if (!existsSync(join(root, parent))) continue
    for (const name of readdirSync(join(root, parent)).sort()) {
      const dir = `${parent}/${name}`
      if (!existsSync(join(root, dir, 'package.json'))) continue
      const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')))
      const dependencies = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies })
      const ownWorkspace = existsSync(join(root, dir, 'pnpm-workspace.yaml'))
      const tests = join(root, dir, 'tests')
      const dockerSpecs = existsSync(tests) && readdirSync(tests, { recursive: true, encoding: 'utf8' }).some(entry => entry.endsWith('.docker.spec.ts'))
      packages.push({ name: manifest.name, dir, forkDependencies: dependencies.filter(dependency => dependency.startsWith('@delo/')), upstreamDependencies: dependencies.filter(dependency => dependency.startsWith('@deepseek-ai/')), ownWorkspace, dockerSpecs })
      if (ownWorkspace) continue
      for (const file of readdirSync(join(root, dir)).filter(entry => /^tsconfig(\..+)?\.json$/.test(entry)).sort()) programs.push({ config: `${dir}/${file}` })
    }
  }
  const upstream = readUpstream(root)
  return { packages, programs, upstream, webSpecs: readWebSpecs(root, upstream) }
}

const SPEC = /\.(?:spec|test)\.[cm]?[jt]sx?$/

/**
 * Upstream's packages under `packages/<group>/` and `apps/`, with their upstream dependencies and spec counts.
 * @param root - the repository root.
 * @returns the packages, sorted by directory.
 */
function readUpstream(root: string): UpstreamPackage[] {
  const dirs: string[] = []
  const children = (dir: string): string[] => existsSync(join(root, dir)) ? readdirSync(join(root, dir), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${dir}/${entry.name}`) : []
  for (const group of children('packages')) dirs.push(...children(group))
  dirs.push(...children('apps'))
  const upstream: UpstreamPackage[] = []
  for (const dir of dirs.sort()) {
    if (!existsSync(join(root, dir, 'package.json'))) continue
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')))
    const upstreamOnly = (names: readonly string[]): string[] => names.filter(dependency => dependency.startsWith('@deepseek-ai/'))
    const dependencies = upstreamOnly(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }))
    const runtimeDependencies = upstreamOnly(Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies }))
    const tests = join(root, dir, 'tests')
    const specs = existsSync(tests) ? readdirSync(tests, { recursive: true, encoding: 'utf8' }).filter(entry => SPEC.test(entry)).length : 0
    upstream.push({ name: manifest.name, dir, dependencies, runtimeDependencies, specs })
  }
  return upstream
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
 * A push of `v5` starts from the remote `v5` tip. A push of any other branch starts from the older of its remote tip and its
 * merge base with `origin/v5`, so the record it leaves covers the later fast-forward of `v5` to the same tree.
 * @param root - the repository root.
 * @param input - the hook's standard input.
 * @param base - the integration branch a new branch is measured from when `origin/v5` is absent.
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
  const v5Base = remoteRef === 'refs/heads/v5' ? undefined : mergeBase(root, 'origin/v5')
  if (v5Base === undefined) return tip ?? (ZERO.test(remote) ? mergeBase(root, base) : undefined)
  // The older of the two starts the wider range, which the later fast-forward of v5 needs.
  if (tip !== undefined && runGit(root, ['merge-base', '--is-ancestor', tip, v5Base]).status === 0) return tip
  return v5Base
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
    console.warn(`delo checks: ignoring ${DURATIONS}, which is not a map of durations`)
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
function cacheState(check: Check, cache: PassCache | undefined): string {
  if (cache === undefined) return 'off (--no-cache, CI, or a full pre-push gate)'
  const key = cache.keyOf(check)
  if (key === undefined) return 'always runs (no declared inputs)'
  return cache.has(check, key) ? `cached pass (${key.slice(0, 12)})` : 'runs (no stored pass for its key)'
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
  return check.declined !== undefined ? `declined: ${check.declined}` : `runs: ${check.command.join(' ')}`
}

/**
 * The run's results for tools and agents: one entry per check with its status, reason, log, duration and peak memory.
 * @param root - the repository root.
 * @param results - the run's results.
 */
function writeReport(root: string, results: readonly Result[]): void {
  const memory = memoryReport()
  const report = {
    peakBytes: memory?.peakBytes ?? null,
    oomKills: memory?.oomKills ?? null,
    checks: results.map(result => ({
      check: result.id, status: result.outcome, cached: result.cached === true, reason: result.detail ?? null, logPath: result.log === undefined ? null : relative(root, result.log),
      durationSeconds: Math.round(result.seconds * 10) / 10, peakBytes: result.peakBytes ?? null, oomKilled: result.oomKilled === true,
    })),
  }
  writeFileSync(join(root, REPORT), `${JSON.stringify(report, null, 2)}\n`)
}

/**
 * Print each failure's log tail and the run's summary.
 * @param results - the run's results.
 * @param milliseconds - the run's wall time.
 * @param root - the repository root, for the paths printed.
 * @returns 0 when no check failed, otherwise 1.
 */
function summarize(results: readonly Result[], milliseconds: number, root: string): number {
  const failures = results.filter(result => failing(result.outcome))
  const declined = results.filter(result => result.outcome === 'declined')
  for (const failure of failures) {
    console.log(`\n── ${failure.id}: ${failure.detail ?? failure.outcome}${failure.log === undefined ? '' : ` (full log: ${relative(root, failure.log)})`}`)
    if (failure.log !== undefined) console.log(logTail(failure.log, 60))
  }
  const memory = memoryReport()
  const count = (predicate: (result: Result) => boolean): number => results.filter(predicate).length
  const passed = count(result => result.outcome === 'passed' && result.cached !== true)
  const cached = count(result => result.cached === true)
  const skipped = count(result => result.outcome === 'skipped')
  const peak = memory?.peakBytes === undefined ? '' : `, peak memory ${(memory.peakBytes / GIB).toFixed(1)} GiB`
  const oom = memory !== undefined && memory.oomKills > 0 ? `, ${String(memory.oomKills)} process(es) stopped at the memory ceiling` : ''
  for (const each of declined) console.log(`\n── ${each.id} declined: ${each.detail ?? 'this host cannot run it'}`)
  const named = failures.length === 0 ? '' : ` (${failures.map(failure => failure.id).join(', ')})`
  console.log(`\ndelo checks: ${String(passed)} passed, ${String(cached)} cached, ${String(failures.length)} failed${named}, ${String(declined.length)} declined, ${String(skipped)} skipped in ${formatSeconds(milliseconds / 1000)}${peak}${oom}; report: ${REPORT}`)
  return failures.length === 0 ? 0 : 1
}

/**
 * The machine-wide run lock: a file naming the holder's pid, taken over when that process is gone.
 * @returns when the lock is held by this process.
 */
async function holdRunLock(): Promise<void> {
  const path = join(tmpdir(), 'delo-run-checks.lock')
  for (let announced = false; ; announced = true) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' })
      process.once('exit', () => { try { rmSync(path, { force: true }) } catch (error) { void error } })
      return
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const holder = Number(readFileSync(path, 'utf8'))
      let alive = false
      try { process.kill(holder, 0); alive = holder !== process.pid } catch (gone) { void gone }
      if (!alive) { rmSync(path, { force: true }); continue }
      if (!announced) process.stderr.write(`run-checks: waiting for the run in process ${String(holder)} to finish\n`)
      await new Promise(resolve => setTimeout(resolve, 5000))
    }
  }
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
    },
  })
  const tiers = [values['pre-commit'], values['pre-push'], values.changed].filter(flag => flag).length
  if (tiers > 1) throw new Error('--pre-commit, --pre-push and --changed each select a tier; give one of them')
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

  const workers = workerCounts(cpus, memory)
  const forkWorkers = values.workers === undefined ? workers.fork : Number(values.workers)
  if (!Number.isSafeInteger(forkWorkers) || forkWorkers < 1) throw new Error(`--workers must be a positive integer, got ${String(values.workers)}`)
  const tree = readTree(root)
  const budgets: Budgets = BudgetsFile.parse(JSON.parse(readFileSync(new URL('./checks/budgets.json', import.meta.url), 'utf8')))
  const checks = catalog(tree, { workers: { ...workers, fork: forkWorkers }, cacheDir: CACHE_DIR, budgets, staleRuntime: staleRuntime(root, tree.upstream), gates: GATES })
  // A name that selects or skips nothing would turn a typo into a pass, so the run stops before any check starts.
  const unknown = unknownSelectors(checks, [...list(values.only), ...list(values.skip)])
  if (unknown.length > 0) throw new Error(`--only and --skip name no check: ${unknown.join(', ')}; the catalogue is printed by --list`)
  const scoped = env[IN_SCOPE] !== undefined
  const header = `${String(cpus)} CPUs, fork suite ${String(forkWorkers)} workers, ${(memory / GIB).toFixed(1)} GiB budget${scoped ? ' enforced without swap' : ' scheduled (no systemd user scope to enforce it)'}`

  if (values.list) {
    console.log(`delo checks (catalogue): ${String(checks.length)} checks, ${header}`)
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
  const fullGate = values['pre-push'] && env['DELO_FULL_GATE'] === '1'
  let plan: Planned[]
  let mode: string
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
    // Under `pnpm --filter`, a script runs in its package; `INIT_CWD` is where it was invoked.
    const targets = positionals.map(path => relative(root, resolve(process.env['INIT_CWD'] ?? process.cwd(), path)))
    plan = select(checks, tree, { targets, ...changed === undefined ? {} : { changed }, only: list(values.only), skip: list(values.skip) })
    mode = changed === undefined ? (targets.length === 0 ? 'full gate' : `targets ${targets.join(', ')}`) : `${String(changed.paths.length)} paths changed since ${changed.base}`
    if (values['pre-push']) console.log(pushBase === undefined ? 'delo checks: the full gate for this push' : `delo checks: what changed since ${pushBase.slice(0, 10)} for this push (DELO_FULL_GATE=1 for the full gate)`)
  }
  const cache = passCacheEnabled({ noCache: values['no-cache'], fullGate }, env)
    ? createPassCache({ root, dir: join(root, CACHE_DIR, 'pass'), env, nodeVersion: process.version, pnpmVersion: () => pnpmVersionOf(root) })
    : undefined

  if (values.plan) {
    const durations = readDurations(root)
    console.log(`delo checks (plan): ${String(plan.length)} checks, ${mode}, ${header}`)
    for (const check of plan) {
      console.log(`  ${check.id}${check.needs.length > 0 ? ` (after ${check.needs.join(', ')})` : ''}: ${check.title}`)
      console.log(`      why: ${check.reason}`)
      console.log(`      pass cache: ${cacheState(check, cache)}`)
      console.log(`      expected: ${durations[check.id] === undefined ? 'no earlier run' : `${formatSeconds(durations[check.id] ?? 0)} on its last run`}`)
      console.log(`      budget: ${budgetText(check)}`)
      console.log(`      ${commandText(check)}`)
    }
    const tierSeconds = values['pre-commit'] ? budgets.tiers['pre-commit']?.seconds : undefined
    if (tierSeconds !== undefined) console.log(`  the pre-commit tier's budget: ${String(tierSeconds)} s`)
    return 0
  }

  // A pre-push run of the pushed HEAD, or a change run, measures HEAD's tree, which a tree record can cover.
  const measuresHead = values['pre-push'] ? pushBase !== undefined : changed !== undefined
  const treeRecords = treeRecordsDir(root)
  const treeRecordsOn = measuresHead && treePassEnabled({ noCache: values['no-cache'] }, env)
  const facts: RunFacts = { lockfile: contentId(root, 'pnpm-lock.yaml'), node: process.version, pnpm: () => pnpmVersionOf(root), env }
  // Whether the record covers this run, which then starts nothing; `announce` names the reason a record does not cover it.
  const covered = (state: TreeState | undefined, announce: boolean): boolean => {
    if (state?.clean !== true) return false
    const lookup = findTreePass(treeRecords, state, plan, facts)
    if (lookup.hit) {
      console.log(`delo checks: this tree passed these checks at ${lookup.record.passedAt}: ${plan.map(check => check.id).join(', ')}; nothing ran`)
      return true
    }
    if (announce && lookup.reason !== undefined) console.log(`delo checks: the record for this tree does not cover this run (${lookup.reason}); the checks run`)
    return false
  }
  // Answered before the lock: a covered tree starts nothing, so it does not wait for a gate running on this machine.
  if (covered(treeRecordsOn ? treeState(root) : undefined, false)) return 0

  // One gate at a time on this machine; a second run waits for the first.
  if (!light && env[IN_SCOPE] === undefined) await holdRunLock()
  if (!light && !values['no-scope'] && env[IN_SCOPE] === undefined && canScope()) {
    const [command = '', ...args] = scopeCommand([process.execPath, ...process.execArgv, ...process.argv.slice(1)], memory)
    const child = spawnSync(command, args, { stdio: [pushInput === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'], env: { ...env, [IN_SCOPE]: '1' }, ...pushInput === undefined ? {} : { input: pushInput } })
    return child.status ?? 1
  }
  // A gate that ran while this run waited for the lock may have recorded the tree, so the record is read again here.
  const startState = treeRecordsOn ? treeState(root) : undefined
  if (covered(startState, true)) return 0
  // Only a pre-push run records its pass, and only from a clean tree.
  const before = values['pre-push'] && startState?.clean === true ? startState : undefined

  const scratch = scratchDir()
  const childEnv = checkEnvironment(env, scratch)
  // The environment `pnpm run` gives a script is read from pnpm only when a planned check needs it.
  if (plan.some(readsPnpmScriptEnvironment)) Object.assign(childEnv, pnpmScriptEnvironment(root, childEnv['PATH'] ?? ''))
  const logDir = join(root, CACHE_DIR, 'logs')
  rmSync(logDir, { recursive: true, force: true })
  mkdirSync(logDir, { recursive: true })
  mkdirSync(join(root, CACHE_DIR, 'tsbuildinfo'), { recursive: true })
  console.log(`delo checks: ${String(plan.length)} checks, ${mode}, ${header}; temporary files in ${scratch}`)

  const started = performance.now()
  const durations = readDurations(root)
  const results = await runPlan(plan, {
    root,
    env: childEnv,
    logDir,
    cpus,
    memoryBytes: memory,
    oomKills: () => memoryReport()?.oomKills,
    bail: values.bail,
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
  rmSync(scratch, { recursive: true, force: true })
  writeDurations(root, durations, results)
  writeReport(root, results)
  if (before !== undefined && !results.some(result => failing(result.outcome))) {
    const written = recordTreePass(treeRecords, { before, after: treeState(root), base: changed === undefined ? null : treeOfRef(root, changed.base), plan, results }, facts, new Date())
    console.log(written.recorded ? `delo checks: this tree's pass is recorded in ${treePassPath(treeRecords, before.tree, process.version)}` : `delo checks: this tree's pass is not recorded: ${written.reason}`)
  }
  const elapsed = (performance.now() - started) / 1000
  const tierSeconds = values['pre-commit'] ? budgets.tiers['pre-commit']?.seconds : undefined
  if (tierSeconds !== undefined && elapsed > tierSeconds) console.log(`  the pre-commit tier took ${formatSeconds(elapsed)}, over its ${String(tierSeconds)} s budget (budgets.json)`)
  return summarize(results, performance.now() - started, root)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`delo checks: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  })
}
