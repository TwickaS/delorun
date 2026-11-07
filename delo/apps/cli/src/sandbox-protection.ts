/**
 * C1's confinement of the CLI profile's commands, which the home process sets when it starts the profile: upstream's
 * local sandbox provider (row `sandbox`, `@deepseek-ai/dsh-sandbox-local`) receives the canonical Delo home as
 * `protectedHome`, C1's read exemptions as `protectedHomeReadable`, and as `deniedSockets` the update channel's and
 * the supervisor's sockets under `run/<profile>/`, the active Docker context's socket with its real path, and Docker
 * Desktop's macOS sockets under `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/` when present. The
 * settings travel as an overlay patch the start writes to `run/<profile>/sandbox.patch.yml` and hands to upstream's
 * profile runner; the provider's other settings in the profile's own patch are kept, its own denied sockets included.
 * A patch that sets the runner itself (`runnerCommand`, `runnerFailureSignatures`) is refused: a non-empty runner
 * command asserts full enforcement and skips the built-in selection, which would boot the row unconfined while the
 * provider reports full.
 *
 * @module @delo/cli/sandbox-protection
 */
import { realpathSync } from 'node:fs'
import { realpath, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { runDirectory, writeProtectedFile } from '@delo/home'
import { updateSocketPath } from '@delo/home-process'
import { resolveDockerContext, supervisorSocketPath } from '@delo/supervisor'
import { stringify } from 'yaml'
import { CliError, EXIT } from './exit.ts'

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
}

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
  }
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

/**
 * The provider's settings in the profile's own patch, which the overlay keeps: the last `sandbox` entry's `config`.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns the settings, or an empty object.
 * @throws {CliError} when the entry's settings are not plain values, which the overlay cannot carry over.
 */
function personSettings(patchPath: string): Record<string, unknown> {
  const entries = loadOverlayPatches('delorun', patchPath).filter(entry => entry.id === SANDBOX_ROW && entry.config !== undefined)
  const config: unknown = entries.at(-1)?.config
  if (config === undefined) return {}
  if (typeof config !== 'object' || config === null || Array.isArray(config) || !isPlain(config)) throw new CliError(EXIT.failed, `delorun: ${patchPath} configures the ${SANDBOX_ROW} row with expressions; Delo adds its home protection to that row at start and can carry over plain values only, so write its settings as plain YAML values`)
  return config as Record<string, unknown>
}

/**
 * Write the overlay that sets the protection on the profile's sandbox row.
 * @param home - the resolved Delo home.
 * @param profile - the CLI profile.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param protection - the settings.
 * @returns the overlay's path, to pass to upstream's profile runner.
 * @throws {CliError} when the profile's own settings for the row cannot be carried over, or when the row sets the
 *   runner itself, which would replace the confinement Delo's home protection needs.
 */
export async function writeSandboxOverlay(home: string, profile: string, patchPath: string, protection: SandboxProtection): Promise<string> {
  const own = personSettings(patchPath)
  // The provider treats a non-empty `runnerCommand` as an assertion of full enforcement and skips its built-in
  // selection, so a person-controlled row could boot unconfined while the provider reports full. Refuse it here,
  // as the expressions above are refused: the row cannot carry over.
  const runnerKeys = ['runnerCommand', 'runnerFailureSignatures'].filter(key => own[key] !== undefined)
  if (runnerKeys.length > 0) {
    throw new CliError(EXIT.failed, `delorun: ${patchPath} configures the ${SANDBOX_ROW} row with ${runnerKeys.join(' and ')}; Delo's home protection requires the provider's built-in runner selection, so remove ${runnerKeys.join(' and ')} from that row`)
  }
  const listed = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
  // The person's own denied sockets stay denied; the home is Delo's.
  const config = {
    ...own,
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...new Set([...listed(own.deniedSockets), ...protection.deniedSockets])],
  }
  const path = sandboxOverlayPath(home, profile)
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
