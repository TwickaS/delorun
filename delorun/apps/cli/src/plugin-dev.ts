/**
 * `delorun plugin dev <folder> [--profile <name>]`: the plugin author's loop. It links the folder into the CLI profile,
 * or reuses the link that is there, and keeps the running studio loading the folder's current code until the person
 * stops it with Ctrl+C.
 *
 * - **Link.** A profile whose `package.json` already depends on the folder's package through `link:` to the same
 *   folder is reused; otherwise the command runs `delorun plugin add link:<folder>` ([upstream](./upstream.ts)), which
 *   installs the package and adds its bundle to the profile's bundle list. A dependency of that name from anywhere else
 *   is refused, as are the `@deepseek-ai/` and `@delorun/` scopes and every name the installation ships, whose shipped
 *   package loads in place of a profile install of the same name.
 * - **Reload.** Upstream's HMR row (`hmr` of `@deepseek-ai/dsh-base`) watches no module root (`root: []`). While the
 *   command runs, the profile's own `cordis.patch.yml` carries one more patch, marked with a comment, that sets the
 *   row's `root` to the folders `plugin dev` sessions watch; HMR recomposes the running Host when the profile's patch
 *   changes, and then replaces the folder's modules whenever a loaded file under it changes. The studio's client HMR
 *   swaps a browser half whenever its `lib/client.js` changes, with no setting. Leaving the command removes the folder
 *   from the patch, and the patch itself when no session is left. A profile patch that already sets the `hmr` row is
 *   refused, so the person's own setting is never replaced.
 * - **Build.** A package with a `build` script is built once at the start and again after each settled change under
 *   its `src/`, one build at a time, with the pnpm `delorun plugin` runs; a failed build leaves the last good build
 *   loaded. A package without one is loaded from its files as they are.
 *
 * Changes to the bundle's `cordis.patch.yml` or `package.json` load at the next start. The command registers as a shared
 * user of the home's stores for its whole run, so an update or a restore waits until it ends.
 *
 * @module @delorun/cli/plugin-dev
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { HOME_STATUS_TIMEOUT_MS } from '@delorun/contract-home-layout'
import { queryHomeStatus } from '@delorun/home-process'
import type { YAMLMap } from 'yaml'
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLSeq } from 'yaml'
import { parseCommandLine, prepareHome, type CommandContext, type CommandResult } from './command.ts'
import { CliError, EXIT } from './exit.ts'
import { useHomeShared } from './home-exclusion.ts'
import { shippedPackageManager } from './package-manager.ts'
import { readPluginManifest } from './plugin-check.ts'
import { installationShips, RESERVED_SCOPES, runningInstallation } from '@delorun/plugin-scaffold'
import { hasCliProfile, profileDirectory } from './profile.ts'
import { printable } from './terminal-text.ts'

/** The usage line. */
const USAGE = 'usage: delorun plugin dev <folder> [--profile <name>]'

/** The id of upstream's HMR row, which `@deepseek-ai/dsh-base` inserts with `root: []`. */
export const HMR_ROW = 'hmr'

/** The comment that marks the profile patch's entry `plugin dev` owns. */
export const DEV_MARKER = ' delorun plugin dev: the folders it watches; it removes this entry when it ends'

/** How long, in milliseconds, the folder stays quiet before a build runs. */
export const DEV_DEBOUNCE_MS = 300

/**
 * Whether a patch entry is the one `plugin dev` owns.
 * @param item - a top-level entry of the profile patch.
 * @returns true for a mapping with the HMR row's id and the marker comment.
 */
function isDevEntry(item: unknown): item is YAMLMap {
  return isMap(item) && item.get('id') === HMR_ROW && (item.commentBefore ?? '').includes(DEV_MARKER.trim())
}

/**
 * Whether a patch entry sets the HMR row and is not the one `plugin dev` owns.
 * @param item - a top-level entry of the profile patch.
 * @returns true for such an entry.
 */
function isOtherHmrEntry(item: unknown): boolean {
  return isMap(item) && item.get('id') === HMR_ROW && !isDevEntry(item)
}

