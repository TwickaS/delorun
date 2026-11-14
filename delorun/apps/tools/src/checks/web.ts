/**
 * The web browser lane: the Chromium e2e specs under `apps/web/tests` that a change reaches, run against the official
 * client build. `readWebSpecs` reads the inventory and what each spec maps to, and `selectWebLane` decides from the
 * changed paths. The module is also the check's command: it builds the client, then runs the selected specs under
 * upstream's web configuration, with WebKit left out.
 *
 * @module @delorun/tools/checks/web
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { z } from 'zod'
import { repositoryRoot } from '../git.ts'

/** The check's id, which the catalogue, `--only` and `budgets.json` name. */
export const WEB_CHECK_ID = 'tests:web-changed'
/** The directory whose `*.e2e.ts` files form the lane's inventory: the files `vitest.web.config.ts` includes there. */
export const WEB_SPEC_DIR = 'apps/web/tests'
/**
 * The most specs one run selects. A change to `apps/web` outside its specs reaches every spec, since each one imports the
 * directory's helpers. Above the cap the merge tier runs a bounded selection ({@link WEB_SMOKE_SPECS} and the reached specs
 * the change names most closely), and a lighter tier declines the lane. At the measured 53 s average per spec, 12 specs and
 * a cold artifact build (about 3 minutes) fit the lane's 1200-second budget.
 */
export const WEB_SPEC_CAP = 12
/**
 * The specs a bounded selection always runs, one per core journey: boot to a selected conversation, DeepSeek account
 * sign-in, opening a recorded conversation, and the settings surface. Each must be a Chromium spec of the inventory;
 * a bounded selection that misses one throws instead of running without it.
 */
export const WEB_SMOKE_SPECS: readonly string[] = [
  'apps/web/tests/startup-auto-selection.e2e.ts',
  'apps/web/tests/account-login.e2e.ts',
  'apps/web/tests/seeded-history.e2e.ts',
  'apps/web/tests/settings-chrome.e2e.ts',
]
/** The build the lane runs first; its environment carries the official client profile. */
export const WEB_BUILD_COMMAND: readonly string[] = ['pnpm', 'run', '--silent', 'build:artifacts']
/** This module, which is the check's command after the tsx launcher. */
export const WEB_LANE_MODULE = 'delorun/apps/tools/src/checks/web.ts'
/** Upstream's web configuration, run unchanged. */
const WEB_CONFIG = 'vitest.web.config.ts'
const VITEST = 'node_modules/.bin/vitest'
/** The directories whose changes reach the lane. */
const REACHING_DIRS = ['packages/client', 'apps/web'] as const
const SPEC_SUFFIX = '.e2e.ts'
/** Documentation changes neither reach the lane nor select a spec. */
const DOCUMENTATION = /\.(?:md|i18n\.yaml)$/
const BUDGETS = new URL('./budgets.json', import.meta.url)

/** A workspace package: the fields the mapping reads. */
export interface WorkspacePackage {
  /** The name in its `package.json`, such as `@deepseek-ai/dsh-session`. */
  readonly name: string
  /** Repository-relative directory, such as `packages/core/session`. */
  readonly dir: string
}

/** One inventory spec and the workspace packages it maps to. */
export interface WebSpec {
  /** Repository-relative path, such as `apps/web/tests/chat.e2e.ts`. */
  readonly path: string
  /** Directories of the packages it maps to, sorted: through its imports, or through its file name when imports map none. */
  readonly packages: readonly string[]
  /** Whether it imports `webkit` from `playwright`; the lane leaves such a spec out, since its WebKit leg needs WebKit's system libraries. */
  readonly webkit: boolean
}

