/**
 * Delo's headless bundle in the home's `headless` profile. Upstream's `headless` template carries no Delo bundle, and a
 * plugin a patch names resolves only from the installation's own dependencies or from a bundle the profile links, so
 * `delorun headless` links `@delo/bundle-headless` into the profile with the operation setup uses for a CLI profile
 * ({@link linkDeloBundles}). It does so as the profile's one-time change `headless-bundle`, on the first run, which
 * also creates the profile from upstream's template, and on the first run of a release that brings it to a profile an
 * earlier run created. The composition then refuses a headless profile that does not load the bundle
 * ([compose](./compose.ts)), so removing it later stops `delorun headless` with the remedy.
 *
 * @module @delo/cli/headless-bundle
 */
import { HEADLESS_BUNDLE } from '@delo/bundle-local/profile'
import { HEADLESS_PROFILE } from '@delo/contract-home-layout'
import type { CommandOutput } from './command.ts'
import { linkDeloBundles, type BundleLinking, type LinkReport } from './delo-bundles.ts'
import type { ProfileMigration } from './profile-migrations.ts'
import { profileBundles } from './studio-bundle.ts'

/** The one-time change that links the headless bundle, as the profile's record of migrations names it. */
export const HEADLESS_BUNDLE_MIGRATION = 'headless-bundle'

/**
 * Link the headless bundle into the home's `headless` profile, creating the profile from upstream's template when it
 * does not exist.
 * @param home - the Delo home.
 * @param linking - upstream's resolution and plugin operation for the `headless` profile.
 * @param report - the log that receives the plugin operation's output, and the writer of the one progress line.
 * @returns true when the profile's bundle list did not name the bundle before.
 * @throws {CliError} when the bundle cannot be linked, as {@link linkDeloBundles} throws.
 */
export async function addHeadlessBundle(home: string, linking: () => Promise<BundleLinking>, report: LinkReport): Promise<boolean> {
  const listed = profileBundles(home, HEADLESS_PROFILE)?.includes(HEADLESS_BUNDLE) === true
  await linkDeloBundles(home, HEADLESS_PROFILE, [HEADLESS_BUNDLE], await linking(), report)
  return !listed
}

/**
 * The migration that links the headless bundle. A failure stops the run: a headless profile without the bundle would
 * run its task without Delo's guards, which the composition refuses anyway.
 * @param add - links the bundle; true when the bundle list did not name it before.
 * @param output - where its line goes.
 * @returns the migration.
 */
export function headlessBundleMigration(add: () => Promise<boolean>, output: CommandOutput): ProfileMigration {
  return {
    id: HEADLESS_BUNDLE_MIGRATION,
    async run() {
      if (await add()) output.stderr(`delorun: added Delorun's safety checks to the ${HEADLESS_PROFILE} profile (the web fetch check and the questions before full access, instruction edits and scheduled work). This happens once.\n`)
      return true
    },
  }
}
