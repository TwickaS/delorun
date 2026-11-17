/**
 * Whether every package of a pack loads from the review copy Changes makes of it. A pack is added through Changes,
 * which copies the installed pack for review and loads the copy, and that copy keeps only what Changes' scan reaches:
 * from a folder whose `node_modules` holds installed packages, the packages each included package's `package.json`
 * declares, found where Node finds them, and the links among them into the running release's `app/node_modules`.
 *
 * The check runs Changes' own scan (`scanFolder` with the Delorun home, the options `storeFolder` uses when a pack is
 * added) on the pack as the runtime store installs it (`installPack`), so it holds exactly what a copy would. Each
 * package in the copy must then resolve what it needs (`packNeeds`) inside the copy, as Node resolves it from the copy's
 * real paths: through the copy's files and its links into the runtime. A package linked into the runtime resolves its
 * own needs from its real path there and is not checked again. A link the copy would keep to anywhere other than the
 * runtime is a problem too, since what it names is not part of the release.
 *
 * When that check passes and the variant is for the platform the check runs on, Changes stores and materializes the
 * copy (`storeFolder`, `materialize`) and a separate Node process imports, from the copy's package directory, every
 * plugin module the pack's bundle patch names ({@link pluginModules}), so a conditional export, a subpath or code the
 * static check does not read cannot hide a failure. Another platform's variant may hold native files this computer
 * cannot load, so it gets the static check only.
 *
 * @module @delorun/release/closure/review-copy
 */
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PackEntry, PackExternal, RuntimePlatform } from '@delorun/contract-release-manifest'
import { materialize, scanFolder, storeFolder } from '@delorun/changes'
import { installPack, parseRuntimeVersion, StorePaths } from '@delorun/runtime-store'
import { describeUnresolved, packNeeds, resolvesInPack, type PackLayout } from './pack-imports.ts'

/**
 * The problems of the review copy of an installed pack.
 * @param folder - the installed pack's package directory, `packs/<release>/<name>/package` in `home`.
 * @param home - a Delorun home whose `runtimes/current` names the release whose `app/node_modules` the pack's peers link to.
 * @returns one line per need the copy cannot meet and per link it keeps out of the release; empty when every package of
 * the copy loads.
 */
export async function reviewCopyProblems(folder: string, home: string): Promise<string[]> {
  const scanned = await scanFolder(folder, { home })
  const sources = new Map(scanned.files.map(file => [file.entry.path, file.source]))
  const linked = new Set<string>()
  const problems: string[] = []
  for (const entry of scanned.entries) {
    if (entry.type !== 'link') continue
    if (entry.runtime === true || !entry.outside) linked.add(entry.path)
    else problems.push(`the review copy links ${entry.path} to ${entry.target}, outside the release`)
  }
  const layout: PackLayout = { paths: new Set(sources.keys()), read: path => readFile(sources.get(path)!, 'utf8'), peers: new Set(), external: new Set(), linked }
  for (const need of await packNeeds(layout)) {
    if (!resolvesInPack(need, layout)) problems.push(`${describeUnresolved(need)}, which the review copy does not hold`)
  }
  return problems
}

/** One built pack variant to check, and the runtime it installs against. */
export interface ReviewCopyRequest {
  /** The pack's entry; its variant for `platform` (or `any`) is the one installed. */
  readonly entry: PackEntry
  /** The platform checked. */
  readonly platform: RuntimePlatform
  /** The variant's archive bytes. */
  readonly archive: Uint8Array
  /** The release the pack belongs to, a runtime version. */
  readonly release: string
  /** The release's `app/node_modules` for `platform`: the staged closure at the cut, an extracted runtime in a report. */
  readonly runtimeNodeModules: string
  /** The bytes of an external package the variant pins. */
  readonly fetchExternal: (pin: PackExternal) => Promise<Uint8Array>
  /** A directory to make the temporary Delorun home in; the home is removed before this returns. */
  readonly scratch: string
}

/**
 * Install one pack variant into a temporary Delorun home whose running release's `app/node_modules` links to
 * `runtimeNodeModules`, with the runtime store's own installer, and check its review copy ({@link reviewCopyProblems});
 * for this computer's own platform, also import the bundle patch's plugin modules from the materialized copy.
 * @param request - the variant and the runtime.
 * @returns the review copy's problems; empty when every package of the copy loads.
 * @throws Error when `release` is not a runtime version; PackRefusal when the installer refuses the variant.
 */
