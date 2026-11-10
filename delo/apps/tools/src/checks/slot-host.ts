/**
 * The machine-wide slot budget's place on this machine: its directories under the system's temporary directory, the budget
 * from the machine and the environment, and the file system, clock and process table that `slots.ts` reads through.
 *
 * @module @delo/tools/checks/slot-host
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { processGuard, type QueueHost } from './run-queue.ts'
import type { SlotBudget, SlotPaths } from './slots.ts'

/** The variable that sets the machine's CPU slots. */
export const SLOTS_ENV = 'DELO_CHECKS_SLOTS'
/** The variable that sets how many disk-heavy holders may run at once. */
export const DISK_RUNS_ENV = 'DELO_CHECKS_DISK_RUNS'
/** Disk-heavy holders at once when the environment names no other count. */
const DEFAULT_DISK_RUNS = 2

/**
 * The directories: the budget's, and the previous queue's directory and lock file, which old worktrees still take.
 * @param base - the system's temporary directory.
 * @returns the paths.
 */
export function slotPaths(base: string = tmpdir()): SlotPaths {
  return { dir: join(base, 'delo-run-checks.slots'), oldQueue: join(base, 'delo-run-checks.queue'), oldLock: join(base, 'delo-run-checks.lock') }
}

/**
 * A positive whole number from the environment.
 * @param env - the environment.
 * @param name - the variable.
 * @param fallback - the value when the variable is unset or empty.
 * @returns the number.
 * @throws Error when the variable is set to anything but a positive whole number.
 */
function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = env[name]
  if (text === undefined || text === '') return fallback
  const value = Number(text)
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive whole number, got ${text}`)
  return value
}

/**
 * The machine's budget: `DELO_CHECKS_SLOTS` CPU slots, else the CPUs; the memory the runner budgets; and
 * `DELO_CHECKS_DISK_RUNS` disk-heavy places, else 2.
 * @param cpus - the CPUs this process may use.
 * @param memoryBytes - the memory the runs may hold together.
 * @param env - the environment.
 * @returns the budget.
 * @throws Error when either variable is not a positive whole number.
 */
export function machineBudget(cpus: number, memoryBytes: number, env: NodeJS.ProcessEnv): SlotBudget {
  return { slots: positive(env, SLOTS_ENV, cpus), memoryBytes, diskRuns: positive(env, DISK_RUNS_ENV, DEFAULT_DISK_RUNS) }
}

/**
 * Whether a process is running: signal 0 reaches it, or it belongs to another user.
 * @param pid - the process id.
 * @returns true while it runs.
 */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (gone) {
    // ESRCH: no such process. EPERM: it runs as another user.
    return gone instanceof Error && 'code' in gone && gone.code === 'EPERM'
  }
}

/**
 * This process as the budget sees it, on the real file system.
 * @param say - prints a line to the run's error output.
 * @returns the host.
 */
export function nodeSlotHost(say: (line: string) => void): QueueHost {
  return {
    fs: {
      ensureDir: path => { mkdirSync(path, { recursive: true }) },
      list: path => existsSync(path) ? readdirSync(path) : [],
      create: (path, text) => { writeFileSync(path, text, { flag: 'wx' }) },
      rename: renameSync,
      remove: path => { rmSync(path, { force: true }) },
      read: path => existsSync(path) ? readFileSync(path, 'utf8') : undefined,
    },
    now: () => Date.now(),
    pid: process.pid,
    alive: processAlive,
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    say,
    guard: processGuard(process),
  }
}
