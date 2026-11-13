/**
 * The import method of a profile's packages. pnpm's default links a package's files from its global store (hard links,
 * or copy-on-write clones), so an edit to a file in the store edits every installed copy, the profile's plugins
 * included, without any package operation. A profile whose `pnpm-workspace.yaml` sets `packageImportMethod: copy`
 * gets its own copies, which the install records then describe. The setting is added where the file names no import
 * method; a value the person set stays.
 *
 * @module @delo/cli/pnpm-import
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { isMap, parseDocument } from 'yaml'
import type { CommandOutput } from './command.ts'
import type { ProfileMigration } from './profile-migrations.ts'

/** The id of the one-time change that sets the import method in an existing profile. */
export const COPY_IMPORT_MIGRATION = 'pnpm-copy-import'

/** The pnpm setting, as pnpm 11 reads it from `pnpm-workspace.yaml`. */
export const IMPORT_METHOD_KEY = 'packageImportMethod'

/**
 * Set `packageImportMethod: copy` in a profile's `pnpm-workspace.yaml` when it names no import method, keeping its
 * comments and every other setting.
 * @param profileDir - the profile directory.
 * @returns `added` when it set the method, `kept` when the file already names one, `absent` when the profile has no
 *   such file yet.
 * @throws Error when the file is not a YAML mapping, naming the file.
 */
export async function ensureCopyImport(profileDir: string): Promise<'added' | 'kept' | 'absent'> {
  const path = join(profileDir, 'pnpm-workspace.yaml')
  if (!existsSync(path)) return 'absent'
  const document = parseDocument(readFileSync(path, 'utf8'))
  if (document.errors.length > 0 || !isMap(document.contents)) throw new Error(`${path} is not a YAML mapping, so its package import method was not set`)
  if (document.has(IMPORT_METHOD_KEY)) return 'kept'
  document.set(IMPORT_METHOD_KEY, 'copy')
  await writeFileAtomic(path, String(document), { mode: 0o600 })
  return 'added'
}

/**
 * The one-time change that sets the import method in a profile set up before Delo set it.
 * @param profileDir - the profile directory.
 * @param output - where a failure is reported.
 * @returns the migration; it completes when the method is set or the file already names one.
 */
export function copyImportMigration(profileDir: string, output: CommandOutput): ProfileMigration {
  return {
    id: COPY_IMPORT_MIGRATION,
    run: async () => {
      try {
        return await ensureCopyImport(profileDir) !== 'absent'
      } catch (error) {
        output.stderr(`delorun: warning: ${error instanceof Error ? error.message : String(error)}; plugins installed into this profile share their files with pnpm's store until it is fixed\n`)
        return false
      }
    },
  }
}
