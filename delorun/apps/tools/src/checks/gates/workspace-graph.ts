/**
 * Workspace-graph gate: Delorun's packages build in an order and the runtime closure carries no release or developer
 * tooling. Run from anywhere inside the repository: `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/workspace-graph.ts`.
 * It prints one line per violation and exits 1 on a violation.
 *
 * The rules, over the packages under `delorun/packages` and `delorun/apps`:
 *
 * 1. No cycle runs through their `dependencies`, `peerDependencies`, `optionalDependencies` and `devDependencies`.
 *    `pnpm run` orders packages by all four sections and refuses a cycle with `ERR_PNPM_TASK_CYCLE`, which stops the
 *    release build in `build-closure`.
 * 2. No package in {@link TOOLING_PACKAGES} is reachable over the first three sections from the closure's deploy root,
 *    which `delorun/apps/release/closure.json` names: `pnpm deploy --prod` copies exactly that set into the runtime
 *    closure, and the tooling imports sources Node does not run from `node_modules`.
 *
 * @module @delorun/tools/checks/gates/workspace-graph
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { repositoryRoot } from '../../git.ts'
import { readWorkspace, type StatePackage } from './package-states.ts'

/** The packages that build, sign and check releases and the repository; the runtime closure carries none of them. */
export const TOOLING_PACKAGES = ['@delorun/release', '@delorun/tools'] as const

/** The release recipe that names the closure's deploy root. */
export const CLOSURE_RECIPE = 'delorun/apps/release/closure.json'

const recipeFields = z.looseObject({ deployRoot: z.string().min(1) })

/**
 * Dependency cycles among the packages, found by a depth-first walk in input order: at least one through every set of
 * packages that depend on each other, each cycle listed once.
 * @param packages - the workspace packages.
 * @returns each cycle as the package names along it, the first name repeated at the end; empty when the graph is acyclic.
 */
export function dependencyCycles(packages: readonly StatePackage[]): string[][] {
  const byName = new Map(packages.map((entry) => [entry.name, entry]))
  const edges = (entry: StatePackage): string[] => [...entry.dependencies, ...entry.devDependencies].filter((name) => byName.has(name))
  const done = new Set<string>()
  const cycles: string[][] = []
  const seenCycles = new Set<string>()
  const visit = (name: string, path: string[]): void => {
    const at = path.indexOf(name)
    if (at !== -1) {
      const cycle = path.slice(at)
      const key = [...cycle].sort().join(' ')
      if (!seenCycles.has(key)) {
        seenCycles.add(key)
        cycles.push([...cycle, name])
      }
      return
    }
    if (done.has(name)) return
    for (const next of edges(byName.get(name)!)) visit(next, [...path, name])
    done.add(name)
  }
  for (const entry of packages) visit(entry.name, [])
  return cycles
}

/**
 * The tooling packages the deploy root reaches over production dependencies, each with the path that reaches it.
 * @param packages - the workspace packages.
 * @param deployRoot - the name of the closure's root package.
 * @returns one message per tooling package reached; empty when the closure carries none.
 */
export function toolingErrors(packages: readonly StatePackage[], deployRoot: string): string[] {
  const byName = new Map(packages.map((entry) => [entry.name, entry]))
  if (!byName.has(deployRoot)) return [`${CLOSURE_RECIPE} names deploy root ${deployRoot}, which is no package under delorun/packages or delorun/apps`]
  const via = new Map<string, string[]>([[deployRoot, [deployRoot]]])
  const queue = [deployRoot]
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    for (const dependency of byName.get(name)!.dependencies) {
      if (byName.has(dependency) && !via.has(dependency)) {
        via.set(dependency, [...via.get(name)!, dependency])
        queue.push(dependency)
      }
    }
  }
  return TOOLING_PACKAGES.filter((name) => via.has(name)).map((name) => `the runtime closure carries ${name}, through ${via.get(name)!.join(' -> ')}; a shipped package depends on release or developer tooling`)
}

/**
 * Every violation of the two rules in a repository.
 * @param root - the repository root.
 * @returns one message per violation; empty when the graph passes.
 */
export function graphErrors(root: string): string[] {
  const { packages } = readWorkspace(root)
  const recipe = recipeFields.parse(JSON.parse(readFileSync(join(root, CLOSURE_RECIPE), 'utf8')))
  return [
    ...dependencyCycles(packages).map((cycle) => `dependency cycle ${cycle.join(' -> ')}; pnpm refuses to order a build over it`),
    ...toolingErrors(packages, recipe.deployRoot),
  ]
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = graphErrors(repositoryRoot(process.cwd()))
  for (const error of errors) console.error(`gates:workspace-graph: ${error}`)
  if (errors.length === 0) console.log('gates:workspace-graph: no dependency cycle, and the runtime closure carries no tooling')
  process.exitCode = errors.length === 0 ? 0 : 1
}
