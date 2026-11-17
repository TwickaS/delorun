/**
 * The plugin list of the product site's plugin browser, read from the repository: the rows of the three bundle patches
 * (`bundle-local`, `bundle-studio`, `bundle-headless`) and the optional packs. A package no profile row and no pack names
 * is left out, whatever its directory is called. The title and sentence of each entry come from the package's
 * `locale/en.json` `meta`, the words the studio's Plugins screen shows.
 *
 * @module @delorun/website/plugin-browser/list-plugins
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import yaml from 'js-yaml'

/** Where a plugin stands in a fresh install, in the words the browser shows. */
export type Standing = 'on' | 'off' | 'headless' | 'pack'

/** One plugin of the browser. */
export interface PluginEntry {
  /** The package name, such as `@delorun/plugin-theme`. */
  readonly name: string
  /** The `meta.title` of the package's `locale/en.json`; empty when missing. */
  readonly title: string
  /** The `meta.description` of the package's `locale/en.json`; empty when missing. */
  readonly sentence: string
  /** The package's `delorun.state`. */
  readonly state: 'shipped' | 'experimental'
  /** Where the plugin stands in a fresh install. */
  readonly standing: Standing
  /** What a pack needs from the person's computer, as one phrase per need; empty for anything else. */
  readonly requires: readonly string[]
  /** The tracked files under the package's folder. */
  readonly files: number
  /** The package folder from the repository root, such as `delorun/packages/plugin-theme`. */
  readonly folder: string
}

/** The patches whose rows make up a default install, in the order their entries are listed. */
const PATCH_PACKAGES = [
  { dir: 'bundle-local', headless: false },
  { dir: 'bundle-studio', headless: false },
  { dir: 'bundle-headless', headless: true },
] as const

const PACKAGES_DIR = 'delorun/packages'

/** The `!!js` tag of Cordis patch files; a row's `disabled` must not use it. */
const JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown) => typeof data === 'string',
  construct: (data: string) => ({ jsExpression: data }),
})
const PATCH_SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION])

