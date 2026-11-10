/**
 * The processes that use the home's chat data beside a home process, and the rule that keeps them apart from an
 * update's session-data copy and restore (contract C3, "Data formats"). `delorun headless` registers itself under
 * `run/data-users/<pid>` before it reads the update records; the copy, the restore and a rollback refuse while another
 * live process is registered. Whichever writes first wins: a headless run registered before the update's check makes
 * the update refuse, and an update recorded before the headless run's check makes the headless run refuse.
 *
 * @module @delo/cli/update/data-users
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { processExists } from '@delo/home'
import { journalPath, readJournal } from '@delo/home-process'
import { DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE } from '@delo/update'

/** The directory of registered data users, under the home's `run/`. */
export const DATA_USERS_DIRECTORY = 'data-users'

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
 * Register this process as a user of the home's chat data.
 * @param home - the resolved Delo home.
 * @param pid - the process id; this process's by default.
 * @returns the release, which removes the registration; a second call does nothing.
 */
export function registerDataUser(home: string, pid: number = process.pid): () => void {
  const directory = join(home, DELO_HOME_ENTRIES.run, DATA_USERS_DIRECTORY)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, String(pid))
  writeFileSync(path, `${String(pid)}\n`, { mode: 0o600 })
  let released = false
  return () => {
    if (released) return
    released = true
    rmSync(path, { force: true })
  }
}

/**
 * The live processes registered as data users, other than one.
 * @param home - the resolved Delo home.
 * @param except - the process id to leave out.
 * @returns their process ids; registrations of dead processes are removed.
 */
export function otherDataUsers(home: string, except: number = process.pid): readonly number[] {
  const directory = join(home, DELO_HOME_ENTRIES.run, DATA_USERS_DIRECTORY)
  if (!existsSync(directory)) return []
  const live: number[] = []
  for (const name of readdirSync(directory)) {
    const pid = Number(name)
    if (!Number.isInteger(pid) || pid <= 0 || pid === except) continue
    if (processExists(pid)) live.push(pid)
    else rmSync(join(directory, name), { force: true })
  }
  return live
}

/**
 * Refuse while another process uses the chat data: the copy, the restore and a rollback call this with the home
 * lock held.
 * @param home - the resolved Delo home.
 * @throws {DataInUseError} naming the processes.
 */
export function assertSoleDataUser(home: string): void {
  const others = otherDataUsers(home)
  if (others.length > 0) throw new DataInUseError(`process ${others.join(', ')} uses the chat data (delorun headless); wait for it to end, then try again`)
}

/**
 * Refuse while an update or a rollback of any CLI profile is between its snapshot and its end, or a restore of a
 * copy is unfinished: the chat data may be mid-copy or mid-restore.
 * @param home - the resolved Delo home.
 * @throws {DataInUseError} naming what is in progress.
 */
export async function assertNoUpdateInProgress(home: string): Promise<void> {
  if (existsSync(join(home, DATA_COPIES_DIRECTORY, RESTORE_JOURNAL_FILE))) throw new DataInUseError('a restore of the chat data is unfinished; run delorun start or delorun recover status first')
  const run = join(home, DELO_HOME_ENTRIES.run)
  if (!existsSync(run)) return
  for (const profile of readdirSync(run)) {
    if (profile === DATA_USERS_DIRECTORY) continue
    const record = await readJournal(journalPath(home, profile))
    if (record !== undefined && record.phase !== 'committed') throw new DataInUseError(`an update of the profile ${profile} from Delo ${record.from} to Delo ${record.to} is ${record.phase}; wait for it to end, or run delorun recover status`)
  }
}
