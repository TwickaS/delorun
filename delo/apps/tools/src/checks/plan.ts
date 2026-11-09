/**
 * The fork's checks as a plan: which checks exist, the command each runs,
 * what each waits for, and which ones a selection picks. Pure: `run-checks.ts`
 * reads the tree, git and the machine and passes the facts in, so selection
 * is tested without a checkout.
 *
 * @module @delo/tools/checks/plan
 */
import { PARITY_OVERLAY_PATH } from '@delo/contract-parity-composition'
import { selectWebLane, WEB_CHECK_ID, WEB_LANE_MODULE, type WebSelection, type WebSpec } from './web.ts'
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
  /** True when the verdict reads commits beyond the tree; a tree pass covers the check only at the same HEAD and range base. */
  readonly history?: boolean
  /** What a narrowed check runs over: the paths or package directories its command appends. Absent when the command is whole. */
  readonly scope?: readonly string[]
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
  /** Whether its `tests/` holds Docker specs (`*.docker.spec.ts`), which the Docker lane runs. */
  readonly dockerSpecs?: boolean
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
  /** The web browser lane's inventory, from `checks/web.ts`; absent in a tree without one, so the lane is never reached. */
  readonly webSpecs?: readonly WebSpec[] | undefined
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
const DOCKER_CONFIG = 'delo/vitest.docker.config.ts'
/** The Docker lane's id. */
export const DOCKER_CHECK_ID = 'tests:docker'
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
// The web lane's CPUs: the artifact build runs eight gate workers, and the specs one browser at a time. The lane runs alone, so the figure sizes only its CPU budget.
const WEB_LANE_CPUS = 8
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
 * The documentation website: its own workspace with its own lockfile and installed dependencies, so the fork suite
 * has no specs there and its packages are not reached through it.
 */
export const DOCS_SITE_DIR = 'delo/apps/docs'
/** The check that builds the documentation website and its dead-link check. */
export const DOCS_SITE_ID = 'docs-site'

/** The check that the committed `THIRD_PARTY_NOTICES.md` matches what upstream's generator writes from the installed manifests. */
export const NOTICES_ID = 'generated:notices'

