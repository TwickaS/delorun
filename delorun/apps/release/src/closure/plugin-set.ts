/**
 * The packages a runtime closure carries beyond what the `delorun` command and upstream's runtime closure reach: every
 * plugin package in the repository (owner decision A399), selected from the workspace and the product package policy
 * and not from a hand list. Upstream's `packages/**` and Delorun's `delorun/packages/**` are all shipped, experimental and
 * work-in-progress ones included; a plugin the default profile does not mount ships turned off, and a person turns it
 * on in Plugins. The selection is written into the dependencies of `@delorun/runtime-closure`, which the recipe deploys,
 * and `sync-closure-plugins.ts --check` fails when the committed manifest differs from it.
 *
 * @module @delorun/release/closure/plugin-set
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_PACKAGE_POLICY, type ProductPackageCategory } from '../../../../../scripts/product-package-policy.ts'

/** One workspace package as the selection reads it. */
export interface WorkspacePackage {
  /** Repository-relative directory. */
  readonly dir: string
  /** The package name. */
  readonly name: string
  /** Whether the manifest is `private`. */
  readonly private: boolean
  /** Delorun's lifecycle state, for packages under `delorun/packages`. */
  readonly state: string | undefined
  /** Whether the package declares `dsh.bundle.patch`, which makes it a bundle that Plugins can switch on. */
  readonly bundle: boolean
}

/** A package the closure does not carry, and the reason. */
export interface ExcludedPackage {
  /** The package name. */
  readonly name: string
  /** Repository-relative directory. */
  readonly dir: string
  /** Why the closure does not carry it. */
  readonly reason: string
}

/** The selection: package names the closure carries and the packages it leaves out. */
export interface ClosureSelection {
  /** Names to declare as dependencies of the closure root, sorted. */
  readonly included: readonly string[]
  /** Everything left out, with reasons. */
  readonly excluded: readonly ExcludedPackage[]
}

/** The policy categories that name a package with no runtime plugin to mount, with the reason the closure gives. */
const NOT_RUNTIME: Readonly<Partial<Record<ProductPackageCategory, string>>> = {
  sdk: 'embedding client that runs in the consumer process',
  build: 'build-time tool',
  test: 'test infrastructure',
  'web-distribution': 'bundled into the Web distribution',
  declarations: 'declarations with no runtime mount',
}

/**
 * Delorun packages that are not runtime plugins: wire contracts for services outside the closure.
 * `contract-relay-protocol` is the relay server's wire contract; the closure's other `contract-*` packages are reached
 * through the `delorun` command.
 */
const DELORUN_NOT_RUNTIME: Readonly<Record<string, string>> = {
  'delorun/packages/contract-relay-protocol': 'wire contract of the relay service, which runs outside the runtime',
}

function readPackages(root: string, group: string): WorkspacePackage[] {
  const found: WorkspacePackage[] = []
  const parent = join(root, group)
  for (const entry of readdirSync(parent, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    // The group is either `packages/<group>/<name>` or `delorun/packages/<name>`.
    const directories = group === 'packages'
      ? readdirSync(join(parent, entry.name), { withFileTypes: true }).filter(each => each.isDirectory()).map(each => `${group}/${entry.name}/${each.name}`)
      : [`${group}/${entry.name}`]
    for (const dir of directories) {
      let manifest: { name?: string; private?: boolean; delorun?: { state?: string }; dsh?: { bundle?: { patch?: string } } }
      try {
        manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
      } catch (error) {
        // A directory without a manifest is not a package (assets, build residue).
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (manifest.name === undefined) continue
      found.push({ dir, name: manifest.name, private: manifest.private === true, state: manifest.delorun?.state, bundle: manifest.dsh?.bundle?.patch !== undefined })
    }
  }
  return found
}

/**
 * Read every workspace package under `packages/*\/*` and `delorun/packages/*`.
 * @param root - the repository root.
 * @returns the packages, sorted by directory.
 */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
  return [...readPackages(root, 'packages'), ...readPackages(root, 'delorun/packages')].sort((a, b) => (a.dir < b.dir ? -1 : 1))
}

/**
 * Decide which workspace packages the closure carries.
 * @param packages - the workspace packages.
 * @returns the selection.
 */
export function selectClosurePackages(packages: readonly WorkspacePackage[]): ClosureSelection {
  const included: string[] = []
  const excluded: ExcludedPackage[] = []
  for (const each of packages) {
    const delorun = each.dir.startsWith('delorun/')
    const category = PRODUCT_PACKAGE_POLICY[each.dir]?.category
    const reason = delorun
      ? DELORUN_NOT_RUNTIME[each.dir] ?? (each.state === 'parked' && each.name.startsWith('@delorun/contract-') ? 'parked wire contract with no runtime consumer' : undefined)
      : each.private
        ? 'private package, not published and not a plugin'
        : category === undefined ? undefined : NOT_RUNTIME[category]
    if (reason === undefined) included.push(each.name)
    else excluded.push({ name: each.name, dir: each.dir, reason })
  }
  return { included: included.sort(), excluded }
}

/**
 * The closure root's dependencies: the two fixed roots that are not selected from the workspace plus the selection.
 * @param current - the committed `dependencies` of `@delorun/runtime-closure`.
 * @param selection - the selection.
 * @returns the dependencies to write, sorted by name.
 */
export function closureRootDependencies(current: Readonly<Record<string, string>>, selection: ClosureSelection): Record<string, string> {
  const fixed = { '@delorun/cli': current['@delorun/cli'] ?? 'workspace:*', 'dsh-python-runtime-closure': current['dsh-python-runtime-closure'] ?? 'workspace:*' }
  const merged: Record<string, string> = { ...fixed }
  for (const name of selection.included) merged[name] = name.startsWith('@delorun/') ? 'workspace:*' : (current[name] ?? 'workspace:*')
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : 1)))
}

/**
 * Bundles that the install anchor must declare so Plugins lists them: every selected package that declares a bundle
 * patch. Bundles the anchor already declares stay as they are.
 * @param packages - the workspace packages.
 * @param selection - the selection.
 * @returns the bundle names, sorted.
 */
export function selectedBundles(packages: readonly WorkspacePackage[], selection: ClosureSelection): string[] {
  const included = new Set(selection.included)
  return packages.filter(each => each.bundle && included.has(each.name)).map(each => each.name).sort()
}
