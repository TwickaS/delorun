/**
 * Create a plugin's folder: the checks on the name, the kind and the folder, and the write of the files of one kind
 * ([scaffold](./scaffold.ts)). `delorun plugin new` and the studio's Create a plugin both call {@link createPlugin}.
 *
 * Contract:
 * - The folder may exist only as an empty directory that is not a symbolic link; missing parent folders are created, and
 *   stay when the write fails, as empty folders.
 * - A name npm would not publish, a name under the `@deepseek-ai/` or `@delorun/` scope, a name the installation ships
 *   (a profile resolves a shipped package before a profile install, see [installation](./installation.ts)) and an
 *   unknown kind are refused with the kind `usage`; a folder that cannot take the scaffold, with `failed`.
 * - It writes only inside the folder, creates no file that exists, and removes what it wrote when a write fails.
 * - The package declares `engines.delorun` as the range `delorun plugin check` recommends for the running Delorun, which
 *   alone decides on Delorun (A567), and `engines.dsh` as `^<running DSH>`, which stock DeepSeek Harness checks, so one
 *   package runs on both; the DSH packages a plugin with code shares with the host are peer and
 *   development dependencies on `^<running DSH>`, and `@deepseek-ai/cordis` on `~<installed cordis>`.
 *
 * @module @delorun/plugin-scaffold/create
 */
import { lstat, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join } from 'node:path'
import type { VersionOutput } from '@delorun/contract-plugin-versions'
import { ScaffoldError } from './error.ts'
import { installationShips, installedCordisVersion, RESERVED_SCOPES, type Installation } from './installation.ts'
import { bareName, PLUGIN_KINDS, scaffoldFiles, type PluginKind, type ScaffoldFile } from './scaffold.ts'

/** An npm package name: lowercase URL-safe characters, an optional scope, no leading dot or underscore (upstream's install-spec rule). */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

/** The longest name the npm registry accepts. */
const PACKAGE_NAME_MAX_LENGTH = 214

/** Names the npm registry refuses although they match {@link PACKAGE_NAME}. */
const REFUSED_NAMES = new Set(['node_modules', 'favicon.ico'])

/**
 * Refuse a kind that is not one of {@link PLUGIN_KINDS}.
 * @param kind - the kind as the caller gave it.
 * @returns the kind.
 * @throws {ScaffoldError} of kind `usage` for an unknown kind.
 */
export function checkKind(kind: string): PluginKind {
  if (!(PLUGIN_KINDS as readonly string[]).includes(kind)) throw new ScaffoldError('usage', `there is no plugin kind ${JSON.stringify(kind)}; choose one of ${PLUGIN_KINDS.join(', ')}`)
  return kind as PluginKind
}

/**
 * Refuse a name a new plugin cannot take by its form alone.
 * @param name - the name.
 * @throws {ScaffoldError} of kind `usage` for a name npm would not publish or one under a reserved scope.
 */
export function checkName(name: string): void {
  const shown = JSON.stringify(name)
  if (name.length > PACKAGE_NAME_MAX_LENGTH || !PACKAGE_NAME.test(name) || REFUSED_NAMES.has(bareName(name)) || isBuiltin(name)) {
    throw new ScaffoldError('usage', `${shown} is not a package name npm publishes; use lowercase letters, digits, "-", "." and "_", not first a "." or "_", optionally after a scope such as @you/, and not the name of a Node.js module`)
  }
  const scope = RESERVED_SCOPES.find(reserved => name.startsWith(reserved))
  if (scope !== undefined) throw new ScaffoldError('usage', `${shown} is under the ${scope.slice(0, -1)} scope, which only its own packages use; name the plugin under your own scope, such as @you/${bareName(name)}`)
}

/** What a folder needs before the scaffold is written into it. */
interface FolderPlan {
  /** Whether the folder itself must be created. */
  readonly create: boolean
  /** The missing parent folders, outermost first; empty when the folder's parent exists. */
  readonly parents: readonly string[]
}

/**
 * The parent folders of a new folder that do not exist yet.
 * @param folder - the new folder's absolute path.
 * @returns the missing parents, outermost first.
 * @throws {ScaffoldError} of kind `failed` when an ancestor cannot be read.
 */
