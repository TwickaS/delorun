/**
 * Delorun's workspaces as the main chat names them: the workspace registry's
 * workspaces inside the root, each by its folder, its path relative to the
 * root.
 *
 * @module @delorun/plugin-main-chat/folders
 */
import { posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Workspace } from '@deepseek-ai/dsh-workspace'

/** The name a chat outside every workspace is listed under. */
export const OUTSIDE = 'none'

/** Delorun's workspaces and their folders, read from the registry at each call. */
export interface Folders {
  /** The registry's workspaces inside the root. */
  readonly workspaces: () => Workspace[]
  /** A workspace's folder. */
  readonly folderName: (workspace: Workspace) => string
  /** The folder of the innermost workspace holding a directory, or {@link OUTSIDE}. */
  readonly folderOf: (cwd: string | undefined) => string
}

/**
 * Delorun's workspaces under a root. A cell made before the bundle placed the first workspace directly under the root has
 * it two levels down, in `deepseek-harness/`, so a folder may hold a slash.
 * @param ctx - a context with the workspace registry.
 * @param root - the directory that holds every workspace.
 * @returns the readers.
 */
export function folders(ctx: Context, root: string): Folders {
  const workspaces = (): Workspace[] => ctx.workspaceRegistry.list().filter(workspace => workspace.path.startsWith(`${root}/`))
  const folderName = (workspace: Workspace): string => posix.relative(root, workspace.path)
  const folderOf = (cwd: string | undefined): string => {
    // The innermost workspace holding the directory owns it.
    const owners = cwd === undefined ? [] : workspaces().filter(workspace => cwd === workspace.path || cwd.startsWith(`${workspace.path}/`))
    const owner = owners.toSorted((a, b) => b.path.length - a.path.length)[0]
    return owner === undefined ? OUTSIDE : folderName(owner)
  }
  return { workspaces, folderName, folderOf }
}
