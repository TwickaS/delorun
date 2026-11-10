/**
 * The machine-wide queue that serialises heavy runs of the check runner. A run that waits writes a ticket file
 * `<priority>-<milliseconds, zero-padded>-<pid>` into one directory; the run whose ticket sorts first among the tickets of
 * live processes takes the turn by renaming its ticket to `<name>.held`, and removes the ticket when it ends. The ordering is
 * first come, first served within a priority; priority 0 (a push to the trunk) goes ahead of waiting priority 1 tickets and
 * never interrupts a holder. Runs of old worktrees take a single lock file instead, which a new run also waits for.
 * The filesystem, clock, process table and signals are injected, so the specs start no process.
 *
 * @module @delo/tools/checks/run-queue
 */
import type { Check } from './plan.ts'

/** The file system the queue uses; every path is absolute. */
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
}

/** What a queue run needs from its process. */
export interface QueueHost {
  readonly fs: QueueFs
  /** Milliseconds from a clock all runs on the machine share. */
  now(): number
  /** This process's id. */
  readonly pid: number
  /** Whether a process with this id is running. */
  alive(pid: number): boolean
  /** Resolve after the milliseconds. */
  sleep(milliseconds: number): Promise<void>
  /** Print a line to the run's error output. */
  say(line: string): void
  /** Run `release` when the process ends, and on SIGINT or SIGTERM before the signal is raised again. */
  guard(release: () => void): void
}

/** Where the queue lives: its directory and the old single lock file that earlier runners take. */
export interface QueuePaths {
  readonly dir: string
  readonly oldLock: string
}

/** How long a waiting run sleeps between looks at the queue. */
export const POLL_MILLISECONDS = 2000
/** The most memory a run of unexclusive, non-merge checks may plan and still skip the queue. */
export const LIGHT_MEMORY_BYTES = 2 * 1024 ** 3
const HELD = '.held'
const MILLISECONDS_WIDTH = 15

/** One ticket as read from a file name. */
interface Ticket {
  readonly file: string
  readonly pid: number
  readonly held: boolean
}

/**
 * Whether a plan is small enough to run without waiting in the queue: no check runs alone or only at the merge, and the
 * checks' memory sums to at most 2 GiB. An empty plan is light.
 * @param plan - the checks the run will start.
 * @returns true when the run takes no ticket.
 */
export function isLightPlan(plan: readonly Pick<Check, 'exclusive' | 'mergeOnly' | 'memoryBytes'>[]): boolean {
  return plan.every(check => check.exclusive !== true && check.mergeOnly !== true) && plan.reduce((sum, check) => sum + check.memoryBytes, 0) <= LIGHT_MEMORY_BYTES
}

/**
 * The queue priority of a run: 0 for a push to the trunk, which `DELO_GATE_PRIORITY=trunk` also declares, otherwise 1.
 * @param env - the run's environment.
 * @param pushesTrunk - whether the run is a pre-push whose pushed refs include the trunk.
 * @returns the priority; the lower number goes first.
 */
export function gatePriority(env: NodeJS.ProcessEnv, pushesTrunk: boolean): 0 | 1 {
  return env['DELO_GATE_PRIORITY'] === 'trunk' || pushesTrunk ? 0 : 1
}

/**
 * The ticket a file name stands for.
 * @param file - the name in the queue directory.
 * @returns the ticket, or undefined for a file that is not one.
 */
function parseTicket(file: string): Ticket | undefined {
  const held = file.endsWith(HELD)
  const match = /^[01]-\d+-(\d+)$/.exec(held ? file.slice(0, -HELD.length) : file)
  return match === null ? undefined : { file, pid: Number(match[1]), held }
}

/**
 * The pid in the old lock file when that process is running and is not this one.
 * @param host - the process.
 * @param path - the old lock file.
 * @returns the pid, or undefined when the file is absent, unreadable as a pid or names a dead process.
 */
function oldHolder(host: QueueHost, path: string): number | undefined {
  const pid = Number(host.fs.read(path))
  return Number.isInteger(pid) && pid > 0 && pid !== host.pid && host.alive(pid) ? pid : undefined
}

/**
 * Wait for this run's turn and keep the turn until the process ends.
 * @param host - the process and file system.
 * @param paths - the queue directory and the old lock file.
 * @param priority - the run's priority, from `gatePriority`.
 * @returns when this run holds the machine.
 */
export async function takeTurn(host: QueueHost, paths: QueuePaths, priority: 0 | 1): Promise<void> {
  const { fs } = host
  fs.ensureDir(paths.dir)
  const name = `${String(priority)}-${String(host.now()).padStart(MILLISECONDS_WIDTH, '0')}-${String(host.pid)}`
  fs.create(`${paths.dir}/${name}`, '')
  let file = name
  host.guard(() => { fs.remove(`${paths.dir}/${file}`); fs.remove(`${paths.dir}/${file}${HELD}`) })
  let announced: number | undefined
  for (;;) {
    const tickets: Ticket[] = []
    for (const entry of fs.list(paths.dir)) {
      const ticket = parseTicket(entry)
      if (ticket === undefined) continue
      if (ticket.pid !== host.pid && !host.alive(ticket.pid)) fs.remove(`${paths.dir}/${entry}`)
      else tickets.push(ticket)
    }
    const others = tickets.filter(ticket => ticket.held && ticket.pid !== host.pid)
    const waiting = tickets.filter(ticket => !ticket.held).sort((a, b) => (a.file < b.file ? -1 : 1))
    const old = oldHolder(host, paths.oldLock)
    const blocker = others[0]?.pid ?? old
    if (blocker === undefined && waiting[0]?.pid === host.pid) {
      fs.rename(`${paths.dir}/${file}`, `${paths.dir}/${file}${HELD}`)
      file = `${file}${HELD}`
      // Another run may have promoted itself in the same instant; the one that sees the other steps back.
      const rivals = fs.list(paths.dir).map(parseTicket).filter(ticket => ticket?.held === true && ticket.pid !== host.pid)
      if (rivals.length === 0 && oldHolder(host, paths.oldLock) === undefined) return
      fs.rename(`${paths.dir}/${file}`, `${paths.dir}/${name}`)
      file = name
    } else {
      const ahead = others.length + (others.length === 0 && old !== undefined ? 1 : 0) + waiting.findIndex(ticket => ticket.pid === host.pid)
      if (ahead !== announced) {
        announced = ahead
        host.say(`run-checks: waiting for the run in process ${String(blocker ?? waiting[0]?.pid)} to finish; ${String(ahead)} run(s) ahead in the queue\n`)
      }
    }
    await host.sleep(POLL_MILLISECONDS)
  }
}

/**
 * Release the turn's signal handling on a process: the release runs when the process ends, and on SIGINT or SIGTERM it runs
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
