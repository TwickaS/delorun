/**
 * The fork's checks as a plan: which checks exist, the command each runs,
 * what each waits for, and which ones a selection picks. Pure: `run-checks.ts`
 * reads the tree, git and the machine and passes the facts in, so selection
 * is tested without a checkout.
 *
 * @module @delo/tools/checks/plan
 */
import type { GateCheck } from './types.ts'

/**
 * The invocations that select a check: `pre-commit` runs the staged paths, `changed` selects by change (`--changed`
 * and the pre-push hook), and `full` is the full gate. A check with no tier runs only when `--only` names it.
 */
export type Tier = 'pre-commit' | 'changed' | 'full'

/** One check's budget from `budgets.json`. */
export interface BudgetEntry {
  /** Resident memory at the check's peak, in GiB; multiplied by its CPUs when `perWorker` is set. */
  readonly memoryGiB: number
  readonly perWorker?: boolean | undefined
  /** Run with no other check beside it. */
  readonly exclusive?: boolean | undefined
}

/** One command the runner starts. */
export interface Check {
  /** `group` or `group:name`, unique in a plan. */
  readonly id: string
  /** The id's first segment; `--only` and `--skip` accept it for all the group's checks. */
  readonly group: string
  /** One line on what it proves. */
  readonly title: string
  /** Working directory, relative to the repository root (`''` for the root). */
  readonly cwd: string
  readonly command: readonly string[]
  /** Checks that must pass first, such as the generated sources a program reads. */
  readonly needs: readonly string[]
  /** Globs (git pathspecs) of the files whose content decides the result; a check without any always runs. */
  readonly inputs?: readonly string[]
  /** Names of the variables whose values decide the result; their values enter the cache key. */
  readonly env?: readonly string[]
  /** Variables the check sets for its command, over the inherited environment. */
  readonly environment?: Readonly<Record<string, string>>
  /** The tiers that select the check by default. */
  readonly tiers: readonly Tier[]
  /** The CPUs it keeps busy, which the runner budgets. */
  readonly cpus: number
  /** Its resident memory at its peak, in bytes, which the runner budgets against the run's ceiling. */
  readonly memoryBytes: number
  /** Run with no other check beside it. */
  readonly exclusive?: boolean
  /** Why this host cannot run it; the runner reports it declined, which fails no run. */
  readonly declined?: string
  /** The budget the memory and exclusivity came from; the cache key includes it. */
  readonly budget: BudgetEntry
}

/** A fork workspace package. */
export interface ForkPackage {
  readonly name: string
  /** Repository-relative directory, such as `delo/packages/pricing`. */
  readonly dir: string
  /** The `@delo/` packages it depends on, in any dependency section. */
  readonly forkDependencies: readonly string[]
  /** The `@deepseek-ai/` packages it depends on, in any dependency section. */
  readonly upstreamDependencies: readonly string[]
  /** Whether it is a pnpm workspace of its own, with its own lockfile: its tsconfigs are not the fork's programs. */
  readonly ownWorkspace: boolean
}

/** A fork TypeScript program, type-checked with `tsc -p`. */
export interface Program {
  /** Repository-relative `tsconfig*.json`. */
  readonly config: string
}

/** An upstream workspace package under `packages/` or `apps/`. */
export interface UpstreamPackage {
  readonly name: string
  /** Repository-relative directory, such as `packages/client/connection`. */
  readonly dir: string
  /** The `@deepseek-ai/` packages it depends on, in any dependency section: a change to one reaches this package's own specs. */
  readonly dependencies: readonly string[]
  /** The subset in `dependencies` and `peerDependencies`: a change to one reaches this package's dependents too. A development dependency serves only the package's own tests. */
  readonly runtimeDependencies: readonly string[]
  /** How many spec files its `tests` directory holds. */
  readonly specs: number
}

/** What the runner found in the tree. */
export interface ForkTree {
  readonly packages: readonly ForkPackage[]
  readonly programs: readonly Program[]
  /** Upstream's packages, for running the specs of a changed upstream package and its direct dependents. */
  readonly upstream: readonly UpstreamPackage[]
}

