/**
 * The fork's checks as a plan: which checks exist, the command each runs,
 * what each waits for, and which ones a selection picks. Pure: `run-checks.ts`
 * reads the tree, git and the machine and passes the facts in, so selection
 * is tested without a checkout.
 *
 * @module @delorun/tools/checks/plan
 */
import { PARITY_OVERLAY_PATH } from '@delorun/contract-parity-composition'
import { selectWebLane, WEB_CHECK_ID, WEB_LANE_MODULE, type WebSelection, type WebSpec } from './web.ts'
import { CLOSURE_CHECK_ID, CLOSURE_LANE_MODULE } from './closure.ts'
import type { GateCheck } from './types.ts'

/** Upstream and Delorun sources the website's studio replica builds from, so a change to one rebuilds the site. */
const REPLICA_INPUTS = [
  ...['ui-primitives', 'ui-approval', 'ui-conversation', 'ui-chat', 'ui-theme', 'ui-sidebar'].map(name => `packages/client/${name}/src/**`),
  ...['plugin-changes', 'bundle-local', 'plugin-theme', 'plugin-settings-layout'].map(name => `delorun/packages/${name}/src/**`),
] as const

/** The path prefixes of {@link REPLICA_INPUTS}, so a change to a file the replica builds from selects the website check. */
const REPLICA_PREFIXES = REPLICA_INPUTS.map(input => input.replace(/\*\*$/, ''))

/**
 * The invocations that select a check: `pre-commit` runs the staged paths, `changed` selects by change (`--changed`
 * and the pre-push hook), and `full` is the full gate. A check with no tier runs only when `--only` names it.
 */
export type Tier = 'pre-commit' | 'changed' | 'full'

/**
 * How much of a change's checks a run pays for. The `lane` tier is what a push of a non-trunk branch runs by default: the
 * mechanical rules ({@link laneKeeps}), the typecheck of the changed packages and their own specs. The `agent` tier is what
 * a lane's agent runs while it works, and a push with `DELORUN_TIER=agent`: every selected check except the merge-only ones.
 * The `merge` tier adds the merge-only checks, and only its pass lets a commit reach the trunk.
 */
export type GateTier = 'lane' | 'agent' | 'merge'

/**
 * Whether the lane tier keeps a check: the boundary check, the JSDoc rules, every repository gate but the ones marked
 * {@link Check.laneLeftOut} or {@link Check.mergeOnly}, the typecheck of
 * a Delorun program in a changed package, and the fork suite when a package changed. Every other check is left to the agent
 * and merge tiers; a kept check's needs are still planned.
 * @param check - the check.
 * @param touchedDirs - the fork package directories a path of the change lies in.
 * @returns true when the lane tier runs it.
 */
export function laneKeeps(check: Check, touchedDirs: ReadonlySet<string>): boolean {
  if (check.id === 'boundary' || check.id === 'jsdoc') return true
  if (check.group === 'gates') return check.laneLeftOut !== true && check.mergeOnly !== true
  if (check.group === 'typecheck') {
    const dir = packageDirOf(String(check.command[check.command.indexOf('-p') + 1]))
    return dir !== undefined && touchedDirs.has(dir)
  }
  return (check.id === 'tests:fork' || check.id.startsWith('tests:fork:')) && touchedDirs.size > 0
}

/** One check's budget from `budgets.json`. */
export interface BudgetEntry {
  /** Resident memory at the check's peak, in GiB; multiplied by its CPUs when `perWorker` is set. */
  readonly memoryGiB: number
  readonly perWorker?: boolean | undefined
  /** Run with no other check beside it. */
  readonly exclusive?: boolean | undefined
  /** Wall-clock budget in seconds; the check's own command reports a run over it. */
  readonly seconds?: number | undefined
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
  /**
   * True when the command does not start through pnpm but runs specs that start pnpm themselves, which need the
   * environment `pnpm run` gives a script ({@link readsPnpmScriptEnvironment}).
   */
  readonly pnpmScript?: boolean
  /** Runs only in the merge tier and the full gate, or when `--only` names it; the agent tier leaves it out. */
  readonly mergeOnly?: true
  /** A repository gate that takes minutes rather than seconds, which the lane tier leaves to the agent and merge tiers. */
  readonly laneLeftOut?: true
  /** The tiers that select the check by default. */
  readonly tiers: readonly Tier[]
  /** The CPUs it keeps busy, which the runner budgets. */
  readonly cpus: number
  /** Its resident memory at its peak, in bytes, which the runner budgets against the run's ceiling. */
  readonly memoryBytes: number
  /** Run with no other check beside it. */
  readonly exclusive?: boolean
  /**
   * Why the runner does not run it: this host cannot, or the selection leaves it nothing to run. The runner reports it
   * declined, which fails no run unless {@link Check.declinedByHost} marks a merge-only check in the merge tier.
   */
  readonly declined?: string
  /**
   * True when {@link Check.declined} is a limit of this host (no Docker engine answers, the closure lane on a host
   * other than `linux-x64`, or the product website without the pictures it builds from) and not an empty selection. A
   * merge-only check declined for it never ran, so in the merge tier the run fails instead of passing without it.
   */
  readonly declinedByHost?: true
  /** True when the verdict reads commits beyond the tree; a tree pass covers the check only at the same HEAD and range base. */
  readonly history?: boolean
  /** What a narrowed check runs over: the paths or package directories its command appends. Absent when the command is whole. */
  readonly scope?: readonly string[]
  /** What a bounded selection ran in place of everything the change reached, which `--plan` and the run's summary print. */
  readonly bounded?: string
  /** The budget the memory and exclusivity came from; the cache key includes it. */
  readonly budget: BudgetEntry
}

/** A fork workspace package. */
export interface ForkPackage {
  readonly name: string
  /** Repository-relative directory, such as `delorun/packages/pricing`. */
  readonly dir: string
  /** The `@delorun/` packages it depends on, in any dependency section. */
  readonly forkDependencies: readonly string[]
  /** The `@deepseek-ai/` packages it depends on, in any dependency section. */
  readonly upstreamDependencies: readonly string[]
  /** Whether it is a pnpm workspace of its own, with its own lockfile: its tsconfigs are not the fork's programs. */
  readonly ownWorkspace: boolean
  /** Whether its `tests/` holds Docker specs (`*.docker.spec.ts`), which the Docker lane runs. */
  readonly dockerSpecs?: boolean
  /** The runtime files its `build` script writes, from {@link declaredBuildOutputs}; absent when it declares no build or no output. */
  readonly buildOutputs?: readonly string[]
}

