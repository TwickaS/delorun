/**
 * Applying an imported setup to a profile, only through the paths a person meets installing the same plugins by hand.
 * Each plugin removal and installation is an agent-style plugin request ([install actions](../install-actions.ts)) that
 * the person's presence applies: upstream's plugin operation with its compatibility checks, the install check around
 * pnpm, build scripts held back by `allowBuilds`, the profile's `package.json` and lockfile put back on failure, and a
 * history version for each. A plugin the person made on another computer is written to a folder under
 * `archive/setup-plugins/` and linked from there, which records its content as a change waiting for review: it is not
 * approved by the import. Settings go into the profile's patch layer last, under the profile's write lock, as one
 * history version. A saved version of the setup as it was is the first step, so one restore undoes the import.
 *
 * @module @delorun/changes/setup-transfer/apply
 */
import { chmod, lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PROTECTED_FILE_MODE } from '@delorun/contract-home-layout'
import { refuseLinkedDirectory, writeStaging, type SetupDocument, type SetupLocalPlugin } from '@delorun/archive'
import { saveProfileVersion } from '@delorun/profile-safety'
import { locked, recordVersion } from '../action-support.ts'
import type { ChangesContext, ReloadHost } from '../actions.ts'
import { ChangesError } from '../errors.ts'
import { applyInstallChange, recordPluginRequest, type PluginOperation } from '../install-actions.ts'
import { pluginSlug } from '../paths.ts'
import { requirePresence, type AtComputer } from '../records.ts'
import type { ChangeId } from '../types.ts'
import { lockfileIntegrities } from './collect.ts'
import { recordImportReviews } from './import-reviews.ts'
import { DEFAULT_IMPORT_OPTIONS, planSetupImport, type ImportOptions } from './plan.ts'

/** The name the saved version of the setup before an import carries. */
export const BEFORE_IMPORT_VERSION_NAME = 'Before importing a setup'

/** What applying a setup needs. */
export interface SetupApplyOptions {
  /** Proof that the person is at their computer. */
  readonly presence: AtComputer
  /** Reloads a running Host. */
  readonly reload: ReloadHost
  /** Upstream's plugin operation, with the install check around it. */
  readonly run: PluginOperation
  /**
   * Reads one plugin file from the archive.
   * @param sha256 - the digest the document names.
   * @returns the file's bytes.
   */
  readonly readFile: (sha256: string) => Uint8Array
  /** What the person chose; settings replaced and no other plugin removed when absent. */
  readonly choices?: ImportOptions
  /** Receives one line as each step finishes. */
  readonly progress?: (line: string) => void
}

/** What an import did. */
export interface SetupApplied {
  /** The profile history version saved before anything changed. */
  readonly savedVersion: string
  /** The plugins removed. */
  readonly removed: readonly string[]
  /** The plugins installed, with the change that holds a local plugin's content for review. */
  readonly installed: readonly { readonly name: string, readonly reviewChange?: ChangeId }[]
  /** Whether the patch layer was written. */
  readonly settingsWritten: boolean
}

/**
 * Apply a setup to a profile.
 * @param ctx - the profile.
 * @param document - the setup document the archive passed validation with.
 * @param options - the person's presence, the plugin operation, the archive's files and the reload.
 * @returns what was done.
 * @throws {ChangesError} `NOT_AT_COMPUTER` without the person's presence; `SETUP_REFUSED` for a local plugin whose package.json names another package, a plugin of Delorun's scope, a credential in an entry, or a registry package whose integrity differs from the archive's; `OPERATION_FAILED` and `INVALID_REQUEST` from the plugin requests. A failure stops the import where it is: the steps before it stay applied, and the saved version restores the setup as it was.
 */
export async function applySetupImport(ctx: ChangesContext, document: SetupDocument, options: SetupApplyOptions): Promise<SetupApplied> {
  requirePresence(options.presence, 'setup')
  // The plan is read again now, so what is applied is what the profile holds at this moment.
  const choices = options.choices ?? DEFAULT_IMPORT_OPTIONS
  const { plan } = await planSetupImport(ctx, document, choices)
  if (plan.endpointNotices.length > 0 && choices.endpointsConfirmed !== true) {
    const where = plan.endpointNotices.map(({ provider, host }) => `${provider} to ${host}`).join(', ')
    throw new ChangesError('SETUP_REFUSED', 'setup', `Nothing was imported: the setup sends requests and your key to ${where}, which you have not confirmed.`)
  }
  const saved = await saveProfileVersion({ profileDir: ctx.profileDir, homeDir: ctx.home, name: BEFORE_IMPORT_VERSION_NAME })
  options.progress?.(`Saved your current setup as the version "${BEFORE_IMPORT_VERSION_NAME}".`)
  const removed: string[] = []
  const installed: { name: string, reviewChange?: ChangeId }[] = []
  for (const name of plan.remove) {
    const entry = await recordPluginRequest(ctx, { action: 'remove', spec: name, by: 'person' })
    await applyInstallChange(ctx, entry.id, options.presence, { reload: options.reload, run: options.run })
    removed.push(name)
    options.progress?.(`Removed ${name}.`)
  }
  for (const { plugin } of plan.install) {
    const spec = plugin.source === 'registry' ? `${plugin.name}@${plugin.version}` : `link:${await stageLocalPlugin(ctx, plugin, options.readFile)}`
    const entry = await recordPluginRequest(ctx, { action: 'install', spec, by: 'person' })
    const checked = plugin.source === 'registry' && plugin.integrity !== undefined ? plugin : undefined
    // The integrity is checked before the Host reloads, so a swapped package is never loaded.
    const result = await applyInstallChange(ctx, entry.id, options.presence, {
      reload: options.reload,
      run: options.run,
      ...checked === undefined ? {} : { verify: async () => requireIntegrity(ctx, checked.name, checked.version, checked.integrity!) },
    })
    if (result.folderChange !== undefined) await recordImportReviews(ctx, saved.id, [result.folderChange])
    installed.push({ name: plugin.name, ...result.folderChange === undefined ? {} : { reviewChange: result.folderChange } })
    options.progress?.(plugin.source === 'local' ? `Added ${plugin.name}; its code waits for your review.` : `Installed ${plugin.name} ${plugin.version}.`)
  }
  const settingsWritten = await writePatch(ctx, document, choices, removed)
  if (settingsWritten) options.progress?.('Wrote your model choices and settings.')
  return { savedVersion: saved.id, removed, installed, settingsWritten }
}

