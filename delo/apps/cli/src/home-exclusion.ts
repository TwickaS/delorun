/**
 * The users of a Delo home's shared stores beside its home processes. Every profile of a home shares `sessions/`,
 * `attachments/`, `storages/`, `trash/` and `archive/`; this module is the one place that decides who may use them at
 * once.
 *
 * - **Exclusive use.** `delorun trash`, `delorun export` and `delorun import` take the home lock of every profile under
 *   `run/` for their whole operation, as a home process does, so no home process can start while they run and a
 *   profile whose home process runs refuses them. They also register under `run/data-users/<pid>` as exclusive users.
 * - **Shared use.** `delorun headless` writes chat data beside the home processes, so it registers under
 *   `run/data-users/<pid>` as a shared user.
 * - **Refusals.** An exclusive user refuses while any other live process is registered; a shared user refuses while
 *   an exclusive user is registered; both refuse while an update or a rollback of any profile is between its snapshot
 *   and its end, or a restore of a session-data copy is unfinished. An update's session-data copy, restore and
 *   rollback refuse while any other live process is registered (contract C3, "Data formats"). Each user registers
 *   before it checks, so of two users that start together at least one refuses.
 *
 * @module @delo/cli/home-exclusion
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, type RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, ensureHomeTree, HomeLayoutError, newStartId, processExists, readHomeLock, runDirectory, type HolderProbe, type HomeLock } from '@delo/home'
import { journalPath, readJournal, updateChannelProbe } from '@delo/home-process'
import { DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE } from '@delo/update'
import { CliError, EXIT } from './exit.ts'
import { runningVersion } from './update/runtime.ts'

/** The directory of registered data users, under the home's `run/`; never a profile's run directory. */
export const DATA_USERS_DIRECTORY = 'data-users'

/** How a registered process uses the shared stores. */
export type DataUseMode = 'shared' | 'exclusive'

/** One live registered user of the shared stores. */
export interface DataUser {
  /** Its process id. */
  readonly pid: number
  /** How it uses the stores; `exclusive` when its registration cannot be read. */
  readonly mode: DataUseMode
  /** The `delorun` command it runs, or `unknown`. */
  readonly command: string
}

/** A refusal that names what holds the data. */
export class DataInUseError extends Error {
  /**
   * @param detail - what holds the data, for the person.
   */
  constructor(readonly detail: string) {
    super(detail)
    this.name = 'DataInUseError'
  }
}

/**
 * The directory of registrations.
 * @param home - the resolved Delo home.
 * @returns its path.
 */
function usersDirectory(home: string): string {
  return join(home, DELO_HOME_ENTRIES.run, DATA_USERS_DIRECTORY)
}

/**
 * Register this process as a user of the shared stores.
 * @param home - the resolved Delo home.
 * @param mode - how it uses them.
 * @param command - the `delorun` command it runs, named in other users' refusals.
 * @param pid - the process id; this process's by default.
 * @returns the release, which removes the registration; a second call does nothing.
 */
export function registerDataUser(home: string, mode: DataUseMode, command: string, pid: number = process.pid): () => void {
  const directory = usersDirectory(home)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, String(pid))
  writeFileSync(path, `${JSON.stringify({ mode, command })}\n`, { mode: 0o600 })
  let released = false
  return () => {
    if (released) return
    released = true
    rmSync(path, { force: true })
  }
}

/**
 * Read one registration; a registration that cannot be read counts as an exclusive use by an unknown command.
 * @param path - the registration file.
 * @param pid - its process id.
 * @returns the user.
 */
function readUser(path: string, pid: number): DataUser {
  let parsed: { mode?: unknown, command?: unknown } | null = null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (_unreadable) {
    // A registration removed while it was read, or not JSON, is read as an exclusive use below.
  }
  if ((parsed?.mode === 'shared' || parsed?.mode === 'exclusive') && typeof parsed.command === 'string') return { pid, mode: parsed.mode, command: parsed.command }
  return { pid, mode: 'exclusive', command: 'unknown' }
}

/**
 * The live registered users other than one process.
 * @param home - the resolved Delo home.
 * @param except - the process id to leave out; this process's by default.
 * @returns the users, in directory order; registrations of dead processes are removed.
 */
export function otherDataUsers(home: string, except: number = process.pid): readonly DataUser[] {
  const directory = usersDirectory(home)
  if (!existsSync(directory)) return []
  const live: DataUser[] = []
  for (const name of readdirSync(directory)) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0 || pid === except) continue
    if (processExists(pid)) live.push(readUser(join(directory, name), pid))
    else rmSync(join(directory, name), { force: true })
  }
  return live
}

/**
 * The users for a refusal.
 * @param users - the users.
 * @returns each as `process <pid> (delorun <command>)`, joined.
 */
function named(users: readonly DataUser[]): string {
  return users.map(user => `process ${String(user.pid)} (delorun ${user.command})`).join(', ')
}

/**
 * Refuse while another process uses the shared stores: an update's copy, restore and rollback call this with the home
 * lock held.
 * @param home - the resolved Delo home.
 * @throws {DataInUseError} naming the processes.
 */
export function assertSoleDataUser(home: string): void {
  const others = otherDataUsers(home)
  if (others.length > 0) throw new DataInUseError(`${named(others)} uses the chat data; wait for it to end, then try again`)
}

/**
 * Refuse while an update or a rollback of any CLI profile is between its snapshot and its end, or a restore of a
 * copy is unfinished: the chat data may be mid-copy or mid-restore.
 * @param home - the resolved Delo home.
 * @throws {DataInUseError} naming what is in progress.
 */
