/**
 * What a suite is and what the harness gives it. A suite measures one point where a person waits on Delo; it declares
 * its scenarios and its measured items, and returns per scenario the samples of each item over the run's repetitions.
 * Adding a suite is one module under `src/suites/` and one entry in `src/suites/index.ts`.
 *
 * @module @delo/benchmarks/harness/suite
 */
import type { LocalChannel } from '../fixtures/channel.ts'
import type { ClosureDirectory, DataFormatVariant } from '../fixtures/closure.ts'
import type { MachineFacts } from './machine.ts'
import type { Scrubber, SuiteResult } from './result.ts'
import type { BenchRoot } from './roots.ts'

/** The options every suite reads. */
export interface RunOptions {
  /** Repetitions per scenario. */
  readonly repeat: number
  /** Chats in the small set. */
  readonly chatsSmall: number
  /** Chats in the large set. */
  readonly chatsLarge: number
  /** Synthetic plugins where a scenario installs many. */
  readonly plugins: number
}

/** The fixtures suites share within one run. */
export interface SharedFixtures {
  /** The run's local channel and launcher. */
  readonly channel: LocalChannel
  /**
   * A release closure of a version, derived from the run's base closure.
   * @param version - the version.
   * @param variant - its `data-formats.json`.
   * @returns the closure's files.
   */
  closure(version: string, variant: DataFormatVariant): Promise<ClosureDirectory>
  /**
   * A template root made once per key and run; suites copy it and never change it.
   * @param key - the template's key.
   * @param make - fills a new root the first time the key is asked for.
   * @returns the template's root.
   */
  template(key: string, make: (root: BenchRoot) => Promise<void>): Promise<BenchRoot>
}

/** What the harness gives a suite. */
export interface SuiteContext {
  /** The repository root. */
  readonly repository: string
  /** The benchmark cache. */
  readonly cache: string
  /** The run's options. */
  readonly options: RunOptions
  /** The machine's facts. */
  readonly machine: MachineFacts
  /** Scrubs text before it enters a result. */
  readonly scrubber: Scrubber
  /**
   * The shared fixtures, created on first use.
   * @returns the fixtures.
   */
  fixtures(): Promise<SharedFixtures>
  /**
   * A new throwaway root, removed at the end of the run if the suite does not remove it first.
   * @returns the root.
   */
  newRoot(): BenchRoot
  /**
   * Write a progress line to standard error.
   * @param text - the line.
   */
  log(text: string): void
}

/** One suite. */
export interface Suite {
  /** Its id, as `--suite` names it. */
  readonly id: string
  /** Its title. */
  readonly title: string
  /** Its measured items, by id, with what each spans; the result lists items in this order. */
  readonly items: Readonly<Record<string, string>>
  /** Its scenarios, as `--scenario` names them. */
  readonly scenarios: readonly { readonly id: string, readonly description: string }[]
  /**
   * Measure the selected scenarios.
   * @param context - what the harness gives it.
   * @param selected - the scenario ids to run.
   * @returns the suite's result.
   */
  run(context: SuiteContext, selected: readonly string[]): Promise<SuiteResult>
}
