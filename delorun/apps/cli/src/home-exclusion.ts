/**
 * The users of a Delorun home's shared stores. Every profile of a home shares `sessions/`, `attachments/`, `storages/`,
 * `trash/`, `archive/` and the runtime store's `current`; this module is the one place that decides who may use them at
 * once. Home processes of several CLI profiles may run at once (contract C19, "The home process").
 *
 * - **Home processes.** Each home process registers under `run/data-users/<pid>` as a shared user with its profile,
 *   from before it takes its profile's home lock until it exits.
 * - **Exclusive use.** `delorun trash`, `delorun export` and `delorun import` take the home lock of every profile under
 *   `run/` for their whole operation, as a home process does, so no home process can start while they run and a
 *   profile whose home process runs refuses them. They also register under `run/data-users/<pid>` as exclusive users.
 *   `delorun recover rollback` with no home process running registers as an exclusive user while it holds its own
 *   profile's home lock, unless it is profile-only ([recover](./recover.ts)). A home process that completes an
 *   interrupted restore of a session-data copy holds an exclusive registration while it does.
 * - **Shared use.** `delorun headless` writes chat data beside the home processes, and `delorun plugin` changes a
 *   profile that an update snapshots and a rollback restores, so each registers under `run/data-users/<pid>` as a
 *   shared user.
 * - **Refusals.** An exclusive user refuses while any other live process is registered; a shared user refuses while
 *   an exclusive user is registered; both refuse while an update or a rollback of any profile is between its snapshot
 *   and its end, or a restore of a session-data copy is unfinished. A home process refuses to start while an exclusive
 *   user is registered or an update or a rollback of another profile is between its snapshot and its end. An update's
 *   prepare, session-data copy, restore and rollback refuse while any other live process is registered, another
 *   profile's home process included (contract C3, "Data formats"). Each user registers before it checks, so of two
 *   users that start together at least one refuses.
 * - **Liveness.** A registration is live while its holder is ([holder](../../../packages/home/src/holder.ts)): its
 *   process exists and, where the registration records the process's start identity, is still that process. A
 *   registration that records another Linux boot than the running one is not live, whatever pid namespace it records;
 *   one of this boot that records another pid namespace than the reader's counts as live.
 *
 * @module @delorun/cli/home-exclusion
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_USERS_DIRECTORY, DELORUN_HOME_ENTRIES, type RuntimeVersion } from '@delorun/contract-home-layout'
import { acquireHomeLock, currentHolder, ensureHomeTree, HomeLayoutError, holderAlive, holderIdentity, holderOf, newStartId, parseHolder, readHomeLock, runDirectory, type HolderProbe, type HomeLock, type ProcessHolder } from '@delorun/home'
import { journalPath, readJournal, updateChannelProbe } from '@delorun/home-process'
import { DATA_COPIES_DIRECTORY, recoverDataCopies, RESTORE_JOURNAL_FILE } from '@delorun/update'
import { CliError, EXIT } from './exit.ts'
import { runningVersion } from './update/runtime.ts'

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
  /** The CLI profile of a home process; absent for every other user. */
  readonly profile?: string
}

/** The `command` a home process registers with. */
const HOME_PROCESS_COMMAND = 'start'

/** A refusal that names what holds the data. */
export class DataInUseError extends Error {
  /** What holds the data, for the person. */
  readonly detail: string

  /**
   * @param detail - what holds the data, for the person.
   */
  constructor(detail: string) {
    super(detail)
    this.detail = detail
    this.name = 'DataInUseError'
  }
}

/**
 * The directory of registrations.
 * @param home - the resolved Delorun home.
 * @returns its path.
 */
function usersDirectory(home: string): string {
  return join(home, DELORUN_HOME_ENTRIES.run, DATA_USERS_DIRECTORY)
}

/**
 * Register a process as a user of the shared stores. The registration records the process's start identity and pid
 * namespace where the platform reports them, so it stops counting once that process exits even when its process id is
 * reused, and a reader in another pid namespace never counts it as exited.
 * @param home - the resolved Delorun home.
 * @param mode - how it uses them.
 * @param command - the `delorun` command it runs, named in other users' refusals.
 * @param pid - the process id; this process's by default.
 * @param profile - the CLI profile of a home process; omitted for every other user.
 * @returns the release, which removes the registration; a second call does nothing.
 */
export function registerDataUser(home: string, mode: DataUseMode, command: string, pid: number = process.pid, profile?: string): () => void {
  const directory = usersDirectory(home)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, String(pid))
  const identity = holderIdentity(pid === process.pid ? currentHolder() : holderOf(pid))
  writeFileSync(path, `${JSON.stringify({ mode, command, ...profile === undefined ? {} : { profile }, ...identity })}\n`, { mode: 0o600 })
  let released = false
  return () => {
    if (released) return
    released = true
    rmSync(path, { force: true })
  }
}