/**
 * Parse the profile patch as a YAML document whose contents are a sequence.
 * @param text - the patch file's text.
 * @param path - the file, for the refusal.
 * @returns the document and its list of patches.
 * @throws {Error} when the text is not YAML or its contents are not a sequence.
 */
function patchList(text: string, path: string): { readonly document: Document, readonly list: YAMLSeq } {
  const parsed = parseDocument(text)
  // A file of comments alone holds no list yet; the comments stay above the one added.
  const document = parsed.contents === null && parsed.errors.length === 0 ? parseDocument(`${text}${text.endsWith('\n') || text === '' ? '' : '\n'}[]\n`) : parsed
  if (document.errors[0] !== undefined) throw new Error(`${path} is not YAML: ${document.errors[0].message}`)
  const list = document.contents
  if (!isSeq(list)) throw new Error(`${path} is not a YAML list of patches`)
  return { document, list }
}

/**
 * The folders the owned entry's `root` lists.
 * @param entry - the owned entry.
 * @returns the folders.
 */
function rootsOf(entry: YAMLMap): string[] {
  const root = entry.getIn(['config', 'root'])
  return isSeq(root) ? root.items.flatMap(item => isScalar(item) && typeof item.value === 'string' ? [item.value] : []) : []
}

/**
 * Add a folder to the HMR roots the profile patch's owned entry sets, adding the entry when there is none.
 * @param text - the profile patch's text.
 * @param folder - the folder's absolute path.
 * @param path - the file, for refusals.
 * @returns the new text; the same text when the folder is listed already.
 * @throws {Error} when another entry of the patch sets the HMR row, which `plugin dev` would replace, or when the patch
 *   is not a YAML list; `runPluginDev` reports it as its refusal.
 */
export function addDevRoot(text: string, folder: string, path: string): string {
  const { document, list } = patchList(text, path)
  if (list.items.some(isOtherHmrEntry)) throw new Error(`${path} already sets the ${HMR_ROW} row, so delorun plugin dev would replace your setting; remove that entry, or add ${folder} to its root yourself`)
  const owned = list.items.find(isDevEntry)
  if (owned !== undefined) {
    if (rootsOf(owned).includes(folder)) return text
    owned.setIn(['config', 'root'], document.createNode([...rootsOf(owned), folder]))
    return String(document)
  }
  const entry = document.createNode({ id: HMR_ROW, config: { root: [folder] } })
  entry.commentBefore = DEV_MARKER
  list.flow = false
  list.items.push(entry)
  return String(document)
}

/**
 * Remove a folder from the HMR roots the profile patch's owned entry sets, and the entry when no folder is left.
 * @param text - the profile patch's text.
 * @param folder - the folder's absolute path.
 * @param path - the file, for refusals.
 * @returns the new text; the same text when the folder is not listed.
 * @throws {Error} when the patch is not a YAML list.
 */
export function removeDevRoot(text: string, folder: string, path: string): string {
  const { document, list } = patchList(text, path)
  const owned = list.items.find(isDevEntry)
  if (owned === undefined || !rootsOf(owned).includes(folder)) return text
  const left = rootsOf(owned).filter(root => root !== folder)
  if (left.length > 0) owned.setIn(['config', 'root'], document.createNode(left))
  else list.items.splice(list.items.indexOf(owned), 1)
  return String(document)
}

/**
 * Change the profile patch under the profile's `package.json` file lock, the lock its package operations hold.
 * @param profileDir - the profile's directory.
 * @param change - the change of the text.
 * @returns whether the file changed.
 */
async function changeProfilePatch(profileDir: string, change: (text: string, path: string) => string): Promise<boolean> {
  const path = join(profileDir, PROFILE_PATCH_FILENAME)
  return withFileLock(join(profileDir, 'package.json'), async () => {
    const before = existsSync(path) ? readFileSync(path, 'utf8') : '[]\n'
    const after = change(before, path)
    if (after === before) return false
    await writeFileAtomic(path, after, { mode: 0o600 })
    return true
  }, { waitMs: 120_000 })
}