export async function assertNoUpdateInProgress(home: string): Promise<void> {
  if (existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))) throw new DataInUseError('a restore of the chat data is unfinished; run delorun start or delorun recover status first')
  for (const profile of profilesOf(home)) {
    const record = await readJournal(journalPath(home, profile))
    if (record !== undefined && record.phase !== 'committed') throw new DataInUseError(`an update of the profile ${profile} from Delo ${record.from} to Delo ${record.to} is ${record.phase}; wait for it to end, or run delorun recover status`)
  }
}

/**
 * The profiles with a run directory under `run/`, in name order.
 * @param home - the resolved Delo home.
 * @returns their names.
 */
function profilesOf(home: string): readonly string[] {
  const run = join(home, DELO_HOME_ENTRIES.run)
  if (!existsSync(run)) return []
  return readdirSync(run, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== DATA_USERS_DIRECTORY).map(entry => entry.name).sort()
}

/**
 * Register this process as a shared user of the stores for a command such as `delorun headless`, refusing while an
 * exclusive user runs or an update, a rollback or a restore is in progress.
 * @param home - the resolved Delo home.
 * @param command - the command's name.
 * @returns the release, which removes the registration.
 * @throws {CliError} naming what holds the stores; nothing stays registered then.
 */
export async function useHomeShared(home: string, command: string): Promise<() => void> {
  const release = registerDataUser(home, 'shared', command)
  try {
    const exclusive = otherDataUsers(home).filter(user => user.mode === 'exclusive')
    if (exclusive.length > 0) throw new DataInUseError(`${named(exclusive)} is changing the stores this command uses; wait for it to finish, and try again`)
    await assertNoUpdateInProgress(home)
    return release
  } catch (error) {
    release()
    if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun ${command}: ${error.detail}`)
    throw error
  }
}

/** What taking a home's locks needs. */
export interface HomeExclusion {
  /** The probe that asks one profile's lock holder for its status. */
  readonly probe: (home: string, profile: string) => HolderProbe
  /** The runtime version the locks record. */
  readonly runtime: RuntimeVersion
}

/**
 * The probe and runtime version of a real command: the update channel's probe and the CLI's version.
 * @returns the exclusion.
 */
export function homeExclusion(): HomeExclusion {
  return { probe: updateChannelProbe, runtime: runningVersion() }
}

/** One home a command runs against exclusively. */
export interface ExclusiveHome {
  /** The Delo home. */
  readonly home: string
  /** The CLI profile the command was given, whose run directory is created when it is missing. */
  readonly profile: string
  /** The command's name, for its refusals. */
  readonly command: string
  /** What a person can use instead while Delo runs, appended to the refusal; empty for nothing. */
  readonly instead: string
}

/**
 * Run one operation while this process holds the home lock of every profile of a home, in profile order, and is the
 * only registered user of the shared stores; release them all afterwards, whether the operation succeeded or not.
 * @param target - the home, the profile, the command's name and what to use instead.
 * @param run - the operation.
 * @param exclusion - the holder probe and the runtime version.
 * @returns what the operation returned.
 * @throws {CliError} when a profile's home process runs, another process holds a profile's lock, another process is
 *   registered as a user of the stores, or an update, a rollback or a restore is in progress; nothing ran then.
 */
export async function withHomeExclusive<T>(target: ExclusiveHome, run: () => Promise<T>, exclusion: HomeExclusion = homeExclusion()): Promise<T> {
  await ensureHomeTree(target.home, target.profile)
  const held: HomeLock[] = []
  let release = (): void => {}
  try {
    for (const profile of profilesOf(target.home)) held.push(await takeLock(target, profile, exclusion))
    release = registerDataUser(target.home, 'exclusive', target.command)
    try {
      assertSoleDataUser(target.home)
      await assertNoUpdateInProgress(target.home)
    } catch (error) {
      if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun ${target.command}: ${error.detail}`)
      throw error
    }
    return await run()
  } finally {
    release()
    for (const lock of held.reverse()) lock.release()
  }
}

/**
 * Take one profile's home lock for a command.
 * @param target - the home, the command's name and what to use instead.
 * @param profile - the profile.
 * @param exclusion - the holder probe and the runtime version.
 * @returns the held lock.
 * @throws {CliError} naming the holder when the lock is held by a live process.
 */
async function takeLock(target: ExclusiveHome, profile: string, exclusion: HomeExclusion): Promise<HomeLock> {
  const directory = runDirectory(target.home, profile)
  try {
    return await acquireHomeLock({ runDirectory: directory, runtime: exclusion.runtime, probe: exclusion.probe(target.home, profile), startId: newStartId() })
  } catch (error: unknown) {
    if (!(error instanceof HomeLayoutError) || (error.code !== 'HOME_RUNNING' && error.code !== 'HOME_UNRESPONSIVE')) throw error
    const holder = readHomeLock(directory)
    const pid = holder === undefined ? '' : ` (process ${String(holder.pid)})`
    const instead = target.instead === '' ? '' : `, or ${target.instead}`
    throw new CliError(EXIT.failed, error.code === 'HOME_RUNNING'
      ? `delorun ${target.command}: Delo is running for the profile ${profile}${pid} and uses the stores this command changes; run delorun stop --profile ${profile} first${instead}`
      : `delorun ${target.command}: another process${pid} holds the home lock of the profile ${profile}, such as another delorun trash, export or import; wait for it to finish, or stop it, and try again`)
  }
}
