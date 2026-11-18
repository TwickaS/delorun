/**
 * The identity of a process that holds a Delorun lock or registration: its process id and, where the operating system
 * reports one, its start identity, so a record left by a process that died is not read as alive once the process id
 * is reused, after a reboot or otherwise.
 *
 * - **Linux.** `linux:<boot id>:<start time>`: the boot id from `/proc/sys/kernel/random/boot_id` and field 22 of
 *   `/proc/<pid>/stat`, the process's start time in clock ticks since boot.
 * - **macOS.** `darwin:<milliseconds since the epoch>`: the start time `ps -o lstart=` reports, read with `LC_ALL=C`
 *   and `TZ=UTC`, to the second.
 * - **Elsewhere, Windows included.** No start identity: a record carries the process id alone, and a process that
 *   reuses that id reads as the holder, alive, until it exits.
 *
 * A record whose start identity differs from the live process's names a process that has exited. A record without
 * one, written by an older Delorun or on a platform without a reader, is judged by its process id alone, as is a record
 * whose process's start identity cannot be read now.
 *
 * A Linux record whose boot id differs from the running system's names a process of an earlier boot, which has exited
 * whatever its process id or pid namespace now names: a restart gives every container and sandbox a new pid namespace
 * too, so the namespace rule below must not keep that record alive. The boot id is the kernel's, so every pid
 * namespace of one boot reads the same value and a holder of this boot is never judged by it.
 *
 * On Linux a record also names the pid namespace its process id is numbered in, `pid:[<inode>]` as `/proc/self/ns/pid`
 * links to it: the writer's own, which numbers both its own process id and a successor's it hands a lock to. A process
 * id from another pid namespace, such as a container's or a sandbox's that shares the home, names nothing in the
 * judging process's, so a record whose namespace differs from the judge's, or that a judge whose own namespace cannot be
 * read meets, is never judged dead: its holder reads as alive. A record without a namespace, written by an older Delorun,
 * on another platform, or on a Linux system whose `/proc/self/ns/pid` cannot be read, is judged as before, and a holder
 * in another pid namespace that wrote such a record can read as dead while it runs.
 *
 * @module @delorun/home/holder
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, readlinkSync } from 'node:fs'

/** A process recorded as holding a lock or registration. */
export interface ProcessHolder {
  /** Its process id. */
  readonly pid: number
  /** Its start identity, absent where the platform has no reader or the record predates it. */
  readonly processStart?: string
  /** The pid namespace `pid` is numbered in, `pid:[<inode>]`; absent off Linux, where it cannot be read, or the record predates it. */
  readonly pidNamespace?: string
}

/** The fields of a holder record besides its process id. */
export type HolderIdentity = Omit<ProcessHolder, 'pid'>

/** The longest start identity a record may carry; the longest one written has 51 characters. */
const MAX_START_LENGTH = 64

const START_IDENTITY = /^(?:linux:[0-9a-f-]{36}:\d+|darwin:\d+)$/u

/** A pid namespace as `/proc/self/ns/pid` links to it; an inode number has at most 20 digits. */
const PID_NAMESPACE = /^pid:\[\d{1,20}\]$/u

/** The longest pid namespace a record may carry. */
const MAX_NAMESPACE_LENGTH = 'pid:[]'.length + 20

/** The boot id of a Linux start identity. */
const LINUX_BOOT = /^linux:([0-9a-f-]{36}):/u