/** The check that builds the host's native system addon, which upstream's suites load and git ignores. */
export const NATIVE_CHECK_ID = 'generate:native'

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
    if (budget === undefined) throw new Error(`delo checks: budgets.json gives ${check.id} no memory; add it or its family`)
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
    if (ids.has(check.id)) throw new Error(`delo checks: two checks are named ${check.id}; a program's check takes its directory's name, so rename one directory or config`)
    ids.add(check.id)
  }
  return checks
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
  // The lanes that run a suite upstream prepares with `build:native-system` (`pnpm run test`, whose script is that build and
  // `vitest run`, and the snapshot gate that needs the whole build). The addon is git-ignored, so a fresh worktree that ran
  // `setup-worktree.ts` has none, and every scenario fails with `Cannot find module …/system.node`; declaring the build as the
  // lane's need pulls it into the plan whatever the tier selects, and rebuilds it on any later run whose tree lost it.
  const upstreamSuiteNeeds = [NATIVE_CHECK_ID, ...built]
  const checks: Draft[] = [
    { id: 'boundary', group: 'boundary', title: 'Every difference from upstream is fork-owned or a listed patch', cwd: '', command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/check-fork-boundary.ts'], needs: [], inputs: ['**'], history: true, tiers: ['changed', 'full'], cpus: 1 },
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
      ...gate.history === true ? { history: true } : {},
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
    // Builds the site from its own install, so its verdict reads the site's sources, Delo's pages and the release version it names.
    {
      id: DOCS_SITE_ID,
      group: DOCS_SITE_ID,
      title: 'Delo\'s documentation website builds, and every internal link and fragment in both locales names a built file or id (`pnpm --dir docs run build`)',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/check-docs-site.ts'],
      needs: [],
      inputs: [`${DOCS_SITE_DIR}/**`, 'delo/docs/**', 'delo/apps/release/package.json'],
      tiers: ['changed', 'full'],
      cpus: 2,
    },
    // Upstream's notices spec runs only in upstream's suite, so a Delo dependency added without regenerating the file passed every other check.
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
    {
      id: 'tests:fork',
      group: 'tests',
      title: 'Every `delo/apps/*/tests` and `delo/packages/*/tests` spec (`delo/vitest.config.ts`)',
      cwd: '',
      command: [VITEST, 'run', '--config', FORK_CONFIG, `--maxWorkers=${String(workers.fork)}`],
      needs: upstreamSuiteNeeds,
      inputs: ['delo/**', ...UPSTREAM_CODE],
      env: TEST_ENV,
      tiers: ['changed', 'full'],
      cpus: workers.fork,
    },
    // Present only in a tree with Docker specs. The specs share the host's one engine, so they run one file at a time.
    ...tree.packages.some(pkg => pkg.dockerSpecs === true)
      ? [{
          id: DOCKER_CHECK_ID,
          group: 'tests',
          title: 'Every `*.docker.spec.ts` spec, against the Docker engine of the active context (`delo/vitest.docker.config.ts`)',
          cwd: '',
          command: [VITEST, 'run', '--config', DOCKER_CONFIG, '--passWithNoTests'],
          needs: built,
          inputs: ['delo/**', ...UPSTREAM_CODE],
          env: TEST_ENV,
          tiers: ['changed', 'full'],
          cpus: 2,
        } satisfies Draft]
      : [],
    {
      id: 'tests:upstream-changed',
      group: 'tests',
      title: 'The specs of each changed upstream package and, within a spec budget, of its direct dependents',
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
      group: 'tests',
      title: 'The reached Chromium e2e specs under `apps/web/tests`, run after the official client build',
      cwd: '',
      command: ['node_modules/.bin/tsx', WEB_LANE_MODULE],
      needs: [],
      tiers: ['changed'],
      cpus: WEB_LANE_CPUS,
    },
    {
      id: 'tests:snapshots',
      group: 'tests',
      title: 'Upstream\'s keyless recorded-session replay (`pnpm run test:snapshot`), which Delo\'s upstream patches must keep passing',
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
      title: 'C16\'s switch registry against the tree: each switch field, the parity overlay, every model-visible contribution of Delo code and ledgered upstream edits, and the switch sweep',
      cwd: '',
      command: ['node_modules/.bin/tsx', 'delo/apps/tools/src/parity/composition/check-parity-switches.ts'],
      needs: [],
      inputs: ['delo/**', ...UPSTREAM_CODE],
      tiers: ['changed', 'full'],
      cpus: 1,
    },
    // The replay declares no inputs, so it runs whenever a selection picks it: its result is upstream's recorded output against the whole tree.
    {
      id: 'parity-replay',
      group: 'parity',
      title: 'Upstream\'s recorded-session replay (`pnpm run test:snapshot`) through C16\'s parity overlay: Delo with its additions switched off reproduces the base tag\'s expected output',
      cwd: '',
      command: ['pnpm', 'run', '--silent', 'test:snapshot'],
      environment: { ...PARITY_OVERLAY, DSH_SNAPSHOT_MAX_CONCURRENCY: String(SNAPSHOT_CONCURRENCY) },
      needs: upstreamSuiteNeeds,
      tiers: ['changed', 'full'],
      cpus: SNAPSHOT_CONCURRENCY,
    },
  )
  return checks
}

/**
 * Whether a change can alter what the parity replay asserts: Delo code or configuration, which the overlay, the
 * registry and the switches read, or an upstream path that changes upstream's runtime or its recorded scenarios.
 * @param path - a repository-relative changed path.
 * @returns true when the parity replay should run for it.
 */
