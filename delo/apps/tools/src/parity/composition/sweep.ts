/**
 * The switch sweep: the state of each registry entry's switch-on scenario.
 * A recorded scenario lives at `snapshots/<profile>/delo-<id>` with its
 * Session fixture, and the `parity-replay` lane replays it with every other
 * corpus scenario under the overlay, so its switch is the only difference
 * from the parity composition. A scenario that has not been recorded keeps
 * its configuration under {@link STAGED_ROOT}, because upstream's corpus gate
 * refuses a scenario directory without a Session fixture; the sweep reports
 * it as pending recording, never as passing.
 *
 * @module @delo/tools/parity/composition/sweep
 */
import type { ParitySwitchEntry } from '@delo/contract-parity-composition'

/** Where the configuration of a switch-on scenario waits for its recording, by `<profile>/delo-<id>`. */
export const STAGED_ROOT = 'delo/apps/tools/src/parity/composition/scenarios'

/** The state of one entry's switch-on scenario. */
export type SweepState =
  | { readonly kind: 'recorded'; readonly scenario: string }
  | { readonly kind: 'pending recording'; readonly scenario: string }
  | { readonly kind: 'planned'; readonly plannedBy: string }
  | { readonly kind: 'feature switch' }
  | { readonly kind: 'missing'; readonly scenario: string }

/** One row of the sweep. */
export interface SweepRow {
  readonly id: string
  readonly state: SweepState
}

/** What the sweep reads from the tree. */
export interface SweepTree {
  /** The file names in a repository directory, or undefined when it does not exist. */
  readonly list: (dir: string) => readonly string[] | undefined
}

const SESSION_FIXTURE = /^session(?:\.\d+)?(?:\.v\d+)?\.jsonl$/u

/**
 * The files a scenario's configuration needs: Web scenarios run through an e2e driver that sets the switch through
 * the scaffold, the other profiles through `runtime.cordis.yml`.
 * @param scenario - `<profile>/delo-<id>`.
 * @returns the file names.
 */
export function scenarioConfigFiles(scenario: string): string[] {
  return scenario.startsWith('web/') ? ['snapshot.yml'] : ['snapshot.yml', 'runtime.cordis.yml']
}

/**
 * The sweep over the registry.
 * @param registry - the switch registry.
 * @param tree - directory listings of the repository.
 * @returns one row per entry, in registry order, and one message per inconsistency.
 */
export function sweep(registry: readonly ParitySwitchEntry[], tree: SweepTree): { rows: SweepRow[]; errors: string[] } {
  const errors: string[] = []
  const rows = registry.map((entry): SweepRow => {
    if (entry.state === 'planned') return { id: entry.id, state: { kind: 'planned', plannedBy: entry.plannedBy } }
    if (!entry.modelVisible || entry.scenario === undefined) return { id: entry.id, state: { kind: 'feature switch' } }
    const { scenario } = entry
    const recorded = tree.list(`snapshots/${scenario}`)
    const staged = tree.list(`${STAGED_ROOT}/${scenario}`)
    const needs = scenarioConfigFiles(scenario)
    if (recorded?.some(name => SESSION_FIXTURE.test(name)) === true) {
      for (const name of needs) if (!recorded.includes(name)) errors.push(`${entry.id}: snapshots/${scenario} has no ${name}`)
      if (staged !== undefined) errors.push(`${entry.id}: snapshots/${scenario} is recorded, so its staged configuration under ${STAGED_ROOT} goes`)
      return { id: entry.id, state: { kind: 'recorded', scenario } }
    }
    if (staged !== undefined) {
      for (const name of needs) if (!staged.includes(name)) errors.push(`${entry.id}: ${STAGED_ROOT}/${scenario} has no ${name}`)
      return { id: entry.id, state: { kind: 'pending recording', scenario } }
    }
    errors.push(`${entry.id}: no switch-on scenario at snapshots/${scenario} and no staged configuration at ${STAGED_ROOT}/${scenario}`)
    return { id: entry.id, state: { kind: 'missing', scenario } }
  })
  const named = new Set(registry.flatMap(entry => entry.state === 'built' && entry.scenario !== undefined ? [entry.scenario] : []))
  for (const profile of tree.list(STAGED_ROOT) ?? []) {
    for (const name of tree.list(`${STAGED_ROOT}/${profile}`) ?? []) {
      if (!named.has(`${profile}/${name}`)) errors.push(`${STAGED_ROOT}/${profile}/${name} is the scenario of no built, model-visible switch`)
    }
  }
  return { rows, errors }
}

/**
 * One line per sweep row.
 * @param row - the row.
 * @returns such as `profile_history: pending recording (session/delo-profile-history)`.
 */
export function sweepLine(row: SweepRow): string {
  const { state } = row
  switch (state.kind) {
    case 'recorded': return `${row.id}: recorded (snapshots/${state.scenario}); parity-replay replays it under the overlay`
    case 'pending recording': return `${row.id}: pending recording (${STAGED_ROOT}/${state.scenario})`
    case 'planned': return `${row.id}: planned (${state.plannedBy}); no switch in the tree yet`
    case 'feature switch': return `${row.id}: feature switch, not model-visible; no scenario`
    case 'missing': return `${row.id}: MISSING switch-on scenario (${state.scenario})`
  }
}
