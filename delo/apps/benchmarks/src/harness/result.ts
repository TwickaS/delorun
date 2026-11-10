/**
 * The machine-readable result of one benchmark run, `delo.benchmark-result/1`: when and on which commit it ran, the
 * machine's facts and load, the options, and per suite each scenario's raw samples and summary per measured item,
 * the scenarios' failures and the items skipped with their reasons. Every text that came from a child process passes
 * {@link Scrubber} first, so the result names no path outside the throwaway roots and no user.
 *
 * @module @delo/benchmarks/harness/result
 */
import { userInfo } from 'node:os'
import type { MachineFacts } from './machine.ts'
import { summarize, type Summary } from './stats.ts'

/** The result format. */
export const RESULT_SCHEMA = 'delo.benchmark-result/1'

/** One measured item of a scenario. */
export interface PhaseResult {
  /** The item's id, such as `download`. */
  readonly phase: string
  /** Every sample, in milliseconds, in run order. */
  readonly samples: readonly number[]
  /** Their summary. */
  readonly summary: Summary
}

/** One scenario of a suite. */
export interface ScenarioResult {
  /** The scenario's id, such as `same-format`. */
  readonly scenario: string
  /** What it varies, in one sentence. */
  readonly description: string
  /** Its workload parameters. */
  readonly parameters: Readonly<Record<string, string | number | boolean>>
  /** How many repetitions completed. */
  readonly completed: number
  /** The measured items, in the order the suite declares them. */
  readonly phases: readonly PhaseResult[]
  /** Why a repetition failed, scrubbed; a scenario with failures is reported and fails the budget check. */
  readonly failures: readonly string[]
}

/** Something a suite did not measure. */
export interface Skipped {
  /** The scenario or item. */
  readonly item: string
  /** Why. */
  readonly reason: string
}

/** One suite's part of a result. */
export interface SuiteResult {
  /** The suite's id. */
  readonly suite: string
  /** Its scenarios. */
  readonly scenarios: readonly ScenarioResult[]
  /** What it skipped. */
  readonly skipped: readonly Skipped[]
}

/** A whole result. */
export interface BenchmarkResult {
  /** {@link RESULT_SCHEMA}. */
  readonly schema: typeof RESULT_SCHEMA
  /** RFC 3339 UTC time the run started. */
  readonly startedAt: string
  /** The commit measured. */
  readonly commit: string
  /** The machine. */
  readonly machine: MachineFacts
  /** Load averages before and after the run. */
  readonly load: { readonly before: readonly number[], readonly after: readonly number[] }
  /** The run's options. */
  readonly options: Readonly<Record<string, string | number | boolean | readonly string[]>>
  /** Each suite. */
  readonly suites: readonly SuiteResult[]
}

/** Collects samples per item over a scenario's repetitions, in first-seen order. */
export class Samples {
  private readonly items = new Map<string, number[]>()

  /**
   * Add one sample.
   * @param phase - the item.
   * @param milliseconds - the sample.
   */
  add(phase: string, milliseconds: number): void {
    const list = this.items.get(phase) ?? []
    list.push(milliseconds)
    this.items.set(phase, list)
  }

  /**
   * Add every item of one repetition.
   * @param timings - the item's samples of the repetition.
   */
  addAll(timings: Readonly<Record<string, number>>): void {
    for (const [phase, milliseconds] of Object.entries(timings)) this.add(phase, milliseconds)
  }

  /**
   * The items with their summaries, ordered by the given order and then by first appearance.
   * @param order - the suite's declared order of items.
   * @returns the items.
   */
  results(order: readonly string[] = []): readonly PhaseResult[] {
    const rank = (phase: string): number => {
      const at = order.indexOf(phase)
      return at === -1 ? order.length : at
    }
    return [...this.items.entries()]
      .map(([phase, samples]) => ({ phase, samples: [...samples], summary: summarize(samples) }))
      .sort((a, b) => rank(a.phase) - rank(b.phase))
  }
}

/** Replaces paths and names that must not reach a result. */
export class Scrubber {
  private readonly replacements: (readonly [string, string])[] = []

  /**
   * @param homes - the real home directories, shown as `<home>`.
   * @param user - the user name, shown as `<user>`.
   */
  constructor(homes: readonly string[], user: string = userInfo().username) {
    for (const home of homes) this.replacements.push([home, '<home>'])
    if (user.length >= 3) this.replacements.push([user, '<user>'])
  }

  /**
   * Show a throwaway root as `<root>`.
   * @param path - the root.
   */
  addRoot(path: string): void {
    this.replacements.unshift([path, '<root>'])
  }

  /**
   * Replace every known path and name in a text.
   * @param text - the text.
   * @returns the text with each replaced.
   */
  scrub(text: string): string {
    let scrubbed = text
    for (const [from, to] of this.replacements) scrubbed = scrubbed.split(from).join(to)
    return scrubbed
  }
}
