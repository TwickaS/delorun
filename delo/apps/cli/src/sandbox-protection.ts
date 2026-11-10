/**
 * C1's confinement of the CLI profile's commands, which the home process sets when it starts the profile: upstream's
 * local sandbox provider (row `sandbox`, `@deepseek-ai/dsh-sandbox-local`) receives the canonical Delo home as
 * `protectedHome`, C1's read exemptions as `protectedHomeReadable`, and as `deniedSockets` the update channel's and
 * the supervisor's sockets under `run/<profile>/`, the active Docker context's socket with its real path, and Docker
 * Desktop's macOS sockets under `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/` when present, and as
 * `escapeSocketDirectories` WSL's interop directory `/run/WSL`, whose sockets let a command start Windows programs
 * outside every Linux namespace: the provider hides it under bwrap and refuses confined commands on a runner that
 * cannot, whenever it exists at a wrap. The settings travel as an overlay patch the start writes to `run/<profile>/sandbox.patch.yml` and hands to upstream's
 * profile runner as its last `--patch` overlay, so the overlay applies over every layer that composes the row, in
 * upstream's order (`readProfilePatches` in `@deepseek-ai/dsh-app-boot`): the bundle layers, the profile's own
 * `cordis.patch.yml`, the home's `cordis.patch.yml`, which upstream applies over every profile, and the start's other
 * overlays. A patch's `config` replaces the row's whole config (`applyPatches` in `@deepseek-ai/cordis-plugin-include`),
 * so the overlay carries over the composed config, which the last layer that sets one gives, with Delo's three keys
 * replaced; its `deniedSockets` and `escapeSocketDirectories` keep the entries every layer lists. A layer that sets the runner itself
 * (`runnerCommand`, `runnerFailureSignatures`) on the row is refused, even when a later layer replaces it: a non-empty
 * runner command asserts full enforcement and skips the built-in selection, which would boot the row unconfined while
 * the provider reports full.
 *
 * @module @delo/cli/sandbox-protection
 */
import { realpathSync } from 'node:fs'
import { realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { composeEntries, type Profile } from '@deepseek-ai/dsh-app-boot'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { runDirectory, writeProtectedFile } from '@delo/home'
import { updateSocketPath } from '@delo/home-process'
import { resolveDockerContext, supervisorSocketPath } from '@delo/supervisor'
import { stringify } from 'yaml'
import { CliError, EXIT } from './exit.ts'
import { isRecord, patchLayers, rowPatches, type PatchLayer } from './patch-layers.ts'

/** The id of upstream's local sandbox provider row in the CLI profile's composition. */
export const SANDBOX_ROW = 'sandbox'

/** The overlay's file under `run/<profile>/`. */
export const SANDBOX_OVERLAY = 'sandbox.patch.yml'

/** The provider settings C1's confinement adds. */
export interface SandboxProtection {
  /** The canonical Delo home. */
  readonly protectedHome: string
  /** C1's read exemptions, relative to the home. */
  readonly protectedHomeReadable: readonly string[]
  /** The sockets confined commands cannot connect to. */
  readonly deniedSockets: readonly string[]
  /** The directories whose sockets start programs outside the sandbox; see {@link WSL_INTEROP_DIRECTORIES}. */
  readonly escapeSocketDirectories: readonly string[]
}

/**
 * WSL's interop directory. Each `*_interop` socket in it accepts a request to start a Windows program, which the
 * kernel's `WSLInterop` binfmt handler sends for any executable with a Windows header, by `/mnt/c/...` path, by bare
 * name or as a copy anywhere; the Windows process runs outside every Linux namespace, mount rule and protected home,
 * with the person's Windows account. The handler finds a socket here whether or not `WSL_INTEROP` is set. The
 * directory is named on every machine: the provider checks at each wrap whether it exists, so no environment
 * variable, and no state at start, decides whether a command is protected.
 */
export const WSL_INTEROP_DIRECTORIES = ['/run/WSL'] as const

/**
 * The Docker context's socket and its real path, for `deniedSockets`.
 * @param env - the launch environment, read for `DOCKER_HOST`, `DOCKER_CONTEXT` and `DOCKER_CONFIG`.
 * @returns the spellings, or none when the context's endpoint is not a Unix socket or does not resolve.
 */
async function dockerSockets(env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  let path: string | undefined
  try {
    const context = await resolveDockerContext(env)
    path = context.endpoint.kind === 'unix' ? context.endpoint.path : undefined
  } catch (_noContext) {
    // No usable Docker context: no Docker socket exists to deny.
    return []
  }
  if (path === undefined) return []
  try {
    return [...new Set([path, await realpath(path)])]
  } catch (_absent) {
    // The socket does not exist yet: its configured path is denied, and the runner shadows what exists at a wrap.
    return [path]
  }
}

/** Docker Desktop's sockets on macOS, relative to the OS home, which C1 denies beside the context's path when present. */
export const DOCKER_DESKTOP_SOCKETS = [
  'Library/Containers/com.docker.docker/Data/docker.raw.sock',
  'Library/Containers/com.docker.docker/Data/docker.sock',
  '.docker/run/docker.sock',
] as const

/**
 * Docker Desktop's macOS sockets that exist, each with its real path.
 * @param osHome - the OS home directory.
 * @returns the spellings.
 */
async function dockerDesktopSockets(osHome: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of DOCKER_DESKTOP_SOCKETS) {
    const path = join(osHome, entry)
    try {
      found.push(path, await realpath(path))
    } catch (_absent) {
      // Not present: Docker Desktop for macOS is not installed or not running.
    }
  }
  return found
}

