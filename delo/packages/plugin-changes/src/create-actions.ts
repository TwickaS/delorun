/**
 * The studio's Create a plugin: the three actions behind its section, each a `POST` that `routes.ts` admits only for
 * the person at their computer before the body is read. A new plugin lives in a workspace, never in the protected Delo
 * home, so the person and the agent work on its files with the chat's normal approvals. `create` writes a new plugin's
 * files with the scaffold `delorun plugin new` uses, into `<workspace>/plugins/<name without its scope>` of a workspace
 * the registry knows (the first one by default) and nowhere else. `request` records the install from that folder as a
 * change waiting for the person's review, as an agent's `install_bundle` of a folder does, so turning the plugin on
 * goes through the Changes review and its protection, also in dangerous mode. `reveal` shows that folder in the
 * computer's file manager. None of them turns a plugin on, reloads the Host or approves content.
 *
 * @module @delo/plugin-changes/create-actions
 */
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { ChangeEntry, ChangesContext } from '@delo/changes'
import { recordPluginRequest } from '@delo/changes/install'
import type { VersionOutput } from '@delo/contract-plugin-versions'
import { bareName, checkKind, checkName, createPlugin, ScaffoldError, type Installation } from '@delo/plugin-scaffold'
import type { CreatedView, RequestedView, RevealedView } from './wire.ts'

/** The folder of a workspace's plugins. */
export const PLUGINS_DIRECTORY = 'plugins'

/** What a scaffold targets: the release it runs on and the installation whose shipped packages a name may not take. */
export interface ScaffoldTarget {
  readonly running: VersionOutput
  readonly installation: Installation
}

/** A workspace a plugin may be created in. */
export interface WorkspaceChoice {
  /** The registry's id. */
  readonly id: string
  /** The title the person sees. */
  readonly title: string
  /** The workspace's canonical folder. */
  readonly path: string
}

/** The refusal of a create action: a status, a code and the sentence the person reads. */
export class CreateRefusal extends Error {
  readonly status: number
  readonly code: string

  /**
   * @param status - the HTTP status.
   * @param code - the refusal code.
   * @param message - the sentence.
   */
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
    this.name = 'CreateRefusal'
  }
}

/**
 * Pick the workspace a request names.
 * @param workspaces - the workspaces the registry holds, the default first.
 * @param id - the id the request names, or undefined for the default.
 * @returns the workspace.
 * @throws {CreateRefusal} `409` when there is no workspace, `404` for an id the registry does not hold.
 */
export function chooseWorkspace(workspaces: readonly WorkspaceChoice[], id: unknown): WorkspaceChoice {
  if (id === undefined) {
    const first = workspaces[0]
    if (first === undefined) throw new CreateRefusal(409, 'NO_WORKSPACE', 'Add a workspace first: a new plugin lives in the plugins folder of one.')
    return first
  }
  const found = typeof id === 'string' ? workspaces.find(workspace => workspace.id === id) : undefined
  if (found === undefined) throw new CreateRefusal(404, 'UNKNOWN_WORKSPACE', 'That is not one of your workspaces.')
  return found
}

/**
 * The folder of a plugin in a workspace.
 * @param workspace - the workspace's canonical folder.
 * @param name - a package name that passed the scaffold's checks.
 * @returns `<workspace>/plugins/<name without its scope>`.
 */
export function pluginFolder(workspace: string, name: string): string {
  return join(workspace, PLUGINS_DIRECTORY, bareName(name))
}

/**
 * Check that a workspace's `plugins` entry is a real folder directly inside the workspace, making it when it is absent.
 * @param workspace - the workspace's canonical folder.
 * @param make - whether to make the folder when it is absent.
 * @returns whether the folder exists.
 * @throws {CreateRefusal} `409` when `plugins` is a link, a file, or resolves outside the workspace.
 */
async function checkPluginsDirectory(workspace: string, make: boolean): Promise<boolean> {
  const directory = join(workspace, PLUGINS_DIRECTORY)
  let status = await lstat(directory).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new CreateRefusal(409, 'CANNOT_CREATE', `${directory} cannot be read, so no plugin is made there.`)
  })
  if (status === undefined) {
    if (!make) return false
    await mkdir(directory)
    status = await lstat(directory)
  }
  if (status.isSymbolicLink() || !status.isDirectory() || await realpath(directory) !== join(await realpath(workspace), PLUGINS_DIRECTORY)) {
    throw new CreateRefusal(409, 'CANNOT_CREATE', `${directory} is not a plain folder inside the workspace, so no plugin is made there. Remove it or rename it, then try again.`)
  }
  return true
}

