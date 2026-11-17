/**
 * The backstop for a Host that died with external agent programs still running (T11, review D15). While a program
 * runs, the gate keeps a record of its process identity in the home's protected files; at the next start it stops
 * each recorded program whose identity still matches in full, and drops the record. A process id alone never
 * identifies a program: on Linux the record holds the kernel start time (`/proc/<pid>/stat` field 22), the boot id
 * and the executable path, and the systemd unit when the subprocess owner placed the program in a user scope, which
 * is then stopped instead of the process group; on macOS the kernel start time and the executable path. Windows
 * records nothing and reaps nothing, because the subprocess owner's kill-on-close Job ends the programs with the Host.
 * @module @delorun/external-agents/reap
 */
import { mkdir, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DELORUN_HOME_ENTRIES } from '@delorun/contract-home-layout'
import { readProtectedFile, writeProtectedFile } from '@delorun/home'
import { z } from 'zod'
import { EXTERNAL_AGENTS } from './locate.ts'
import type { ExternalAgentName } from './contract.ts'

/** How often the identity of a process starting in a systemd scope is read again, in milliseconds. */
const SCOPE_SETTLE_POLL_MS = 20

/** The record file's format version. */
export const PROGRAM_RECORD_VERSION = 1 as const

/** The largest record file read; a larger one is refused. */
const RECORD_MAX_BYTES = 64 * 1024

/** What identifies one running process beyond its id. */
export interface ProcessIdentity {
  /** The process id. */
  readonly pid: number
  /** The kernel's start time of the process, as the platform reports it. */
  readonly startTime: string
  /** The boot id on Linux; absent on macOS. */
  readonly bootId?: string | undefined
  /** The process's executable path. */
  readonly exe: string
  /** The systemd unit the process runs in, when it is a scope of the subprocess owner. */
  readonly unit?: string | undefined
}

/** One recorded program. */
export interface ProgramRecord {
  /** The agent. */
  readonly provider: ExternalAgentName
  /** The program's identity when it started. */
  readonly identity: ProcessIdentity
}

/** The operating-system calls the reaper makes, injected so specs run on a fake process table. */
export interface ProcessTable {
  /** The platform, which picks what is recorded. */
  readonly platform: NodeJS.Platform
  /**
   * Read a live process's identity.
   * @param pid - the process id.
   * @returns the identity, or undefined when no process has that id or it cannot be read.
   */
  identify(pid: number): Promise<ProcessIdentity | undefined>
  /**
   * Send a signal to a process group.
   * @param pgid - the group id, which is the recorded program's id because the subprocess owner starts it as a group leader.
   * @param signal - the signal.
   */
  killGroup(pgid: number, signal: NodeJS.Signals): void
  /**
   * Stop a systemd user unit.
   * @param unit - the unit name.
   */
  stopUnit(unit: string): Promise<void>
}

const IdentitySchema = z.object({
  pid: z.number().int().positive(),
  startTime: z.string().min(1),
  bootId: z.string().min(1).optional(),
  exe: z.string().min(1),
  unit: z.string().regex(/^[\w@.-]+\.scope$/u).optional(),
}).strict()

const RecordFileSchema = z.object({
  v: z.literal(PROGRAM_RECORD_VERSION),
  programs: z.array(z.object({ provider: z.enum(EXTERNAL_AGENTS), identity: IdentitySchema }).strict()),
}).strict()

/**
 * The path of the record file.
 * @param home - the Delorun home.
 * @returns `<home>/secrets/external-agents/programs.json`.
 */
export function programRecordPath(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.secrets, 'external-agents', 'programs.json')
}

/**
 * Whether two identities name the same process: every recorded value is equal.
 * @param recorded - the identity when the program started.
 * @param current - the identity read now.
 * @returns true only on a full match.
 */
export function sameProcess(recorded: ProcessIdentity, current: ProcessIdentity): boolean {
  return recorded.pid === current.pid
    && recorded.startTime === current.startTime
    && recorded.bootId === current.bootId
    && recorded.exe === current.exe
    && recorded.unit === current.unit
}

/** What a reap did with one record. */
export type ReapOutcome = 'stopped-unit' | 'stopped-group' | 'gone' | 'not-the-program' | 'not-located'

/** Options of {@link ProgramRecords}. */
export interface ProgramRecordsOptions {
  /** The record file's path. */
  readonly path: string
  /** The process table. */
  readonly table: ProcessTable
  /** How long a stopped group has after SIGTERM before SIGKILL, in milliseconds. */
  readonly graceMs: number
  /** How long a process started in a systemd scope has to enter it before it goes unrecorded, in milliseconds. */
  readonly settleMs: number
  /** The real paths of the executables a live agent's leader runs; a record naming another executable is never stopped. */
  readonly located: () => ReadonlySet<string>
  /** Report a problem the reaper contained. */
  readonly warn: (message: string) => void
}

