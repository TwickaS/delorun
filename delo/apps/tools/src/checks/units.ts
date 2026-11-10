/**
 * The fork suite's units: one per Delo package with specs, so a pass is remembered per package instead of for the whole
 * suite. A unit's key covers the package's own files, the files of the Delo packages it depends on directly or not, the
 * files of the upstream packages those depend on directly or not, the shared test configuration (`delo/vitest*`, the root
 * configuration files, `vendor/`, `native/`, the DOM setup script) and what every key covers (`cache.ts`). Documentation
 * outside the packages, such as `delo/docs/` and the changelog fragments, is in no unit's key, so a change to it reruns no
 * spec.
 *
 * The audit of what each package's specs read beyond that is the {@link UNIT_RULES} table: a package whose specs read other
 * files names them, a package whose specs boot a whole profile is keyed on the whole tree, and a package whose specs read
 * the home directory, Docker or the real repository's history is keyed on the whole tree and HEAD and never shared.
 *
 * @module @delo/tools/checks/units
 */
import type { Check, ForkPackage, ForkTree, UpstreamPackage } from './plan.ts'
import { dependencyClosure, UNSHAREABLE_PACKAGES } from './sharing.ts'

/** One package of a unitised suite. */
export interface Unit {
  /** The package directory, such as `delo/packages/trash`. */
  readonly dir: string
  /** The argument that narrows the suite's command to the package: its directory with a trailing slash. */
  readonly arg: string
  /** The globs whose content decides the package's specs. */
  readonly inputs: readonly string[]
  /** True when the specs read state outside any key: the pass stays in this worktree and its key adds HEAD. */
  readonly local?: true
}

/** A planned check with its units, when it has them. */
export type WithUnits<T extends Check = Check> = T & { readonly units?: readonly Unit[] }

/** What a package's specs read beyond its own key. */
export interface UnitRule {
  /** Delo package directories whose files, and dependencies' files, the specs read without depending on them. */
  readonly packages?: readonly string[]
  /** Further globs the specs read. */
  readonly paths?: readonly string[]
  /** The specs boot a whole profile or walk the tree: the key is the whole tree. */
  readonly wholeTree?: true
  /** What the specs read, for the reader of the table. */
  readonly reads: string
}

/**
 * Whether a check is the fork suite or one of its phases, which are unitised.
 * @param id - the check's id.
 * @returns true for `tests:fork` and `tests:fork:<phase>`.
 */
export function isForkSuite(id: string): boolean {
  return id === 'tests:fork' || id.startsWith('tests:fork:')
}

/**
 * The audit of each package's specs that read beyond their package key; a package not named reads only its key.
 */
export const UNIT_RULES: Readonly<Record<string, UnitRule>> = {
  'delo/packages/bundle-local': { wholeTree: true, reads: 'upstream\'s CLI, every package manifest, the studio bundle and the parity contract, through real profile composition' },
  'delo/packages/home-auth': { wholeTree: true, reads: 'the studio\'s web bundles and the built studio plugins, through a booted studio' },
  'delo/packages/contract-host-qualified-keys': { paths: ['packages/client/**', 'packages/api/terminal-controller/**', 'packages/experimental/inspector/**'], reads: 'the sources of the client, terminal-controller and inspector packages whose persisted keys it checks' },
  'delo/packages/home': { packages: ['delo/packages/home-process'], reads: 'the home-process sources, which a lock contender fixture imports' },
  'delo/packages/logs': { packages: ['delo/apps/relay', 'delo/packages/home-process', 'delo/packages/supervisor'], paths: ['apps/desktop/package.json'], reads: 'the relay, home-process and supervisor test drivers and manifests, and the desktop manifest' },
  'delo/packages/plugin-onboarding': { paths: ['delo/apps/cli/src/setup/progress.ts'], reads: 'the CLI\'s setup progress module' },
  'delo/packages/plugin-settings-layout': { paths: ['packages/client/**'], reads: 'every client package\'s sources, for the settings ids' },
  'delo/packages/plugin-theme': { paths: ['packages/client/**'], reads: 'the client packages\' locale modules, for the vocabulary' },
}

/** Upstream's code and configuration, as the whole-tree key of `plan.ts` names it. */
const WHOLE_TREE = ['delo/**', 'packages/**', 'apps/**', 'vendor/**', 'native/**', 'scripts/**', 'snapshots/**', '*.json', '*.ts', '*.mjs', '*.yaml']