const BOOT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** `ps -o lstart=` under `LC_ALL=C`: weekday, month, day of the month, time and year. */
const LSTART = /^[A-Z][a-z]{2} ([A-Z][a-z]{2}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Field 22 of `/proc/<pid>/stat`, counted from the first field after the command name's closing parenthesis (field 3). */
const STARTTIME_INDEX = 22 - 3

/**
 * Whether a process exists. A process of another user still exists (`EPERM`).
 * @param pid - the process id.
 * @returns false only when the operating system reports `ESRCH`.
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * The Linux start identity from the contents of `/proc/<pid>/stat` and the boot id.
 * @param stat - the stat line; the command name may hold spaces and parentheses.
 * @param bootId - the boot id, with or without its trailing newline.
 * @returns `linux:<boot id>:<start time>`, or `undefined` when either input is malformed.
 */
export function linuxProcessStart(stat: string, bootId: string): string | undefined {
  const boot = bootId.trim()
  const close = stat.lastIndexOf(')')
  const starttime = close < 0 ? undefined : stat.slice(close + 2).split(' ')[STARTTIME_INDEX]
  if (!BOOT_ID.test(boot) || starttime === undefined || !/^\d+$/u.test(starttime)) return undefined
  return `linux:${boot}:${starttime}`
}

/**
 * The macOS start identity from the output of `ps -o lstart=` under `LC_ALL=C` and `TZ=UTC`.
 * @param lstart - the output, with or without surrounding white space.
 * @returns `darwin:<milliseconds since the epoch>`, or `undefined` when the output is not one start time.
 */
export function darwinProcessStart(lstart: string): string | undefined {
  const match = LSTART.exec(lstart.trim())
  const month = match === null ? -1 : MONTHS.indexOf(match[1]!)
  if (match === null || month < 0) return undefined
  const [, , day, hours, minutes, seconds, year] = match
  return `darwin:${String(Date.UTC(Number(year), month, Number(day), Number(hours), Number(minutes), Number(seconds)))}`
}

/**
 * Read a file's text.
 * @param path - the file.
 * @returns its text, or `undefined` when it cannot be read.
 */
function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (_unreadable) {
    // A process that has exited has no `/proc/<pid>/`; a kernel without the file has no reader. Both read as unknown.
    return undefined
  }
}

/**
 * The output of `ps -o lstart=` for one process.
 * @param pid - the process id.
 * @returns the output, or `undefined` when `ps` fails, as it does for a process that does not exist.
 */
function psStart(pid: number): string | undefined {
  try {
    return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 })
  } catch (_failed) {
    // `ps` exits with status 1 for a process that does not exist; any failure reads as unknown.
    return undefined
  }
}

/**
 * The start identity of a live process, read now.
 * @param pid - the process id.
 * @param platform - the operating system whose reader to use; this one's by default.
 * @returns the identity, or `undefined` when the platform has no reader or the process's cannot be read.
 */
export function readProcessStart(pid: number, platform: NodeJS.Platform = process.platform): string | undefined {
  switch (platform) {
    case 'linux': {
      const stat = readText(`/proc/${String(pid)}/stat`)
      const bootId = readText('/proc/sys/kernel/random/boot_id')
      return stat === undefined || bootId === undefined ? undefined : linuxProcessStart(stat, bootId)
    }
    case 'darwin': {
      const lstart = psStart(pid)
      return lstart === undefined ? undefined : darwinProcessStart(lstart)
    }
    default:
      // Windows and every other platform: no reader, so holders there are judged by their process id alone.
      return undefined
  }
}

/**
 * The pid namespace of this process, read now.
 * @param platform - the operating system whose reader to use; this one's by default.
 * @returns `pid:[<inode>]` on Linux, or `undefined` elsewhere or when `/proc/self/ns/pid` cannot be read or is not of
 *   that form.
 */
export function readPidNamespace(platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform !== 'linux') return undefined
  let link: string
  try {
    link = readlinkSync('/proc/self/ns/pid')
  } catch (_unreadable) {
    // No `/proc` mounted, or a kernel without pid namespaces: records written here carry no namespace.
    return undefined
  }
  return PID_NAMESPACE.test(link) ? link : undefined
}

/**
 * The running system's boot id, read once.
 * @returns the boot id, or `undefined` off Linux or where `/proc/sys/kernel/random/boot_id` cannot be read.
 */
function ownBootId(): string | undefined {
  if (process.platform !== 'linux') return undefined
  ownBoot ??= { value: readText('/proc/sys/kernel/random/boot_id')?.trim() }
  return ownBoot.value
}