/** The record file and the reaping at start. Writes are serialised, so concurrent starts and ends never lose a record. */
export class ProgramRecords {
  private readonly options: ProgramRecordsOptions
  private queue: Promise<void> = Promise.resolve()

  /** @param options - the file, the process table, the grace period and the warning sink. */
  constructor(options: ProgramRecordsOptions) {
    this.options = options
  }

  /**
   * Record a started program. On Windows nothing is recorded; a program whose identity cannot be read, or that has not
   * entered its scope within `settleMs`, is not recorded and a warning names it, because a guessed identity
   * could later stop another process.
   * @param provider - the agent.
   * @param pid - the process id of the managed range's leader.
   * @param unit - the systemd scope the subprocess owner started it in, from the handle.
   * @returns the identity recorded, or undefined when none was.
   */
  async started(provider: ExternalAgentName, pid: number, unit?: string): Promise<ProcessIdentity | undefined> {
    if (this.options.table.platform === 'win32') return undefined
    const identity = unit === undefined ? await this.options.table.identify(pid) : await this.inScope(pid, unit)
    if (identity === undefined) {
      this.options.warn(`external agents: the identity of ${provider}'s process ${String(pid)} could not be read, so it is not recorded for reaping`)
      return undefined
    }
    await this.change(programs => [...programs.filter(record => record.identity.pid !== pid), { provider, identity }])
    return identity
  }

  /**
   * The identity of a process the subprocess owner starts in a systemd scope. The handle's process id first runs
   * `systemd-run`, which places itself in the scope and then runs the subprocess runner and the program in the same
   * process; the identity is read again until the process sits in the handle's unit and no longer runs `systemd-run`.
   * @param pid - the process id the handle names.
   * @param unit - the scope unit the handle names.
   * @returns the identity, or undefined when the process ended or did not settle within `settleMs`.
   */
  private async inScope(pid: number, unit: string): Promise<ProcessIdentity | undefined> {
    const deadline = Date.now() + this.options.settleMs
    for (;;) {
      const identity = await this.options.table.identify(pid)
      if (identity === undefined) return undefined
      if (identity.unit === unit && basename(identity.exe) !== 'systemd-run') return identity
      if (Date.now() >= deadline) return undefined
      await new Promise(resolve => setTimeout(resolve, SCOPE_SETTLE_POLL_MS))
    }
  }

  /**
   * Forget a program that ended.
   * @param identity - the identity {@link started} recorded.
   */
  async ended(identity: ProcessIdentity): Promise<void> {
    await this.change(programs => programs.filter(record => !sameProcess(record.identity, identity)))
  }

  /**
   * Stop every recorded program whose identity still matches in full and whose executable is a located one, and clear
   * the records. A record whose process is gone, whose id now names another process or whose executable is not a
   * located agent program is dropped without a signal. An unreadable record file stops
   * nothing and is left in place, with a warning.
   * @returns each record with what was done.
   */
  async reap(): Promise<readonly { readonly record: ProgramRecord, readonly outcome: ReapOutcome }[]> {
    const done: { record: ProgramRecord, outcome: ReapOutcome }[] = []
    if (this.options.table.platform === 'win32') return done
    await this.change(async (programs) => {
      for (const record of programs) done.push({ record, outcome: await this.reapOne(record) })
      return []
    })
    return done
  }

  /**
   * Stop one recorded program if it is still that program.
   * @param record - the record.
   * @returns what was done.
   */
  private async reapOne(record: ProgramRecord): Promise<ReapOutcome> {
    const { table } = this.options
    const current = await table.identify(record.identity.pid)
    if (current === undefined) return 'gone'
    if (!sameProcess(record.identity, current)) return 'not-the-program'
    if (!this.options.located().has(record.identity.exe)) return 'not-located'
    if (record.identity.unit !== undefined) {
      await table.stopUnit(record.identity.unit)
      return 'stopped-unit'
    }
    table.killGroup(record.identity.pid, 'SIGTERM')
    await new Promise(resolve => setTimeout(resolve, this.options.graceMs))
    const after = await table.identify(record.identity.pid)
    if (after !== undefined && sameProcess(record.identity, after)) table.killGroup(record.identity.pid, 'SIGKILL')
    return 'stopped-group'
  }

