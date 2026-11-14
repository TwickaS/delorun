/**
 * How the permission store names a workspace. A workspace is a directory, and
 * the store keys it by that directory's canonical path — the same canon
 * `@deepseek-ai/dsh-workspace` gives a workspace record, so a trailing slash,
 * a `..` segment or a symbolic link reaches the entry of the directory it
 * names, not a second entry of its own spelling.
 *
 * The key is computed synchronously: the mode-switch guard answers before a
 * `sandbox/mode` event is appended, and a synchronous verdict cannot await a
 * filesystem call. A directory that has gone away keeps its recorded spelling,
 * resolved absolute, so a workspace the person moved away and back again keeps
 * the permission it had. That fallback keeps the spelling's case: on a file system that ignores case, a missing
 * folder spelled in another case gets a key of its own until the folder exists again, and no test host here has such
 * a file system, so no case is folded.
 *
 * Free of Cordis, so the key is testable without a mounted plugin.
 *
 * @module @delorun/plugin-permission-defaults/workspace
 */
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

/** The key the store uses for a session that names no directory: no workspace, so no per-workspace permission. */
export const NO_WORKSPACE = '' as const

/**
 * The store's key for one workspace directory.
 * @param cwd - the directory as a session header or a caller spells it. A blank
 *   value names no workspace.
 * @returns the canonical absolute path, or {@link NO_WORKSPACE} for a blank value.
 */
export function workspaceKey(cwd: string): string {
  if (cwd.trim() === '') return NO_WORKSPACE
  try {
    return realpathSync.native(cwd)
  } catch {
    // The directory is gone or unreadable: keep the spelling the caller gave,
    // resolved absolute against nothing (a relative path resolves against the
    // process working directory, which is what a session header never holds).
    return resolve(cwd)
  }
}