/** The test runners' worker counts. */
export interface Workers {
  /** The fork suite's workers. */
  readonly fork: number
  /** The changed-upstream lane's workers, before its own cap. */
  readonly upstream: number
}

/** The checks' budgets, from `budgets.json`. */
export interface Budgets {
  /** Time budgets of a tier's run, in seconds. */
  readonly tiers: Readonly<Partial<Record<Tier, { readonly seconds: number }>>>
  /** Memory budgets by check id or by id family (`typecheck`, `gates`); the most specific entry wins. */
  readonly checks: Readonly<Record<string, BudgetEntry>>
}

/** What the runner found on the machine and in the repository. */
export interface Host {
  readonly workers: Workers
  /** Repository-relative directory for incremental compiler state. */
  readonly cacheDir: string
  /** Each check's memory, exclusivity and time budgets. */
  readonly budgets: Budgets
  /** Why the build is not current: upstream packages whose runtime bundles are missing or older than their sources. Empty when it is current; lanes that run built code need `build:artifacts` while it is not. */
  readonly staleRuntime: readonly string[]
  /** The repository gates the runner schedules, from `checks/gates/index.ts`. */
  readonly gates: readonly GateCheck[]
}

const GIB = 1024 ** 3

/** What to select. */
export interface Selection {
  /** Paths whose checks to run; empty with no `changed` selects everything. */
  readonly targets: readonly string[]
  /** Paths changed since `base`; set, it selects by change and the fork suite runs the packages a change reaches. */
  readonly changed?: { readonly base: string; readonly paths: readonly string[] }
  /** Check ids or groups to keep; empty keeps all. */
  readonly only: readonly string[]
  /** Check ids or groups to drop. */
  readonly skip: readonly string[]
}

/** A selected check and why it was picked. */
export interface Planned extends Check {
  readonly reason: string
}

const TSC = 'node_modules/.bin/tsc'
const VITEST = 'node_modules/.bin/vitest'
const FORK_CONFIG = 'delo/vitest.config.ts'
// Upstream's own unit configuration, unchanged: the fork's WSL wrapper for it is not part of this tree.
const UPSTREAM_CONFIG = 'vitest.config.ts'
// Upstream's own default for the replay's scenarios at once. Ten at once measured 92 s against 110 s for five, bound by the largest scenario file, for 3.7 GB more memory.
const SNAPSHOT_CONCURRENCY = 5
/**
 * The most spec files the changed-upstream lane runs to include a changed
 * package's direct dependents. A package with 39 direct dependents measured
 * 643 spec files and 185 s; the median package has 3. Above the budget the
 * lane runs the changed packages' own specs and leaves the dependents to
 * upstream's full suite.
 */