/** A Delorun package whose built output is missing or older than its sources. */
export interface StaleDelorunBuild {
  /** The package name, which the build check filters on. */
  readonly name: string
  /** Why it is stale, for the check's title. */
  readonly reason: string
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
  /** True when a `security` ledger entry lies in the package: a change to it always runs its direct dependents' specs in the merge tier. */
  readonly security?: boolean
}

/** What the runner found in the tree. */
export interface ForkTree {
  readonly packages: readonly ForkPackage[]
  readonly programs: readonly Program[]
  /** Upstream's packages, for running the specs of a changed upstream package and its direct dependents. */
  readonly upstream: readonly UpstreamPackage[]
  /** The web browser lane's inventory, from `checks/web.ts`; absent in a tree without one, so the lane is never reached. */
  readonly webSpecs?: readonly WebSpec[] | undefined
  /** Whether the tree holds the journey spec, {@link JOURNEY_SPEC}; absent counts as not, and the check is not offered. */
  readonly journey?: boolean | undefined
}

/** The test runners' worker counts. */
export interface Workers {
  /** The fork suite's unit workers; the integration phase takes at most {@link FORK_INTEGRATION_WORKERS} of them. */
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
  /** Delorun packages that declare a build and whose output is missing or older than their sources, from {@link staleDelorunBuilds}. Upstream's `build:artifacts` does not build them, so they get their own check, `build:delorun`. Absent counts as none. */
  readonly staleDelorunBuilds?: readonly StaleDelorunBuild[]
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
  /** The tier of a change run. Absent or `merge` selects every merge-only check a change reaches; `agent` leaves them out unless `only` names them; `lane` keeps only what {@link laneKeeps} keeps, over the changed packages without their dependents. The full gate ignores it. */
  readonly tier?: GateTier
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
const FORK_CONFIG = 'delorun/vitest.config.ts'
const DOCKER_CONFIG = 'delorun/vitest.docker.config.ts'
/** The Docker lane's id. */
export const DOCKER_CHECK_ID = 'tests:docker'
/** The journey check's id. */
export const JOURNEY_CHECK_ID = 'journey'
/** The journey's one spec, which `delorun/vitest.docker.config.ts` runs alone under `DELORUN_JOURNEY=1` and leaves out of the Docker lane. */
export const JOURNEY_SPEC = 'delorun/apps/release/tests/journey/journey.docker.spec.ts'
/** The checks that need the Docker engine of the active context, which the runner declines while none answers. */
const ENGINE_CHECKS: readonly string[] = [DOCKER_CHECK_ID, JOURNEY_CHECK_ID]
// Upstream's own unit configuration, unchanged: the fork's WSL wrapper for it is not part of this tree.
const UPSTREAM_CONFIG = 'vitest.config.ts'
// Upstream's own default for the replay's scenarios at once. Ten at once measured 92 s against 110 s for five, bound by the largest scenario file, for 3.7 GB more memory.
const SNAPSHOT_CONCURRENCY = 5
/**
 * The most spec files the changed-upstream lane runs to include a changed
 * package's direct dependents. A package with 39 direct dependents measured
 * 643 spec files and 185 s; the median package has 3. Above the budget the
 * lane runs the changed packages' own specs and leaves the dependents to
 * upstream's full suite. A `security` package's dependents are exempt in the
 * merge tier ({@link upstreamSpecDirs}).
 */
export const UPSTREAM_CHANGED_SPEC_BUDGET = 150
// The changed-upstream lane's workers: path-filtered runs measured well inside this beside the compilers.
const UPSTREAM_CHANGED_WORKERS = 8
/** The fork suite's unit phase: the `fork` and `fork-client` projects of `delorun/vitest.config.ts`. */
export const FORK_UNIT_ID = 'tests:fork'
/** The fork suite's integration phase: the `fork-integration` project, after the unit phase. */
export const FORK_INTEGRATION_ID = 'tests:fork:integration'
/** Both phases of the fork suite, which the selection narrows alike. */
const FORK_SUITE_IDS: ReadonlySet<string> = new Set([FORK_UNIT_ID, FORK_INTEGRATION_ID])
/**
 * The integration phase's most workers. Each worker's specs start git, Node and `tsx` children or write real file
 * trees, so a worker uses more than one CPU and much of the disk. At this bound, three runs of the phase on a 22-CPU
 * host with eight CPUs kept busy and the disk at up to 48 % IO pressure had no test timeout, where the same specs
 * among 20 workers timed out.
 */
export const FORK_INTEGRATION_WORKERS = 4
// The web lane's CPUs: the artifact build runs eight gate workers, and the specs one browser at a time. The lane runs alone, so the figure sizes only its CPU budget.
const WEB_LANE_CPUS = 8
/** Paths whose change can affect every check: fork-wide test and compiler configuration and the dependency set. */
const FORK_WIDE = ['delorun/vitest.', 'delorun/apps/tools/src/checks/', 'tsconfig', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'vitest.shared.ts']
/** Fork TypeScript and configuration: what a fork program or the fork suite can compile or import. */
const DELORUN_CODE = ['delorun/**/*.ts', 'delorun/**/*.tsx', 'delorun/**/*.json']
/** Upstream code and configuration the upstream and fork compilers and specs read; documentation is left out. */
const UPSTREAM_CODE = ['packages/**', 'apps/**', 'vendor/**', 'native/**', 'scripts/**', 'snapshots/**', '*.json', '*.ts', '*.mjs', '*.yaml']
/** Everything the fork's programs and specs can read. */
const FORK_CODE = [...DELORUN_CODE, ...UPSTREAM_CODE]
/** The variables the fork and upstream test lanes read, through their locale and time zone. */
const TEST_ENV = ['LANG', 'LC_ALL', 'TZ']
/**
 * The documentation website: its own workspace with its own lockfile and installed dependencies, so the fork suite
 * has no specs there and its packages are not reached through it.
 */
export const DOCS_SITE_DIR = 'delorun/apps/docs'
/** The check that builds the documentation website and its dead-link check. */
export const DOCS_SITE_ID = 'docs-site'
/** The product website, which is also its own workspace; it shares its design with the documentation site and reads the changelog record. */
export const WEBSITE_DIR = 'delorun/apps/website'
/** The check that builds the product website and its dead-link check. */
export const WEBSITE_ID = 'website-site'
/**
 * The variable that names the folder of the product website's source pictures, which are not in the repository. The
 * website's own `scripts/pictures-dir.ts` owns the variable and the folder's rules; this names it so the plan can
 * decline the check on a host that has no pictures to build from.
 */
export const WEBSITE_PICTURES_VARIABLE = 'SITE_PICTURES_DIR'

/** The check that the committed `THIRD_PARTY_NOTICES.md` matches what upstream's generator writes from the installed manifests. */
export const NOTICES_ID = 'generated:notices'

/** The check that builds the Delorun packages whose output is missing or older than their sources. */
export const DELORUN_BUILD_ID = 'build:delorun'

/** The check that runs the unit specs with the clock moved forward. */
export const MOVED_CLOCK_ID = 'tests:moved-clock'
// The moved-clock check's workers: it runs the unit specs three times in a row, so a modest pool keeps it beside other work.
const MOVED_CLOCK_WORKERS = 8

/** The parity replay's negative control: a replay with a planted switch left on must fail. */
export const PARITY_CONTROL_ID = 'parity-replay:control'

/** The check that builds the host's native system addon, which upstream's suites load and git ignores. */
export const NATIVE_CHECK_ID = 'generate:native'

/** The wait-time benchmarks against their ceilings, run only on request. */
export const BENCHMARK_CHECK_ID = 'benchmark:delorun'

/**
 * The runtime files a package's build writes, as its manifest declares them: the JavaScript files under `lib/` that its
 * `exports` and `files` name, without a pattern or a declaration file. A package with no `build` script declares none.
 * @param manifest - the `scripts`, `exports` and `files` fields of its `package.json`.
 * @returns the paths relative to the package, such as `lib/index.js`, in first-seen order.
 */
export function declaredBuildOutputs(manifest: { readonly scripts?: Readonly<Record<string, string>> | undefined, readonly exports?: unknown, readonly files?: readonly string[] | undefined }): string[] {
  if (manifest.scripts?.['build'] === undefined) return []
  const named: string[] = []
  const collect = (value: unknown): void => {
    if (typeof value === 'string') named.push(value)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect)
  }
  collect(manifest.exports)
  named.push(...manifest.files ?? [])
  const outputs = named.map(path => path.replace(/^\.\//, '')).filter(path => path.startsWith('lib/') && /\.[cm]?js$/.test(path) && !path.includes('*'))
  return [...new Set(outputs)]
}

/** What {@link staleDelorunBuilds} reads from the file system. */
export interface BuildProbe {
  /** Whether a repository-relative path exists. */
  readonly exists: (path: string) => boolean
  /** The newest modification time under a package's `lib/`, ignoring its declarations; 0 when none. */
  readonly newestOutput: (dir: string) => number
  /** The newest modification time under a package's `src/`; 0 when none. */
  readonly newestSource: (dir: string) => number
}

/**
 * The Delorun packages that declare a build and whose output is missing or older than their sources, so a lane that
 * loads the output (the CLI's start spec, the profile's bundle) would fail on the missing build and not on the change.
 * A package that declares no build or no runtime output is ignored.
 * @param packages - the fork's packages.
 * @param probe - the file system facts.
 * @returns the stale packages, in package order.
 */
export function staleDelorunBuilds(packages: readonly ForkPackage[], probe: BuildProbe): StaleDelorunBuild[] {
  return packages.flatMap((pkg) => {
    const outputs = pkg.buildOutputs ?? []
    if (outputs.length === 0) return []
    const missing = outputs.find(output => !probe.exists(`${pkg.dir}/${output}`))
    if (missing !== undefined) return [{ name: pkg.name, reason: `${pkg.dir}/${missing} is missing` }]
    return probe.newestSource(pkg.dir) > probe.newestOutput(pkg.dir) ? [{ name: pkg.name, reason: `${pkg.dir} is older than its sources` }] : []
  })
}

/**
 * Whether a changed path can change the third-party notices: a manifest, the lockfile, the notices file or its generator.
 * @param path - a changed path, relative to the repository root.
 * @returns whether the notices check must run.
 */
export function affectsNotices(path: string): boolean {
  return path === 'pnpm-lock.yaml' || path === 'package.json' || path.endsWith('/package.json') || path === 'THIRD_PARTY_NOTICES.md' || path.startsWith('scripts/gen-third-party-notices')
}
/** C16's parity overlay, which the parity replay hands to every snapshot adapter through `DSH_SNAPSHOT_PATCH`. */
const PARITY_OVERLAY = { DSH_SNAPSHOT_PATCH: PARITY_OVERLAY_PATH }

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

/**
 * Whether a check needs the environment `pnpm run` gives a script: the repository's pinned pnpm first on `PATH` and
 * as `npm_execpath`, and `pnpm_config_verify_deps_before_run=false`, so a nested pnpm neither resolves another pnpm
 * nor installs before it runs.
 * @param check - the check.
 * @returns true when its command runs pnpm or it is marked {@link Check.pnpmScript}.
 */
export function readsPnpmScriptEnvironment(check: Pick<Check, 'command' | 'pnpmScript'>): boolean {
  return check.command[0] === 'pnpm' || check.pnpmScript === true
}

/** A check before its budget is attached. */
type Draft = Omit<Check, 'budget' | 'memoryBytes'>

/**
 * Every check the tree supports, with its budget from `host.budgets`.
 * @param tree - the fork's packages and programs.
 * @param host - the test runners' CPUs, the compiler cache, the budgets and the repository gates.
 * @returns the checks, in catalog order.
 * @throws Error when a check has no budget in `budgets.json`, by its id, its id family or its group, or when two checks share an id.
 */
export function catalog(tree: ForkTree, host: Host): Check[] {
  const checks = draft(tree, host).map(check => {
    const budget = budgetFor(check.id, check.group, host.budgets)
    if (budget === undefined) throw new Error(`delorun checks: budgets.json gives ${check.id} no memory; add it or its family`)
    return {
      ...check,
      budget,
      memoryBytes: Math.round(budget.memoryGiB * GIB * (budget.perWorker === true ? check.cpus : 1)),
      ...budget.exclusive === true ? { exclusive: true } : {},
    }
  })
  // The scheduler keys results by id, so two checks under one id would silently replace each other.
  const ids = new Set<string>()
  for (const check of checks) {
    if (ids.has(check.id)) throw new Error(`delorun checks: two checks are named ${check.id}; a program's check takes its directory's name, so rename one directory or config`)
    ids.add(check.id)
  }
  return checks
}

// The most specific budget: the id's own entry, then each enclosing family's, such as `typecheck:delorun:tools` → `typecheck:delorun` → `typecheck`, then the group's.
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
  const staleDelorun = host.staleDelorunBuilds ?? []
  // Delorun's packages with a build are not part of upstream's `build:artifacts`; a lane that loads their output needs it too.
  const delorunBuilt = staleDelorun.length > 0 ? [DELORUN_BUILD_ID] : []
  // The lanes that run a suite upstream prepares with `build:native-system` (`pnpm run test`, whose script is that build and
  // `vitest run`, and the snapshot gate that needs the whole build). The addon is git-ignored, so a fresh worktree that ran
  // `setup-worktree.ts` has none, and every scenario fails with `Cannot find module …/system.node`; declaring the build as the
  // lane's need pulls it into the plan whatever the tier selects, and rebuilds it on any later run whose tree lost it.
  const upstreamSuiteNeeds = [NATIVE_CHECK_ID, ...built, ...delorunBuilt]
  const checks: Draft[] = [
    { id: 'boundary', group: 'boundary', title: 'Every difference from upstream is fork-owned, a ledger entry or a path rule', cwd: '', command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-fork-boundary.ts'], needs: [], inputs: ['**'], history: true, tiers: ['changed', 'full'], cpus: 1 },
  ]
  for (const gate of host.gates) {
    checks.push({
      id: gate.id,
      group: 'gates',
      title: gate.title,
      cwd: '',
      command: [...gate.command],
      needs: gate.builtArtifacts === true ? built : [],
      ...gate.inputs === undefined ? {} : { inputs: gate.inputs },
      ...gate.history === true ? { history: true } : {},
      ...gate.environment === undefined ? {} : { environment: gate.environment },
      ...gate.tier === 'agent' ? { laneLeftOut: true } : {},
      ...gate.tier === 'merge' ? { mergeOnly: true } : {},
      tiers: gate.staged === true ? ['pre-commit', 'changed', 'full'] : ['changed', 'full'],
      cpus: 1,
    })
  }
  checks.push(
    { id: 'whitespace:staged', group: 'whitespace', title: 'No whitespace error in the staged changes (`git diff --cached --check`)', cwd: '', command: ['git', 'diff', '--cached', '--check', '--'], needs: [], tiers: ['pre-commit'], cpus: 1 },
    { id: 'jsdoc', group: 'docs', title: 'Upstream\'s JSDoc rules over every export of the fork\'s sources (`delorun/**/src`)', cwd: '', command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-jsdoc.ts'], needs: [], inputs: FORK_CODE, tiers: ['changed', 'full'], cpus: 1 },
    { id: 'typecheck:upstream', group: 'typecheck', title: 'Upstream\'s incremental typecheck (`pnpm run typecheck`), whose declarations the fork\'s programs read', cwd: '', command: ['pnpm', 'run', '--silent', 'typecheck'], needs: [], inputs: UPSTREAM_CODE, tiers: ['changed', 'full'], cpus: 2 },
  )
  for (const program of tree.programs) {
    const label = programLabel(program.config)
    checks.push({
      id: `typecheck:delorun:${label}`,
      group: 'typecheck',
      title: `\`${program.config}\``,
      cwd: '',
      command: [TSC, '--noEmit', '-p', program.config, '--incremental', '--tsBuildInfoFile', `${cacheDir}/tsbuildinfo/${label}.tsbuildinfo`],
      // A program can resolve a built Delorun package to its emitted declarations, which a stale build lacks.
      needs: ['typecheck:upstream', ...delorunBuilt],
      inputs: FORK_CODE,
      tiers: ['changed', 'full'],
      cpus: 1,
    })
  }
  if (built.length > 0) {
    const [first = ''] = host.staleRuntime
    checks.push({ id: 'build:artifacts', group: 'generate', title: `Upstream's runtime bundles (\`pnpm run build:artifacts\`): ${String(host.staleRuntime.length)} reason(s), such as ${first}`, cwd: '', command: ['pnpm', 'run', '--silent', 'build:artifacts'], needs: [], tiers: ['changed', 'full'], cpus: 4 })
  }
  if (staleDelorun.length > 0) {
    checks.push({
      id: DELORUN_BUILD_ID,
      group: 'generate',
      title: `Delorun's built packages (\`pnpm --filter <package> run build\`): ${staleDelorun.map(pkg => `${pkg.name} (${pkg.reason})`).join('; ')}`,
      cwd: '',
      // One package at a time, after upstream's own build whose declarations they read.
      command: ['pnpm', '--silent', '--workspace-concurrency=1', ...staleDelorun.flatMap(pkg => ['--filter', pkg.name]), 'run', 'build'],
      needs: built,
      tiers: ['changed', 'full'],
      cpus: 2,
    })
  }
  checks.push(
    // Builds the site from its own install, so its verdict reads the site's sources, Delorun's pages and the release version it names.
    {
      id: DOCS_SITE_ID,
      group: DOCS_SITE_ID,
      title: 'Delorun\'s documentation website builds, and every internal link and fragment in both locales names a built file or id (`pnpm --dir docs run build`)',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-docs-site.ts'],
      needs: [],
      inputs: [`${DOCS_SITE_DIR}/**`, 'delorun/packages/site-design/**', 'delorun/docs/**', 'delorun/apps/release/package.json'],
      tiers: ['changed', 'full'],
      cpus: 2,
    },
    {
      id: WEBSITE_ID,
      group: DOCS_SITE_ID,
      title: 'Delorun\'s product website builds, and every internal link in it names a built file or id (`pnpm --dir website run build`)',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/check-docs-site.ts', 'website'],
      // The site's type check reaches upstream's client primitives through `@delorun/brand`, which resolve to their built `lib/`.
      needs: built,
      inputs: [`${WEBSITE_DIR}/**`, 'delorun/packages/site-design/**', 'delorun/packages/brand/**', 'delorun/changelog/changelog.json', ...REPLICA_INPUTS],
      tiers: ['changed', 'full'],
      cpus: 2,
    },
    // Upstream's notices spec runs only in upstream's suite, so a Delorun dependency added without regenerating the file passed every other check.
    {
      id: NOTICES_ID,
      group: 'generate',
      title: 'The committed third-party notices match the installed manifests (`scripts/gen-third-party-notices.ts --check`)',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'scripts/gen-third-party-notices.ts', '--check'],
      needs: [],
      inputs: ['pnpm-lock.yaml', '**/package.json', 'THIRD_PARTY_NOTICES.md', 'scripts/gen-third-party-notices.ts'],
      tiers: ['changed', 'full'],
      cpus: 1,
    },
    // No tier selects it: a lane that loads the addon declares it as a need, and `--only generate:native` builds it alone.
    { id: NATIVE_CHECK_ID, group: 'generate', title: 'The host\'s native system addon, which upstream\'s suites load (`pnpm run build:native-system`)', cwd: '', command: ['pnpm', 'run', '--silent', 'build:native-system'], needs: [], tiers: [], cpus: 2 },
    // Timings are meaningless on a loaded machine and a full run takes most of an hour, so no tier selects it: `--only benchmark:delorun`.
    { id: BENCHMARK_CHECK_ID, group: 'benchmark', title: 'Delorun\'s wait-time benchmarks against the ceilings in `delorun/apps/benchmarks/budgets.json` (`pnpm run benchmark:delorun -- --check-budgets`); needs `--prepare` first', cwd: '', command: ['pnpm', 'run', '--silent', 'benchmark:delorun', '--', '--check-budgets'], needs: [], tiers: [], cpus: 4 },
    {
      id: FORK_UNIT_ID,
      group: 'tests',
      title: 'The unit and client component specs under `delorun/apps/*/tests` and `delorun/packages/*/tests` (`delorun/vitest.config.ts`, projects `fork`, `fork-client` and `fork-client-website`)',
      cwd: '',
      // A narrowed run can reach a package whose specs are all integration specs, so a phase with none passes.
      command: [VITEST, 'run', '--config', FORK_CONFIG, '--project', 'fork', '--project', 'fork-client', '--project', 'fork-client-website', `--maxWorkers=${String(workers.fork)}`, '--passWithNoTests'],
      needs: upstreamSuiteNeeds,
      inputs: ['delorun/**', ...UPSTREAM_CODE],
      env: TEST_ENV,
      tiers: ['changed', 'full'],
      cpus: workers.fork,
    },
    // After the unit phase, so its children never compete with the unit phase's workers for the CPUs.
    {
      id: FORK_INTEGRATION_ID,
      group: 'tests',
      title: 'The `*.integration.spec.ts` specs, which start git, Node and `tsx` children (`delorun/vitest.config.ts`, project `fork-integration`)',
      cwd: '',
      command: [VITEST, 'run', '--config', FORK_CONFIG, '--project', 'fork-integration', `--maxWorkers=${String(Math.min(workers.fork, FORK_INTEGRATION_WORKERS))}`, '--passWithNoTests'],
      needs: [...upstreamSuiteNeeds, FORK_UNIT_ID],
      inputs: ['delorun/**', ...UPSTREAM_CODE],
      env: TEST_ENV,
      tiers: ['changed', 'full'],
      cpus: Math.min(workers.fork, FORK_INTEGRATION_WORKERS),
    },
    // No tier selects it: run it with `--only tests:moved-clock` before a release and after a change that adds dated fixtures.
    {
      id: MOVED_CLOCK_ID,
      group: 'tests',
      title: 'The unit and client component specs with `Date` moved forward 2 and 400 days: a test that passes today and fails then compares a fixed date with the clock (`delorun/vitest.moved-clock.config.ts`)',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/checks/moved-clock.ts', `--workers=${String(Math.min(workers.fork, MOVED_CLOCK_WORKERS))}`],
      needs: upstreamSuiteNeeds,
      tiers: [],
      cpus: Math.min(workers.fork, MOVED_CLOCK_WORKERS),
    },
    // Present only in a tree with Docker specs. The specs share the host's one engine, so they run one file at a time.
    ...tree.packages.some(pkg => pkg.dockerSpecs === true)
      ? [{
          id: DOCKER_CHECK_ID,
          mergeOnly: true,
          group: 'tests',
          title: 'Every `*.docker.spec.ts` spec, against the Docker engine of the active context (`delorun/vitest.docker.config.ts`); declined while no engine answers',
          cwd: '',
          command: [VITEST, 'run', '--config', DOCKER_CONFIG, '--passWithNoTests'],
          // The specs run only where the lane says they are required: the opt-in of the image build spec, and the switch that
          // makes the supervisor spec fail instead of skip when the engine or its image digest is missing.
          environment: { DELORUN_DOCKER_SPECS: '1' },
          needs: built,
          inputs: ['delorun/**', ...UPSTREAM_CODE],
          env: TEST_ENV,
          tiers: ['changed', 'full'],
          cpus: 2,
        } satisfies Draft]
      : [],
    // Present only in a tree with the journey spec. It builds a release from the tree's artifacts and runs it in containers,
    // so it waits for every build a stale tree needs and runs alone.
    ...tree.journey === true
      ? [{
          id: JOURNEY_CHECK_ID,
          mergeOnly: true,
          group: JOURNEY_CHECK_ID,
          title: 'The journey: a release built from the tree\'s artifacts, installed through the packed launcher in a clean container that reaches only the spec\'s servers, and walked from setup and a chat through customisation, updates, rollbacks, verify, the trash, export and import (`delorun/apps/release/tests/journey`); declined while no engine answers',
          cwd: '',
          // The verbose reporter names each step's outcome, `it.fails` steps included, in the check's log.
          command: [VITEST, 'run', '--config', DOCKER_CONFIG, '--reporter=verbose'],
          environment: { DELORUN_JOURNEY: '1' },
          needs: [...built, ...delorunBuilt],
          inputs: ['delorun/**', ...UPSTREAM_CODE],
          env: TEST_ENV,
          tiers: ['changed', 'full'],
          cpus: 4,
        } satisfies Draft]
      : [],
    {
      id: 'tests:upstream-changed',
      group: 'tests',
      title: 'The specs of each changed upstream package and, within a spec budget or when it is a security-ledger package, of its direct dependents',
      cwd: '',
      command: [VITEST, 'run', '--config', UPSTREAM_CONFIG, `--maxWorkers=${String(Math.min(workers.upstream, UPSTREAM_CHANGED_WORKERS))}`, '--passWithNoTests'],
      // Upstream's setting for lanes on shared hosts: it raises the default test, hook and expect.poll timeouts together, which its process- and Git-heavy specs need at this parallelism.
      environment: { DSH_COVERAGE_TEST_TIMEOUT_MS: '30000' },
      // Upstream's CI runs its specs through `pnpm run test`; specs that start pnpm in fixtures read that script environment.
      pnpmScript: true,
      inputs: UPSTREAM_CODE,
      env: TEST_ENV,
      needs: upstreamSuiteNeeds,
      tiers: ['changed'],
      cpus: Math.min(workers.upstream, UPSTREAM_CHANGED_WORKERS),
    },
    // The lane has no declared inputs, so it always runs when a change reaches it: its verdict reads the official build, which no cache key covers.
    {
      id: WEB_CHECK_ID,
      mergeOnly: true,
      group: 'tests',
      title: 'The reached Chromium e2e specs under `apps/web/tests`, run after the official client build',
      cwd: '',
      command: ['node_modules/.bin/tsx', WEB_LANE_MODULE],
      needs: [],
      tiers: ['changed'],
      cpus: WEB_LANE_CPUS,
    },
    // A change to what the runtime closure carries can break the release build or the closure itself, which no other lane builds.
    {
      id: CLOSURE_CHECK_ID,
      mergeOnly: true,
      group: 'tests',
      title: 'The `linux-x64` runtime closure of HEAD builds from the built artifacts, and boots, serves the studio and answers `--version` and every top-level command',
      cwd: '',
      command: ['node_modules/.bin/tsx', CLOSURE_LANE_MODULE],
      needs: [...built, ...delorunBuilt],
      inputs: ['delorun/**', ...UPSTREAM_CODE, 'pnpm-lock.yaml'],
      tiers: ['changed', 'full'],
      cpus: 4,
    },
    {
      id: 'tests:snapshots',
      mergeOnly: true,
      group: 'tests',
      title: 'Upstream\'s keyless recorded-session replay (`pnpm run test:snapshot`), which Delorun\'s upstream patches must keep passing',
      cwd: '',
      command: ['pnpm', 'run', '--silent', 'test:snapshot'],
      environment: { DSH_SNAPSHOT_MAX_CONCURRENCY: String(SNAPSHOT_CONCURRENCY) },
      needs: upstreamSuiteNeeds,
      tiers: ['changed', 'full'],
      cpus: SNAPSHOT_CONCURRENCY,
    },
    {
      id: 'parity-switches',
      group: 'parity',
      title: 'C16\'s switch registry against the tree: each switch field, the parity overlay, every model-visible contribution of Delorun code and ledgered upstream edits, and the switch sweep',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/parity/composition/check-parity-switches.ts'],
      needs: [],
      inputs: ['delorun/**', ...UPSTREAM_CODE],
      tiers: ['changed', 'full'],
      cpus: 1,
    },
    // The replay declares no inputs, so it runs whenever a selection picks it: its result is upstream's recorded output against the whole tree.
    {
      id: 'parity-replay',
      mergeOnly: true,
      group: 'parity',
      title: 'Upstream\'s recorded-session replay (`pnpm run test:snapshot`) through C16\'s parity overlay: Delorun with its additions switched off reproduces the base tag\'s expected output',
      cwd: '',
      command: ['pnpm', 'run', '--silent', 'test:snapshot'],
      environment: { ...PARITY_OVERLAY, DSH_SNAPSHOT_MAX_CONCURRENCY: String(SNAPSHOT_CONCURRENCY) },
      needs: upstreamSuiteNeeds,
      tiers: ['changed', 'full'],
      cpus: SNAPSHOT_CONCURRENCY,
    },
    // The replay's negative control, which a spec does not nest: like the replay, it declares no inputs.
    {
      id: PARITY_CONTROL_ID,
      mergeOnly: true,
      group: 'parity',
      title: 'C16\'s `parity replay refuses a model-visible switch left on`: one recorded headless scenario replayed with a planted overlay that leaves `profile_history` on must fail on the request header',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delorun/apps/tools/src/parity/composition/replay-control.ts'],
      needs: upstreamSuiteNeeds,
      tiers: ['changed', 'full'],
      cpus: 1,
    },
  )
  return checks
}

/**
 * Whether a change can alter what the parity replay asserts: Delorun code or configuration, which the overlay, the
 * registry and the switches read, or an upstream path that changes upstream's runtime or its recorded scenarios.
 * @param path - a repository-relative changed path.
 * @returns true when the parity replay should run for it.
 */
export function affectsParity(path: string): boolean {
  if (path.startsWith('delorun/')) return /\.(?:tsx?|json|ya?ml)$/.test(path) && !/\.i18n\.yaml$/.test(path)
  return affectsUpstreamRuntime(path)
}

function matches(check: Check, names: readonly string[]): boolean {
  return names.some(name => check.id === name || check.group === name || check.id.startsWith(`${name}:`))
}

/**
 * The `--only` or `--skip` names that match no check, by id, group or id family. A name that matches none would
 * select nothing or skip nothing, so the runner refuses the run rather than report it as a pass.
 * @param checks - the catalogue.
 * @param names - the names given on the command line or in `DELORUN_PUSH_SKIP`.
 * @returns the names that match no check, in the order given.
 */
export function unknownSelectors(checks: readonly Check[], names: readonly string[]): string[] {
  return names.filter(name => !checks.some(check => matches(check, [name])))
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
 * @param path - a repository-relative path outside `delorun/`.
 * @returns true when the recorded-session replay should run for it.
 */
export function affectsUpstreamRuntime(path: string): boolean {
  if (path.startsWith('snapshots/')) return true
  if (/^(?:docs|website|\.agents|\.github)\//.test(path)) return false
  if (/\.(?:md|i18n\.yaml)$/.test(path)) return false
  return !/(?:^|\/)tests\/|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path)
}

/**
 * What the changed-upstream lane runs for a set of changed paths.
 */
export interface UpstreamSpecSelection {
  /** The package directories, with a trailing slash. */
  readonly dirs: string[]
  /** Whether the direct dependents are among them. */
  readonly dependents: boolean
  /** True when the dependents are included only because a `security` package changed and the tier is not the agent tier, whatever their spec count. */
  readonly forced?: true
  /** The names of the direct dependents of a changed `security` package that the agent tier left for the merge tier; absent when none were. */
  readonly left?: string[]
}

/**
 * The upstream package directories whose specs the changed-upstream lane
 * runs: each package a path lies in and, when their specs fit
 * {@link UPSTREAM_CHANGED_SPEC_BUDGET}, every package that depends on one of
 * them directly, in any dependency section (a development dependency counts:
 * a spec of the dependent can load the package). A change to a `security`
 * package ({@link UpstreamPackage.security}) always runs its direct dependents,
 * whatever their spec count, except in the agent tier, which leaves the ones
 * over the budget to the merge tier and names them in `left`.
 * @param upstream - upstream's packages.
 * @param paths - repository-relative changed paths.
 * @param tier - the gate tier; absent counts as the merge tier.
 * @returns the directories and what the budget did with the dependents.
 */
export function upstreamSpecDirs(upstream: readonly UpstreamPackage[], paths: readonly string[], tier?: GateTier): UpstreamSpecSelection {
  const changed = upstream.filter(pkg => paths.some(path => path.startsWith(`${pkg.dir}/`)))
  if (changed.length === 0) return { dirs: [], dependents: false }
  const names = new Set(changed.map(pkg => pkg.name))
  const direct = upstream.filter(pkg => !names.has(pkg.name) && pkg.dependencies.some(dependency => names.has(dependency)))
  const specs = [...changed, ...direct].reduce((sum, pkg) => sum + pkg.specs, 0)
  const securityNames = new Set(changed.filter(pkg => pkg.security === true).map(pkg => pkg.name))
  if (specs <= UPSTREAM_CHANGED_SPEC_BUDGET) return { dirs: [...changed, ...direct].map(pkg => `${pkg.dir}/`), dependents: true }
  if (securityNames.size > 0 && tier !== 'agent') return { dirs: [...changed, ...direct].map(pkg => `${pkg.dir}/`), dependents: true, forced: true }
  const left = direct.filter(pkg => pkg.dependencies.some(dependency => securityNames.has(dependency))).map(pkg => pkg.name)
  return { dirs: changed.map(pkg => `${pkg.dir}/`), dependents: false, ...left.length === 0 ? {} : { left } }
}

/**
 * The upstream packages a `security` ledger entry lies in, marked on the inventory.
 * @param upstream - upstream's packages.
 * @param patches - the ledger's entries, of every class.
 * @returns the packages, each with `security` set where a `security` entry's path lies under its directory.
 */
export function withSecurityPackages(upstream: readonly UpstreamPackage[], patches: readonly { readonly path: string, readonly class: string }[]): UpstreamPackage[] {
  const securityPaths = patches.filter(patch => patch.class === 'security').map(patch => patch.path)
  return upstream.map(pkg => securityPaths.some(path => path.startsWith(`${pkg.dir}/`)) ? { ...pkg, security: true } : pkg)
}

/**
 * The direct dependents of a changed `security` upstream package that the agent tier leaves to the merge tier because
 * their specs exceed {@link UPSTREAM_CHANGED_SPEC_BUDGET}, for the plan to name.
 * @param tree - the fork's packages and upstream's.
 * @param selection - the selection; only an `agent` tier change leaves any out.
 * @returns one line naming the dependents, or an empty list.
 */
export function dependentsLeftForMerge(tree: ForkTree, selection: Selection): string[] {
  if (selection.tier !== 'agent' || selection.changed === undefined) return []
  const { left } = upstreamSpecDirs(tree.upstream, selection.changed.paths.filter(path => !path.startsWith('delorun/') && !/\.(?:md|i18n\.yaml)$/.test(path)), 'agent')
  return left === undefined ? [] : [`specs of the direct dependents of a security-ledger package (${left.join(', ')})`]
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
 * @returns such as `delorun/apps/cell`, or undefined outside `delorun/apps` and `delorun/packages` and for the two websites.
 */
export function packageDirOf(path: string): string | undefined {
  if (path.startsWith(`${DOCS_SITE_DIR}/`) || path.startsWith(`${WEBSITE_DIR}/`)) return undefined
  return /^delorun\/(?:apps|packages)\/[^/]+/.exec(path)?.[0]
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
  const web = selectWebLane(tree.webSpecs ?? [], paths, tree.upstream, everything, selection.tier !== 'agent' && selection.tier !== 'lane')
  // An upstream package's code reaches only the fork packages that depend on it, directly or through other upstream packages. Any other code outside delorun/ (root configuration, scripts, vendor) reaches everything; upstream's documentation, notes and recorded scenarios reach no fork check.
  const upstreamOf = (path: string): UpstreamPackage | undefined => tree.upstream.find(pkg => path.startsWith(`${pkg.dir}/`))
  const upstreamTouched = new Set(paths.filter(path => !path.startsWith('delorun/') && affectsUpstreamRuntime(path)).flatMap(path => upstreamOf(path)?.name ?? []))
  const upstreamReached = upstreamDependents(tree.upstream, upstreamTouched)
  const viaUpstream = tree.packages.filter(pkg => pkg.upstreamDependencies.some(dependency => upstreamReached.has(dependency))).map(pkg => pkg.name)
  const forkWide = paths.filter(path => path.startsWith('delorun/') ? FORK_WIDE.some(prefix => path.startsWith(prefix)) : upstreamOf(path) === undefined && affectsUpstreamRuntime(path) && !path.startsWith('snapshots/'))
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
    if (check.mergeOnly === true && (selection.tier === 'agent' || selection.tier === 'lane')) continue
    if (selection.tier === 'lane' && !laneKeeps(check, touchedDirs)) continue
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
    } else if (FORK_SUITE_IDS.has(check.id) && (touchedDirs.size > 0 || forkWide.length > 0 || viaUpstream.length > 0)) {
      pick(check, selection.changed === undefined ? 'specs under the targets' : 'specs of the packages a change reaches, dependents included')
    } else if (check.id === DOCKER_CHECK_ID) {
      const docker = tree.packages.find(pkg => pkg.dockerSpecs === true && (forkWide.length > 0 || reachedDirs.has(pkg.dir)))
      if (docker !== undefined) pick(check, `Docker specs of a package a change reaches (${docker.dir})`)
    } else if (check.id === JOURNEY_CHECK_ID) {
      // What the installed release runs: Delorun code and configuration, and upstream code that reaches the runtime.
      const release = paths.find(affectsParity)
      if (release !== undefined) pick(check, `${release.startsWith('delorun/') ? 'Delorun code' : 'upstream-owned code'} the installed release runs changed (${release})`)
    } else if (check.id === 'tests:snapshots') {
      const upstream = paths.find(path => !path.startsWith('delorun/') && affectsUpstreamRuntime(path))
      if (upstream !== undefined) pick(check, `upstream-owned code changed (${upstream})`)
    } else if (check.id === NOTICES_ID) {
      const manifest = paths.find(affectsNotices)
      if (manifest !== undefined) pick(check, `a manifest, the lockfile or the notices changed (${manifest})`)
    } else if (check.id === DOCS_SITE_ID) {
      const site = paths.find(path => path.startsWith(`${DOCS_SITE_DIR}/`) || path.startsWith('delorun/packages/site-design/') || path.startsWith('delorun/docs/') || path === 'delorun/apps/release/package.json')
      if (site !== undefined) pick(check, `the documentation site or its pages changed (${site})`)
    } else if (check.id === WEBSITE_ID) {
      const site = paths.find(path => path.startsWith(`${WEBSITE_DIR}/`) || path.startsWith('delorun/packages/site-design/') || path.startsWith('delorun/packages/brand/') || path === 'delorun/changelog/changelog.json' || REPLICA_PREFIXES.some(prefix => path.startsWith(prefix)))
      if (site !== undefined) pick(check, `the product website or the design it shares changed (${site})`)
    } else if (check.id === CLOSURE_CHECK_ID && selection.changed !== undefined) {
      const closure = paths.find(path => affectsParity(path) || path === 'pnpm-lock.yaml')
      if (closure !== undefined) pick(check, `a change reaches what the runtime closure carries (${closure})`)
    } else if (check.group === 'parity' && selection.changed !== undefined) {
      const parity = paths.find(affectsParity)
      if (parity !== undefined) pick(check, `${parity.startsWith('delorun/') ? 'Delorun code' : 'upstream-owned code'} changed (${parity})`)
    } else if (check.id === WEB_CHECK_ID) {
      if (web.reached) pick(check, web.reason)
    } else if (check.id === 'tests:upstream-changed') {
      const { dirs, dependents, forced, left } = upstreamSpecDirs(tree.upstream, paths.filter(path => !path.startsWith('delorun/') && !/\.(?:md|i18n\.yaml)$/.test(path)), selection.tier)
      if (dirs.length > 0) pick(check, forced === true ? `${String(dirs.length)} upstream package(s): the changed ones and the direct dependents of a security-ledger package, whatever their spec count`
        : dependents ? `${String(dirs.length)} upstream package(s): the changed ones and their direct dependents`
          : left === undefined ? `the changed upstream package(s) only; their direct dependents exceed ${String(UPSTREAM_CHANGED_SPEC_BUDGET)} spec files and run in upstream's full suite`
            : `the changed upstream package(s) only; the direct dependents of a security-ledger package exceed ${String(UPSTREAM_CHANGED_SPEC_BUDGET)} spec files and run in the merge tier`)
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
    const suiteDirs = selection.tier === 'lane' ? [...touchedDirs] : forkWide.length > 0 ? undefined : [...reachedDirs]
    plan.set(check.id, { ...narrowed(check, selection, paths, suiteDirs?.map(dir => `${dir}/`), tree.upstream, web), needs: required.map(need => need.id), reason })
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
 * The checks a change reaches in the merge tier that a lighter tier leaves out, for the plan to name: the merge-only ones
 * for the agent tier, and every one the lane tier does not keep.
 * @param checks - the catalog.
 * @param tree - the fork's packages.
 * @param selection - the selection; only the `agent` and `lane` tiers leave anything out.
 * @returns the ids, in catalog order.
 */
export function leftForMerge(checks: readonly Check[], tree: ForkTree, selection: Selection): string[] {
  if (selection.tier !== 'agent' && selection.tier !== 'lane') return []
  const kept = new Set(select(checks, tree, selection).map(check => check.id))
  return select(checks, tree, { ...selection, tier: 'merge' }).filter(check => (selection.tier === 'lane' || check.mergeOnly === true) && !kept.has(check.id)).map(check => check.id)
}

/**
 * Decline the closure lane on a host that cannot build and boot the closure it checks, as a limit of the host, so a
 * merge-tier run fails instead of passing without the closure, as it does for the Docker lane.
 * @param plan - the plan.
 * @param problem - why this host cannot run the lane, from `closureHostProblem`; undefined on a host that can.
 * @returns the plan, with the lane declined for a host limit when there is a problem.
 */
export function declineClosureOffHost(plan: readonly Planned[], problem: string | undefined): Planned[] {
  return plan.map(check => check.id === CLOSURE_CHECK_ID && problem !== undefined ? { ...check, declined: problem, declinedByHost: true } : check)
}

/**
 * Decline the Docker lane and the journey while no engine answers, so a merge-tier run fails instead of passing on
 * specs that skip. Probes once, and only when the plan holds either.
 * @param plan - the plan.
 * @param probe - asks the engine; returns why none answers, or undefined when one does.
 * @returns the plan, with each check that needs the engine declined for a host limit when the probe names a reason.
 */
export function declineUnansweredDocker(plan: readonly Planned[], probe: () => string | undefined): Planned[] {
  if (!plan.some(check => ENGINE_CHECKS.includes(check.id))) return [...plan]
  const reason = probe()
  return plan.map(check => ENGINE_CHECKS.includes(check.id) && reason !== undefined ? { ...check, declined: reason, declinedByHost: true } : check)
}

/**
 * Why this host cannot build the product website: its home page shows real screenshots of the studio, which are not in
 * the repository, so the build reads them from the folder {@link WEBSITE_PICTURES_VARIABLE} names and fails without it.
 * @param env - the environment the check would run with.
 * @param exists - whether a path exists, so the folder's presence is read without touching the filesystem here.
 * @returns the reason, or undefined when the variable names a folder that exists.
 */
export function websitePicturesProblem(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean): string | undefined {
  const value = env[WEBSITE_PICTURES_VARIABLE]
  if (value === undefined || value === '') {
    return `the product website's home page shows real screenshots of the studio, which are not in the repository, so its build needs ${WEBSITE_PICTURES_VARIABLE} to name the folder they are kept in; set it to that folder (for example ~/site-pictures) and run the check again`
  }
  if (!exists(value)) {
    return `${WEBSITE_PICTURES_VARIABLE} names ${value}, which does not exist; set it to the folder of the product website's source pictures and run the check again`
  }
  return undefined
}

/**
 * Decline the product website's check on a host with no pictures to build it from, as a limit of the host rather than a
 * failure of the change: the pictures are not in the repository, so a checkout that never received them cannot build the
 * site, and reporting that as a failed check would blame the change for it.
 * @param plan - the plan.
 * @param problem - why this host cannot build the site, from {@link websitePicturesProblem}; undefined when it can.
 * @returns the plan, with the check declined for a host limit when there is a problem.
 */
export function declineWebsiteWithoutPictures(plan: readonly Planned[], problem: string | undefined): Planned[] {
  return plan.map(check => check.id === WEBSITE_ID && problem !== undefined ? { ...check, declined: problem, declinedByHost: true } : check)
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
 * @param web - the web lane's selection: the specs it runs, or why it runs none.
 * @returns the check, with its command and scope narrowed where the selection narrows it.
 */
function narrowed(check: Check, selection: Selection, paths: readonly string[], reachedDirs: readonly string[] | undefined, upstream: readonly UpstreamPackage[], web: WebSelection): Check {
  if (check.id === WEB_CHECK_ID) return web.declined !== undefined ? { ...check, declined: web.declined } : { ...check, command: [...check.command, ...web.specs], scope: web.specs, ...web.bounded === undefined ? {} : { bounded: web.bounded } }
  if (check.id === 'tests:upstream-changed') {
    const { dirs } = upstreamSpecDirs(upstream, paths.filter(path => !path.startsWith('delorun/')), selection.tier)
    // With no directory it would run every upstream spec, which the full gate does not run in this lane.
    return dirs.length === 0 ? { ...check, declined: 'no upstream package changed' } : { ...check, command: [...check.command, ...dirs], scope: dirs }
  }
  if (check.id === DOCKER_CHECK_ID) return reachedDirs === undefined || reachedDirs.length === 0 ? check : { ...check, command: [...check.command, ...reachedDirs], scope: reachedDirs }
  if (!FORK_SUITE_IDS.has(check.id)) return check
  if (selection.changed !== undefined) {
    return reachedDirs === undefined || reachedDirs.length === 0 ? check : { ...check, command: [...check.command, ...reachedDirs], scope: reachedDirs }
  }
  if (paths.length === 0) return check
  const filters = [...new Set(paths.flatMap(path => {
    // A spec file runs as itself; any other path, a test helper among them, stands for its package's specs.
    if (/\.spec\.tsx?$/.test(path)) return [path]
    const dir = packageDirOf(path)
    return dir === undefined ? [] : [`${dir}/`]
  }))]
  return filters.length === 0 ? check : { ...check, command: [...check.command, ...filters], scope: filters }
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
