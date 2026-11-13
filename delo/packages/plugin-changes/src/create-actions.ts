/**
 * The studio's Create a plugin: the three actions behind its section, each a `POST` that `routes.ts` admits only for
 * the person at their computer before the body is read. `create` writes a new plugin's files with the scaffold
 * `delorun plugin new` uses, into `plugins/<name without its scope>` below the Delo home and nowhere else. `request`
 * records the install from that folder as a change waiting for the person's review, as an agent's `install_bundle` of
 * a folder does, so turning the plugin on goes through the Changes review and its protection, also in dangerous mode.
 * `reveal` shows that folder in the computer's file manager. None of them turns a plugin on, reloads the Host or
 * approves content.
 *
 * @module @delo/plugin-changes/create-actions
 */
import { lstat, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeEntry, ChangesContext } from '@delo/changes'
import { recordPluginRequest } from '@delo/changes/install'
import { DELO_HOME_ENTRIES, PRIVATE_DIR_MODE } from '@delo/contract-home-layout'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { bareName, checkKind, createPlugin, ScaffoldError, type Installation } from '@delo/plugin-scaffold'
import type { CreatedView, RequestedView, RevealedView } from './wire.ts'

/** What a scaffold targets: the release it runs on and the installation whose shipped packages a name may not take. */
export interface ScaffoldTarget {
  readonly running: VersionOutput
  readonly installation: Installation
}

/** The refusal of a create action: a status, a code and the sentence the person reads. */
export class CreateRefusal extends Error {
  /**
   * @param status - the HTTP status.
   * @param code - the refusal code.
   * @param message - the sentence.
   */
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message)
    this.name = 'CreateRefusal'
  }
}

/**
 * The folder of a plugin created in the studio.
 * @param home - the Delo home.
 * @param name - a package name that passed the scaffold's checks.
 * @returns `<home>/plugins/<name without its scope>`.
 */
export function pluginFolder(home: string, name: string): string {
  return join(home, DELO_HOME_ENTRIES.plugins, bareName(name))
}

/**
 * Create a plugin's folder and files.
 * @param home - the Delo home.
 * @param body - `name` and `kind`.
 * @param target - the release and installation the plugin targets.
 * @returns the folder and the files written.
 * @throws {CreateRefusal} `400` for a refused name or kind, `409` for a folder that cannot take the files.
 */
export async function createAction(home: string, body: { readonly name: unknown, readonly kind: unknown }, target: ScaffoldTarget): Promise<CreatedView> {
  if (typeof body.name !== 'string' || typeof body.kind !== 'string') throw new CreateRefusal(400, 'BAD_REQUEST', 'Name the plugin and choose its kind.')
  try {
    const kind = checkKind(body.kind)
    const folder = pluginFolder(home, body.name)
    // The name's checks come before any folder is made, so a refused name leaves nothing behind.
    await mkdir(join(home, DELO_HOME_ENTRIES.plugins), { recursive: true, mode: PRIVATE_DIR_MODE })
    const files = await createPlugin({ name: body.name, kind, folder, running: target.running, installation: target.installation })
    return { kind: 'created', plugin: body.name, pluginKind: kind, folder, files }
  } catch (error) {
    if (error instanceof ScaffoldError) throw new CreateRefusal(error.kind === 'usage' ? 400 : 409, error.kind === 'usage' ? 'BAD_REQUEST' : 'CANNOT_CREATE', error.message)
    throw error
  }
}

/**
 * Read the name of a plugin the studio created, which must be a folder directly below `plugins` that holds a package of
 * that name.
 * @param home - the Delo home.
 * @param name - the package name the person was shown.
 * @returns the folder.
 * @throws {CreateRefusal} `404` when no such plugin was created, `400` for a name that is not a package name.
 */
async function createdFolder(home: string, name: unknown): Promise<string> {
  if (typeof name !== 'string' || name !== name.trim() || name.startsWith('.')) throw new CreateRefusal(400, 'BAD_REQUEST', 'Name the plugin by its package name.')
  const folder = pluginFolder(home, name)
  try {
    if (!(await lstat(folder)).isDirectory()) throw new Error('not a directory')
    const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as { readonly name?: unknown }
    if (manifest.name !== name) throw new Error('another package')
  } catch (_absent) {
    // Any failure to read the folder means the studio did not create this plugin.
    throw new CreateRefusal(404, 'NOT_CREATED_HERE', `${name} was not created in the studio's plugins folder.`)
  }
  return folder
}

/**
 * Record the install of a created plugin from its folder as a change that waits for review.
 * @param ctx - the profile.
 * @param body - `name`.
 * @param toView - the entry as an answer carries it.
 * @returns the pending entry.
 * @throws {CreateRefusal} for a plugin the studio did not create.
 */
export async function requestAction(ctx: ChangesContext, body: { readonly name: unknown }, toView: (entry: ChangeEntry) => RequestedView['entry']): Promise<RequestedView> {
  const folder = await createdFolder(ctx.home, body.name)
  return { kind: 'requested', entry: toView(await recordPluginRequest(ctx, { action: 'install', spec: `link:${folder}` })) }
}

/**
 * Show a created plugin's folder in the file manager.
 * @param home - the Delo home.
 * @param body - `name`.
 * @param open - shows a folder in the computer's file manager.
 * @returns the folder.
 * @throws {CreateRefusal} for a plugin the studio did not create.
 */
export async function revealAction(home: string, body: { readonly name: unknown }, open: (folder: string) => void): Promise<RevealedView> {
  const folder = await createdFolder(home, body.name)
  open(folder)
  return { kind: 'revealed', folder }
}
