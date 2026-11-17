/**
 * The files `delorun plugin new` writes for each kind of plugin, from the scaffold's own function. Only the paths are
 * kept: they do not depend on the name or the versions used here.
 *
 * @module @delorun/website/plugin-browser/scaffold-files
 */
import { PLUGIN_KINDS, scaffoldFiles, type PluginKind } from '../../../../packages/plugin-scaffold/src/scaffold.ts'

/** The paths one kind writes, `package.json` first, relative to the new folder. */
export type ScaffoldPaths = Readonly<Record<PluginKind, readonly string[]>>

/** A name and versions that stand in for the person's; they change file contents, not file paths. */
const SAMPLE = { name: '@you/my-plugin', dsh: '0.0.0', delorun: '0.0.0', cordis: '0.0.0' } as const

/**
 * The paths of the files each kind of plugin gets.
 * @returns the paths per kind, in the order `plugin new` writes them.
 */
export function scaffoldPaths(): ScaffoldPaths {
  const paths = {} as Record<PluginKind, readonly string[]>
  for (const kind of PLUGIN_KINDS) paths[kind] = scaffoldFiles({ ...SAMPLE, kind }).map((file) => file.path)
  return paths
}