export function affectsParity(path: string): boolean {
  if (path.startsWith('delo/')) return /\.(?:tsx?|json|ya?ml)$/.test(path) && !/\.i18n\.yaml$/.test(path)
  return affectsUpstreamRuntime(path)
}

function matches(check: Check, names: readonly string[]): boolean {
  return names.some(name => check.id === name || check.group === name || check.id.startsWith(`${name}:`))
}

/**
 * The `--only` or `--skip` names that match no check, by id, group or id family. A name that matches none would
 * select nothing or skip nothing, so the runner refuses the run rather than report it as a pass.
 * @param checks - the catalogue.
 * @param names - the names given on the command line or in `DELO_PUSH_SKIP`.
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
 * @returns such as `delo/apps/cell`, or undefined outside `delo/apps` and `delo/packages` and for the documentation site.
 */
export function packageDirOf(path: string): string | undefined {
  if (path.startsWith(`${DOCS_SITE_DIR}/`)) return undefined
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
  const web = selectWebLane(tree.webSpecs ?? [], paths, tree.upstream, everything)
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
    } else if (check.id === DOCKER_CHECK_ID) {
      const docker = tree.packages.find(pkg => pkg.dockerSpecs === true && (forkWide.length > 0 || reachedDirs.has(pkg.dir)))
      if (docker !== undefined) pick(check, `Docker specs of a package a change reaches (${docker.dir})`)
    } else if (check.id === 'tests:snapshots') {
      const upstream = paths.find(path => !path.startsWith('delo/') && affectsUpstreamRuntime(path))
      if (upstream !== undefined) pick(check, `upstream-owned code changed (${upstream})`)
    } else if (check.id === NOTICES_ID) {
      const manifest = paths.find(affectsNotices)
      if (manifest !== undefined) pick(check, `a manifest, the lockfile or the notices changed (${manifest})`)
    } else if (check.id === DOCS_SITE_ID) {
      const site = paths.find(path => path.startsWith(`${DOCS_SITE_DIR}/`) || path.startsWith('delo/docs/') || path === 'delo/apps/release/package.json')
      if (site !== undefined) pick(check, `the documentation site or its pages changed (${site})`)
    } else if (check.group === 'parity' && selection.changed !== undefined) {
      const parity = paths.find(affectsParity)
      if (parity !== undefined) pick(check, `${parity.startsWith('delo/') ? 'Delo code' : 'upstream-owned code'} changed (${parity})`)
    } else if (check.id === WEB_CHECK_ID) {
      if (web.reached) pick(check, web.reason)
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
    plan.set(check.id, { ...narrowed(check, selection, paths, forkWide.length > 0 ? undefined : [...reachedDirs].map(dir => `${dir}/`), tree.upstream, web), needs: required.map(need => need.id), reason })
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
 * @param web - the web lane's selection: the specs it runs, or why it runs none.
 * @returns the check, with its command and scope narrowed where the selection narrows it.
 */
function narrowed(check: Check, selection: Selection, paths: readonly string[], reachedDirs: readonly string[] | undefined, upstream: readonly UpstreamPackage[], web: WebSelection): Check {
  if (check.id === WEB_CHECK_ID) return web.declined !== undefined ? { ...check, declined: web.declined } : { ...check, command: [...check.command, ...web.specs], scope: web.specs }
  if (check.id === 'tests:upstream-changed') {
    const { dirs } = upstreamSpecDirs(upstream, paths.filter(path => !path.startsWith('delo/')))
    // With no directory it would run every upstream spec, which the full gate does not run in this lane.
    return dirs.length === 0 ? { ...check, declined: 'no upstream package changed' } : { ...check, command: [...check.command, ...dirs], scope: dirs }
  }
  if (check.id === DOCKER_CHECK_ID) return reachedDirs === undefined || reachedDirs.length === 0 ? check : { ...check, command: [...check.command, ...reachedDirs], scope: reachedDirs }
  if (check.id !== 'tests:fork') return check
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