/** What every unit's specs share: the suite's configuration, the root configuration and the vendored and native code. */
export const SHARED_TEST_INPUTS: readonly string[] = ['delo/vitest*', 'delo/package.json', '*.json', '*.ts', '*.mjs', '*.yaml', '.npmrc', '.nvmrc', 'vendor/**', 'native/**', 'scripts/test-dom-environment.ts']

/**
 * The directories of upstream packages and of every upstream package they depend on, in any dependency section.
 * @param upstream - upstream's packages.
 * @param names - the package names to start from.
 * @returns the directories, sorted.
 */
export function upstreamClosure(upstream: readonly UpstreamPackage[], names: readonly string[]): string[] {
  const byName = new Map(upstream.map(pkg => [pkg.name, pkg]))
  const reached = new Set<string>()
  const visit = (name: string): void => {
    const pkg = byName.get(name)
    if (pkg === undefined || reached.has(pkg.dir)) return
    reached.add(pkg.dir)
    for (const dependency of pkg.dependencies) visit(dependency)
  }
  for (const name of names) visit(name)
  return [...reached].sort()
}

/**
 * The key inputs of one package's specs.
 * @param pkg - the package.
 * @param tree - the fork's packages and upstream's.
 * @returns the unit.
 */
export function unitOf(pkg: ForkPackage, tree: Pick<ForkTree, 'packages' | 'upstream'>): Unit {
  const arg = `${pkg.dir}/`
  const rule = UNIT_RULES[pkg.dir]
  if (UNSHAREABLE_PACKAGES.some(entry => entry.dir === pkg.dir)) return { dir: pkg.dir, arg, inputs: WHOLE_TREE, local: true }
  if (rule?.wholeTree === true) return { dir: pkg.dir, arg, inputs: WHOLE_TREE }
  const forkDirs = dependencyClosure(tree.packages, [pkg.dir, ...rule?.packages ?? []])
  const upstreamNames = tree.packages.filter(each => forkDirs.includes(each.dir)).flatMap(each => each.upstreamDependencies)
  const dirs = [...forkDirs, ...upstreamClosure(tree.upstream, upstreamNames)]
  return { dir: pkg.dir, arg, inputs: [...dirs.map(dir => `${dir}/**`), ...rule?.paths ?? [], ...SHARED_TEST_INPUTS] }
}

/**
 * The units of a fork-suite check: one per package of its scope that has specs, or of every such package for the whole
 * suite. A check whose scope names spec files or a directory that is not a Delo package is not unitised, and neither is
 * the whole suite while a directory with specs is not a package of the tree, since no unit would cover its specs.
 * @param check - the planned check.
 * @param tree - the fork's packages and upstream's.
 * @param specDirs - the directories under `delo/apps` and `delo/packages` that hold spec files.
 * @returns the units, or undefined when the check is not unitised or no package of its scope has specs.
 */
export function suiteUnits(check: Check, tree: Pick<ForkTree, 'packages' | 'upstream'>, specDirs: readonly string[]): Unit[] | undefined {
  if (!isForkSuite(check.id)) return undefined
  const suite = tree.packages.filter(pkg => !pkg.ownWorkspace)
  const byArg = new Map(suite.map(pkg => [`${pkg.dir}/`, pkg]))
  if (check.scope === undefined && specDirs.some(dir => !suite.some(pkg => pkg.dir === dir))) return undefined
  const scope = check.scope?.map(arg => byArg.get(arg)) ?? suite
  if (scope.some(pkg => pkg === undefined)) return undefined
  const units = scope.filter((pkg): pkg is ForkPackage => pkg !== undefined && specDirs.includes(pkg.dir)).map(pkg => unitOf(pkg, tree))
  return units.length === 0 ? undefined : units
}

/**
 * A unitised check's command for a subset of its units: the command without its scope arguments, then each unit's argument.
 * @param check - the check, whose `scope` arguments are the last of its command.
 * @param units - the units to run.
 * @returns the command.
 */
export function commandFor(check: Check, units: readonly Unit[]): string[] {
  const base = check.command.slice(0, check.command.length - (check.scope?.length ?? 0))
  return [...base, ...units.map(unit => unit.arg)]
}