/**
 * Check that the lockfile holds the integrity the archive names for a registry plugin.
 * @param ctx - the profile.
 * @param name - the plugin.
 * @param version - the version installed.
 * @param integrity - the integrity the archive names.
 * @throws {ChangesError} `SETUP_REFUSED` when the lockfile records another integrity or none, so the package that arrived is not known to be the one that was exported.
 */
async function requireIntegrity(ctx: ChangesContext, name: string, version: string, integrity: string): Promise<void> {
  const held = (await lockfileIntegrities(ctx.profileDir)).get(`${name}@${version}`)
  if (held !== integrity) {
    const why = held === undefined ? 'could not be checked against the profile\'s lockfile' : 'arrived with another checksum than the one the setup names'
    throw new ChangesError('SETUP_REFUSED', name, `${name} ${version} ${why}, so it is not known to be the package that was exported. Stopped there; the version "${BEFORE_IMPORT_VERSION_NAME}" restores your setup.`)
  }
}

/**
 * Write a local plugin's files from the archive into a new folder under the home and name that folder as the spec.
 * The folder is created fresh: one an earlier import left is removed first, nothing is written through a link, each
 * path is resolved inside the folder, and each file is the bytes its digest names.
 * @param ctx - the profile.
 * @param plugin - the plugin.
 * @param read - reads a file from the archive.
 * @returns the folder's absolute path.
 * @throws {ChangesError} `SETUP_REFUSED` when the plugin's package.json names another package; the write's own error, after the folder is removed, when a file cannot be written.
 */
async function stageLocalPlugin(ctx: ChangesContext, plugin: SetupLocalPlugin, read: (sha256: string) => Uint8Array): Promise<string> {
  const manifest = plugin.files.find(file => file.path === 'package.json')!
  let declared: unknown
  try {
    declared = (JSON.parse(Buffer.from(read(manifest.sha256)).toString('utf8')) as { name?: unknown }).name
  } catch {
    // A package.json that is not JSON names no package.
    declared = undefined
  }
  if (declared !== plugin.name) throw new ChangesError('SETUP_REFUSED', plugin.name, `The setup carries ${plugin.name}, but the package.json in its files names ${typeof declared === 'string' ? declared : 'no package'}.`)
  const parent = join(ctx.home, 'archive', 'setup-plugins', ctx.profile)
  await refuseLinkedDirectory(parent)
  const folder = join(parent, pluginSlug(plugin.name))
  await removeEarlierImport(folder)
  try {
    await writeStaging(folder, plugin.files.map(file => ({ path: file.path, bytes: () => read(file.sha256) })))
    for (const file of plugin.files) if (file.executable) await chmod(join(folder, file.path), 0o700)
  } catch (error) {
    // A write that fails partway leaves no half-written folder for a later import or a person to find.
    await rm(folder, { recursive: true, force: true })
    throw error
  }
  return folder
}

/**
 * Remove the folder an earlier import of the same plugin left, when it is a directory.
 * @param folder - the folder.
 * @throws {ChangesError} `SETUP_REFUSED` when a link or a file stands there, which an import does not replace.
 */
async function removeEarlierImport(folder: string): Promise<void> {
  let stats
  try {
    stats = await lstat(folder)
  } catch (error: unknown) {
    // ENOENT: no earlier import left a folder.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (!stats.isDirectory()) throw new ChangesError('SETUP_REFUSED', folder, `${folder} is a link or a file where an import keeps a plugin's folder; move it away to import this plugin.`)
  await rm(folder, { recursive: true })
}

/**
 * Write the profile's patch layer from the setup, last, under the profile's write lock, and record a history version.
 * @param ctx - the profile.
 * @param document - the setup document.
 * @param choices - what the person chose.
 * @param removed - the plugins the import removed, whose rows go with them.
 * @returns whether the file changed.
 */
async function writePatch(ctx: ChangesContext, document: SetupDocument, choices: ImportOptions, removed: readonly string[]): Promise<boolean> {
  return locked(ctx, async () => {
    const { patch } = await planSetupImport(ctx, document, choices, removed)
    if (!patch.changed) return false
    const path = join(ctx.profileDir, 'cordis.patch.yml')
    await writeFileAtomic(path, patch.text, { mode: PROTECTED_FILE_MODE })
    await recordVersion(ctx, 'Imported the model choices and settings of a setup')
    return true
  })
}
