/**
 * Which passes the machine-wide store (`shared-cache.ts`) may serve, and what each key must cover beyond a check's
 * declared inputs. A pass is shared only when its key covers everything its result depends on; a check that reads state
 * outside its key, such as git history, the home directory, the network, Docker, git-ignored files or an artifact a build
 * writes, keeps its passes in its own worktree. The rule for each check is the {@link SHARE_RULES} table, which records the
 * reason; a check the table does not name is not shared, so a new check is shared only after its inputs have been audited.
 *
 * A security-class check runs whatever any cache holds in the merge tier and the full gate (`cache.ts`).
 *
 * @module @delorun/tools/checks/sharing
 */
import type { Check, ForkPackage, UpstreamPackage } from './plan.ts'

/** One check's sharing rule. */
export type ShareRule =
  | { readonly share: true; readonly note: string }
  | { readonly share: false; readonly reason: string; readonly security?: true }
  /** A Delorun program's typecheck: shared unless the program reads emitted declarations ({@link SharingFacts.declarationReaders}). */
  | { readonly share: 'program' }
  /** The fork suite: shared unless its scope runs a package of {@link UNSHAREABLE_PACKAGES}; security class when it runs a security package. */
  | { readonly share: 'fork-suite' }
  /** The changed-upstream lane: shared, and security class when its scope runs a security-ledger package or a direct dependent of one. */
  | { readonly share: 'upstream-changed' }

/** The file whose existence switches a module alias in upstream's `vitest.config.ts`; a typecheck or build writes it. */
const LIVESHARE_TYPERT = 'packages/experimental/liveshare/lib/typert.remote-client.js'

/**
 * The sharing rule of each check id or id family; the most specific entry wins, as in `budgets.json`. The table is the
 * audit: each entry states what the check reads beyond its declared inputs and why the key does or does not cover it.
 * Every key also covers the code the command runs, the install, the platform, the clone and the keyed variables
 * (`cache.ts`), so a shared entry names only what the check reads beyond that.
 */
export const SHARE_RULES: Readonly<Record<string, ShareRule>> = {
  'boundary': { share: false, security: true, reason: 'reads git history: the pinned upstream commit and the retired entries\' commits must be ancestors of HEAD, and the security paths are read at HEAD' },
  'gates:licence': { share: false, reason: 'walks git-ignored manifests under delorun/, such as built output and the documentation site\'s install, which no key covers' },
  'gates:package-states': { share: true, note: 'reads the Delorun manifests, which are its inputs' },
  'gates:secrets': { share: false, security: true, reason: 'security class; reads the pinned upstream commit\'s objects' },
  'gates:personal-data': { share: false, security: true, reason: 'security class; reads the range\'s commits and a pattern file in the home directory' },
  'gates:infrastructure': { share: false, security: true, reason: 'security class; reads the pinned upstream commit\'s objects' },
  'gates:dco': { share: false, reason: 'reads the range\'s commits' },
  'gates:commits': { share: false, reason: 'reads the range\'s commit messages' },
  'gates:changelog': { share: false, reason: 'reads the range\'s commits and trailers' },
  'gates:doc-times': { share: false, reason: 'reads the lines the range adds' },
  'gates:whitespace': { share: false, reason: 'reads the files that differ from the merge base with origin/main, which history decides' },
  'gates:docs': { share: false, reason: 'compiles referenced projects under apps/, vendor/ and native/ that are not its inputs, reads and writes emitted declarations, and tests link targets anywhere in the tree' },
  'gates:fundamentals': { share: false, security: true, reason: 'security class: it keeps each enforced security fundamental traceable to its code and test' },
  'jsdoc': { share: false, reason: 'resolves the built Delorun packages\' git-ignored declarations and reads git-ignored sources under src/' },
  'typecheck:upstream': { share: false, reason: 'writes the declarations that the fork\'s programs and gates read, and reads website/ and benchmarks/, which are not its inputs' },
  'typecheck:delorun': { share: 'program' },
  'build': { share: false, reason: 'a build, not a pass' },
  'generate': { share: false, reason: 'a build or generator; the notices check reads installed manifests and bundles packages beyond its inputs' },
  'docs-site': { share: false, reason: 'the site build reads its own install, link targets anywhere in the tree and its own build cache, which no key covers' },
  'tests:fork': { share: 'fork-suite' },
  'tests:docker': { share: false, reason: 'reads the Docker engine\'s images and containers' },
  'tests:upstream-changed': { share: 'upstream-changed' },
  'tests:web-changed': { share: false, reason: 'reads the official client build; it declares no inputs' },
  'tests:snapshots': { share: false, reason: 'declares no inputs' },
  'parity-switches': { share: true, note: 'reads the fork\'s and upstream\'s code, the ledger and the pinned upstream commit\'s objects, which the clone in the key fixes' },
  'parity-replay': { share: false, reason: 'declares no inputs' },
  'whitespace': { share: false, reason: 'reads the index' },
}