/**
 * Read one registration; a registration that cannot be read counts as an exclusive use by an unknown command, judged
 * by its process id alone.
 * @param path - the registration file.
 * @param pid - its process id.
 * @returns the user, and its holder with the start identity and pid namespace its registration records.
 */
function readUser(path: string, pid: number): { readonly user: DataUser, readonly holder: ProcessHolder } {
  let parsed: Readonly<Record<string, unknown>> | null = null
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Readonly<Record<string, unknown>> | null
  } catch (_unreadable) {
    // A registration removed while it was read, or not JSON, is read as an exclusive use below.
  }
  const holder = typeof parsed === 'object' && parsed !== null ? parseHolder({ pid, processStart: parsed.processStart, pidNamespace: parsed.pidNamespace }) : undefined
  if (holder === undefined || parsed === null || (parsed.mode !== 'shared' && parsed.mode !== 'exclusive') || typeof parsed.command !== 'string') return { user: { pid, mode: 'exclusive', command: 'unknown' }, holder: { pid } }
  return {
    user: { pid, mode: parsed.mode, command: parsed.command, ...typeof parsed.profile === 'string' ? { profile: parsed.profile } : {} },
    holder,
  }
}

/**
 * The live registered users other than one process. A registration is live while its holder is alive by
 * `holderAlive`: it does not record an earlier Linux boot, and its process exists and, where it records a start
 * identity, is still the process that registered, or it records another pid namespace than this process's.
 * @param home - the resolved Delorun home.
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
    const { user, holder } = readUser(join(directory, name), pid)
    if (holderAlive(holder)) live.push(user)
    else rmSync(join(directory, name), { force: true })
  }
  return live
}

/**
 * The users for a refusal.
 * @param users - the users.
 * @returns each as `the home process of the profile <profile> (process <pid>)` or `process <pid> (delorun <command>)`, joined.
 */
function named(users: readonly DataUser[]): string {
  return users.map(user => user.profile === undefined
    ? `process ${String(user.pid)} (delorun ${user.command})`
    : `the home process of the profile ${user.profile} (process ${String(user.pid)})`).join(', ')
}

/**
 * Refuse while another process uses the shared stores, another profile's home process included: an update's prepare,
 * copy, restore and rollback call this with the home lock held.
 * @param home - the resolved Delorun home.
 * @throws {DataInUseError} naming the processes, and the `delorun stop` of each home process among them.
 */
export function assertSoleDataUser(home: string): void {
  const others = otherDataUsers(home)
  if (others.length === 0) return
  const stops = others.flatMap(user => user.profile === undefined ? [] : [`delorun stop --profile ${user.profile}`])
  throw new DataInUseError(`${named(others)} uses the chat data; wait for it to end${stops.length === 0 ? '' : `, or stop it with ${stops.join(' and ')}`}, then try again`)
}

/**
 * Refuse while an update or a rollback of a CLI profile is between its snapshot and its end, or a restore of a copy
 * is unfinished: the chat data may be mid-copy or mid-restore.
 * @param home - the resolved Delorun home.
 * @param homeProcess - the profile of a home process that is starting: its own update record is left out, and so is an
 *   unfinished restore, both of which its start completes under its lock, the restore with an exclusive registration.
 * @throws {DataInUseError} naming what is in progress.
 */
export async function assertNoUpdateInProgress(home: string, homeProcess?: string): Promise<void> {
  if (homeProcess === undefined && existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))) throw new DataInUseError('a restore of the chat data is unfinished; run delorun start or delorun recover status first')
  for (const profile of profilesOf(home)) {
    if (profile === homeProcess) continue
    const record = await readJournal(journalPath(home, profile))
    if (record !== undefined && record.phase !== 'committed') throw new DataInUseError(`an update of the profile ${profile} from Delorun ${record.from} to Delorun ${record.to} is ${record.phase}; wait for it to end, or run delorun recover status`)
  }
}

/**
 * The profiles with a run directory under `run/`, in name order.
 * @param home - the resolved Delorun home.
 * @returns their names.
 */
function profilesOf(home: string): readonly string[] {
  const run = join(home, DELORUN_HOME_ENTRIES.run)
  if (!existsSync(run)) return []
  return readdirSync(run, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name !== DATA_USERS_DIRECTORY).map(entry => entry.name).sort()
}

/**
 * Register this process as a shared user of the stores for a command such as `delorun headless`, refusing while an
 * exclusive user runs or an update, a rollback or a restore is in progress.
 * @param home - the resolved Delorun home.
 * @param command - the command's name.
 * @returns the release, which removes the registration.
 * @throws {CliError} naming what holds the stores; nothing stays registered then.
 */
export async function useHomeShared(home: string, command: string): Promise<() => void> {
  return registerShared(home, command, undefined)
}

/**
 * Register this process as a profile's home process, a shared user of the stores for its whole life, before it takes
 * the profile's home lock; refuse while an exclusive user runs or an update or a rollback of another profile is between
 * its snapshot and its end. Its own registration never refuses its own update, copy, restore or rollback.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile.
 * @returns the release, which removes the registration; the caller runs it when the process exits.
 * @throws {CliError} naming what holds the stores; nothing stays registered then.
 */