/**
 * The settings for a profile, from the canonical home.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param env - the launch environment.
 * @param osHome - the OS home directory, under which Docker Desktop for macOS keeps its sockets.
 * @returns the settings.
 */
export async function sandboxProtection(home: string, profile: string, env: Readonly<Record<string, string | undefined>>, osHome: string): Promise<SandboxProtection> {
  const canonical = realpathSync.native(home)
  const sockets = [updateSocketPath(canonical, profile), supervisorSocketPath(canonical, profile), ...await dockerSockets(env), ...await dockerDesktopSockets(osHome)]
  return {
    protectedHome: canonical,
    protectedHomeReadable: [...READ_EXEMPTIONS],
    deniedSockets: [...new Set(sockets)],
    escapeSocketDirectories: [...WSL_INTEROP_DIRECTORIES],
  }
}

/**
 * The escape directories the start set that a booted sandbox row's settings do not name. The provider hides, and under
 * bwrap filters vsock for, only the directories its settings name, so the invariants in `compose.ts` refuse a Host whose
 * row dropped one, before boot and after it, whichever layer replaced the list.
 * @param protection - the settings the start set.
 * @param config - the sandbox row's `config` as the Loader mounted it.
 * @returns the missing directories in the start's order; empty when the row names each of them.
 */
export function missingEscapeSocketDirectories(protection: Pick<SandboxProtection, 'escapeSocketDirectories'>, config: unknown): string[] {
  const named = typeof config === 'object' && config !== null && 'escapeSocketDirectories' in config && Array.isArray(config.escapeSocketDirectories)
    ? new Set(config.escapeSocketDirectories)
    : new Set()
  return protection.escapeSocketDirectories.filter(directory => !named.has(directory))
}

/**
 * Whether a value holds only YAML scalars, arrays and plain objects, which the overlay can write again.
 * @param value - the value.
 * @returns false for an expression node or any other object.
 */
function isPlain(value: unknown): boolean {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true
  if (Array.isArray(value)) return value.every(isPlain)
  // The include's dialect parses `!!js` into an object carrying `__jsExpr`, which plain YAML would write as data.
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Object.hasOwn(value, '__jsExpr')) return false
  return Object.values(value).every(isPlain)
}

/** The provider settings that set the runner itself, which no layer of the row may set. */
const RUNNER_KEYS = ['runnerCommand', 'runnerFailureSignatures'] as const

/** The keys whose values the overlay replaces outright, so a layer's value for them, expressions included, is dropped. */
const REPLACED_KEYS: readonly string[] = ['protectedHome', 'protectedHomeReadable']

/**
 * The configs that patches or composed entries give the `sandbox` row, in order.
 * @param entries - the patches or entries.
 * @returns the configs, which a later one replaces whole.
 */
function rowConfigs(entries: readonly unknown[]): unknown[] {
  return rowPatches(entries, SANDBOX_ROW).flatMap(entry => entry.config === undefined ? [] : [entry.config])
}

/**
 * The sources of the layers that give the row a config passing a test.
 * @param layers - the layers.
 * @param test - the test.
 * @returns the sources, comma-separated.
 */
