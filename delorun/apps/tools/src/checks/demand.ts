/**
 * What a run asks of the machine-wide slot budget (`slots.ts`), and the run fitted to what it is granted. A run asks for the
 * slots its checks that will really run can keep busy at once, at least four when it can use them, the memory its largest
 * check needs, and a disk-heavy place when it builds, installs or runs the fork suite. Checks a stored pass serves ask
 * for nothing, and a run with nothing left to run takes no slots. A granted run narrows its test runners' `--maxWorkers`
 * to its slots; the pass cache does not key the worker count.
 *
 * The slots a run asks for are the CPUs its own memory ceiling keeps busy, never the sum of every check's CPUs. The runner
 * starts a check only while the memory it already holds plus that check stays inside the ceiling (`run.ts`), so a plan of
 * ninety checks that each need half a gigabyte runs a handful at a time however many CPUs it names. Asking for the sum
 * reserved the whole machine for work that used a fraction of it, and every other run waited behind that reservation.
 *
 * @module @delorun/tools/checks/demand
 */
import type { PassCache } from './cache.ts'
import type { Check } from './plan.ts'
import type { SlotBudget, SlotDemand } from './slots.ts'
import { isForkSuite, type WithUnits } from './units.ts'

const GIB = 1024 ** 3
/** The fewest slots a run that can use more asks for, so it starts beside a large run and still makes progress. */
export const MIN_RUN_SLOTS = 4
/** The CPUs a granted run keeps beside its test runners for the compilers and generators it runs at the same time. */
const COMPILER_SLOTS = 2

/**
 * Whether a check works the disk hard: a build, a generator, the documentation site's build, or the fork suite.
 * @param check - the check.
 * @returns true for a disk-heavy check.
 */
export function diskHeavy(check: Pick<Check, 'id' | 'group'>): boolean {
  return check.group === 'generate' || check.group === 'docs-site' || isForkSuite(check.id)
}

/**
 * The checks of a plan that will run: not declined, and not served from a stored pass, whole or for every package.
 * @param plan - the plan.
 * @param cache - the pass cache, or undefined when the run has none.
 * @returns the checks, in plan order.
 */
export function checksToRun<T extends WithUnits>(plan: readonly T[], cache: Pick<PassCache, 'keyOf' | 'lookup' | 'unitKey' | 'lookupUnit'> | undefined): T[] {
  return plan.filter((check) => {
    if (check.declined !== undefined) return false
    if (cache === undefined) return true
    if (check.units !== undefined && check.units.length > 0) return check.units.some(unit => cache.lookupUnit(check, unit, cache.unitKey(check, unit)) === undefined)
    const key = cache.keyOf(check)
    return key === undefined || cache.lookup(check, key) === undefined
  })
}

/**
 * A plan without the checks that were planned only as another check's need when no check that would run needs them, such
 * as the native addon's build beside a fork suite every package of which a stored pass serves: no result depends on them.
 * The kept checks no longer name a dropped check among their needs, so the runner does not wait for its result.
 * @param plan - the plan.
 * @param running - the checks of the plan that will run, from {@link checksToRun}.
 * @returns the plan, in plan order.
 */
export function withoutIdleNeeds<T extends Check & { readonly reason: string }>(plan: readonly T[], running: readonly T[]): T[] {
  const runningIds = new Set(running.map(check => check.id))
  const byId = new Map(plan.map(check => [check.id, check]))
  const needed = new Set<string>()
  const visit = (check: T | undefined): void => {
    for (const need of check?.needs ?? []) {
      if (needed.has(need)) continue
      needed.add(need)
      visit(byId.get(need))
    }
  }
  for (const check of running) if (!check.reason.startsWith('needed by ')) visit(check)
  const kept = plan.filter(check => !runningIds.has(check.id) || !check.reason.startsWith('needed by ') || needed.has(check.id))
  const dropped = new Set(plan.filter(check => !kept.includes(check)).map(check => check.id))
  return kept.map(check => check.needs.some(need => dropped.has(need)) ? { ...check, needs: check.needs.filter(need => !dropped.has(need)) } : check)
}

/**
 * The memory a check is counted at when a run asks for slots: its own figure, and for a runner that scales with its workers
 * the figure at the fewest workers a run may be granted, which is also how the run's ceiling is measured. A runner's memory
 * follows the grant (`fitToGrant`), so counting it at its widest would understate what the ceiling can hold.
 * @param check - the check.
 * @returns the bytes.
 */
function demandMemoryOf(check: Check): number {
  return check.budget.perWorker === true ? check.budget.memoryGiB * GIB * Math.min(check.cpus, MIN_RUN_SLOTS) : check.memoryBytes
}

/**
 * The CPUs a run can keep busy inside a memory ceiling: its checks taken cheapest memory per CPU first, so the answer is
 * the most the ceiling allows rather than what the checks would use if memory were free. A check too large for the
 * ceiling is passed over, and the smaller ones behind it are still counted.
 * @param checks - the checks that will run.
 * @param memoryBytes - the run's memory ceiling.
 * @returns the CPUs the ceiling can keep busy.
 */
export function concurrencyWithin(checks: readonly Check[], memoryBytes: number): number {
  const sized = checks.map(check => ({ cpus: check.cpus, memoryBytes: demandMemoryOf(check) }))
  const order = sized.sort((a, b) => a.memoryBytes / a.cpus - b.memoryBytes / b.cpus)
  let memory = 0
  let cpus = 0
  for (const check of order) {
    if (memory + check.memoryBytes > memoryBytes) continue
    memory += check.memoryBytes
    cpus += check.cpus
  }
  return cpus
}

/**
 * What a run asks for.
 * @param running - the checks that will run, from {@link checksToRun}; not empty.
 * @param budget - the machine's budget, whose memory per slot sets the run's share.
 * @param priority - 0 for a push to the trunk, otherwise 1.
 * @param label - what the run is, for `--queue`.
 * @returns the demand.
 */
export function runDemand(running: readonly Check[], budget: SlotBudget, priority: 0 | 1, label: string): SlotDemand {
  const memoryBytes = Math.max(...running.map(demandMemoryOf))
  const want = Math.max(1, Math.min(budget.slots, concurrencyWithin(running, memoryBytes)))
  const min = Math.min(want, MIN_RUN_SLOTS)
  return { want, min, memoryBytes, disk: running.some(diskHeavy), priority, label }
}

/**
 * A plan fitted to a grant: a test runner whose `--maxWorkers` exceeds the slots it may use runs with that many workers,
 * and its CPUs and per-worker memory follow. A runner keeps two slots for the compilers beside it when the grant has more
 * than eight.
 * @param plan - the plan.
 * @param slots - the granted slots.
 * @returns the plan, with the workers of each test runner at most the grant allows.
 */
export function fitToGrant<T extends Check>(plan: readonly T[], slots: number): T[] {
  const allowed = Math.max(1, slots > 8 ? slots - COMPILER_SLOTS : slots)
  return plan.map((check) => {
    const at = check.command.findIndex(arg => arg.startsWith('--maxWorkers='))
    const workers = Number(check.command[at]?.slice('--maxWorkers='.length))
    if (at < 0 || workers <= allowed) return check
    const command = check.command.map((arg, index) => index === at ? `--maxWorkers=${String(allowed)}` : arg)
    return { ...check, command, cpus: Math.min(check.cpus, allowed), memoryBytes: check.budget.perWorker === true ? Math.round(check.budget.memoryGiB * GIB * allowed) : check.memoryBytes }
  })
}