export async function registerHomeProcess(home: string, profile: string): Promise<() => void> {
  return registerShared(home, HOME_PROCESS_COMMAND, profile)
}

/**
 * Register this process as a shared user and check that it may use the stores.
 * @param home - the resolved Delorun home.
 * @param command - the command's name.
 * @param homeProcess - the profile of a home process; `undefined` for any other command.
 * @returns the release, which removes the registration.
 * @throws {CliError} naming what holds the stores; nothing stays registered then.
 */
async function registerShared(home: string, command: string, homeProcess: string | undefined): Promise<() => void> {
  const release = registerDataUser(home, 'shared', command, process.pid, homeProcess)
  try {
    const exclusive = otherDataUsers(home).filter(user => user.mode === 'exclusive')
    if (exclusive.length > 0) throw new DataInUseError(`${named(exclusive)} is changing the stores this command uses; wait for it to finish, and try again`)
    await assertNoUpdateInProgress(home, homeProcess)
    return release
  } catch (error) {
    release()
    if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun ${command}: ${error.detail}`)
    throw error
  }
}

/** The registration a starting process already holds: a home process's, or the shared one of a command. */
export interface OwnRegistration {
  /** The `delorun` command it runs: `start` for a home process. */
  readonly command: string
  /** The CLI profile of a home process; absent for every other command. */
  readonly profile?: string
}

/**
 * The registration a start already holds: `delorun start`'s home process with its profile, or `delorun headless`'s
 * shared one.
 * @param kind - which start.
 * @param profile - the profile it boots.
 * @returns the registration.
 */
export function startRegistration(kind: 'cli' | 'headless', profile: string): OwnRegistration {
  return kind === 'cli' ? { command: HOME_PROCESS_COMMAND, profile } : { command: 'headless' }
}

/**
 * Run one recovery that changes the whole home's shared stores while this process is their only user: its own
 * registration turns exclusive, it refuses while any other process is registered, and every user that registers while
 * it runs refuses. Afterwards the registration is the shared one it was again, so the release the process's own
 * registration returned still removes it.
 * @param home - the resolved Delorun home.
 * @param own - the registration this process already holds.
 * @param waiting - what waits, for the refusal: `<what> waits to be ..., and <who uses the data>`.
 * @param run - the recovery.
 * @param checks - further refusals to run once registered, such as an update in progress.
 * @returns what the recovery returned.
 * @throws {CliError} while another process uses the shared stores or a check refuses; the recovery did not run.
 */
export async function asSoleUser<T>(home: string, own: OwnRegistration, waiting: string, run: () => Promise<T>, checks: () => Promise<void> = () => Promise.resolve()): Promise<T> {
  registerDataUser(home, 'exclusive', own.command, process.pid, own.profile)
  try {
    try {
      assertSoleDataUser(home)
      await checks()
    } catch (error) {
      if (error instanceof DataInUseError) throw new CliError(EXIT.failed, `delorun ${own.command}: ${waiting}, and ${error.detail}`)
      throw error
    }
    return await run()
  } finally {
    registerDataUser(home, 'shared', own.command, process.pid, own.profile)
  }
}

/**
 * Complete an interrupted restore of a session-data copy before a profile's home process boots its Host. The restore
 * replaces the whole home's chat data, so it runs {@link asSoleUser}. Without an unfinished restore it only removes the
 * leftovers of an interrupted copy.
 * @param home - the resolved Delorun home.
 * @param profile - the CLI profile whose home process is starting, already registered by {@link registerHomeProcess}.
 * @returns whether a restore was completed.
 * @throws {CliError} while another process uses the shared stores; the restore journal stays for a later start.
 *   DataSafetyError from {@link recoverDataCopies} when the journal cannot be trusted, which keeps the profile from
 *   starting.
 */
export async function finishInterruptedRestore(home: string, profile: string): Promise<boolean> {
  if (!existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))) return recoverDataCopies(home)
  return asSoleUser(home, { command: HOME_PROCESS_COMMAND, profile }, 'a restore of the chat data is unfinished and must complete before Delorun starts', () => recoverDataCopies(home))
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
  /** The Delorun home. */
  readonly home: string
  /** The CLI profile the command was given, whose run directory is created when it is missing. */
  readonly profile: string
  /** The command's name, for its refusals. */
  readonly command: string
  /** What a person can use instead while Delorun runs, appended to the refusal; empty for nothing. */
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
      ? `delorun ${target.command}: Delorun is running for the profile ${profile}${pid} and uses the stores this command changes; run delorun stop --profile ${profile} first${instead}`
      : `delorun ${target.command}: another process${pid} holds the home lock of the profile ${profile}, such as another delorun trash, export or import; wait for it to finish, or stop it, and try again`)
  }
}
