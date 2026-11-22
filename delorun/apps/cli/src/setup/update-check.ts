/**
 * The `updateCheck` answer as a profile row: `config.enabled` of `@delorun/bundle-local`'s `delorun-update-check` row, the
 * C16 switch `update_check`, written into the profile's `cordis.patch.yml` in the form Settings → General → Updates saves it.
 * The bundle's own patch, which the profile patch follows, supplies the row's plugin name and inherited config.
 *
 * @module @delorun/cli/setup/update-check
 */
import { fileURLToPath } from 'node:url'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { SETUP_UPDATE_CHECK_ROW } from '@delorun/contract-setup-answers'
import { readPatchRow, setRowFields, type InheritedRow } from '@delorun/setup-apply'

/**
 * The release-check row as `@delorun/bundle-local` inserts it.
 * @param bundlePatch - the bundle's `cordis.patch.yml`; the installed bundle's by default.
 * @returns the row's id, plugin name and config.
 * @throws {Error} when the bundle's patch inserts no such row with a config mapping.
 */
export function updateCheckRow(bundlePatch = fileURLToPath(import.meta.resolve('@delorun/bundle-local/cordis.patch.yml'))): InheritedRow {
  const row = loadOverlayPatches('delorun setup', bundlePatch).flatMap(patch => patch.insert ?? []).find(entry => entry.id === SETUP_UPDATE_CHECK_ROW)
  const config: unknown = row?.config
  if (row === undefined || typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new Error(`delorun setup: ${bundlePatch} inserts no ${SETUP_UPDATE_CHECK_ROW} row with a config, so the release-check answer cannot be written`)
  }
  return { id: row.id, name: row.name, config: { ...config } }
}

/**
 * Write the release-check answer into a profile's patch. On, the bundle's value, leaves no config on the row.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param enabled - the `updateCheck` answer.
 */
export function writeUpdateCheckRow(patchPath: string, enabled: boolean): void {
  setRowFields(patchPath, updateCheckRow(), { enabled })
}

/**
 * Read the release-check answer from a profile's patch, the row {@link writeUpdateCheckRow} and Settings → General →
 * Updates write.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param inherited - the row as the bundle inserts it; the installed bundle's by default.
 * @returns the row's `enabled` value: the profile's, or the bundle's when the profile sets none.
 * @throws {CliError} `EXIT.failed` when the patch is not a YAML patch list.
 */
export function readUpdateCheckRow(patchPath: string, inherited: InheritedRow = updateCheckRow()): boolean {
  const config = { ...inherited.config, ...readPatchRow(patchPath, inherited.id, 'delorun setup') }
  return config['enabled'] !== false
}
