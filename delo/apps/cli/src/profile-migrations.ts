/**
 * One-time changes a release makes to a CLI profile that an earlier release set up, such as adding the studio bundle
 * ([studio bundle](./studio-bundle.ts)). They run at a fresh start, under the profile's home lock and before its Host
 * boots, never in an update's successor, whose boot shares the health check's 120 seconds; each one that completes is
 * recorded in `run/<profile>/migrations.json`, so it never runs again. One that fails is not recorded: the start goes
 * on, and the next fresh start tries it again. A package operation a migration runs takes upstream's profile file
 * lock, which `delorun plugin` and the Host's plugin manager take too.
 *
 * @module @delo/cli/profile-migrations
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDirectory, writeProtectedFile } from '@delo/home'
import type { CommandOutput } from './command.ts'
import { CliError } from './exit.ts'

/** The record of a profile's completed migrations, under its run directory. */
export const MIGRATIONS_FILE = 'migrations.json'

/** One one-time change to a profile. */
export interface ProfileMigration {
  /** The migration's stable id, which the record keeps. */
  readonly id: string
  /**
   * Apply the change, or find it not needed.
   * @returns true when the migration is complete, false when it failed and the next fresh start tries it again.
   */
  readonly run: () => Promise<boolean>
}

/**
 * The ids of a profile's completed migrations.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the ids; none when the record is absent or does not read, so every migration runs again and each finds
 *   itself not needed.
 */
export function completedMigrations(home: string, profile: string): readonly string[] {
  const path = join(runDirectory(home, profile), MIGRATIONS_FILE)
  if (!existsSync(path)) return []
  let record: { done?: unknown }
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as { done?: unknown }
  } catch (_unreadable) {
    // A record that is not JSON names nothing done; each migration checks the profile itself before it changes it.
    return []
  }
  return Array.isArray(record.done) ? record.done.filter((id): id is string => typeof id === 'string') : []
}

/**
 * Run each migration the profile has not completed, in order, and record each that completes.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param migrations - the migrations of this release, in order.
 * @returns the ids that ran and completed.
 */
export async function runProfileMigrations(home: string, profile: string, migrations: readonly ProfileMigration[]): Promise<string[]> {
  const done = [...completedMigrations(home, profile)]
  const ran: string[] = []
  for (const migration of migrations) {
    if (done.includes(migration.id)) continue
    if (!await migration.run()) continue
    done.push(migration.id)
    ran.push(migration.id)
    await writeProtectedFile(join(runDirectory(home, profile), MIGRATIONS_FILE), `${JSON.stringify({ v: 1, done })}\n`)
  }
  return ran
}

/**
 * The migration that adds the studio bundle to a profile setup created before it existed.
 * @param add - adds the bundle when the profile lacks it; true when it was added.
 * @param output - where its lines go.
 * @param profile - the CLI profile, which the lines name.
 * @returns the migration; a profile that cannot take the bundle starts in the stock look, and the next fresh start
 *   tries again. A failure that is not a refusal of the operation stops the start.
 */
export function studioBundleMigration(add: () => Promise<boolean>, output: CommandOutput, profile: string): ProfileMigration {
  return {
    id: 'studio-bundle',
    async run() {
      try {
        if (await add()) output.stderr(`delorun: added Delo's studio look to the profile ${profile}; Settings → Appearance switches back to the stock look.\n`)
        return true
      } catch (error) {
        if (!(error instanceof CliError)) throw error
        output.stderr(`delorun: the profile ${profile} starts in the stock look, because Delo's studio look could not be added: ${error.message}\n`)
        return false
      }
    },
  }
}
