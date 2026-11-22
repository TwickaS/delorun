/**
 * Which part of a run counts as the plugin's behaviour. The runner marks each stage (`mark`), and the events of the
 * in-process hooks and the helper carry a time. Delorun's own install and removal of the plugin (its package manager
 * fetching from the registry, starting programs) are not what the plugin did, so events in the `install`, `uninstall`
 * and `update` stages, and between stages (the runner's own set-up commands), are left out; every other stage counts.
 * A baseline run has no plugin, so all of its events count.
 *
 * @module @delorun/tools/compat-bench/privacy/stages
 */
import type { StageName } from '../observer.ts'

/** One stage mark, as the observer writes it to `stages.jsonl`. */
export type StageMark = Readonly<{ at: string; stage: StageName; phase: 'before' | 'after' }>

/** The stages whose events are not the plugin's. */
export const UNATTRIBUTED_STAGES: ReadonlyArray<StageName> = ['install', 'update', 'uninstall']

/** A span of time in milliseconds since the epoch. */
export type Window = Readonly<{ from: number; to: number }>

/**
 * Parse `stages.jsonl`.
 * @param text - the file's text.
 * @returns the marks, skipping torn lines.
 */
export function parseMarks(text: string): ReadonlyArray<StageMark> {
  const marks: StageMark[] = []
  for (const line of text.split('\n')) {
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value === 'object' && value !== null && 'at' in value && 'stage' in value && 'phase' in value) marks.push(value as StageMark)
    } catch { /* a blank or torn line */ }
  }
  return marks
}

/**
 * Work out the windows in which the plugin's behaviour counts: from a counted stage's `before` mark to its `after` mark
 * (to `until` when the run ended inside it).
 * @param marks - the stage marks in order.
 * @param until - the time the run ended, in milliseconds.
 * @returns the windows.
 */
export function attributedWindows(marks: ReadonlyArray<StageMark>, until: number): ReadonlyArray<Window> {
  const windows: Window[] = []
  const open = new Map<StageName, number>()
  for (const mark of marks) {
    const time = Date.parse(mark.at)
    if (UNATTRIBUTED_STAGES.includes(mark.stage)) continue
    if (mark.phase === 'before') {
      open.set(mark.stage, time)
    } else {
      const from = open.get(mark.stage)
      if (from !== undefined) windows.push({ from, to: time })
      open.delete(mark.stage)
    }
  }
  for (const from of open.values()) windows.push({ from, to: until })
  return windows
}

/**
 * Keep the events that happened inside a window. An event with no time is kept (a log that predates the times).
 * @param events - events that may carry a time.
 * @param windows - the windows that count.
 * @returns the events inside them.
 */
export function withinWindows<T extends Readonly<{ ts?: number }>>(events: ReadonlyArray<T>, windows: ReadonlyArray<Window>): ReadonlyArray<T> {
  return events.filter(event => event.ts === undefined || windows.some(window => event.ts !== undefined && event.ts >= window.from && event.ts <= window.to))
}
