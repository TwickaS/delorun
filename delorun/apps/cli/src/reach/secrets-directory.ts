/**
 * The directory the home keeps its paired devices' sessions in, resolved the way the running home resolves it, for
 * `delorun reach off` when no home answers. The home reads its `delorun-home-auth` row composed over every layer (the
 * bundles' patches, the profile's patch and the home's own patch), takes the row's `secretsDirectory` or its own
 * `secrets/home-auth`, and refuses one that is not absolute or not in its `secrets` directory. The layers and the check
 * are the ones the home uses ({@link patchLayers}, {@link checkSecretsDirectory}); the start's `--patch` overlays are
 * not known to a stopped home, so they are not read. The studio bundle sets the directory with the expression
 * `dshHomePath('secrets', 'home-auth')`, which the boot evaluates to the home's own; that one expression is read as the
 * home's own directory, and any other expression is refused, not run here.
 *
 * @module @delorun/cli/reach/secrets-directory
 */
import { join } from 'node:path'
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { checkSecretsDirectory } from '@delorun/home-auth'
import { HOME_AUTH_ROW_ID } from '@delorun/setup-apply'
import { composedRow, isRecord, patchLayers } from '../patch-layers.ts'
import { profileDirectory } from '../profile.ts'

/** The expression the studio bundle's row sets, which the boot evaluates to `<home>/secrets/home-auth`. */
const HOME_OWN_EXPRESSION = /^dshHomePath\(\s*(['"])secrets\1\s*,\s*(['"])home-auth\2\s*\)$/

/**
 * @param home - the Delorun home.
 * @param profile - the CLI profile.
 * @param installAnchor - the installation's `package.json`, which the profile's bundles resolve from.
 * @returns the absolute directory the home would open.
 * @throws {Error} when a layer cannot be read or the row names a directory the home would refuse.
 */
export function homeAuthDirectory(home: string, profile: string, installAnchor: string): string {
  const loaded = loadProfileDirectory('delorun', profileDirectory(home, profile), installAnchor)
  const row = composedRow(patchLayers(home, loaded, []), HOME_AUTH_ROW_ID)
  const set = isRecord(row?.config) ? row.config.secretsDirectory : undefined
  const own = join(home, 'secrets', 'home-auth')
  if (set === undefined) return checkSecretsDirectory(own)
  if (typeof set === 'string') return checkSecretsDirectory(set)
  if (isRecord(set) && typeof set.__jsExpr === 'string' && HOME_OWN_EXPRESSION.test(set.__jsExpr.trim())) return checkSecretsDirectory(own)
  throw new Error(`the ${HOME_AUTH_ROW_ID} row sets secretsDirectory to something other than a path or the home's own directory`)
}