let ownBoot: { readonly value: string | undefined } | undefined

let ownNamespace: { readonly value: string | undefined } | undefined

/**
 * This process's pid namespace, read once.
 * @returns the namespace, or `undefined` where it cannot be read.
 */
function ownPidNamespace(): string | undefined {
  ownNamespace ??= { value: readPidNamespace() }
  return ownNamespace.value
}

let current: ProcessHolder | undefined

/**
 * This process as a holder, its start identity read once.
 * @returns the holder.
 */
export function currentHolder(): ProcessHolder {
  current ??= holderOf(process.pid)
  return current
}

/**
 * Another process as a holder, its start identity read now: a successor this process hands a lock to. Its process id
 * is this process's view of it, so the record names this process's pid namespace.
 * @param pid - the live process's id.
 * @returns the holder, without a start identity or a pid namespace when either cannot be read.
 */
export function holderOf(pid: number): ProcessHolder {
  const processStart = readProcessStart(pid)
  const pidNamespace = ownPidNamespace()
  return { pid, ...holderIdentity({ processStart, pidNamespace }) }
}

/**
 * The fields a holder record carries besides its process id, each only when present: what a writer spreads after the
 * record's own fields.
 * @param holder - the holder.
 * @returns `processStart` and `pidNamespace` where the holder has them.
 */
export function holderIdentity(holder: { readonly processStart?: string | undefined, readonly pidNamespace?: string | undefined }): HolderIdentity {
  const { processStart, pidNamespace } = holder
  return { ...processStart === undefined ? {} : { processStart }, ...pidNamespace === undefined ? {} : { pidNamespace } }
}

/** The processes a holder record is checked against: this operating system's, or a spec's stand-in. */
export interface ProcessTable {
  /** The operating system, which decides whether start identities can be read at all. */
  readonly platform: NodeJS.Platform
  /**
   * Whether a process exists.
   * @param pid - the process id.
   * @returns false only when no process has the id.
   */
  exists(pid: number): boolean
  /**
   * A live process's start identity.
   * @param pid - the process id.
   * @returns the identity, or `undefined` when it cannot be read.
   */
  start(pid: number): string | undefined
  /**
   * The checking process's own pid namespace.
   * @returns `pid:[<inode>]`, or `undefined` where it cannot be read.
   */
  pidNamespace(): string | undefined
  /**
   * The boot id of the running system, which every pid namespace on one kernel shares. Absent in a table that has no
   * boot id to compare, which then never judges a record by its boot.
   * @returns the boot id, or `undefined` where it cannot be read or the platform has none.
   */
  bootId?(): string | undefined
}

/** This operating system's processes, read through {@link processExists}, {@link readProcessStart} and this process's pid namespace. */
export const SYSTEM_PROCESS_TABLE: ProcessTable = {
  platform: process.platform,
  exists: processExists,
  start: pid => readProcessStart(pid),
  pidNamespace: ownPidNamespace,
  bootId: ownBootId,
}

/** The platforms {@link readProcessStart} reads a start identity on. */
const START_IDENTITY_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['linux', 'darwin'])

/** Why a holder whose process may run cannot be confirmed as the process that wrote its record. */
export type UnconfirmedHolder =
  /** The platform has no start identity reader, as on Windows, so a process that reuses the id cannot be told apart. */
  | 'no-start-reader'
  /** The record carries no start identity, written by an older Delorun or where it could not be read. */
  | 'no-start-identity'
  /** The record names a pid namespace other than the checking process's, or the checking process's cannot be read. */
  | 'other-namespace'
  /** The live process's start identity cannot be read now. */
  | 'start-unreadable'

/**
 * What a holder record names now (a closed union).
 *
 * - `confirmed`: a live process has the record's process id and start identity, in the record's pid namespace.
 * - `exited`: no process has the id in the record's pid namespace.
 * - `replaced`: a process has the id but another start identity, so the recorded process has exited.
 * - `unconfirmed`: a process may run under the id, and whether it is the recorded one cannot be told, for `reason`.
 */