/**
 * The fork packages whose specs read state outside the key, so a fork-suite pass that runs them is never shared. Each
 * entry names what its specs read.
 */
export const UNSHAREABLE_PACKAGES: readonly { readonly dir: string, readonly reads: string }[] = [
  { dir: 'delorun/apps/cli', reads: 'the home directory and the Docker binary through the doctor specs, and Delorun\'s built bundle' },
  { dir: 'delorun/apps/release', reads: 'the real repository\'s HEAD and its ledger at HEAD' },
  { dir: 'delorun/apps/tools', reads: 'the real repository\'s git state and files outside the package' },
  { dir: 'delorun/packages/home-process', reads: 'the Docker context the supervisor resolves from the inherited environment' },
  { dir: 'delorun/packages/supervisor', reads: 'the Docker socket of the active context' },
]

/**
 * The rule for a check: its id's entry, then each enclosing family's.
 * @param id - the check's id.
 * @returns the rule, or undefined when the table names neither the id nor a family of it.
 */
export function shareRule(id: string): ShareRule | undefined {
  const parts = id.split(':')
  for (let length = parts.length; length > 0; length -= 1) {
    const rule = SHARE_RULES[parts.slice(0, length).join(':')]
    if (rule !== undefined) return rule
  }
  return undefined
}

/** What the sharing decision needs from the tree. */
export interface SharingFacts {
  /** The fork's packages, for the code a command runs and the fork suite's scope. */
  readonly packages: readonly ForkPackage[]
  /** Upstream's packages, for the changed-upstream lane's security dependents. */
  readonly upstream: readonly UpstreamPackage[]
  /** Fork package directories that enforce a security fundamental: a suite that runs one is security class. */
  readonly securityPackages: readonly string[]
  /** The Delorun program configs that read emitted declarations: with project references, or through a built Delorun package. */
  readonly declarationReaders: readonly string[]
}

/** The sharing decision of a run, from {@link sharingPolicy}. */
export interface SharingPolicy {
  /**
   * Why the store does not serve the check, or undefined when it does.
   * @param check - the planned check.
   * @returns the reason, or undefined.
   */
  unshared(check: Check): string | undefined
  /**
   * Whether the check is security class: served from no cache in the merge tier and the full gate.
   * @param check - the planned check.
   * @returns true for a security-class check.
   */
  security(check: Check): boolean
  /**
   * Whether a Delorun package enforces a security fundamental, so its specs' pass serves no strict run.
   * @param dir - the package directory.
   * @returns true for a security package.
   */
  securityPackage(dir: string): boolean
  /**
   * The source files of the code the check's command runs, as globs, which join its key: the source and manifest of a
   * Delorun package a script argument of the command lies in and of every Delorun package it depends on, and `scripts/**` for
   * upstream's scripts. A directory or spec file the command is narrowed to is not code it runs.
   * @param check - the check.
   * @returns the globs, sorted.
   */
  codeInputs(check: Check): string[]
  /**
   * Repository-relative files outside git's view, such as a generated file whose existence a check reads, whose content
   * joins the key.
   * @param check - the check.
   * @returns the paths.
   */
  stateFiles(check: Check): string[]
}

/**
 * The directories of a set of fork packages and of every fork package they depend on, directly or not.
 * @param packages - every fork package.
 * @param dirs - the directories to start from.
 * @returns the directories, sorted.
 */
export function dependencyClosure(packages: readonly ForkPackage[], dirs: readonly string[]): string[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]))
  const reached = new Set<string>()
  const visit = (pkg: ForkPackage | undefined): void => {
    if (pkg === undefined || reached.has(pkg.dir)) return
    reached.add(pkg.dir)
    for (const dependency of pkg.forkDependencies) visit(byName.get(dependency))
  }
  for (const dir of dirs) visit(packages.find(pkg => pkg.dir === dir))
  return [...reached].sort()
}

/**
 * The package directories a scoped suite runs.
 * @param scope - the check's scope, directories with a trailing slash or spec files; undefined for the whole suite.
 * @param dirs - every package directory of the suite.
 * @returns the directories a path of the scope lies in, or all of them for the whole suite.
 */
