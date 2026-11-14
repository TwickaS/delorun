/**
 * What the machine-wide slot budget (`slots.ts`) needs from a process, which runs skip it (a light plan), a run's priority,
 * and the release of its files when the process ends. The file system, clock, process table and signals are injected, so
 * the specs start no process.
 *
 * @module @delorun/tools/checks/run-queue
 */
import type { Check } from './plan.ts'

/** The file system the slot budget uses; every path is absolute. */
export interface QueueFs {
  /** Create the directory and its parents. */
  ensureDir(path: string): void
  /** The names in a directory, or none when it does not exist. */
  list(path: string): string[]
  /** Create a file exclusively; throws when it exists. */
  create(path: string, text: string): void
  /** Rename a file in one step. */
  rename(from: string, to: string): void
  /** Remove a file, silently when it is absent. */
  remove(path: string): void
  /** A file's text, or undefined when it does not exist. */
  read(path: string): string | undefined
  /** When a file was last written, in milliseconds on the shared clock, or undefined when it does not exist. */
  modified(path: string): number | undefined
}

/** What a run that takes slots needs from its process. */
export interface QueueHost {
  readonly fs: QueueFs
  /** Milliseconds from a clock all runs on the machine share. */
  now(): number
  /** This process's id. */
  readonly pid: number
  /** Whether a process with this id is running. */
  alive(pid: number): boolean
  /**
   * When the process with this id started, as the kernel reports it, so a recorded holder whose id a later process reuses
   * is not taken for that process; undefined when the process is gone or the system does not report it.
   */
  startOf(pid: number): string | undefined
  /**
   * When the process with this id started, in milliseconds on the shared clock; undefined when the process is gone or the
   * system does not report it. A file that records no start time is attributed to a process only if the process started
   * before the file was last written.
   */
  startedAt(pid: number): number | undefined
  /** Whether the id belongs to a thread of another process, which a signal reaches but which holds nothing. */
  isThread(pid: number): boolean
  /** Resolve after the milliseconds. */
  sleep(milliseconds: number): Promise<void>
  /** Print a line to the run's error output. */
  say(line: string): void
  /** Run `release` when the process ends, and on SIGINT or SIGTERM before the signal is raised again. */
  guard(release: () => void): void
}

/** The most memory a run of light checks may plan and still take no slots. */
export const LIGHT_MEMORY_BYTES = 4 * 1024 ** 3
/**
 * Whether a plan is small enough to run without taking slots: every check keeps one CPU busy and neither runs alone nor
 * only at the merge, and the checks' memory sums to at most 4 GiB, as the repository gates, the boundary check and the JSDoc
 * rules do. An empty plan is light.
 * @param plan - the checks the run will start.
 * @returns true when the run takes no slots.
 */
export function isLightPlan(plan: readonly Pick<Check, 'exclusive' | 'mergeOnly' | 'memoryBytes' | 'cpus'>[]): boolean {
  return plan.every(check => check.cpus <= 1 && check.exclusive !== true && check.mergeOnly !== true) && plan.reduce((sum, check) => sum + check.memoryBytes, 0) <= LIGHT_MEMORY_BYTES
}

/**
 * The queue priority of a run: 0 for a push to the trunk, which `DELORUN_GATE_PRIORITY=trunk` also declares, otherwise 1.
 * @param env - the run's environment.
 * @param pushesTrunk - whether the run is a pre-push whose pushed refs include the trunk.
 * @returns the priority; the lower number goes first.
 */
export function gatePriority(env: NodeJS.ProcessEnv, pushesTrunk: boolean): 0 | 1 {
  return env['DELORUN_GATE_PRIORITY'] === 'trunk' || pushesTrunk ? 0 : 1
}

/**
 * The release of a run's slots on a process: the release runs when the process ends, and on SIGINT or SIGTERM it runs
 * before the signal is raised again with its default action.
 * @param proc - the process, or a stand-in with the same members.
 * @returns the `guard` function a `QueueHost` takes.
 */
export function processGuard(proc: Pick<NodeJS.Process, 'once' | 'kill' | 'pid'>): QueueHost['guard'] {
  return release => {
    proc.once('exit', release)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      proc.once(signal, () => {
        release()
        proc.kill(proc.pid, signal)
      })
    }
  }
}