/** What the profile records for the package. */
export type LinkState =
  | { readonly kind: 'linked' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'other', readonly spec: string }

/**
 * Whether the profile already depends on the package through a link to the folder.
 * @param profileDir - the profile's directory.
 * @param name - the package's name.
 * @param folder - the folder's real path.
 * @returns `linked`, `absent`, or `other` with the recorded spec.
 */
export function linkState(profileDir: string, name: string, folder: string): LinkState {
  const manifest: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const dependencies = typeof manifest === 'object' && manifest !== null ? (manifest as { dependencies?: unknown }).dependencies : undefined
  const spec = typeof dependencies === 'object' && dependencies !== null ? (dependencies as Record<string, unknown>)[name] : undefined
  if (typeof spec !== 'string') return { kind: 'absent' }
  const linked = /^link:(.*)$/s.exec(spec)?.[1]
  if (linked !== undefined) {
    const target = resolve(profileDir, linked)
    if (existsSync(target) && realpathSync(target) === folder) return { kind: 'linked' }
  }
  return { kind: 'other', spec }
}

/**
 * Whether the profile's bundle list names the package.
 * @param profileDir - the profile's directory.
 * @param name - the package's name.
 * @returns true when its layer is on.
 */
function bundleListed(profileDir: string, name: string): boolean {
  const manifest: unknown = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
  const bundles = (manifest as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.includes(name)
}

/**
 * Whether a changed path, relative to the folder, is a source change that needs a build.
 * @param name - the path a watch event names, relative to the folder.
 * @returns true for a path under `src/`.
 */
export function isSourceChange(name: string | null): boolean {
  return name !== null && name.split(/[\\/]/)[0] === 'src'
}

/** A running watch. */
export interface DevWatch {
  /** Stop watching. */
  close(): void
}

/** What `plugin dev` calls outside this module; specs replace them. */
export interface DevDependencies {
  /**
   * Run `delorun plugin` with these arguments ([upstream](./upstream.ts)).
   * @param args - the arguments after `plugin`.
   * @returns pnpm's exit code, which the CLI's exit codes do not list.
   */
  readonly plugin: (args: readonly string[]) => Promise<number>
  /**
   * Run the folder's build script.
   * @param folder - the folder.
   * @returns whether the build succeeded.
   */
  readonly build: (folder: string) => Promise<boolean>
  /**
   * Watch the folder recursively.
   * @param folder - the folder.
   * @param onChange - called with each changed path, relative to the folder.
   * @returns the watch.
   */
  readonly watch: (folder: string, onChange: (name: string | null) => void) => DevWatch
  /**
   * Wait until the person stops the command.
   * @returns when Ctrl+C or a termination signal arrived.
   */
  readonly stopped: () => Promise<void>
  /**
   * The home process's process id, when one answers for the profile.
   * @param home - the Delorun home.
   * @param profile - the profile.
   * @returns its process id, or `undefined` when none answers.
   */
  readonly running: (home: string, profile: string) => Promise<number | undefined>
  /** How long changes settle before a build; {@link DEV_DEBOUNCE_MS} by default. */
  readonly debounceMs?: number
}

/**
 * Run a folder's `build` script with the pnpm `delorun plugin` runs, its output on this terminal.
 * @param folder - the folder.
 * @returns whether it exited 0.
 */
function runBuild(folder: string): Promise<boolean> {
  const shipped = shippedPackageManager()
  const command = shipped?.command ?? 'pnpm'
  const args = [...shipped?.args ?? [], 'run', 'build']
  return new Promise((done) => {
    const child = spawn(command, args, { cwd: folder, stdio: 'inherit', env: { ...process.env, ...shipped?.env }, shell: shipped === undefined && process.platform === 'win32' })
    child.once('error', () => { done(false) })
    child.once('exit', (code) => { done(code === 0) })
  })
}

/**
 * The dependencies of a real run.
 * @param context - the command's context, for `delorun plugin add`.
 * @param plugin - `delorun plugin`'s runner.
 * @returns the dependencies.
 */
export function realDevDependencies(context: CommandContext, plugin: (args: readonly string[], context: CommandContext) => Promise<number>): DevDependencies {
  return {
    plugin: args => plugin(args, context),
    build: runBuild,
    watch: (folder, onChange) => {
      const watcher = watch(folder, { recursive: true, persistent: false }, (_event, name) => { onChange(name) })
      watcher.on('error', (error) => { context.stderr(`delorun plugin dev: stopped watching ${printable(folder)}: ${printable(error.message)}\n`) })
      return { close: () => { watcher.close() } }
    },
    stopped: () => new Promise((done) => {
      // Signal listeners keep no process alive, and the watch is not persistent, so this timer holds the process until a stop.
      const alive = setInterval(() => undefined, 2 ** 30)
      const stop = (): void => {
        clearInterval(alive)
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        done()
      }
      process.on('SIGINT', stop)
      process.on('SIGTERM', stop)
    }),
    running: async (home, profile) => {
      try {
        const answer = await queryHomeStatus(home, profile, HOME_STATUS_TIMEOUT_MS)
        return 'pid' in answer && typeof answer.pid === 'number' ? answer.pid : undefined
      } catch (_notAnswering) {
        // No token file, no socket or no answer: no home process answers for the profile.
        return undefined
      }
    },
  }
}

/**
 * Read and check the folder's manifest.
 * @param folder - the folder's real path.
 * @returns the package's name and whether it has a build script.
 * @throws {CliError} when the manifest cannot be read, names no package, declares no bundle or uses a shipped scope.
 */
async function devPackage(folder: string): Promise<{ readonly name: string, readonly builds: boolean }> {
  const manifest = await readPluginManifest(folder, 'delorun plugin dev')
  const name = manifest['name']
  if (typeof name !== 'string' || name === '') throw new CliError(EXIT.failed, `delorun plugin dev: ${printable(join(folder, 'package.json'))} names no package; give it a "name"`)
  const dsh = manifest['dsh']
  if (typeof dsh !== 'object' || dsh === null || !('bundle' in dsh)) {
    throw new CliError(EXIT.failed, `delorun plugin dev: ${printable(name)} declares no "dsh": { "bundle": ... } in its package.json, so it would add no plugin to the profile; delorun plugin new <name> creates a package that does`)
  }
  if (RESERVED_SCOPES.some(scope => name.startsWith(scope)) || await installationShips(runningInstallation(), name)) {
    throw new CliError(EXIT.failed, `delorun plugin dev: ${printable(name)} is the name of a package Delorun ships, or uses a scope whose packages ship with Delorun, and a shipped package loads in place of a profile install of the same name; give your fork its own package name`)
  }
  const scripts = manifest['scripts']
  return { name, builds: typeof scripts === 'object' && scripts !== null && typeof (scripts as Record<string, unknown>)['build'] === 'string' }
}

/**
 * Run `delorun plugin dev`.
 * @param args - the arguments after `dev`.
 * @param context - the environment and output.
 * @param dependencies - the plugin command, the build, the watch, the stop and the home process probe.
 * @returns 0 when the person stopped it; 1 when linking failed or the profile patch could not be changed.
 * @throws {CliError} for a wrong command line, a missing CLI profile, a folder that is not a plugin package, a
 *   dependency of the same name from elsewhere, or a profile patch that sets the HMR row itself.
 */
export async function runPluginDev(args: readonly string[], context: CommandContext, dependencies: DevDependencies): Promise<CommandResult> {
  const { values, positionals } = parseCommandLine('plugin dev', args, { profile: { type: 'string' } })
  if (positionals.length !== 1) throw new CliError(EXIT.usage, `delorun plugin dev: ${USAGE}`)
  const given = resolve(positionals[0]!)
  if (!existsSync(given)) throw new CliError(EXIT.failed, `delorun plugin dev: ${printable(given)} does not exist`)
  const folder = realpathSync(given)
  const { name, builds } = await devPackage(folder)
  const { home, profile } = await prepareHome(context, values.profile)
  if (!hasCliProfile(home.path, profile)) throw new CliError(EXIT.failed, `delorun plugin dev: the profile ${profile} is not set up in ${home.path}; run: delorun setup`)
  const profileDir = profileDirectory(home.path, profile)
  const state = linkState(profileDir, name, folder)
  if (state.kind === 'other') {
    throw new CliError(EXIT.failed, `delorun plugin dev: the profile ${profile} installs ${printable(name)} from ${printable(state.spec)}, not from ${printable(folder)}; remove it with delorun plugin remove ${printable(name)} first, or give your copy another package name`)
  }
  // Built before linking, so the first load reads a current build.
  if (builds && !await dependencies.build(folder)) context.stderr(`delorun plugin dev: the build of ${printable(name)} failed; Delorun loads what its last build left, and the next change under src/ builds again.\n`)
  if (state.kind === 'absent') {
    const linked = await dependencies.plugin(['--profile', profile, 'add', `link:${folder}`])
    if (linked !== EXIT.ok) return EXIT.failed
  } else if (!bundleListed(profileDir, name)) {
    context.stderr(`delorun plugin dev: ${printable(name)} is linked but its bundle is off in the profile ${profile}; turn it on in the studio's Plugins page to load it.\n`)
  }
  const release = await useHomeShared(home.path, 'plugin dev')
  try {
    try {
      await changeProfilePatch(profileDir, (text, path) => addDevRoot(text, folder, path))
    } catch (error) {
      throw new CliError(EXIT.failed, `delorun plugin dev: ${printable(error instanceof Error ? error.message : String(error))}`)
    }
    const pid = await dependencies.running(home.path, profile)
    context.stdout([
      `${name} loads from ${folder} in the profile ${profile}.`,
      `Delorun reloads its code when a file under ${folder} changes, and the studio swaps its browser half when lib/client.js changes; changes to its cordis.patch.yml or package.json load at the next start.`,
      ...builds ? ['A change under src/ runs its build script first.'] : [],
      pid === undefined ? 'Delorun is not running for this profile: start it with delorun start, and it loads the plugin.' : `Delorun is running for this profile (process ${String(pid)}).`,
      `Press Ctrl+C to stop; ${name} stays installed, and delorun plugin remove ${name} uninstalls it.`,
      '',
    ].map(line => printable(line)).join('\n'))
    const stopWatching = builds ? rebuildOnChange(folder, name, context, dependencies) : () => Promise.resolve()
    await dependencies.stopped()
    await stopWatching()
    await changeProfilePatch(profileDir, (text, path) => removeDevRoot(text, folder, path))
    context.stdout(`Stopped watching ${printable(folder)}.\n`)
    return EXIT.ok
  } finally {
    release()
  }
}

/**
 * Build the folder after each settled change under `src/`, one build at a time.
 * @param folder - the folder.
 * @param name - the package's name, for the lines.
 * @param context - where the lines go.
 * @param dependencies - the watch and the build.
 * @returns a function that stops watching and waits for a build in progress.
 */
function rebuildOnChange(folder: string, name: string, context: CommandContext, dependencies: DevDependencies): () => Promise<void> {
  let timer: NodeJS.Timeout | undefined
  let building = Promise.resolve()
  const build = async (): Promise<void> => {
    const ok = await dependencies.build(folder)
    if (ok) context.stdout(`Built ${printable(name)}; Delorun loads the new build.\n`)
    else context.stderr(`delorun plugin dev: the build of ${printable(name)} failed; Delorun keeps what its last build left.\n`)
  }
  const watcher = dependencies.watch(folder, (changed) => {
    if (!isSourceChange(changed)) return
    clearTimeout(timer)
    timer = setTimeout(() => { building = building.then(build) }, dependencies.debounceMs ?? DEV_DEBOUNCE_MS)
  })
  return async () => {
    clearTimeout(timer)
    watcher.close()
    await building
  }
}
