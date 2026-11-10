/**
 * The check runner's selection, asked per lane: which merge-tier checks a lane's own changed paths select, and over what
 * scope. The batch reads the tree once, through {@link readPlanSource}, and builds the catalogue with the runner's own
 * `catalog` and `select`, so a lane is a suspect for a check exactly when the runner would run that check for it.
 *
 * @module @delo/tools/batch/plan-source
 */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { GATES } from '../checks/gates/index.ts'
import { catalog, packageDirOf, select, type Budgets, type ForkTree, type StaleDeloBuild } from '../checks/plan.ts'
import { readTree } from '../checks/tree.ts'

/** A check a lane's paths select, and the scope the runner narrows it to; no scope is the whole command. */
export interface SelectedCheck {
  readonly id: string
  readonly scope?: readonly string[] | undefined
}

/** The selection facts the batch reads. */
export interface PlanSource {
  /**
   * The checks the merge tier selects for a set of changed paths, needs included.
   * @param paths - repository-relative changed paths.
   * @returns the checks, in catalogue order.
   */
  readonly select: (paths: readonly string[]) => SelectedCheck[]
  /**
   * The workspace package a path lies in.
   * @param path - a repository-relative path.
   * @returns the package directory, Delo's or upstream's, or undefined outside every package.
   */
  readonly packageOf: (path: string) => string | undefined
}

/** The `checks/budgets.json` fields the catalogue reads. */
const BudgetsSchema = z.object({
  tiers: z.record(z.string(), z.object({ seconds: z.number() })),
  checks: z.record(z.string(), z.object({ memoryGiB: z.number(), perWorker: z.boolean().optional(), exclusive: z.boolean().optional(), seconds: z.number().optional() })),
})

/**
 * The batch's selection over a tree. Every runtime build counts as stale, so the build checks a lane's lanes wait for
 * (`build:artifacts`, `build:delo`) are in the catalogue and a lane that selects a lane needing them is a suspect for them.
 * @param tree - the fork's packages, programs and upstream's packages.
 * @param budgets - the checks' budgets.
 * @returns the selection.
 */
export function planSourceOf(tree: ForkTree, budgets: Budgets): PlanSource {
  const staleDeloBuilds: StaleDeloBuild[] = tree.packages.filter(pkg => (pkg.buildOutputs ?? []).length > 0).map(pkg => ({ name: pkg.name, reason: 'assumed stale for attribution' }))
  const checks = catalog(tree, { workers: { fork: 1, upstream: 1 }, cacheDir: 'node_modules/.cache/delo-checks', budgets, staleRuntime: ['assumed stale for attribution'], staleDeloBuilds, gates: GATES })
  return {
    select: paths => select(checks, tree, { targets: [], changed: { base: 'trunk', paths }, tier: 'merge', only: [], skip: [] }).map(check => ({ id: check.id, scope: check.scope })),
    packageOf: path => packageDirOf(path) ?? tree.upstream.find(pkg => path.startsWith(`${pkg.dir}/`))?.dir,
  }
}

/**
 * The batch's selection over the tree at a repository root, with the runner's budgets.
 * @param root - the repository root.
 * @returns the selection.
 */
export function readPlanSource(root: string): PlanSource {
  const budgets = BudgetsSchema.parse(JSON.parse(readFileSync(new URL('../checks/budgets.json', import.meta.url), 'utf8')))
  return planSourceOf(readTree(root), budgets)
}
