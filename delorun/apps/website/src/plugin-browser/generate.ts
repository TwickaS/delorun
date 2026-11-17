/**
 * Writes `plugins.generated.json`, the plugin browser's data: the plugin list and the scaffold's file paths. Run from
 * `delorun/apps/website` with `node src/plugin-browser/generate.ts` (`--check` compares instead of writing).
 *
 * @module @delorun/website/plugin-browser/generate
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readPluginList, type PluginEntry, type PluginSources } from './list-plugins.ts'
import { scaffoldPaths, type ScaffoldPaths } from './scaffold-files.ts'

/** The data file's content. */
export interface PluginBrowserData {
  readonly plugins: readonly PluginEntry[]
  readonly scaffold: ScaffoldPaths
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '../../../../..')
/** The data file next to this module. */
export const DATA_PATH = join(HERE, 'plugins.generated.json')

/** Counts the files git tracks, so the count is the same on every machine; regenerate the data after committing a file. */
export const gitSources: PluginSources = {
  countFiles: (folder) => execFileSync('git', ['ls-files', '--', folder], { cwd: ROOT, encoding: 'utf8', timeout: 20_000 }).split('\n').filter((line) => line !== '').length,
}

/**
 * Reads the repository into the data file's content.
 * @param root - the repository root.
 * @param sources - how files are counted.
 * @returns the data.
 * @throws when a listed package lacks its title or sentence.
 */
export function buildData(root: string, sources: PluginSources): PluginBrowserData {
  const { plugins, unworded } = readPluginList(root, sources)
  if (unworded.length > 0) throw new Error(`these listed packages lack locale/en.json meta.title or meta.description: ${unworded.join(', ')}`)
  return { plugins, scaffold: scaffoldPaths() }
}

/**
 * The data file's text.
 * @param data - the data.
 * @returns the JSON with a trailing newline.
 */
export function dataText(data: PluginBrowserData): string {
  return `${JSON.stringify(data, null, 2)}\n`
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = dataText(buildData(ROOT, gitSources))
  if (process.argv.includes('--check')) {
    if (readFileSync(DATA_PATH, 'utf8') !== text) {
      console.error('plugin-browser: plugins.generated.json is stale; run `node src/plugin-browser/generate.ts` in delorun/apps/website')
      process.exitCode = 1
    }
  } else {
    writeFileSync(DATA_PATH, text)
  }
}