function sourcesOf(layers: readonly PatchLayer[], test: (config: unknown) => boolean): string {
  return layers.filter(layer => rowConfigs(layer.patches).some(test)).map(layer => layer.source).join(', ')
}

/**
 * The settings of a row config the overlay carries over: the config without the keys it replaces.
 * @param config - the row config.
 * @returns the settings, or `undefined` when the config is not an object or holds an expression in a carried key.
 */
function carriedSettings(config: unknown): Record<string, unknown> | undefined {
  if (!isRecord(config)) return undefined
  const kept = Object.fromEntries(Object.entries(config).filter(([key]) => !REPLACED_KEYS.includes(key)))
  return isPlain(kept) ? kept : undefined
}

/**
 * The string entries of a list in a row config.
 * @param config - the row config.
 * @param key - the list's key, `deniedSockets` or `escapeSocketDirectories`.
 * @returns the entries, or none when the config lists none as plain strings.
 */
function listedEntries(config: unknown, key: 'deniedSockets' | 'escapeSocketDirectories'): string[] {
  const value = isRecord(config) ? config[key] : undefined
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

/**
 * Write the overlay that sets the protection on the profile's sandbox row. The overlay must be the last `--patch`
 * overlay the start passes, after `patchFiles`: its config replaces the row's composed config whole.
 * @param home - the resolved Delo home, whose `cordis.patch.yml` applies over every profile.
 * @param name - the CLI profile's name.
 * @param profile - the profile as it boots: its bundle layers and its own patch.
 * @param patchFiles - the start's other `--patch` overlays, which apply before this one.
 * @param protection - the settings.
 * @returns the overlay's path, to pass to upstream's profile runner after `patchFiles`.
 * @throws {CliError} when any layer sets the runner itself on the row, which would replace the confinement Delo's
 *   home protection needs, naming each file and key; or when the composed settings hold expressions the overlay
 *   cannot carry over.
 * @throws {Error} upstream's loader error when the home patch or an overlay cannot be read or parsed.
 */
export async function writeSandboxOverlay(home: string, name: string, profile: Profile, patchFiles: readonly string[], protection: SandboxProtection): Promise<string> {
  const layers = patchLayers(home, profile, patchFiles)
  const runner = RUNNER_KEYS.flatMap(key => {
    const sources = sourcesOf(layers, config => isRecord(config) && config[key] !== undefined)
    return sources === '' ? [] : [{ key, sources }]
  })
  if (runner.length > 0) {
    const keys = runner.map(entry => entry.key).join(' and ')
    throw new CliError(EXIT.failed, `delorun: the ${SANDBOX_ROW} row sets the runner itself (${runner.map(entry => `${entry.key} in ${entry.sources}`).join('; ')}); Delo's home protection requires the provider's built-in runner selection, so remove ${keys} from that row in each file named`)
  }
  const composed = rowConfigs(composeEntries(layers.map(layer => layer.patches))).at(-1) ?? {}
  const carried = carriedSettings(composed)
  if (carried === undefined) {
    const sources = sourcesOf(layers, config => carriedSettings(config) === undefined)
    throw new CliError(EXIT.failed, `delorun: the ${SANDBOX_ROW} row is configured with expressions (in ${sources}); Delo adds its home protection to that row at start and can carry over plain values only, so write its settings as plain YAML values`)
  }
  // A denied socket or escape directory only narrows what a confined command reaches, so every layer's entries stay.
  const listed = (key: 'deniedSockets' | 'escapeSocketDirectories'): string[] => layers.flatMap(layer => rowConfigs(layer.patches).flatMap(config => listedEntries(config, key)))
  const config = {
    ...carried,
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...new Set([...listed('deniedSockets'), ...protection.deniedSockets])],
    escapeSocketDirectories: [...new Set([...listed('escapeSocketDirectories'), ...protection.escapeSocketDirectories])],
  }
  const path = sandboxOverlayPath(home, name)
  await writeProtectedFile(path, stringify([{ id: SANDBOX_ROW, config }]))
  return path
}

/**
 * The overlay's path of a profile.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @returns `<home>/run/<profile>/sandbox.patch.yml`.
 */
export function sandboxOverlayPath(home: string, profile: string): string {
  return join(runDirectory(home, profile), SANDBOX_OVERLAY)
}

/**
 * Remove the overlay.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 */
export async function removeSandboxOverlay(home: string, profile: string): Promise<void> {
  try {
    await unlink(sandboxOverlayPath(home, profile))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