export function scopedDirs(scope: readonly string[] | undefined, dirs: readonly string[]): string[] {
  if (scope === undefined) return [...dirs]
  return dirs.filter(dir => scope.some(path => path.startsWith(`${dir}/`)))
}

/**
 * The fork package directories that the security fundamentals' enforcing files lie in.
 * @param paths - the files the enforced fundamentals name, repository-relative (`FUNDAMENTALS_INPUTS`).
 * @returns the directories under `delorun/apps` and `delorun/packages`, sorted.
 */
export function securityPackageDirs(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap(path => /^delorun\/(?:apps|packages)\/[^/]+/.exec(path)?.[0] ?? []))].sort()
}

/**
 * The Delorun program configs that read emitted declarations: a config with project references, every config of the CLI
 * (which resolves `@deepseek-ai/dsh` to its built declarations), and every config of a package that depends, directly or
 * not, on a Delorun package with a build.
 * @param configs - each program config with whether it declares `references`.
 * @param packages - the fork's packages.
 * @returns the configs, sorted.
 */
export function declarationReaders(configs: readonly { readonly config: string, readonly references: boolean }[], packages: readonly ForkPackage[]): string[] {
  const built = new Set(packages.filter(pkg => (pkg.buildOutputs ?? []).length > 0).map(pkg => pkg.dir))
  return configs.filter(({ config, references }) => {
    const dir = /^delorun\/(?:apps|packages)\/[^/]+/.exec(config)?.[0] ?? ''
    if (references || dir === 'delorun/apps/cli') return true
    return dependencyClosure(packages, [dir]).some(each => each !== dir && built.has(each))
  }).map(({ config }) => config).sort()
}

/**
 * The run's sharing decision over a tree.
 * @param facts - the packages and the package classes.
 * @returns the policy.
 */
export function sharingPolicy(facts: SharingFacts): SharingPolicy {
  const forkDirs = facts.packages.map(pkg => pkg.dir)
  const unshareable = UNSHAREABLE_PACKAGES.map(entry => entry.dir)
  const securityNames = new Set(facts.upstream.filter(pkg => pkg.security === true).map(pkg => pkg.name))
  const upstreamSecurityDirs = facts.upstream.filter(pkg => securityNames.has(pkg.name) || pkg.dependencies.some(dependency => securityNames.has(dependency))).map(pkg => pkg.dir)
  const decide = (check: Check): { readonly reason?: string; readonly security: boolean } => {
    const rule = shareRule(check.id)
    if (rule === undefined) return { reason: 'its inputs have not been audited for sharing', security: false }
    switch (rule.share) {
      case true: return { security: false }
      case false: return { reason: rule.reason, security: rule.security === true }
      case 'program': {
        const config = String(check.command[check.command.indexOf('-p') + 1])
        return facts.declarationReaders.includes(config) ? { reason: `${config} reads emitted declarations, which no key covers`, security: false } : { security: false }
      }
      case 'fork-suite': {
        const dirs = scopedDirs(check.scope, forkDirs)
        const security = dirs.some(dir => facts.securityPackages.includes(dir))
        const reader = dirs.find(dir => unshareable.includes(dir))
        return reader === undefined ? { security } : { reason: `it runs the specs of ${reader}, which read state outside the key`, security }
      }
      case 'upstream-changed':
        return { security: scopedDirs(check.scope, upstreamSecurityDirs).length > 0 }
    }
  }
  return {
    unshared: check => decide(check).reason,
    securityPackage: dir => facts.securityPackages.includes(dir),
    security: check => decide(check).security,
    codeInputs: (check) => {
      // A script the command runs, not a directory or spec it narrows the run to.
      const scripts = check.command.filter(arg => /\.[cm]?[jt]sx?$/.test(arg) && !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(arg))
      const owned = scripts.flatMap(arg => facts.packages.filter(pkg => arg.startsWith(`${pkg.dir}/`)).map(pkg => pkg.dir))
      const globs = dependencyClosure(facts.packages, owned).flatMap(dir => [`${dir}/src/**`, `${dir}/package.json`])
      if (check.command.some(arg => arg.startsWith('scripts/'))) globs.push('scripts/**')
      return [...new Set(globs)].sort()
    },
    stateFiles: check => shareRule(check.id)?.share === 'upstream-changed' ? [LIVESHARE_TYPERT] : [],
  }
}
