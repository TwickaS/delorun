/**
 * The places a chat can write, as the add-time consent warns about them: a workspace of the profile, and the
 * temporary directories every confined command may write (`/tmp` and the platform's temporary directory). A review
 * names the working directory and the pinned files of a start that lie inside one of them, because a chat can change
 * what such a start runs, or what its files load, without a review asking again at the next start. A chat with full
 * access writes outside these places as well; they are not detected.
 *
 * @module @delo/plugin-mcp-consent/writable
 */
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, relative, sep } from 'node:path'

/** The temporary directories a confined command may write, before they are resolved. */
export const TEMPORARY_DIRECTORIES: readonly string[] = ['/tmp', tmpdir()]

/**
 * Whether a canonical path is a directory or lies beneath it, compared by path segment.
 * @param path - the canonical path.
 * @param root - the canonical directory.
 * @returns true when the path is the directory or inside it.
 */
function within(path: string, root: string): boolean {
  const rest = relative(root, path)
  return rest === '' || (rest !== '..' && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
}

/**
 * The canonical places a chat can write.
 * @param workspaces - the canonical paths of the profile's workspaces.
 * @param temporary - the temporary directories; one that does not resolve, such as `/tmp` on Windows, is left out.
 * @returns the places.
 */
export async function chatWritableRoots(workspaces: readonly string[], temporary: readonly string[] = TEMPORARY_DIRECTORIES): Promise<readonly string[]> {
  const resolved = await Promise.allSettled(temporary.map(directory => realpath(directory)))
  return [...new Set([...workspaces, ...resolved.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []))])]
}

/**
 * The paths that lie inside a place a chat can write.
 * @param paths - canonical paths, such as a start's working directory and its pinned files.
 * @param roots - the places, from {@link chatWritableRoots}.
 * @returns the paths inside one of them, in order and without repeats.
 */
export function writableByChats(paths: readonly string[], roots: readonly string[]): readonly string[] {
  return [...new Set(paths)].filter(path => roots.some(root => within(path, root)))
}