export async function installedReviewCopyProblems(request: ReviewCopyRequest): Promise<string[]> {
  const release = parseRuntimeVersion(request.release)
  if (release === undefined) throw new Error(`${request.release} is not a runtime version`)
  const home = await mkdtemp(join(request.scratch, 'review-copy-home-'))
  try {
    const paths = new StorePaths(home, request.platform)
    await mkdir(join(paths.version(release), 'app'), { recursive: true, mode: 0o700 })
    await symlink(resolve(request.runtimeNodeModules), paths.runtimeNodeModules(release), 'dir')
    await writeFile(paths.pointer('current'), `${release}\n`, { mode: 0o600 })
    const installed = await installPack({ paths, release, entry: request.entry, platform: request.platform, archive: request.archive, fetchExternal: request.fetchExternal })
    const problems = await reviewCopyProblems(installed, home)
    if (problems.length > 0 || request.platform !== `${process.platform}-${process.arch}`) return problems
    const { version } = await storeFolder(home, installed)
    const copy = join(home, 'review-copy')
    await materialize(home, version, copy)
    return await importProblems(copy, await pluginModules(copy))
  } finally {
    await removeSealed(home)
  }
}

/** Plugin modules a patch row cannot name: Cordis' own, such as `cordis:group`. */
const CORDIS_PREFIX = 'cordis:'

/**
 * The plugin modules a pack's bundle patch (`dsh.bundle.patch` in its `package.json`) inserts, a group's children
 * included, disabled rows too, since a person can turn one on.
 * @param directory - the pack's package directory.
 * @returns the module specifiers in patch order without repeats; empty for a package without a bundle patch.
 * @throws Error when the patch is not a list of entries whose inserted rows each name a module.
 */
export async function pluginModules(directory: string): Promise<string[]> {
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
  const patch = manifest.dsh?.bundle?.patch
  if (patch === undefined) return []
  // `!!js` values stay unevaluated text; only the rows' names are read.
  const parsed: unknown = parseYaml(await readFile(join(directory, patch), 'utf8'), { logLevel: 'error' })
  if (!Array.isArray(parsed)) throw new Error(`${patch} is not a list of patch entries`)
  const names = new Set<string>()
  const rows = (list: unknown): void => {
    if (!Array.isArray(list)) throw new Error(`${patch} inserts rows that are not a list`)
    for (const row of list as unknown[]) {
      if (typeof row !== 'object' || row === null) throw new Error(`${patch} inserts a row that is not a mapping`)
      const { name, group, config } = row as { name?: unknown, group?: unknown, config?: unknown }
      if (group === true || (typeof name === 'string' && name.startsWith(CORDIS_PREFIX))) {
        if (config !== undefined) rows(config)
      } else if (typeof name === 'string') {
        names.add(name)
      } else {
        throw new Error(`${patch} inserts a row that names no plugin module`)
      }
    }
  }
  for (const entry of parsed as unknown[]) {
    const inserted = typeof entry === 'object' && entry !== null ? (entry as { insert?: unknown }).insert : undefined
    if (inserted !== undefined) rows(inserted)
  }
  return [...names]
}

/** How long the import of a pack's plugin modules may take before it counts as failed. */
const IMPORT_TIMEOUT_MS = 120_000

/** The child process's script: import each module named in `argv[1]` and print the failures as JSON. */
const IMPORT_SCRIPT = [
  'const failures = []',
  'for (const name of JSON.parse(process.argv[1])) {',
  '  try { await import(name) } catch (error) { failures.push(`${name}: ${String(error instanceof Error ? error.message : error).split("\\n")[0]}`) }',
  '}',
  'process.stdout.write(JSON.stringify(failures))',
  // A plugin module may hold a handle open at import; the result is written, so the process ends here.
  'process.exit(0)',
].join('\n')

/**
 * Import modules from a directory in a separate Node process, as the loader resolves a bundle's rows from the bundle's
 * package: a bare specifier resolves from the directory, the package's own name through its `exports`.
 * @param directory - the materialized copy's package directory.
 * @param names - the module specifiers.
 * @returns one line per module that fails to import, or one line when the process fails; empty when all import.
 */
async function importProblems(directory: string, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return []
  const env = { ...process.env }
  // A loader hook of the building process, such as tsx, must not change how the copy resolves.
  delete env['NODE_OPTIONS']
  return await new Promise((resolveProblems) => {
    execFile(process.execPath, ['--input-type=module', '-e', IMPORT_SCRIPT, JSON.stringify(names)], { cwd: directory, env, timeout: IMPORT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        resolveProblems([`importing the plugin modules from the review copy failed: ${error.message.split('\n')[0]}${stderr === '' ? '' : `: ${stderr.trim().split('\n').slice(-1)[0]}`}`])
        return
      }
      resolveProblems((JSON.parse(stdout) as string[]).map(line => `${line}, imported from the review copy`))
    })
  })
}

/** Remove a tree the installer sealed read-only: its directories become writable first; links are never followed. */
async function removeSealed(directory: string): Promise<void> {
  const unseal = async (path: string): Promise<void> => {
    if (!(await lstat(path)).isDirectory()) return
    await chmod(path, 0o700)
    for (const name of await readdir(path)) await unseal(join(path, name))
  }
  await unseal(directory)
  await rm(directory, { recursive: true, force: true })
}