/** What a change selects for the lane. */
export interface WebSelection {
  /** Whether a change reaches the lane, which is then picked; a check the lane does not reach is not picked. */
  readonly reached: boolean
  /** Why the lane is picked: how many specs the change reached. */
  readonly reason: string
  /** The specs the lane runs, in path order; empty exactly when `declined` is set. */
  readonly specs: readonly string[]
  /** Why the lane runs nothing although it was picked: no spec maps, or the count is above {@link WEB_SPEC_CAP} outside the merge tier. */
  readonly declined?: string | undefined
  /** What a bounded selection ran and how many reached specs it left out; set only for one. */
  readonly bounded?: string | undefined
}

/**
 * The module specifiers a spec imports, and whether it imports WebKit from `playwright`.
 * @param path - the spec's repository-relative path, which names the parse.
 * @param source - the spec's text.
 * @returns the specifiers in source order, and the WebKit flag.
 */
export function readSpecImports(path: string, source: string): { readonly specifiers: readonly string[], readonly webkit: boolean } {
  const specifiers: string[] = []
  let webkit = false
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
      if (node.moduleSpecifier.text === 'playwright' && importsWebKit(node)) webkit = true
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined && ts.isStringLiteral(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text)
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments
      if (argument !== undefined && ts.isStringLiteralLike(argument)) specifiers.push(argument.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS))
  return { specifiers, webkit }
}

/**
 * Whether an import declaration binds `webkit` as a value.
 * @param node - an import declaration from `playwright`.
 * @returns true when a value import names `webkit`.
 */
function importsWebKit(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause
  if (clause === undefined || clause.isTypeOnly) return false
  const bindings = clause.namedBindings
  return bindings !== undefined && ts.isNamedImports(bindings)
    && bindings.elements.some(element => !element.isTypeOnly && (element.propertyName ?? element.name).text === 'webkit')
}

/**
 * Whether a repository-relative path is an e2e spec of the inventory, WebKit specs included.
 * @param path - a repository-relative path.
 * @returns true for a `*.e2e.ts` file under {@link WEB_SPEC_DIR}.
 */
function isSpecFile(path: string): boolean {
  return path.startsWith(`${WEB_SPEC_DIR}/`) && path.endsWith(SPEC_SUFFIX)
}

/**
 * The innermost workspace package a repository-relative path lies in.
 * @param path - a repository-relative path.
 * @param packages - the workspace packages.
 * @returns the package's directory, or undefined outside every package.
 */
export function containingPackage(path: string, packages: readonly WorkspacePackage[]): string | undefined {
  let found: string | undefined
  for (const pkg of packages) {
    const inside = path === pkg.dir || path.startsWith(`${pkg.dir}/`)
    if (inside && (found === undefined || pkg.dir.length > found.length)) found = pkg.dir
  }
  return found
}

/**
 * The package a module specifier names, without its subpath: `@scope/name` or `name`.
 * @param specifier - a bare module specifier, such as `@deepseek-ai/dsh-client-shortcuts/protocol`.
 * @returns the package name.
 */
function packageNameOf(specifier: string): string {
  const [first = '', second] = specifier.split('/')
  return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first
}

/**
 * The packages a spec maps to: each workspace package its imports reach, a relative import by the package its
 * resolved path lies in. A spec whose imports map no package maps by its file name: a package whose directory name
 * is a dash-delimited run of the file name's stem.
 * @param path - the spec's repository-relative path.
 * @param specifiers - its module specifiers.
 * @param packages - the workspace packages.
 * @returns the package directories, sorted.
 */
export function mapSpecToPackages(path: string, specifiers: readonly string[], packages: readonly WorkspacePackage[]): string[] {
  const dirs = new Set<string>()
  for (const specifier of specifiers) {
    if (specifier.startsWith('.')) {
      const dir = containingPackage(posix.join(posix.dirname(path), specifier), packages)
      if (dir !== undefined) dirs.add(dir)
    } else {
      const match = packages.find(pkg => pkg.name === packageNameOf(specifier))
      if (match !== undefined) dirs.add(match.dir)
    }
  }
  if (dirs.size === 0) {
    const stem = posix.basename(path).slice(0, -SPEC_SUFFIX.length)
    for (const pkg of packages) {
      if (`-${stem}-`.includes(`-${posix.basename(pkg.dir)}-`)) dirs.add(pkg.dir)
    }
  }
  return [...dirs].sort()
}

