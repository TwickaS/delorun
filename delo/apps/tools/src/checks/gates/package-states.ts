/**
 * Package-states gate: every package and app under `delo/packages` and `delo/apps` records exactly one state in its
 * `"delo"` field, and the state agrees with the dependency graph from the shipped roots. Run from anywhere inside the
 * repository: `node_modules/.bin/tsx delo/apps/tools/src/checks/gates/package-states.ts`. It prints the packages of each
 * state and one line per violation, and exits 1 on a violation.
 *
 * The rules, over the edges in `dependencies`, `peerDependencies` and `optionalDependencies` between workspace packages:
 *
 * 1. A `shipped` or `experimental` package without `unreached` is reachable from a root.
 * 2. A package with `unreached` is not reachable, and is `shipped` or `experimental`; the marker names the lane that
 *    wires the package and leaves with that change.
 * 3. A `parked` package is not reachable, and no `shipped` or `experimental` package depends on it.
 *
 * @module @delo/tools/checks/gates/package-states
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'

/** The states a package records. */
export const PACKAGE_STATES = ['shipped', 'experimental', 'parked'] as const

/** One of {@link PACKAGE_STATES}. */
export type PackageState = (typeof PACKAGE_STATES)[number]

/** The workspace directories whose entries must record a state. */
const WORKSPACE_DIRS = ['delo/packages', 'delo/apps'] as const

/**
 * The directories whose packages the user installs or the repository releases or runs as its own tooling, such as the
 * check runner and the wait-time benchmarks; reachability starts here.
 */
export const ROOT_DIRS = [
  'delo/apps/benchmarks',
  'delo/apps/cli',
  'delo/apps/npm-launcher',
  'delo/apps/install',
  'delo/apps/release',
  'delo/apps/tools',
  'delo/apps/docs',
  'delo/apps/website',
] as const

const stateField = z.strictObject({
  state: z.enum(PACKAGE_STATES),
  unreached: z.string().min(1).optional(),
  // The connections a plugin is recommended for; `@delo/plugin-onboarding`'s `declaredConnections` owns their form.
  connections: z.array(z.string()).optional(),
})

const manifestFields = z.looseObject({
  name: z.string(),
  delo: z.unknown().optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  optionalDependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
})

/** A workspace package as the rules see it. */
export interface StatePackage {
  readonly name: string
  /** Repository-relative directory, such as `delo/packages/home`. */
  readonly dir: string
  /** The recorded state, or `undefined` when the field is missing or invalid. */
  readonly state?: PackageState | undefined
  /** The lane that wires the package, when nothing reaches it yet. */
  readonly unreached?: string | undefined
  /** Names of every package it depends on, in any of the three dependency sections. */
  readonly dependencies: readonly string[]
  /** Names of the packages in its `devDependencies`, which the state rules ignore and the build order does not. */
  readonly devDependencies: readonly string[]
}

/** The workspace as read from disk. */
export interface StateWorkspace {
  readonly packages: readonly StatePackage[]
  /** Directories under the workspace roots that hold no `package.json`, such as spike directories. */
  readonly withoutManifest: readonly string[]
}

/**
 * Reads every package manifest under `delo/packages` and `delo/apps`.
 * @param root - the repository root.
 * @returns the packages, with a missing or invalid `delo` field left as no state, and the directories with no manifest.
 */
