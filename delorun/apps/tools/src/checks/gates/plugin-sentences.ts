/**
 * Plugin-sentences gate: every package the product site's plugin browser lists, a row of the default or headless bundle
 * patches or an optional pack, has a non-empty `meta.title` and `meta.description` in its `locale/en.json`. The studio's
 * Plugins screen and the site show those words, and the package's `exports` must let the plugin manager resolve the locale file. Run from anywhere inside the repository:
 * `node_modules/.bin/tsx delorun/apps/tools/src/checks/gates/plugin-sentences.ts`. It prints one line per package
 * without them and exits 1.
 *
 * @module @delorun/tools/checks/gates/plugin-sentences
 */
import { pathToFileURL } from 'node:url'
import { readPluginList, type PluginSources } from '../../../../website/src/plugin-browser/list-plugins.ts'
import { repositoryRoot } from '../../git.ts'

/** The list reads files only for their count, which this gate ignores. */
const NO_FILES: PluginSources = { countFiles: () => 0 }

/**
 * The listed packages that lack a title or a sentence.
 * @param root - the repository root.
 * @returns the package names, in listing order; empty when every listed package has both.
 */
export function unwordedPackages(root: string): string[] {
  return readPluginList(root, NO_FILES).unworded
}

/**
 * The listed packages whose `exports` do not let the plugin manager resolve `locale/en.json`.
 * @param root - the repository root.
 * @returns the package names; empty when every listed package exports its locale files.
 */
export function unexportedPackages(root: string): string[] {
  return readPluginList(root, NO_FILES).unexported
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const missing = unwordedPackages(repositoryRoot(process.cwd()))
  for (const name of missing) console.error(`gates:plugin-sentences: ${name} is listed on the site but its locale/en.json lacks meta.title or meta.description`)
  const unexported = unexportedPackages(repositoryRoot(process.cwd()))
  for (const name of unexported) console.error(`gates:plugin-sentences: ${name} is listed on the site but its package.json exports do not include "./locale/*.json", so the studio cannot read its words`)
  process.exitCode = missing.length === 0 && unexported.length === 0 ? 0 : 1
}