/**
 * The inventory: every `*.e2e.ts` under {@link WEB_SPEC_DIR}, each with the packages it maps to.
 * @param root - the repository root.
 * @param packages - the workspace packages, with their directories.
 * @returns the specs, sorted by path; empty when the directory does not exist.
 */
export function readWebSpecs(root: string, packages: readonly WorkspacePackage[]): WebSpec[] {
  if (!existsSync(join(root, WEB_SPEC_DIR))) return []
  const paths = readdirSync(join(root, WEB_SPEC_DIR), { recursive: true, encoding: 'utf8' })
    .map(entry => `${WEB_SPEC_DIR}/${entry.split(sep).join('/')}`)
    .filter(path => path.endsWith(SPEC_SUFFIX))
    .sort()
  return paths.map(path => {
    const { specifiers, webkit } = readSpecImports(path, readFileSync(join(root, path), 'utf8'))
    return { path, packages: mapSpecToPackages(path, specifiers, packages), webkit }
  })
}

/**
 * What a change selects for the lane. The lane is reached by a non-documentation path under `packages/client` or
 * `apps/web`, or under a package that an inventory spec maps to. A spec is selected when it is itself changed or
 * maps to a changed package. With no change set and no target, the selection is the whole inventory. In the merge tier a
 * change that reaches the lane runs specs whenever the inventory has any: above {@link WEB_SPEC_CAP}, or when no spec
 * maps to the change, it runs the bounded selection of {@link boundedWebSelection} instead of declining.
 * @param specs - the inventory.
 * @param paths - the changed paths, or the targets; empty for a run that names neither.
 * @param packages - the workspace packages.
 * @param everything - true when the run names no change set and no target, so `paths` is not a change.
 * @param merge - true in the merge tier, which runs a bounded selection where a lighter tier declines.
 * @returns the selection; `specs` is empty exactly when `declined` is set.
 * @throws Error from {@link boundedWebSelection} when a smoke spec is not in the inventory.
 */
export function selectWebLane(specs: readonly WebSpec[], paths: readonly string[], packages: readonly WorkspacePackage[], everything: boolean, merge: boolean): WebSelection {
  const inventory = specs.filter(spec => !spec.webkit)
  const leftOut = specs.length - inventory.length
  const note = leftOut === 0 ? '' : `; ${String(leftOut)} WebKit spec(s) left out`
  if (everything) {
    // With no change or target, the lane's inventory is the whole of it; the cap decides whether it runs.
    const declined = inventory.length === 0 ? `no web e2e spec in the inventory${note}`
      : inventory.length > WEB_SPEC_CAP ? `the whole inventory (${String(inventory.length)} web e2e specs) is above the cap of ${String(WEB_SPEC_CAP)}; name a change with --changed or a target${note}`
        : undefined
    return { reached: true, reason: `the whole inventory: ${String(inventory.length)} web e2e spec(s)${note}`, specs: declined === undefined ? inventory.map(spec => spec.path) : [], declined }
  }
  const changes = paths.filter(path => !DOCUMENTATION.test(path))
  const importedDirs = new Set(inventory.flatMap(spec => spec.packages))
  const reached = changes.some(path => REACHING_DIRS.some(dir => path.startsWith(`${dir}/`)) || importedDirs.has(containingPackage(path, packages) ?? ''))
  if (!reached) return { reached: false, reason: 'no changed path reaches the lane', specs: [], declined: 'no changed path reaches the lane' }
  // A changed spec selects itself only: its package is reached through every sibling's helper imports, so it is not a changed package.
  const changedDirs = new Set(changes.filter(path => !isSpecFile(path)).flatMap(path => containingPackage(path, packages) ?? []))
  const selected = inventory.filter(spec => changes.includes(spec.path) || spec.packages.some(dir => changedDirs.has(dir)))
  const reason = `${String(selected.length)} of ${String(inventory.length)} web e2e spec(s) reached${note}`
  if (inventory.length === 0) return { reached, reason, specs: [], declined: `no web e2e spec in the inventory${note}` }
  if (merge && (selected.length === 0 || selected.length > WEB_SPEC_CAP)) {
    const bounded = boundedWebSelection(inventory, selected, changes, changedDirs)
    const leftOut = selected.filter(spec => !bounded.includes(spec.path)).length
    return {
      reached, reason, specs: bounded,
      bounded: `the merge tier runs a bounded selection of ${String(bounded.length)} spec(s): the ${String(WEB_SMOKE_SPECS.length)} smoke specs and the ${String(bounded.length - WEB_SMOKE_SPECS.length)} reached spec(s) the change names most closely; ${String(leftOut)} of the ${String(selected.length)} reached spec(s) left out`,
    }
  }
  if (selected.length === 0) return { reached, reason, specs: [], declined: `no web e2e spec maps to the change${note}` }
  if (selected.length > WEB_SPEC_CAP) {
    return { reached, reason, specs: [], declined: `${String(selected.length)} web e2e specs reach the change, above the cap of ${String(WEB_SPEC_CAP)}; the merge tier runs a bounded selection of them${note}` }
  }
  return { reached, reason, specs: selected.map(spec => spec.path) }
}