export function readWorkspace(root: string): StateWorkspace {
  const packages: StatePackage[] = []
  const withoutManifest: string[] = []
  for (const base of WORKSPACE_DIRS) {
    if (!existsSync(join(root, base))) continue
    for (const entry of readdirSync(join(root, base), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = `${base}/${entry.name}`
      const manifest = join(root, dir, 'package.json')
      if (!existsSync(manifest)) {
        withoutManifest.push(dir)
        continue
      }
      const fields = manifestFields.parse(JSON.parse(readFileSync(manifest, 'utf8')))
      const recorded = stateField.safeParse(fields.delo)
      packages.push({
        name: fields.name,
        dir,
        state: recorded.success ? recorded.data.state : undefined,
        unreached: recorded.success ? recorded.data.unreached : undefined,
        dependencies: [
          ...Object.keys(fields.dependencies ?? {}),
          ...Object.keys(fields.peerDependencies ?? {}),
          ...Object.keys(fields.optionalDependencies ?? {}),
        ],
        devDependencies: Object.keys(fields.devDependencies ?? {}),
      })
    }
  }
  return { packages, withoutManifest }
}

/**
 * The packages reachable from the roots through workspace dependencies, the roots included.
 * @param packages - the workspace packages.
 * @param rootDirs - the directories of the root packages.
 * @returns the reachable package names.
 */
export function reachable(packages: readonly StatePackage[], rootDirs: readonly string[]): Set<string> {
  const byName = new Map(packages.map((entry) => [entry.name, entry]))
  const queue = packages.filter((entry) => rootDirs.includes(entry.dir))
  const seen = new Set(queue.map((entry) => entry.name))
  for (let entry = queue.pop(); entry !== undefined; entry = queue.pop()) {
    for (const dependency of entry.dependencies) {
      const next = byName.get(dependency)
      if (next !== undefined && !seen.has(dependency)) {
        seen.add(dependency)
        queue.push(next)
      }
    }
  }
  return seen
}

/**
 * The violations of the three rules, and of the requirement that every package records a valid state.
 * @param packages - the workspace packages.
 * @param rootDirs - the directories of the root packages.
 * @returns one message per violation, in package order; empty when the states agree with the graph.
 */
export function stateErrors(packages: readonly StatePackage[], rootDirs: readonly string[]): string[] {
  const errors: string[] = []
  const seen = reachable(packages, rootDirs)
  const byName = new Map(packages.map((entry) => [entry.name, entry]))
  for (const entry of packages) {
    if (entry.state === undefined) {
      errors.push(`${entry.name}: ${entry.dir}/package.json has no valid "delo" field; expected {"state": "shipped" | "experimental" | "parked", "unreached"?: "<lane>"}`)
      continue
    }
    const isReached = seen.has(entry.name)
    if (entry.unreached !== undefined) {
      if (entry.state === 'parked') errors.push(`${entry.name}: is parked and marked unreached "${entry.unreached}"; only a shipped or experimental package carries the marker`)
      else if (isReached) errors.push(`${entry.name}: is marked unreached "${entry.unreached}" but a root reaches it; remove the marker in the change that wires it`)
    } else if (entry.state === 'parked') {
      if (isReached) errors.push(`${entry.name}: is parked but a root reaches it`)
    } else if (!isReached) {
      errors.push(`${entry.name}: is ${entry.state} but no root reaches it; wire it, or mark it unreached with the lane that wires it, or park it`)
    }
    if (entry.state !== 'parked') {
      for (const dependency of entry.dependencies) {
        if (byName.get(dependency)?.state === 'parked') errors.push(`${entry.name}: ${entry.state} package depends on parked ${dependency}`)
      }
    }
  }
  return errors
}

/**
 * The summary the gate prints on success: one line per state, and the unreached packages with their lanes.
 * @param workspace - the workspace as read.
 * @returns the lines to print.
 */
export function summaryLines(workspace: StateWorkspace): string[] {
  const lines = PACKAGE_STATES.map((state) => {
    const names = workspace.packages.filter((entry) => entry.state === state).map((entry) => entry.name)
    return `gates:package-states: ${state} (${names.length}): ${names.join(' ')}`
  })
  for (const entry of workspace.packages.filter((candidate) => candidate.unreached !== undefined)) {
    lines.push(`gates:package-states: unreached ${entry.name}: lane ${entry.unreached}`)
  }
  for (const dir of workspace.withoutManifest) lines.push(`gates:package-states: ${dir}: no package.json, not a package`)
  return lines
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspace = readWorkspace(repositoryRoot(process.cwd()))
  const errors = stateErrors(workspace.packages, ROOT_DIRS)
  for (const error of errors) console.error(`gates:package-states: ${error}`)
  if (errors.length === 0) for (const line of summaryLines(workspace)) console.log(line)
  process.exitCode = errors.length === 0 ? 0 : 1
}