export const UPSTREAM_CHANGED_SPEC_BUDGET = 150
// The changed-upstream lane's workers: path-filtered runs measured well inside this beside the compilers.
const UPSTREAM_CHANGED_WORKERS = 8
/** Paths whose change can affect every check: fork-wide test and compiler configuration and the dependency set. */
const FORK_WIDE = ['delo/vitest.', 'delo/apps/tools/src/checks/', 'tsconfig', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.shared.ts']
/** Fork TypeScript and configuration: what a fork program or the fork suite can compile or import. */
const DELO_CODE = ['delo/**/*.ts', 'delo/**/*.tsx', 'delo/**/*.json']
/** Upstream code and configuration the upstream and fork compilers and specs read; documentation is left out. */
const UPSTREAM_CODE = ['packages/**', 'apps/**', 'vendor/**', 'native/**', 'scripts/**', 'snapshots/**', '*.json', '*.ts', '*.mjs', '*.yaml']
/** Everything the fork's programs and specs can read. */
const FORK_CODE = [...DELO_CODE, ...UPSTREAM_CODE]
/** The variables the fork and upstream test lanes read, through their locale and time zone. */
const TEST_ENV = ['LANG', 'LC_ALL', 'TZ']

/**
 * The name a program's check carries: its directory, and the config's own suffix when it has one.
 * @param config - the repository-relative tsconfig path.
 * @returns such as `control`, `control-tests` or `cell-denial`.
 */
export function programLabel(config: string): string {
  const parts = config.split('/')
  const file = parts.at(-1) ?? ''
  const dir = parts.at(-2) ?? ''
  const suffix = /^tsconfig\.(.+)\.json$/.exec(file)?.[1]
  return suffix === undefined ? dir : `${dir}-${suffix}`
}

/** A check before its budget is attached. */
type Draft = Omit<Check, 'budget' | 'memoryBytes'>

/**
 * Every check the tree supports, with its budget from `host.budgets`.
 * @param tree - the fork's packages and programs.
 * @param host - the test runners' CPUs, the compiler cache, the budgets and the repository gates.
 * @returns the checks, in catalog order.
 * @throws Error when a check has no budget in `budgets.json`, by its id, its id family or its group.
 */
export function catalog(tree: ForkTree, host: Host): Check[] {
  return draft(tree, host).map(check => {
    const budget = budgetFor(check.id, check.group, host.budgets)
    if (budget === undefined) throw new Error(`delo checks: budgets.json gives ${check.id} no memory; add it or its family`)
    return {
      ...check,
      budget,
      memoryBytes: Math.round(budget.memoryGiB * GIB * (budget.perWorker === true ? check.cpus : 1)),
      ...budget.exclusive === true ? { exclusive: true } : {},
    }
  })
}

// The most specific budget: the id's own entry, then each enclosing family's, such as `typecheck:delo:tools` → `typecheck:delo` → `typecheck`, then the group's.
function budgetFor(id: string, group: string, budgets: Budgets): BudgetEntry | undefined {
  const parts = id.split(':')
  for (let length = parts.length; length > 0; length -= 1) {
    const entry = budgets.checks[parts.slice(0, length).join(':')]
    if (entry !== undefined) return entry
  }
  return budgets.checks[group]
}

function draft(tree: ForkTree, host: Host): Draft[] {
  const { workers, cacheDir } = host
  // Lanes that execute upstream's built code wait for a build when it is missing or stale, instead of failing every scenario on it.
  const built = host.staleRuntime.length > 0 ? ['build:artifacts'] : []
  const checks: Draft[] = [
    { id: 'boundary', group: 'boundary', title: 'Every difference from upstream is fork-owned or a listed patch', cwd: '', command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/check-fork-boundary.ts'], needs: [], inputs: ['**'], tiers: ['changed', 'full'], cpus: 1 },
  ]
  for (const gate of host.gates) {
    checks.push({
      id: gate.id,
      group: 'gates',
      title: gate.title,
      cwd: '',
      command: [...gate.command],
      needs: [],
      ...gate.inputs === undefined ? {} : { inputs: gate.inputs },
      tiers: gate.staged === true ? ['pre-commit', 'changed', 'full'] : ['changed', 'full'],
      cpus: 1,
    })
  }
  checks.push(
    { id: 'whitespace:staged', group: 'whitespace', title: 'No whitespace error in the staged changes (`git diff --cached --check`)', cwd: '', command: ['git', 'diff', '--cached', '--check', '--'], needs: [], tiers: ['pre-commit'], cpus: 1 },
    { id: 'jsdoc', group: 'docs', title: 'Upstream\'s JSDoc rules over every export of the fork\'s sources (`delo/**/src`)', cwd: '', command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/check-jsdoc.ts'], needs: [], inputs: FORK_CODE, tiers: ['changed', 'full'], cpus: 1 },
    { id: 'typecheck:upstream', group: 'typecheck', title: 'Upstream\'s incremental typecheck (`pnpm run typecheck`), whose declarations the fork\'s programs read', cwd: '', command: ['pnpm', 'run', '--silent', 'typecheck'], needs: [], inputs: UPSTREAM_CODE, tiers: ['changed', 'full'], cpus: 2 },
  )
  for (const program of tree.programs) {
    const label = programLabel(program.config)
    checks.push({
      id: `typecheck:delo:${label}`,
      group: 'typecheck',
      title: `\`${program.config}\``,
      cwd: '',
      command: [TSC, '--noEmit', '-p', program.config, '--incremental', '--tsBuildInfoFile', `${cacheDir}/tsbuildinfo/${label}.tsbuildinfo`],
      needs: ['typecheck:upstream'],
      inputs: FORK_CODE,
      tiers: ['changed', 'full'],
      cpus: 1,
    })
  }
  if (built.length > 0) {
    const [first = ''] = host.staleRuntime
    checks.push({ id: 'build:artifacts', group: 'generate', title: `Upstream's runtime bundles (\`pnpm run build:artifacts\`): ${String(host.staleRuntime.length)} reason(s), such as ${first}`, cwd: '', command: ['pnpm', 'run', '--silent', 'build:artifacts'], needs: [], tiers: ['changed', 'full'], cpus: 4 })
  }
  checks.push(
    { id: 'generate:native', group: 'generate', title: 'The host\'s native system addon, which upstream\'s suite loads (`pnpm run build:native-system`)', cwd: '', command: ['pnpm', 'run', '--silent', 'build:native-system'], needs: [], tiers: [], cpus: 2 },
    {
      id: 'tests:fork',
      group: 'tests',
      title: 'Every `delo/apps/*/tests` and `delo/packages/*/tests` spec (`delo/vitest.config.ts`)',
      cwd: '',
      command: [VITEST, 'run', '--config', FORK_CONFIG, `--maxWorkers=${String(workers.fork)}`],
      needs: built,
      inputs: ['delo/**', ...UPSTREAM_CODE],
      env: TEST_ENV,
      tiers: ['changed', 'full'],
      cpus: workers.fork,
    },
    {
      id: 'tests:upstream-changed',
      group: 'tests',
      title: 'The specs of each changed upstream package and, within a spec budget, of its direct dependents',
      cwd: '',
      command: [VITEST, 'run', '--config', UPSTREAM_CONFIG, `--maxWorkers=${String(Math.min(workers.upstream, UPSTREAM_CHANGED_WORKERS))}`, '--passWithNoTests'],
      // Upstream's setting for lanes on shared hosts: it raises the default test, hook and expect.poll timeouts together, which its process- and Git-heavy specs need at this parallelism.
      environment: { DSH_COVERAGE_TEST_TIMEOUT_MS: '30000' },
      inputs: UPSTREAM_CODE,
      env: TEST_ENV,
      needs: built,
      tiers: ['changed'],
      cpus: Math.min(workers.upstream, UPSTREAM_CHANGED_WORKERS),
    },
    {
      id: 'tests:snapshots',
      group: 'tests',
      title: 'Upstream\'s keyless recorded-session replay (`pnpm run test:snapshot`), which Delo\'s upstream patches must keep passing',
      cwd: '',
      command: ['pnpm', 'run', '--silent', 'test:snapshot'],
      environment: { DSH_SNAPSHOT_MAX_CONCURRENCY: String(SNAPSHOT_CONCURRENCY) },
      needs: built,
      tiers: ['changed', 'full'],
      cpus: SNAPSHOT_CONCURRENCY,
    },
  )
  return checks
}

function matches(check: Check, names: readonly string[]): boolean {
  return names.some(name => check.id === name || check.group === name || check.id.startsWith(`${name}:`))
}

/**
 * The fork packages a set of packages reaches through their dependents.
 * @param packages - every fork package.
 * @param names - the packages a change touched.
 * @returns those packages and every package that depends on one of them, directly or not.
 */
export function withDependents(packages: readonly ForkPackage[], names: ReadonlySet<string>): Set<string> {
  const reached = new Set(names)
  let grew = true
  while (grew) {
    grew = false
    for (const pkg of packages) {
      if (!reached.has(pkg.name) && pkg.forkDependencies.some(dependency => reached.has(dependency))) {
        reached.add(pkg.name)
        grew = true
      }
    }
  }
  return reached
}

/**
 * Whether an upstream-owned path can change what upstream's built code does:
 * not documentation, translations, agent notes or a spec file. A recorded
 * scenario or its harness under `snapshots/` always counts.
 * @param path - a repository-relative path outside `delo/`.
 * @returns true when the recorded-session replay should run for it.
 */
export function affectsUpstreamRuntime(path: string): boolean {
  if (path.startsWith('snapshots/')) return true
  if (/^(?:docs|website|\.agents|\.github)\//.test(path)) return false
  if (/\.(?:md|i18n\.yaml)$/.test(path)) return false
  return !/(?:^|\/)tests\/|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)
}

/**
 * The upstream package directories whose specs the changed-upstream lane
 * runs: each package a path lies in and, when their specs fit
 * {@link UPSTREAM_CHANGED_SPEC_BUDGET}, every package that depends on one of
 * them directly.
 * @param upstream - upstream's packages.
 * @param paths - repository-relative changed paths.
 * @returns the directories, with a trailing slash, and whether the direct dependents are among them.
 */
export function upstreamSpecDirs(upstream: readonly UpstreamPackage[], paths: readonly string[]): { dirs: string[], dependents: boolean } {
  const changed = upstream.filter(pkg => paths.some(path => path.startsWith(`${pkg.dir}/`)))
  if (changed.length === 0) return { dirs: [], dependents: false }
  const names = new Set(changed.map(pkg => pkg.name))
  const direct = upstream.filter(pkg => !names.has(pkg.name) && pkg.dependencies.some(dependency => names.has(dependency)))
  const specs = [...changed, ...direct].reduce((sum, pkg) => sum + pkg.specs, 0)
  const dependents = specs <= UPSTREAM_CHANGED_SPEC_BUDGET
  return { dirs: (dependents ? [...changed, ...direct] : changed).map(pkg => `${pkg.dir}/`), dependents }
}

/**
 * Upstream packages and every upstream package that depends on one of them
 * at runtime, directly or not. Development dependencies do not carry a
 * change further than the depending package's own tests.
 * @param upstream - upstream's packages.
 * @param names - the packages a change touched.
 * @returns their names, the touched ones included.
 */
export function upstreamDependents(upstream: readonly UpstreamPackage[], names: ReadonlySet<string>): Set<string> {
  const reached = new Set(names)
  let grew = true
  while (grew) {
    grew = false
    for (const pkg of upstream) {
      if (!reached.has(pkg.name) && pkg.runtimeDependencies.some(dependency => reached.has(dependency))) {
        reached.add(pkg.name)
        grew = true
      }
    }
  }
  return reached
}

/**
 * The fork package directory a path lies in.
 * @param path - a repository-relative path.
 * @returns such as `delo/apps/cell`, or undefined outside `delo/apps` and `delo/packages`.
 */
export function packageDirOf(path: string): string | undefined {
  return /^delo\/(?:apps|packages)\/[^/]+/.exec(path)?.[0]
}

/**
 * The checks a selection picks, with their reasons, in catalog order. A
 * selected check's needs are selected too unless `skip` names them, in which
 * case the check runs on what the earlier runs left.
 * @param checks - the catalog.
 * @param tree - the fork's packages, for dependents.
 * @param selection - targets or changes and the `--only` and `--skip` filters.
 * @returns the plan.
 */
export function select(checks: readonly Check[], tree: ForkTree, selection: Selection): Planned[] {
  const picked = new Map<string, string>()
  const pick = (check: Check, reason: string): void => {
    if (!picked.has(check.id)) picked.set(check.id, reason)
  }
  const paths = selection.changed?.paths ?? selection.targets
  const everything = paths.length === 0 && selection.changed === undefined
  // An upstream package's code reaches only the fork packages that depend on it, directly or through other upstream packages. Any other code outside delo/ (root configuration, scripts, vendor) reaches everything; upstream's documentation, notes and recorded scenarios reach no fork check.
  const upstreamOf = (path: string): UpstreamPackage | undefined => tree.upstream.find(pkg => path.startsWith(`${pkg.dir}/`))
  const upstreamTouched = new Set(paths.filter(path => !path.startsWith('delo/') && affectsUpstreamRuntime(path)).flatMap(path => upstreamOf(path)?.name ?? []))
  const upstreamReached = upstreamDependents(tree.upstream, upstreamTouched)
  const viaUpstream = tree.packages.filter(pkg => pkg.upstreamDependencies.some(dependency => upstreamReached.has(dependency))).map(pkg => pkg.name)
  const forkWide = paths.filter(path => path.startsWith('delo/') ? FORK_WIDE.some(prefix => path.startsWith(prefix)) : upstreamOf(path) === undefined && affectsUpstreamRuntime(path) && !path.startsWith('snapshots/'))
  const touchedDirs = new Set(paths.map(packageDirOf).filter(dir => dir !== undefined))
  const touchedPackages = new Set([...tree.packages.filter(pkg => touchedDirs.has(pkg.dir)).map(pkg => pkg.name), ...viaUpstream])
  const reached = withDependents(tree.packages, touchedPackages)
  const reachedDirs = new Set(tree.packages.filter(pkg => reached.has(pkg.name)).map(pkg => pkg.dir))

  for (const check of checks) {
    if (everything) {
      // The full gate runs every upstream spec through its own lane only when it is named; `tests:upstream-changed` is a change's lane.
      if (check.tiers.includes('full')) pick(check, 'the full gate')
      continue
    }
    if (!check.tiers.includes('changed')) continue
    if (check.id === 'boundary') pick(check, 'always: it reads everything that differs from upstream in seconds')
    else if (check.group === 'gates') pick(check, 'always: a repository gate reads the change in seconds')
    else if (check.id === 'jsdoc' && (touchedDirs.size > 0 || forkWide.length > 0)) pick(check, 'a fork package\'s sources may have changed')
    else if (check.id === 'typecheck:upstream') {
      if (forkWide.length > 0) pick(check, `a fork-wide change (${forkWide[0] ?? ''})`)
      else if (upstreamTouched.size > 0 || reachedDirs.size > 0) pick(check, upstreamTouched.size > 0 ? `an upstream package changed (${[...upstreamTouched][0] ?? ''})` : 'the fork programs it gates read its declarations')
    } else if (check.group === 'typecheck') {
      if (forkWide.length > 0) pick(check, `a fork-wide change (${forkWide[0] ?? ''})`)
      else {
        const dir = packageDirOf(check.command[check.command.indexOf('-p') + 1] ?? '')
        if (dir !== undefined && reachedDirs.has(dir)) pick(check, touchedDirs.has(dir) ? `a change under ${dir}` : `${dir} depends on a changed package`)
      }
    } else if (check.id === 'tests:fork' && (touchedDirs.size > 0 || forkWide.length > 0 || viaUpstream.length > 0)) {
      pick(check, selection.changed === undefined ? 'specs under the targets' : 'specs of the packages a change reaches, dependents included')
    } else if (check.id === 'tests:snapshots') {
      const upstream = paths.find(path => !path.startsWith('delo/') && affectsUpstreamRuntime(path))
      if (upstream !== undefined) pick(check, `upstream-owned code changed (${upstream})`)
    } else if (check.id === 'tests:upstream-changed') {
      const { dirs, dependents } = upstreamSpecDirs(tree.upstream, paths.filter(path => !path.startsWith('delo/') && !/\.(?:md|i18n\.yaml)$/.test(path)))
      if (dirs.length > 0) pick(check, dependents ? `${String(dirs.length)} upstream package(s): the changed ones and their direct dependents` : `the changed upstream package(s) only; their direct dependents exceed ${String(UPSTREAM_CHANGED_SPEC_BUDGET)} spec files and run in upstream's full suite`)
    }
  }
  for (const check of checks) {
    if (selection.only.length > 0 && matches(check, selection.only)) pick(check, '--only')
  }

  const kept = (check: Check): boolean => picked.has(check.id) && (selection.only.length === 0 || matches(check, selection.only)) && !matches(check, selection.skip)
  const plan = new Map<string, Planned>()
  const add = (check: Check, reason: string): void => {
    if (plan.has(check.id)) return
    const required = check.needs.flatMap(need => checks.filter(candidate => candidate.id === need && !matches(candidate, selection.skip)))
    for (const need of required) add(need, `needed by ${check.id}`)
    plan.set(check.id, { ...narrowed(check, selection, paths, forkWide.length > 0 ? undefined : [...reachedDirs].map(dir => `${dir}/`), tree.upstream), needs: required.map(need => need.id), reason })
  }
  for (const check of checks) {
    if (kept(check)) add(check, picked.get(check.id) ?? '')
  }
  return checks.flatMap(check => {
    const planned = plan.get(check.id)
    return planned === undefined ? [] : [planned]
  })
}

/**
 * The checks the pre-commit tier runs: each one with the tier, over the staged paths the runner appends to its command.
 * With no staged path a check is declined, since the whole tree is not what a commit changes.
 * @param checks - the catalog.
 * @param staged - the staged paths, repository-relative.
 * @returns the pre-commit checks, in catalog order.
 */
export function selectPreCommit(checks: readonly Check[], staged: readonly string[]): Planned[] {
  return checks.filter(check => check.tiers.includes('pre-commit')).map(check => ({
    ...check,
    command: staged.length === 0 ? check.command : [...check.command, ...staged],
    ...staged.length === 0 ? { declined: 'no staged file to check' } : {},
    reason: 'the staged paths',
  }))
}

/**
 * A check narrowed to the selection. The fork suite runs the packages a change reaches, dependents included, by
 * directory, and the packages of the targets for targets; the changed-upstream lane runs the directories of the
 * changed upstream packages and their direct dependents.
 * @param check - the check.
 * @param selection - the selection.
 * @param paths - the changed or targeted paths.
 * @param reachedDirs - the fork package directories the change reaches, with a trailing slash; undefined after a fork-wide change, which runs every spec.
 * @param upstream - upstream's packages.
 * @returns the check, with its command narrowed where the selection narrows it.
 */
function narrowed(check: Check, selection: Selection, paths: readonly string[], reachedDirs: readonly string[] | undefined, upstream: readonly UpstreamPackage[]): Check {
  if (check.id === 'tests:upstream-changed') {
    const { dirs } = upstreamSpecDirs(upstream, paths.filter(path => !path.startsWith('delo/')))
    // With no directory it would run every upstream spec, which the full gate does not run in this lane.
    return dirs.length === 0 ? { ...check, declined: 'no upstream package changed' } : { ...check, command: [...check.command, ...dirs] }
  }
  if (check.id !== 'tests:fork') return check
  if (selection.changed !== undefined) {
    return reachedDirs === undefined || reachedDirs.length === 0 ? check : { ...check, command: [...check.command, ...reachedDirs] }
  }
  if (paths.length === 0) return check
  const filters = [...new Set(paths.flatMap(path => {
    // A spec file runs as itself; any other path, a test helper among them, stands for its package's specs.
    if (/\.spec\.tsx?$/.test(path)) return [path]
    const dir = packageDirOf(path)
    return dir === undefined ? [] : [`${dir}/`]
  }))]
  return filters.length === 0 ? check : { ...check, command: [...check.command, ...filters] }
}

/**
 * How long each check's longest chain of dependents takes, from the last
 * run's durations: the check's own time plus the longest chain that waits for
 * it. The runner starts the longest chains first, so a check that gates a
 * long suite, or is one, does not wait behind short ones.
 * @param plan - the checks.
 * @param seconds - the last run's durations by id; a check without one counts one second.
 * @returns the chain time by id.
 */
export function criticalPath(plan: readonly Check[], seconds: Readonly<Record<string, number>>): Map<string, number> {
  const chain = new Map<string, number>()
  const visit = (check: Check): number => {
    const known = chain.get(check.id)
    if (known !== undefined) return known
    const dependents = plan.filter(candidate => candidate.needs.includes(check.id))
    const total = (seconds[check.id] ?? 1) + Math.max(0, ...dependents.map(visit))
    chain.set(check.id, total)
    return total
  }
  for (const check of plan) visit(check)
  return chain
}