/**
 * A bounded selection of at most {@link WEB_SPEC_CAP} specs: every {@link WEB_SMOKE_SPECS} spec, then the reached specs
 * in this order until the cap: a changed spec; a spec whose file name contains a changed package's directory name; a
 * spec that maps to a changed package fewer inventory specs map to; then by path. The result depends only on its arguments.
 * @param inventory - the Chromium specs of the inventory.
 * @param selected - the reached specs.
 * @param changes - the changed paths, documentation left out.
 * @param changedDirs - the changed packages' directories, specs left out.
 * @returns the spec paths, sorted.
 * @throws Error when a smoke spec is not a Chromium spec of the inventory.
 */
export function boundedWebSelection(inventory: readonly WebSpec[], selected: readonly WebSpec[], changes: readonly string[], changedDirs: ReadonlySet<string>): string[] {
  const missing = WEB_SMOKE_SPECS.filter(path => !inventory.some(spec => spec.path === path))
  if (missing.length > 0) {
    throw new Error(`${WEB_CHECK_ID}: smoke spec(s) ${missing.join(', ')} are not Chromium specs of ${WEB_SPEC_DIR}; name existing specs in WEB_SMOKE_SPECS (delorun/apps/tools/src/checks/web.ts)`)
  }
  const users = (dir: string): number => inventory.filter(spec => spec.packages.includes(dir)).length
  const named = (spec: WebSpec): boolean => {
    const stem = posix.basename(spec.path).slice(0, -SPEC_SUFFIX.length)
    return [...changedDirs].some(dir => `-${stem}-`.includes(`-${posix.basename(dir)}-`))
  }
  // One number per spec: a changed spec, then a named one, then by how few inventory specs map to its changed package.
  const rank = (spec: WebSpec): number => {
    const reach = Math.min(inventory.length, ...spec.packages.filter(dir => changedDirs.has(dir)).map(users))
    return ((changes.includes(spec.path) ? 0 : 2) + (named(spec) ? 0 : 1)) * (inventory.length + 1) + reach
  }
  const order = (left: WebSpec, right: WebSpec): number => {
    const difference = rank(left) - rank(right)
    return difference !== 0 ? difference : left.path.localeCompare(right.path)
  }
  const ranked = selected.filter(spec => !WEB_SMOKE_SPECS.includes(spec.path)).sort(order)
  return [...WEB_SMOKE_SPECS, ...ranked.slice(0, WEB_SPEC_CAP - WEB_SMOKE_SPECS.length).map(spec => spec.path)].sort()
}

