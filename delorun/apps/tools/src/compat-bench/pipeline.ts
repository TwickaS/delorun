/**
 * The stage list. A stage is a typed {@link Stage}: its name, what must have happened before it can run, and a function
 * from the run's state to a result. The runner takes a list of them (the ten below by default), so a later stage, such
 * as one that runs Delorun's own smoke or standards suites with the plugin installed, is one new file that exports a
 * `Stage` and is added to the list passed as `stages`.
 *
 * @module @delorun/tools/compat-bench/pipeline
 */
import type { StageResult } from './card.ts'
import type { StageName } from './observer.ts'
import { clashes, cost, feature, harness, install, restart, screens, start, uninstall, type RunState } from './stages.ts'
import { updateStage } from './update.ts'

/** What must be true before a stage can run. */
export type Needs = 'nothing' | 'installed' | 'started'

/** One stage of a run. */
export interface Stage {
  /** The name the card and the observers' marks use. */
  readonly name: StageName
  /** The state the stage needs; a stage whose need is unmet is recorded as skipped. */
  readonly needs: Needs
  /**
   * Run the stage.
   * @param state - the run's state.
   * @returns the stage's result.
   */
  run(state: RunState): Promise<StageResult>
}

/** The reasons a stage is skipped when its need is unmet. */
export const UNMET: Readonly<Record<Exclude<Needs, 'nothing'>, string>> = {
  installed: 'the plugin did not install',
  started: 'the studio did not start with the plugin',
}

/** The ten stages of the plan, in order. */
export const DEFAULT_STAGES: readonly Stage[] = [
  { name: 'install', needs: 'nothing', run: install },
  { name: 'start', needs: 'installed', run: start },
  { name: 'harness', needs: 'started', run: harness },
  { name: 'screens', needs: 'started', run: screens },
  { name: 'feature', needs: 'started', run: async state => await feature(state, state.exercise) },
  { name: 'restart', needs: 'started', run: restart },
  {
    name: 'update', needs: 'installed',
    run: async state => state.host === 'stock'
      ? { name: 'update', status: 'not-applicable', reason: 'the update test starts from the previous Delorun release', durationMs: 0, failures: [] }
      : await updateStage(state),
  },
  { name: 'clashes', needs: 'started', run: clashes },
  { name: 'cost', needs: 'started', run: cost },
  { name: 'uninstall', needs: 'installed', run: uninstall },
]

/**
 * Whether a stage's need is met.
 * @param stage - the stage.
 * @param state - the run's state.
 * @returns the reason it cannot run, or undefined when it can.
 */
export function unmetNeed(stage: Stage, state: Pick<RunState, 'installed' | 'started'>): string | undefined {
  if (stage.needs === 'nothing') return undefined
  if (stage.needs === 'installed') return state.installed ? undefined : UNMET.installed
  return state.started ? undefined : UNMET.started
}
