/**
 * The machine-wide slot budget's place on this machine: its directories under the system's temporary directory, the budget
 * from the machine and the environment, and the file system, clock and process table that `slots.ts` reads through. The
 * budget's directory belongs to the user and only the user can reach it; the previous queue's directory and lock file keep
 * the shared names that old worktrees use.
 *
 * @module @delo/tools/checks/slot-host
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from './private-dir.ts'
import { processGuard, type QueueHost } from './run-queue.ts'
import type { SlotBudget, SlotPaths } from './slots.ts'

/** The variable that sets the machine's CPU slots. */
export const SLOTS_ENV = 'DELO_CHECKS_SLOTS'
/** The variable that sets how many disk-heavy holders may run at once. */
export const DISK_RUNS_ENV = 'DELO_CHECKS_DISK_RUNS'
/**
 * Disk-heavy holders at once when the environment names no other count. On a 22-CPU, 21 GB machine with an NVMe-backed WSL
 * disk, two disk-heavy holders (one of 15 slots, one of 5) kept the I/O pressure (`/proc/pressure/io`, "some") at 0.5% to 4%
 * and stalled tasks for 0.9% of a 30 s window, while five more runs waited for a disk place with the CPU load near 10. The
 * disk had room for a third holder, and the slots and memory still bound the total.
 */
const DEFAULT_DISK_RUNS = 3

/**
 * The directories: the user's budget directory, and the previous queue's directory and lock file, which old worktrees
 * still take.
 * @param base - the system's temporary directory.
 * @param uid - the user whose budget it is.
 * @returns the paths.
 */
export function slotPaths(base: string, uid: number): SlotPaths {
  return { dir: join(base, `delo-run-checks-${String(uid)}.slots`), oldQueue: join(base, 'delo-run-checks.queue'), oldLock: join(base, 'delo-run-checks.lock') }
}

/**
 * This user's directories under the system's temporary directory, with the budget's directory created with mode 0700.
 * @param base - the system's temporary directory.
 * @param uid - the user, `process.getuid()`.
 * @returns the paths.
 * @throws Error when the budget's directory is a symbolic link or not a directory, belongs to another user, or grants any
 * access to the group or others.
 */
export function privateSlotPaths(base: string, uid: number): SlotPaths {
  const paths = slotPaths(base, uid)
  ensurePrivateDir(paths.dir, uid, 'the slot budget', `remove ${paths.dir} while no run holds or waits for slots, or run \`chmod 700 ${paths.dir}\` as its owner`)
  return paths
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
 * `DELO_CHECKS_DISK_RUNS` disk-heavy places, else 3.
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
 * When a process started: field 22 of `/proc/<pid>/stat`, in clock ticks since boot.
 * @param pid - the process id.
 * @param read - reads a file's text; it throws for a file that does not exist.
 * @returns the start time, or undefined when the process is gone or the system has no `/proc`.
 */
export function processStart(pid: number, read: (path: string) => string = path => readFileSync(path, 'utf8')): string | undefined {
  let text: string
  try {
    text = read(`/proc/${String(pid)}/stat`)
  } catch (gone) {
    // ENOENT: the process is gone, or the system has no /proc.
    void gone
    return undefined
  }
  // The command name in field 2 may hold spaces and parentheses; the fields after its closing parenthesis start at field 3.
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19]
}

/** Clock ticks per second in `/proc/<pid>/stat`, which Linux fixes at 100 for user space. */
const CLOCK_TICKS = 100

/**
 * When a process started on the shared clock: its start in ticks since boot, from `/proc/<pid>/stat`, added to the boot time
 * from `/proc/stat`. The boot time has whole-second resolution.
 * @param pid - the process id.
 * @param read - reads a file's text; it throws for a file that does not exist.
 * @returns milliseconds since the epoch, or undefined when the process is gone or the system has no `/proc`.
 */
export function processStartedAt(pid: number, read: (path: string) => string = path => readFileSync(path, 'utf8')): number | undefined {
  const ticks = Number(processStart(pid, read))
  let boot: number
  try {
    boot = Number(/^btime (\d+)$/m.exec(read('/proc/stat'))?.[1])
  } catch (unreadable) {
    // ENOENT: the system has no /proc.
    void unreadable
    return undefined
  }
  return Number.isFinite(ticks) && Number.isFinite(boot) && boot > 0 ? boot * 1000 + (ticks / CLOCK_TICKS) * 1000 : undefined
}

/**
 * Whether an id is a thread of another process: the thread group in `/proc/<id>/status` differs from the id. A V8 worker
 * thread's id can equal the pid a dead run once had.
 * @param pid - the id.
 * @param read - reads a file's text; it throws for a file that does not exist.
 * @returns true for a thread that is not its process's main thread.
 */
export function processIsThread(pid: number, read: (path: string) => string = path => readFileSync(path, 'utf8')): boolean {
  let text: string
  try {
    text = read(`/proc/${String(pid)}/status`)
  } catch (gone) {
    // ENOENT: the process is gone, or the system has no /proc.
    void gone
    return false
  }
  const group = /^Tgid:\s*(\d+)$/m.exec(text)?.[1]
  return group !== undefined && Number(group) !== pid
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
      modified: path => existsSync(path) ? statSync(path).mtimeMs : undefined,
    },
    now: () => Date.now(),
    pid: process.pid,
    alive: processAlive,
    startOf: pid => processStart(pid),
    startedAt: pid => processStartedAt(pid),
    isThread: pid => processIsThread(pid),
    sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    say,
    guard: processGuard(process),
  }
}
