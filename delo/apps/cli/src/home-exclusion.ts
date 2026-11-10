/**
 * Exclusive use of a Delo home by `delorun trash`, `delorun export` and
 * `delorun import`. Every profile of a home shares `sessions/`, `attachments/`,
 * `storages/`, `trash/` and `archive/`, so such a command takes the home lock
 * of every profile under `run/` for its whole operation, as a home process
 * does, and releases each lock when it ends. While it holds them no home
 * process can start; a profile whose home process runs refuses the command,
 * and so does a lock another command holds.
 *
 * @module @delo/cli/home-exclusion
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeVersion } from '@delo/contract-home-layout'
import { acquireHomeLock, ensureHomeTree, HomeLayoutError, newStartId, readHomeLock, runDirectory, type HolderProbe, type HomeLock } from '@delo/home'
import { updateChannelProbe } from '@delo/home-process'
import { CliError, EXIT } from './exit.ts'
import { runningVersion } from './start.ts'

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
 * Run one operation while this process holds the home lock of every profile
 * of a home, in profile order, and release them all afterwards, whether the
 * operation succeeded or not.
 * @param target - the home, the profile, the command's name and what to use instead.
 * @param run - the operation.
 * @param exclusion - the holder probe and the runtime version.
 * @returns what the operation returned.
 * @throws {CliError} when a profile's home process runs or another process holds a profile's lock; nothing ran then.
 */
export async function withHomeExclusive<T>(target: ExclusiveHome, run: () => Promise<T>, exclusion: HomeExclusion = homeExclusion()): Promise<T> {
  await ensureHomeTree(target.home, target.profile)
  const profiles = (await readdir(join(target.home, 'run'), { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
  const held: HomeLock[] = []
  try {
    for (const profile of profiles) held.push(await takeLock(target, profile, exclusion))
    return await run()
  } finally {
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