async function missingParents(folder: string): Promise<readonly string[]> {
  const missing: string[] = []
  let ancestor = dirname(folder)
  for (;;) {
    // The ancestor may be reached through a symbolic link, such as /tmp on macOS; only the new folder must not be one.
    const status = await stat(ancestor).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new ScaffoldError('failed', `${ancestor} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
    })
    if (status !== undefined) return missing.reverse()
    missing.push(ancestor)
    ancestor = dirname(ancestor)
  }
}

/**
 * Check that the folder can take the scaffold: an empty directory, or a new one whose missing parents can be created.
 * @param folder - the folder's absolute path.
 * @param via - words appended to the advice to choose another folder, such as ` with --dir`.
 * @returns what must be created.
 * @throws {ScaffoldError} of kind `failed` for a folder that exists and is not an empty directory, or an ancestor that cannot be read.
 */
async function checkFolder(folder: string, via: string): Promise<FolderPlan> {
  const status = await lstat(folder).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new ScaffoldError('failed', `${folder} cannot be read: ${error instanceof Error ? error.message : String(error)}`)
  })
  if (status === undefined) return { create: true, parents: await missingParents(folder) }
  if (status.isSymbolicLink() || !status.isDirectory()) throw new ScaffoldError('failed', `${folder} exists and is not a folder; choose another folder${via}`)
  if ((await readdir(folder)).length > 0) throw new ScaffoldError('failed', `${folder} is not empty; choose a new or empty folder${via}`)
  return { create: false, parents: [] }
}

/**
 * Write the scaffold into the folder, creating no file or directory that exists. When a write fails, what this call
 * wrote is removed: the folder when this call created it, otherwise each file and directory it created.
 * @param folder - the folder's absolute path.
 * @param plan - what must be created.
 * @param files - the files.
 * @throws {ScaffoldError} of kind `failed` when a write fails.
 */
async function writeScaffold(folder: string, plan: FolderPlan, files: readonly ScaffoldFile[]): Promise<void> {
  const directories = [...new Set(files.flatMap((file) => {
    const parts = file.path.split('/').slice(0, -1)
    return parts.map((_part, index) => parts.slice(0, index + 1).join('/'))
  }))]
  const created: { readonly path: string, readonly directory: boolean }[] = []
  let ownsFolder = false
  try {
    for (const parent of plan.parents) await mkdir(parent)
    if (plan.create) {
      await mkdir(folder)
      ownsFolder = true
    }
    for (const directory of directories) {
      const path = join(folder, ...directory.split('/'))
      await mkdir(path)
      created.push({ path, directory: true })
    }
    for (const file of files) {
      const path = join(folder, ...file.path.split('/'))
      await writeFile(path, file.text, { flag: 'wx' })
      created.push({ path, directory: false })
    }
  } catch (error) {
    if (ownsFolder) await rm(folder, { recursive: true, force: true })
    else for (const { path, directory } of created.reverse()) await (directory ? rmdir(path) : rm(path, { force: true }))
    throw new ScaffoldError('failed', `${folder} could not be written, and what this command wrote there is removed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** What {@link createPlugin} is asked to create. */
export interface CreateRequest {
  /** The package name. */
  readonly name: string
  /** The kind of plugin. */
  readonly kind: PluginKind
  /** The plugin's folder: an absolute path, new or empty. */
  readonly folder: string
  /** The release the plugin targets. */
  readonly running: VersionOutput
  /** The installation whose shipped packages a name may not take and whose cordis version the plugin declares. */
  readonly installation: Installation
  /** Words appended to the advice to choose another folder, such as ` with --dir`; empty when the caller offers no such option. */
  readonly chooseFolderVia: string
}

/**
 * Create the plugin's folder and write its files.
 * @param request - what to create.
 * @returns the paths of the files written, relative to the folder, with `/` separators.
 * @throws {ScaffoldError} of kind `usage` for a refused name, or of kind `failed` for a folder that cannot take the
 *   scaffold, an installation without a readable cordis, or a write that fails.
 */
export async function createPlugin(request: CreateRequest): Promise<readonly string[]> {
  checkName(request.name)
  const folderPlan = await checkFolder(request.folder, request.chooseFolderVia)
  if (await installationShips(request.installation, request.name)) {
    throw new ScaffoldError('usage', `${JSON.stringify(request.name)} is a package this Delorun installation ships, and a profile loads the shipped package instead of a plugin of the same name; choose another name, such as @you/${bareName(request.name)}`)
  }
  const files = scaffoldFiles({ name: request.name, kind: request.kind, dsh: request.running.dsh, delorun: request.running.delorun, cordis: installedCordisVersion(request.installation) })
  await writeScaffold(request.folder, folderPlan, files)
  return files.map(file => file.path)
}
