/**
 * The machine-wide slot budget's place on this machine: its directories under the system's temporary directory, the budget
 * from the machine and the environment, and the file system, clock and process table that `slots.ts` reads through. The
 * budget's directory belongs to the user and only the user can reach it; the previous queue's directory and lock file keep
 * the shared names that old worktrees use.
 *
 * @module @delorun/tools/checks/slot-host
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ensurePrivateDir } from './private-dir.ts'
import { processGuard, type QueueHost } from './run-queue.ts'
import type { SlotBudget, SlotPaths } from './slots.ts'

const GIB = 1024 ** 3

/** The variable that sets the machine's CPU slots. */
export const SLOTS_ENV = 'DELORUN_CHECKS_SLOTS'
/** The variable that sets the memory the runs may hold together, in GiB. */
export const MEMORY_ENV = 'DELORUN_CHECKS_MEMORY_GIB'
/** The variable that sets how many disk-heavy holders may run at once. */
export const DISK_RUNS_ENV = 'DELORUN_CHECKS_DISK_RUNS'
/**
 * Disk-heavy holders at once when the environment names no other count. The figure was measured on a 22-CPU, 21 GB machine
 * with an NVMe-backed WSL disk, where two holders kept the I/O pressure (`/proc/pressure/io`, "some") at 0.5% to 4% and the
 * disk had room for a third. It is a starting point, not a measurement of this machine: a disk that reports no seek cost
 * (`rotational` 0, as an NVMe or a virtio disk does) takes more holders before it saturates, so {@link diskRunsFor} raises
 * the count on one, and `DELORUN_CHECKS_DISK_RUNS` overrides both.
 */
const DEFAULT_DISK_RUNS = 3
/** Disk-heavy holders on a disk that reports no seek cost, where the disk is not the first thing to saturate. */
const SOLID_STATE_DISK_RUNS = 4

/**
 * The directories: the user's budget directory, and the previous queue's directory and lock file, which old worktrees
 * still take.
 * @param base - the system's temporary directory.
 * @param uid - the user whose budget it is.
 * @returns the paths.
 */
export function slotPaths(base: string, uid: number): SlotPaths {
  return { dir: join(base, `delorun-checks-${String(uid)}.slots`), oldQueue: join(base, 'delorun-checks.queue'), oldLock: join(base, 'delorun-checks.lock') }
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
 * A positive number of GiB from the environment, in bytes.
 * @param env - the environment.
 * @param name - the variable.
 * @param fallback - the bytes when the variable is unset or empty.
 * @returns the bytes.
 * @throws Error when the variable is set to anything but a positive number.
 */
function gib(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const text = env[name]
  if (text === undefined || text === '') return fallback
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of GiB, got ${text}`)
  return Math.round(value * GIB)
}

/**
 * The disk-heavy places a disk takes: {@link SOLID_STATE_DISK_RUNS} on a disk that reports no seek cost, else
 * {@link DEFAULT_DISK_RUNS}.
 * @param rotational - the disk's `rotational` flag, or undefined where the machine reports none.
 * @returns the count.
 */
export function diskRunsFor(rotational: boolean | undefined): number {
  return rotational === false ? SOLID_STATE_DISK_RUNS : DEFAULT_DISK_RUNS
}

/**
 * How far above the hardware a declared slot count may go before the queue says so. A generous ceiling is meant to sit near
 * the machine and rarely bind; a figure several times the CPUs is not a ceiling at all, and it also distorts the memory
 * arithmetic, since a request that declares no memory is reserved its slots' share of the budget (`slots.ts`).
 */
export const SLOTS_CEILING_FACTOR = 2

/**
 * The line that says a declared slot count is far above the hardware, or undefined when it is not. The figure is the
 * owner's to set, so the queue reports the mismatch rather than overriding it: a count left over from a larger machine
 * overfills this one, and the memory arithmetic follows the count rather than the machine.
 * @param budget - the machine's budget.
 * @param cpus - the CPUs this process may use.
 * @returns the warning, or undefined when the count is within {@link SLOTS_CEILING_FACTOR} times the CPUs.
 */
export function budgetWarning(budget: SlotBudget, cpus: number): string | undefined {
  const ceiling = Math.max(1, cpus * SLOTS_CEILING_FACTOR)
  if (budget.slots <= ceiling) return undefined
  return `${SLOTS_ENV}=${String(budget.slots)} is ${(budget.slots / cpus).toFixed(1)} times this machine's ${String(cpus)} CPUs: set it near the hardware, or the queue overfills the machine and reserves memory by a share of a budget it does not have`
}

/**
 * The machine's budget: `DELORUN_CHECKS_SLOTS` CPU slots, else the CPUs; `DELORUN_CHECKS_MEMORY_GIB` of memory, else the
 * memory the runner budgets; and `DELORUN_CHECKS_DISK_RUNS` disk-heavy places, else what the disk takes.
 * @param cpus - the CPUs this process may use.
 * @param memoryBytes - the memory the runs may hold together, from {@link runMemoryBytes}.
 * @param env - the environment.
 * @param rotational - the disk's `rotational` flag, or undefined where the machine reports none.
 * @returns the budget.
 * @throws Error when a variable is not a positive number.
 */
export function machineBudget(cpus: number, memoryBytes: number, env: NodeJS.ProcessEnv, rotational?: boolean): SlotBudget {
  return { slots: positive(env, SLOTS_ENV, cpus), memoryBytes: gib(env, MEMORY_ENV, memoryBytes), diskRuns: positive(env, DISK_RUNS_ENV, diskRunsFor(rotational)) }
}

/**
 * The disk's `rotational` flag for the file system a directory lies on, read from `/sys/dev/block`.
 * @param dir - a directory on the disk.
 * @param read - reads a file's text; it throws for a file that does not exist.
 * @param link - reads a symbolic link's target.
 * @returns false for a disk that reports no seek cost, true for one that does, and undefined where the machine reports none.
 */
export function diskRotational(dir: string, read: (path: string) => string = path => readFileSync(path, 'utf8'), link: (path: string) => string = path => readlinkSync(path)): boolean | undefined {
  let device: string
  try {
    // `/sys/dev/block` names each block device by its major:minor, which `stat` packs into one number.
    const dev = statSync(dir).dev
    device = `${String((dev >> 8) & 0xfff)}:${String((dev & 0xff) | ((dev >> 12) & 0xfff00))}`
  } catch (error) {
    // ENOENT: no such directory.
    void error
    return undefined
  }
  try {
    // The entry links to the device's directory, which for a partition is `.../block/<disk>/<partition>`: the disk is the
    // directory above it, and only the disk has a `queue`.
    const target = link(`/sys/dev/block/${device}`)
    const parts = target.split('/')
    const at = parts.lastIndexOf('block')
    const disk = parts[at + 1] ?? ''
    return read(`/sys/block/${disk}/queue/rotational`).trim() !== '0'
  } catch (error) {
    // No /sys/dev/block, or no queue for the device: the machine reports no disk.
    void error
    return undefined
  }
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
