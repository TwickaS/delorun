/**
 * One-time changes a release makes to a CLI profile that an earlier release set up, such as adding the studio bundle
 * ([studio bundle](./studio-bundle.ts)). They run at a fresh start, under the profile's home lock and before its Host
 * boots, never in an update's successor, whose boot shares the health check's 120 seconds. Each one that completes is
 * recorded in the profile's own `profiles/<profile>/delo-migrations.json`, so it never runs again while the profile
 * keeps that record. One that fails is not recorded: the start goes on, and the next fresh start tries it again. A
 * package operation a migration runs takes upstream's profile file lock, which `delorun plugin` and the Host's plugin
 * manager take too.
 *
 * The record is not one of the files the profile history tracks: a restore of a history version leaves it as it
 * stands, so restoring a version from before a migration does not run that migration again.
 *
 * A record that does not read runs no migration: the start warns, naming the file and the remedy, and goes on with the
 * profile unchanged. A profile with no record whose run directory holds the record an earlier release kept there,
 * `run/<profile>/migrations.json`, takes that record over before any migration runs.
 *
 * @module @delo/cli/profile-migrations
 */
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { runDirectory, writeProtectedFile } from '@delo/home'
import type { CommandOutput } from './command.ts'
import { CliError } from './exit.ts'

/** The record of a profile's completed migrations, in the profile directory beside upstream's profile files. */
export const MIGRATIONS_FILE = 'delo-migrations.json'

/** The record an earlier release kept under the profile's run directory, which a start takes over once. */
export const RUN_DIRECTORY_MIGRATIONS_FILE = 'migrations.json'

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

/** A profile's record of completed migrations, as one file reads. */
export type MigrationRecord =
  | { readonly kind: 'absent' }
  | { readonly kind: 'read', readonly done: readonly string[] }
  | { readonly kind: 'unreadable', readonly path: string, readonly reason: string }

/**
 * The path of a profile's record.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns `profiles/<profile>/delo-migrations.json` under the home.
 */
export function migrationsPath(home: string, profile: string): string {
  return join(home, 'profiles', profile, MIGRATIONS_FILE)
}

/**
 * Read one record file: `{"v":1,"done":[<id>…]}`.
 * @param path - the file.
 * @returns `absent` when the file does not exist; `unreadable` with the reason when it cannot be read, is not JSON or
 *   holds anything else.
 */
function readRecordFile(path: string): MigrationRecord {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    return { kind: 'unreadable', path, reason: (error as NodeJS.ErrnoException).code ?? String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (_notJson) {
    // Reported as the reason below; the caller runs no migration.
    return { kind: 'unreadable', path, reason: 'it is not JSON' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { kind: 'unreadable', path, reason: 'it is not a record of completed changes' }
  const record = parsed as { readonly v?: unknown, readonly done?: unknown }
  if (record.v !== 1 || !Array.isArray(record.done) || !record.done.every((id): id is string => typeof id === 'string')) {
    return { kind: 'unreadable', path, reason: 'it is not a record of completed changes' }
  }
  return { kind: 'read', done: record.done }
}

/**
 * A profile's record of completed migrations: its own record, or, while it has none, the record an earlier release
 * kept under its run directory.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @returns the record, and the file it was read from when it is the run directory's.
 */
export function completedMigrations(home: string, profile: string): MigrationRecord & { readonly fromRunDirectory?: string } {
  const own = readRecordFile(migrationsPath(home, profile))
  if (own.kind !== 'absent') return own
  const earlier = join(runDirectory(home, profile), RUN_DIRECTORY_MIGRATIONS_FILE)
  const record = readRecordFile(earlier)
  return record.kind === 'read' ? { ...record, fromRunDirectory: earlier } : record
}

/**
 * Write a profile's record.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param done - the completed migrations' ids.
 * @returns when the record is written and synced.
 */
async function writeRecord(home: string, profile: string, done: readonly string[]): Promise<void> {
  await writeProtectedFile(migrationsPath(home, profile), `${JSON.stringify({ v: 1, done })}\n`)
}

/**
 * Run each migration the profile has not completed, in order, and record each that completes. A record an earlier
 * release kept under the run directory is first written to the profile and then removed. A record that does not read
 * runs nothing and changes nothing: the output names the file and the remedy.
 * @param home - the Delo home.
 * @param profile - the CLI profile.
 * @param migrations - the migrations of this release, in order.
 * @param output - where the warning about a record that does not read goes.
 * @returns the ids that ran and completed.
 */
export async function runProfileMigrations(home: string, profile: string, migrations: readonly ProfileMigration[], output: CommandOutput): Promise<string[]> {
  if (migrations.length === 0) return []
  const record = completedMigrations(home, profile)
  switch (record.kind) {
    case 'unreadable':
      output.stderr(`delorun: Delo applied none of its one-time changes to the profile ${profile}, because ${record.path} does not read: ${record.reason}. The profile starts as it is. Removing that file lets the next start apply the changes this release makes to a profile an earlier release set up, such as adding the studio look; each change checks the profile first and skips what it already holds.\n`)
      return []
    case 'read':
      if (record.fromRunDirectory !== undefined) {
        await writeRecord(home, profile, record.done)
        rmSync(record.fromRunDirectory, { force: true })
      }
      break
    case 'absent':
      break
    default:
      record satisfies never
  }
  const done = record.kind === 'read' ? [...record.done] : []
  const ran: string[] = []
  for (const migration of migrations) {
    if (done.includes(migration.id)) continue
    if (!await migration.run()) continue
    done.push(migration.id)
    ran.push(migration.id)
    await writeRecord(home, profile, done)
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