/**
 * Create a plugin's folder and files in a workspace.
 * @param workspaces - the workspaces the registry holds, the default first.
 * @param body - `name`, `kind` and optionally `workspace`.
 * @param target - the release and installation the plugin targets.
 * @returns the workspace, the folder and the files written.
 * @throws {CreateRefusal} `400` for a refused name or kind, `404` for an unknown workspace, `409` for a folder that
 *   cannot take the files.
 */
export async function createAction(workspaces: readonly WorkspaceChoice[], body: { readonly name: unknown, readonly kind: unknown, readonly workspace?: unknown }, target: ScaffoldTarget): Promise<CreatedView> {
  if (typeof body.name !== 'string' || typeof body.kind !== 'string') throw new CreateRefusal(400, 'BAD_REQUEST', 'Name the plugin and choose its kind.')
  try {
    const kind = checkKind(body.kind)
    checkName(body.name)
    const workspace = chooseWorkspace(workspaces, body.workspace)
    const folder = pluginFolder(workspace.path, body.name)
    // The name's checks come before any folder is made, so a refused name leaves nothing behind.
    await checkPluginsDirectory(workspace.path, true)
    const files = await createPlugin({ name: body.name, kind, folder, running: target.running, installation: target.installation, chooseFolderVia: ', or choose another name' })
    return { kind: 'created', plugin: body.name, pluginKind: kind, workspace: workspace.id, folder, files }
  } catch (error) {
    if (error instanceof ScaffoldError) throw new CreateRefusal(error.kind === 'usage' ? 400 : 409, error.kind === 'usage' ? 'BAD_REQUEST' : 'CANNOT_CREATE', error.message)
    throw error
  }
}

/**
 * Read the name of a plugin the studio created, which must be a folder directly below a workspace's `plugins` that
 * holds a package of that name.
 * @param workspaces - the workspaces the registry holds.
 * @param body - the workspace's id and the package name the person was shown.
 * @returns the folder.
 * @throws {CreateRefusal} `404` when no such plugin was created, `400` for a name that is not a package name.
 */
async function createdFolder(workspaces: readonly WorkspaceChoice[], body: { readonly workspace?: unknown, readonly name: unknown }): Promise<string> {
  if (body.workspace === undefined) throw new CreateRefusal(400, 'BAD_REQUEST', 'Name the workspace the plugin is in.')
  const workspace = chooseWorkspace(workspaces, body.workspace)
  const name = body.name
  try {
    if (typeof name !== 'string') throw new ScaffoldError('usage', 'Name the plugin by its package name.')
    checkName(name)
  } catch (error) {
    if (error instanceof ScaffoldError) throw new CreateRefusal(400, 'BAD_REQUEST', error.message)
    throw error
  }
  const folder = pluginFolder(workspace.path, name)
  try {
    if (!await checkPluginsDirectory(workspace.path, false)) throw new Error('no plugins folder')
    if (!(await lstat(folder)).isDirectory()) throw new Error('not a directory')
    const manifest = JSON.parse(await readFile(join(folder, 'package.json'), 'utf8')) as { readonly name?: unknown }
    if (manifest.name !== name) throw new Error('another package')
  } catch (_absent) {
    // Any failure to read the folder means the studio did not create this plugin there.
    throw new CreateRefusal(404, 'NOT_CREATED_HERE', `${name} was not created in that workspace's plugins folder.`)
  }
  return folder
}

/**
 * Record the install of a created plugin from its folder as a change that waits for review.
 * @param ctx - the profile.
 * @param workspaces - the workspaces the registry holds.
 * @param body - `workspace` and `name`.
 * @param toView - the entry as an answer carries it.
 * @returns the pending entry.
 * @throws {CreateRefusal} for a plugin the studio did not create.
 */
export async function requestAction(ctx: ChangesContext, workspaces: readonly WorkspaceChoice[], body: { readonly workspace?: unknown, readonly name: unknown }, toView: (entry: ChangeEntry) => RequestedView['entry']): Promise<RequestedView> {
  const folder = await createdFolder(workspaces, body)
  return { kind: 'requested', entry: toView(await recordPluginRequest(ctx, { action: 'install', spec: `link:${folder}` })) }
}

/**
 * Show a created plugin's folder in the file manager.
 * @param workspaces - the workspaces the registry holds.
 * @param body - `workspace` and `name`.
 * @param open - shows a folder in the computer's file manager.
 * @returns the folder.
 * @throws {CreateRefusal} for a plugin the studio did not create.
 */
export async function revealAction(workspaces: readonly WorkspaceChoice[], body: { readonly workspace?: unknown, readonly name: unknown }, open: (folder: string) => void): Promise<RevealedView> {
  const folder = await createdFolder(workspaces, body)
  open(folder)
  return { kind: 'revealed', folder }
}