export type HolderCheck =
  | { readonly kind: 'confirmed' }
  | { readonly kind: 'exited' }
  | { readonly kind: 'replaced' }
  | { readonly kind: 'unconfirmed', readonly reason: UnconfirmedHolder }

/**
 * Whether a record names a Linux boot other than the running one. No process outlives its boot, so such a holder has
 * exited, whatever its process id or pid namespace now names.
 * @param holder - the recorded holder.
 * @param table - the processes to check against.
 * @returns true when the record's boot id and the table's both exist and differ.
 */
function fromEarlierBoot(holder: ProcessHolder, table: ProcessTable): boolean {
  const recorded = holder.processStart === undefined ? undefined : LINUX_BOOT.exec(holder.processStart)?.[1]
  const running = table.bootId?.()
  return recorded !== undefined && running !== undefined && recorded !== running
}

/**
 * Check a recorded holder against the live processes. Only `confirmed` permits acting on the process, such as
 * signalling it: every other outcome may name a process other than the one that wrote the record.
 * @param holder - the recorded holder.
 * @param table - the processes to check against; this operating system's by default.
 * @returns what the record names now.
 */
export function checkHolder(holder: ProcessHolder, table: ProcessTable = SYSTEM_PROCESS_TABLE): HolderCheck {
  if (fromEarlierBoot(holder, table)) return { kind: 'exited' }
  if (holder.pidNamespace !== undefined && holder.pidNamespace !== table.pidNamespace()) return { kind: 'unconfirmed', reason: 'other-namespace' }
  if (!table.exists(holder.pid)) return { kind: 'exited' }
  if (!START_IDENTITY_PLATFORMS.has(table.platform)) return { kind: 'unconfirmed', reason: 'no-start-reader' }
  if (holder.processStart === undefined) return { kind: 'unconfirmed', reason: 'no-start-identity' }
  const live = table.start(holder.pid)
  if (live === undefined) return { kind: 'unconfirmed', reason: 'start-unreadable' }
  return live === holder.processStart ? { kind: 'confirmed' } : { kind: 'replaced' }
}

/**
 * Whether a recorded holder still runs: its process exists and, when the record carries a start identity that can be
 * read for the live process now, the two are equal. A record that names a pid namespace other than this process's, or
 * that names one while this process's cannot be read, is not judged: its process id names nothing here, so it reads as
 * alive.
 * @param holder - the recorded holder.
 * @param table - the processes to check against; this operating system's by default.
 * @returns false when the process does not exist or is another process with the same id, in the record's pid namespace.
 */
export function holderAlive(holder: ProcessHolder, table: ProcessTable = SYSTEM_PROCESS_TABLE): boolean {
  const { kind } = checkHolder(holder, table)
  return kind !== 'exited' && kind !== 'replaced'
}

/**
 * Read the holder fields of a parsed JSON record.
 * @param record - the record's fields.
 * @returns the holder, or `undefined` when `pid` is not a positive integer, `processStart` is present but not a start
 *   identity, or `pidNamespace` is present but not `pid:[<inode>]`.
 */
export function parseHolder(record: Readonly<Record<string, unknown>>): ProcessHolder | undefined {
  const { pid, processStart, pidNamespace } = record
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  const start = optionalMatch(processStart, START_IDENTITY, MAX_START_LENGTH)
  const namespace = optionalMatch(pidNamespace, PID_NAMESPACE, MAX_NAMESPACE_LENGTH)
  if (start === false || namespace === false) return undefined
  return { pid, ...holderIdentity({ processStart: start, pidNamespace: namespace }) }
}

/**
 * Validate an optional string field of a holder record.
 * @param value - the field's value.
 * @param pattern - the form it must have.
 * @param maxLength - its longest allowed length.
 * @returns the value, `undefined` when absent, or false when present but not a string of that form.
 */
function optionalMatch(value: unknown, pattern: RegExp, maxLength: number): string | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'string' && value.length <= maxLength && pattern.test(value) ? value : false
}