/** A plugin row a patch inserts. */
export interface PatchRow {
  readonly id: string
  /** The package name with any subpath removed. */
  readonly packageName: string
  readonly disabled: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The `@delorun/*` rows a bundle patch inserts.
 * @param text - the patch file's text.
 * @param source - the patch's path, for the error message.
 * @returns the rows in patch order; a row naming a subpath of a package names the package.
 * @throws when `disabled` is neither `true` nor `false`, because the list cannot say whether the row loads.
 */
export function patchRows(text: string, source: string): PatchRow[] {
  const document: unknown = yaml.load(text, { schema: PATCH_SCHEMA })
  if (!Array.isArray(document)) return []
  const rows: PatchRow[] = []
  for (const item of document) {
    if (!isRecord(item) || !Array.isArray(item['insert'])) continue
    for (const row of item['insert']) {
      if (!isRecord(row) || typeof row['name'] !== 'string' || typeof row['id'] !== 'string') continue
      if (!row['name'].startsWith('@delorun/')) continue
      const disabled = row['disabled']
      if (disabled !== undefined && typeof disabled !== 'boolean') throw new Error(`${source}: the row "${row['id']}" has a "disabled" that is not a literal true or false`)
      const [scope, bare] = row['name'].split('/')
      rows.push({ id: row['id'], packageName: `${scope}/${bare}`, disabled: disabled === true })
    }
  }
  return rows
}

/** What a pack needs from the computer, as the bundle's `package.json` declares it. */
export interface Need {
  readonly kind: string
  readonly names?: readonly string[]
  readonly name?: string
  readonly os?: readonly string[]
  readonly browser?: string
}

const OS_NAMES: Readonly<Record<string, string>> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' }

function joinWords(words: readonly string[]): string {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`
}

/**
 * One need in the words a visitor reads.
 * @param need - a need from the pack's `delorun.requires`.
 * @returns a short phrase such as `typescript-language-server installed`.
 */
export function needPhrase(need: Need): string {
  switch (need.kind) {
    case 'program':
      return `${joinWords(need.names ?? [])} installed`
    case 'env':
      return `the ${need.name ?? ''} setting`
    case 'platform':
      return `${joinWords((need.os ?? []).map((os) => OS_NAMES[os] ?? os))} as the operating system`
    case 'playwright-browser':
      return `a one-off ${need.browser ?? ''} download`
    default:
      throw new Error(`a pack declares a need of the unknown kind "${need.kind}"`)
  }
}

interface Manifest {
  readonly name: string
  readonly delorun?: { readonly state?: string; readonly pack?: boolean; readonly requires?: Record<string, { readonly needs?: readonly Need[] }> }
}

/** The file system the list reads, replaceable in a test. */
export interface PluginSources {
  /** The tracked files under a repository-relative folder. */
  countFiles(folder: string): number
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function manifestsByName(root: string): Map<string, { manifest: Manifest; folder: string }> {
  const found = new Map<string, { manifest: Manifest; folder: string }>()
  for (const entry of readdirSync(join(root, PACKAGES_DIR), { withFileTypes: true })) {
    const path = join(root, PACKAGES_DIR, entry.name, 'package.json')
    if (!entry.isDirectory() || !existsSync(path)) continue
    const manifest = readJson(path) as Manifest
    found.set(manifest.name, { manifest, folder: `${PACKAGES_DIR}/${entry.name}` })
  }
  return found
}

/**
 * Drops a need that offers programs as alternatives when each of them is also a need of its own in the same list, which
 * would say the same thing twice.
 * @param needs - a pack's needs, from all its rows.
 * @returns the needs without such alternatives.
 */
function withoutCoveredAlternatives(needs: readonly Need[]): Need[] {
  const single = new Set(needs.filter((need) => need.kind === 'program' && need.names?.length === 1).map((need) => need.names![0]))
  return needs.filter((need) => !(need.kind === 'program' && (need.names?.length ?? 0) > 1 && need.names!.every((name) => single.has(name))))
}

function standingOrder(standing: Standing): number {
  return ['on', 'off', 'headless', 'pack'].indexOf(standing)
}

/**
 * The plugins a default install holds and the optional packs, in the order the browser lists them: on, installed and
 * off, headless only, then packs.
 * @param root - the repository root.
 * @param sources - how files are counted.
 * @returns the entries, and the packages named without a title or a sentence.
 * @throws when a patch row names a package that is not in `delorun/packages`.
 */
export function readPluginList(root: string, sources: PluginSources): { plugins: PluginEntry[]; unworded: string[] } {
  const packages = manifestsByName(root)
  const standings = new Map<string, Standing>()
  for (const { dir, headless } of PATCH_PACKAGES) {
    const patch = `${PACKAGES_DIR}/${dir}/cordis.patch.yml`
    for (const row of patchRows(readFileSync(join(root, patch), 'utf8'), patch)) {
      if (!packages.has(row.packageName)) throw new Error(`${patch}: the row "${row.id}" names ${row.packageName}, which is not a package under ${PACKAGES_DIR}`)
      const earlier = standings.get(row.packageName)
      // A package with several rows is on when any row is on.
      if (earlier === undefined || (earlier === 'off' && !row.disabled)) standings.set(row.packageName, headless ? 'headless' : row.disabled ? 'off' : 'on')
    }
  }
  for (const [name, { manifest }] of packages) if (manifest.delorun?.pack === true) standings.set(name, 'pack')
  const plugins: PluginEntry[] = []
  const unworded: string[] = []
  for (const [name, standing] of standings) {
    const { manifest, folder } = packages.get(name)!
    const state = manifest.delorun?.state
    if (state !== 'shipped' && state !== 'experimental') throw new Error(`${name} is listed but its "delorun.state" is ${String(state)}`)
    const localePath = join(root, folder, 'locale', 'en.json')
    const meta = existsSync(localePath) ? (readJson(localePath) as { meta?: { title?: string; description?: string } }).meta : undefined
    const title = meta?.title ?? ''
    const sentence = meta?.description ?? ''
    if (title === '' || sentence === '') unworded.push(name)
    const needs = Object.values(manifest.delorun?.requires ?? {}).flatMap((row) => row.needs ?? [])
    const requires = [...new Set(withoutCoveredAlternatives(needs).map(needPhrase))]
    plugins.push({ name, title, sentence, state, standing, requires: standing === 'pack' ? requires : [], files: sources.countFiles(folder), folder })
  }
  plugins.sort((a, b) => standingOrder(a.standing) - standingOrder(b.standing))
  return { plugins, unworded }
}