  /**
   * Change the records under the queue.
   * @param edit - the change, given the current records.
   */
  private async change(edit: (programs: readonly ProgramRecord[]) => readonly ProgramRecord[] | Promise<readonly ProgramRecord[]>): Promise<void> {
    const run = this.queue.then(async () => {
      const programs = await this.read()
      if (programs === undefined) return
      const next = await edit(programs)
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 })
      await writeProtectedFile(this.options.path, `${JSON.stringify({ v: PROGRAM_RECORD_VERSION, programs: next }, null, 2)}\n`)
    })
    this.queue = run.catch((error: unknown) => {
      this.options.warn(`external agents: the program records at ${this.options.path} could not be updated: ${String(error)}`)
    })
    await this.queue
  }

  /**
   * Read the records.
   * @returns the records, an empty list when the file does not exist, or undefined when it is unreadable.
   */
  private async read(): Promise<readonly ProgramRecord[] | undefined> {
    let text: string
    try {
      text = (await readProtectedFile(this.options.path, RECORD_MAX_BYTES)).toString('utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      this.options.warn(`external agents: the program records at ${this.options.path} cannot be read, so no program is reaped: ${String(error)}`)
      return undefined
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      this.options.warn(`external agents: the program records at ${this.options.path} are not JSON, so no program is reaped: ${String(error)}`)
      return undefined
    }
    const parsed = RecordFileSchema.safeParse(json)
    if (!parsed.success) {
      this.options.warn(`external agents: the program records at ${this.options.path} do not match version ${String(PROGRAM_RECORD_VERSION)}, so no program is reaped: ${parsed.error.message}`)
      return undefined
    }
    return parsed.data.programs
  }
}

/**
 * Parse the start time out of a Linux `/proc/<pid>/stat` line: field 22, counted after the command name, which may
 * hold spaces and parentheses.
 * @param stat - the file's text.
 * @returns the start time in clock ticks since boot, or undefined for a malformed line.
 */
export function linuxStartTime(stat: string): string | undefined {
  const close = stat.lastIndexOf(')')
  if (close < 0) return undefined
  // Fields after the command name start at field 3 (the state), so field 22 is index 19.
  const field = stat.slice(close + 1).trim().split(/\s+/u)[19]
  return field !== undefined && /^\d+$/u.test(field) ? field : undefined
}

/**
 * The subprocess owner's systemd scope a Linux process runs in, from its `/proc/<pid>/cgroup`.
 * @param cgroup - the file's text.
 * @returns the scope unit when the unified hierarchy places it in a `dsh-subprocess-…` or `dsh-terminal-…` scope.
 */
export function linuxScopeUnit(cgroup: string): string | undefined {
  for (const line of cgroup.split('\n')) {
    if (!line.startsWith('0::')) continue
    const unit = line.slice(3).split('/').findLast(part => part.length > 0)
    if (unit !== undefined && /^dsh-(?:subprocess|terminal)-[\w@.-]*\.scope$/u.test(unit)) return unit
  }
  return undefined
}

/** Runs a command and returns its standard output; it rejects when the command fails. */
export type RunCommand = (argv: readonly string[]) => Promise<string>

/**
 * Read a Linux process's identity from `/proc`.
 * @param pid - the process id.
 * @returns the identity, or undefined when the process is gone or a value cannot be read.
 */
async function linuxIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  try {
    const [stat, bootId, exe, cgroup] = await Promise.all([
      readFile(`/proc/${String(pid)}/stat`, 'utf8'),
      readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
      readlink(`/proc/${String(pid)}/exe`),
      readFile(`/proc/${String(pid)}/cgroup`, 'utf8'),
    ])
    const startTime = linuxStartTime(stat)
    if (startTime === undefined) return undefined
    return { pid, startTime, bootId: bootId.trim(), exe, unit: linuxScopeUnit(cgroup) }
  } catch {
    // ENOENT for a process that is gone, EACCES for one of another user: neither is a program this home recorded.
    return undefined
  }
}

/**
 * Read a macOS process's identity with `ps`: the kernel start time and the executable path.
 * @param run - the command runner.
 * @param pid - the process id.
 * @returns the identity, or undefined when `ps` finds no such process.
 */
async function macIdentity(run: RunCommand, pid: number): Promise<ProcessIdentity | undefined> {
  let startTime: string
  let exe: string
  try {
    startTime = (await run(['/bin/ps', '-o', 'lstart=', '-p', String(pid)])).trim()
    exe = (await run(['/bin/ps', '-o', 'comm=', '-p', String(pid)])).trim()
  } catch {
    // ps exits 1 when no process has the id.
    return undefined
  }
  return startTime.length > 0 && exe.startsWith('/') ? { pid, startTime, exe } : undefined
}

/**
 * The process table of the computer the Host runs on.
 * @param platform - the platform.
 * @param run - runs `ps` on macOS and `systemctl --user stop` on Linux.
 * @returns the table.
 */
export function systemProcessTable(platform: NodeJS.Platform, run: RunCommand): ProcessTable {
  return {
    platform,
    identify: pid => (platform === 'linux' ? linuxIdentity(pid) : platform === 'darwin' ? macIdentity(run, pid) : Promise.resolve(undefined)),
    killGroup: (pgid, signal) => {
      try {
        process.kill(-pgid, signal)
      } catch (error) {
        // ESRCH: the group left between the identity check and the signal.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    },
    stopUnit: async (unit) => {
      await run(['systemctl', '--user', 'stop', unit])
    },
  }
}