/**
 * The environment the lane's commands run with: the official client profile, the replay mode that writes no golden,
 * and no DeepSeek key, which is what `env -u DEEPSEEK_API_KEY` gives.
 * @param environment - the environment the lane starts with.
 * @returns the environment for the build and the specs.
 */
export function laneEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = { ...environment, DSH_BUILD_CLIENT_PROFILE: 'official', DSH_SNAPSHOT: 'replay' }
  delete child.DEEPSEEK_API_KEY
  return child
}

/**
 * Why the lane refuses a path: it is outside the inventory, does not exist, or runs WebKit. The plan passes only
 * inventory specs without WebKit, so a refusal means a path was named by hand.
 * @param root - the repository root.
 * @param path - a repository-relative path.
 * @returns the reason, or undefined when the lane may run the spec.
 */
export function refusal(root: string, path: string): string | undefined {
  if (!isSpecFile(path)) return `${path} is not a ${WEB_SPEC_DIR}/**/*${SPEC_SUFFIX} spec`
  if (!existsSync(join(root, path))) return `${path} does not exist`
  if (readSpecImports(path, readFileSync(join(root, path), 'utf8')).webkit) return `${path} runs WebKit, which this lane leaves out until the host has WebKit's system libraries`
  return undefined
}

/**
 * The wall-clock budget `budgets.json` gives the lane.
 * @returns its seconds.
 * @throws Error when `budgets.json` gives the lane no `seconds`.
 */
function wallClockBudget(): number {
  const budgets = z.object({ checks: z.record(z.string(), z.object({ seconds: z.number().positive().optional() })) })
    .parse(JSON.parse(readFileSync(BUDGETS, 'utf8')))
  const seconds = budgets.checks[WEB_CHECK_ID]?.seconds
  if (seconds === undefined) throw new Error(`budgets.json gives ${WEB_CHECK_ID} no wall-clock budget`)
  return seconds
}

/**
 * The lane's commands in order: the official client build, then the specs under upstream's web configuration, which
 * name no WebKit spec because the plan leaves them out and {@link refusal} rejects them.
 * @param specs - repository-relative inventory paths.
 * @returns each command's argv; the first entry of each is the program.
 */
export function webLaneSteps(specs: readonly string[]): readonly (readonly string[])[] {
  return [WEB_BUILD_COMMAND, [VITEST, 'run', '--config', WEB_CONFIG, ...specs]]
}

/**
 * Build the official client, then run the given specs under upstream's web configuration. A step that fails ends the lane.
 * @param root - the repository root.
 * @param specs - repository-relative inventory paths the plan selected.
 * @param environment - the environment the lane starts with.
 * @returns the exit status: the failing step's, or 0.
 */
export function runWebLane(root: string, specs: readonly string[], environment: NodeJS.ProcessEnv): number {
  // Read before any step starts, so a budget that is missing fails the lane before the build rather than after it.
  const budget = wallClockBudget()
  const refused = specs.map(path => refusal(root, path)).filter(reason => reason !== undefined)
  if (refused.length > 0) {
    for (const reason of refused) console.error(`${WEB_CHECK_ID}: ${reason}`)
    return 1
  }
  if (specs.length === 0) {
    console.error(`${WEB_CHECK_ID}: no spec to run`)
    return 1
  }
  const child = laneEnvironment(environment)
  const started = performance.now()
  let status = 0
  for (const [program = '', ...args] of webLaneSteps(specs)) {
    const file = program.includes('/') ? join(root, program) : program
    const step = spawnSync(file, args, { cwd: root, env: child, stdio: 'inherit' })
    if (step.error !== undefined) console.error(`${WEB_CHECK_ID}: ${program} did not start: ${step.error.message}`)
    status = step.status ?? 1
    if (status !== 0) break
  }
  const seconds = (performance.now() - started) / 1000
  if (seconds > budget) console.log(`${WEB_CHECK_ID} took ${seconds.toFixed(0)} s, over its ${String(budget)} s budget (budgets.json)`)
  return status
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runWebLane(repositoryRoot(process.cwd()), process.argv.slice(2), process.env)
}
