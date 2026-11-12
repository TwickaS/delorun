/**
 * C1's confinement of the CLI profile's commands, which the home process sets when it starts the profile: upstream's
 * local sandbox provider (row `sandbox`, `@deepseek-ai/dsh-sandbox-local`) receives the canonical Delo home as
 * `protectedHome`, C1's read exemptions as `protectedHomeReadable`, `privateTmp` on, and as `deniedSockets` the update
 * channel's and the supervisor's sockets under `run/<profile>/`, the daemon sockets of {@link DAEMON_SOCKETS}, the
 * active Docker context's socket with its real path, Docker Desktop's macOS sockets under
 * `~/Library/Containers/com.docker.docker/Data/` and `~/.docker/run/` when present, and the ssh-agent socket
 * `SSH_AUTH_SOCK` names with its real path, and as `escapeSocketDirectories` the directories
 * of {@link escapeDirectories}, whose sockets let a command start programs outside the sandbox or act with the
 * person's authority: the provider hides each under bwrap and refuses confined commands on a runner that cannot,
 * whenever one exists at a wrap. The settings travel as an overlay patch the start writes to `run/<profile>/sandbox.patch.yml` and hands to upstream's
 * profile runner as its last `--patch` overlay, so the overlay applies over every layer that composes the row, in
 * upstream's order (`readProfilePatches` in `@deepseek-ai/dsh-app-boot`): the bundle layers, the profile's own
 * `cordis.patch.yml`, the home's `cordis.patch.yml`, which upstream applies over every profile, and the start's other
 * overlays. A patch's `config` replaces the row's whole config (`applyPatches` in `@deepseek-ai/cordis-plugin-include`),
 * so the overlay carries over the composed config, which the last layer that sets one gives, with `protectedHome`,
 * `protectedHomeReadable` and `privateTmp` replaced; its `deniedSockets` and `escapeSocketDirectories` keep the entries every layer lists. A layer that sets the runner itself
 * (`runnerCommand`, `runnerFailureSignatures`) on the row is refused, even when a later layer replaces it: a non-empty
 * runner command asserts full enforcement and skips the built-in selection, which would boot the row unconfined while
 * the provider reports full.
 *
 * @module @delo/cli/sandbox-protection
 */
import { realpathSync } from 'node:fs'
import { realpath, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { composeEntries, type Profile } from '@deepseek-ai/dsh-app-boot'
import { READ_EXEMPTIONS } from '@delo/contract-home-layout'
import { runDirectory, writeProtectedFile } from '@delo/home'
import { updateSocketPath, type HostProtection } from '@delo/home-process'
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
  /** The sockets confined commands cannot connect to: the home's own, {@link DAEMON_SOCKETS} and those in {@link observedSockets}. */
  readonly deniedSockets: readonly string[]
  /**
   * The entries of {@link deniedSockets} the start found on this computer: the Docker context's socket with its real
   * path and Docker Desktop's sockets. The next start may find others, so C3's H3 leaves them out of what it compares
   * across an update; the rest of the protection is fixed by the release and the home.
   */
  readonly observedSockets: readonly string[]
  /** The directories whose sockets start programs outside the sandbox; see {@link escapeDirectories}. */
  readonly escapeSocketDirectories: readonly string[]
  /** Whether bwrap hides the host's `/tmp` from `read-only` commands and every other mount of it; always on. */
  readonly privateTmp: true
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
 * The directories, besides {@link WSL_INTEROP_DIRECTORIES}, whose sockets let a confined command start a program
 * outside the sandbox or act with the person's authority, named on every machine whatever exists at start:
 * - `/run/user/<uid>`, the person's runtime directory (`$XDG_RUNTIME_DIR` under logind, elogind and WSLg): the session
 *   bus `bus` and the user manager's `systemd/private`, through which `systemd-run --user` starts any program as a
 *   user unit outside every namespace, gpg-agent and its ssh socket, the keyring, the display and audio servers,
 *   editors' and terminals' control sockets, and rootless Docker and Podman;
 * - `/run/dbus`, the system bus, which acts with the polkit authorizations of the person's session;
 * - `/tmp/tmux-<uid>` and `/run/screen`, whose servers run commands in the person's terminal sessions;
 * - `/tmp/.X11-unix`, the X server, which takes input for the person's other windows;
 * - `/mnt/wslg`, WSLg's display and audio sockets and its second mounts of the runtime directory and of `/`;
 * - `/mnt/wsl/docker-desktop/shared-sockets` and `~/.docker/desktop`, Docker Desktop's control sockets under WSL and on
 *   Linux, among them its backend's API, whose routes include its settings, the engine's `daemon.json` and container
 *   actions.
 * A runtime directory elsewhere, which `XDG_RUNTIME_DIR` or `TMUX_TMPDIR` may name, is not listed, so that the list
 * depends only on the user id and the OS home, and the next start compares it whatever its environment. Where the
 * platform has no user id, as on Windows, the directories named by the user id and Docker Desktop's are left out.
 * @param uid - the person's user id, or `undefined` where the platform has none.
 * @param osHome - the OS home directory, under which Docker Desktop for Linux keeps its control sockets.
 * @returns the absolute directories, in this order.
 */
export function escapeDirectories(uid: number | undefined, osHome: string): string[] {
  const own = uid === undefined ? [] : [`/run/user/${String(uid)}`]
  const tmux = uid === undefined ? [] : [`/tmp/tmux-${String(uid)}`]
  const dockerDesktop = uid === undefined ? [] : ['/mnt/wsl/docker-desktop/shared-sockets', join(osHome, '.docker', 'desktop')]
  return [...WSL_INTEROP_DIRECTORIES, ...own, '/run/dbus', ...tmux, '/run/screen', '/tmp/.X11-unix', '/mnt/wslg', ...dockerDesktop]
}

/**
 * The daemon sockets C1 denies on every machine with a user id, whether or not they exist at start: Docker Desktop's
 * `/run/docker-cli.sock` under WSL, which serves its backend's API to the `docker` group, and tailscaled's LocalAPI
 * socket on Linux and macOS, through which its operator changes the node's settings. The runner shadows those that
 * exist at each wrap.
 */
export const DAEMON_SOCKETS = ['/run/docker-cli.sock', '/run/tailscale/tailscaled.sock', '/var/run/tailscaled.socket'] as const

/**
 * The ssh-agent socket the launch environment names, and its real path, for `deniedSockets`: an agent signs with the
 * person's keys for any client that connects. Confined commands do not inherit `SSH_AUTH_SOCK`, and no setting
 * forwards the agent to them.
 * @param env - the launch environment, read for `SSH_AUTH_SOCK`.
 * @returns the spellings; none when the variable is unset or not an absolute path.
 */
async function agentSockets(env: Readonly<Record<string, string | undefined>>): Promise<string[]> {
  const path = env.SSH_AUTH_SOCK
  if (path === undefined || !isAbsolute(path)) return []
  try {
    return [...new Set([path, await realpath(path)])]
  } catch (_absent) {
    // No agent listens there now: its configured path is denied, and the runner shadows what exists at a wrap.
    return [path]
  }
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
 * @param uid - the person's user id, which names the runtime and tmux directories; `undefined` where there is none.
 * @returns the settings.
 */
export async function sandboxProtection(home: string, profile: string, env: Readonly<Record<string, string | undefined>>, osHome: string, uid: number | undefined): Promise<SandboxProtection> {
  const canonical = realpathSync.native(home)
  const fixed = [updateSocketPath(canonical, profile), supervisorSocketPath(canonical, profile), ...uid === undefined ? [] : DAEMON_SOCKETS]
  const found = [...await dockerSockets(env), ...await dockerDesktopSockets(osHome), ...await agentSockets(env)]
  const observed = [...new Set(found)].filter(socket => !fixed.includes(socket))
  return {
    protectedHome: canonical,
    protectedHomeReadable: [...READ_EXEMPTIONS],
    deniedSockets: [...new Set([...fixed, ...observed])],
    observedSockets: observed,
    escapeSocketDirectories: escapeDirectories(uid, osHome),
    privateTmp: true,
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

/** The keys of a sandbox row's config that hold its protection, which H3 compares by {@link protectionWeakenings}. */
const PROTECTION_KEYS: readonly string[] = ['protectedHome', 'protectedHomeReadable', 'deniedSockets', 'escapeSocketDirectories', 'privateTmp']

/**
 * A sandbox row's settings without its protection, which C3's H3 hashes: the protection is compared by
 * {@link protectionWeakenings} instead, so a release may tighten it without H3 failing.
 * @param config - the row's config as the Loader mounted it.
 * @returns the other settings; a config that is not an object as it is.
 */
export function settingsBeyondProtection(config: unknown): unknown {
  return isRecord(config) ? Object.fromEntries(Object.entries(config).filter(([key]) => !PROTECTION_KEYS.includes(key))) : config
}

/**
 * The protection a booted sandbox row gives confined commands, without the sockets one start found on the computer.
 * @param config - the row's config as the Loader mounted it.
 * @param observed - the sockets to leave out: those only the start denies ({@link startOnlySockets}), or none to keep
 *   every socket the row denies.
 * @returns the protection, or `undefined` when the config names no protected home.
 */
export function hostProtectionOf(config: unknown, observed: readonly string[]): HostProtection | undefined {
  if (!isRecord(config) || typeof config.protectedHome !== 'string') return undefined
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
  return {
    protectedHome: config.protectedHome,
    protectedHomeReadable: strings(config.protectedHomeReadable),
    deniedSockets: strings(config.deniedSockets).filter(socket => !observed.includes(socket)),
    escapeSocketDirectories: strings(config.escapeSocketDirectories),
    privateTmp: config.privateTmp === true,
  }
}

/**
 * How a protection is weaker than an earlier one: another protected home, a read exemption the earlier one did not
 * have, a denied socket or hidden escape directory it no longer names, or the host's `/tmp` shown again. A protection
 * that only adds denied sockets or escape directories, drops read exemptions or turns `privateTmp` on is not weaker.
 * @param before - the earlier protection.
 * @param after - the later one, with every socket its row denies.
 * @returns one clause per weakening, in that order; none when the later protection is at least as strict.
 */
export function protectionWeakenings(before: HostProtection, after: HostProtection): string[] {
  const added = (list: readonly string[], earlier: readonly string[]): string[] => list.filter(entry => !earlier.includes(entry))
  const weakenings: string[] = []
  if (after.protectedHome !== before.protectedHome) weakenings.push(`protects ${after.protectedHome} instead of ${before.protectedHome}`)
  const readable = added(after.protectedHomeReadable, before.protectedHomeReadable)
  if (readable.length > 0) weakenings.push(`lets confined commands read ${readable.join(', ')}`)
  const sockets = added(before.deniedSockets, after.deniedSockets)
  if (sockets.length > 0) weakenings.push(`no longer denies ${sockets.join(', ')}`)
  const escapes = added(before.escapeSocketDirectories, after.escapeSocketDirectories)
  if (escapes.length > 0) weakenings.push(`no longer hides ${escapes.join(', ')}`)
  if (before.privateTmp && !after.privateTmp) weakenings.push('shows confined commands the host\'s /tmp')
  return weakenings
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
const REPLACED_KEYS: readonly string[] = ['protectedHome', 'protectedHomeReadable', 'privateTmp']

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
 * The entries every layer lists for the sandbox row under a key, in layer order.
 * @param layers - the layers.
 * @param key - the list's key.
 * @returns the entries, repeats included.
 */
function layeredEntries(layers: readonly PatchLayer[], key: 'deniedSockets' | 'escapeSocketDirectories'): string[] {
  return layers.flatMap(layer => rowConfigs(layer.patches).flatMap(config => listedEntries(config, key)))
}

/**
 * The sockets only the start denies: the observed sockets no layer of the profile lists. An observed socket a layer
 * also lists is the profile's setting, which C3's H3 holds the next release to whether or not the next start finds it.
 * @param home - the resolved Delo home, whose `cordis.patch.yml` applies over every profile.
 * @param profile - the profile as it boots: its bundle layers and its own patch.
 * @param patchFiles - the start's other `--patch` overlays, without the sandbox overlay.
 * @param protection - the start's protection.
 * @returns the entries of {@link SandboxProtection.observedSockets} no layer lists.
 * @throws {Error} upstream's loader error when the home patch or an overlay cannot be read or parsed.
 */
export function startOnlySockets(home: string, profile: Profile, patchFiles: readonly string[], protection: SandboxProtection): string[] {
  const listed = layeredEntries(patchLayers(home, profile, patchFiles), 'deniedSockets')
  return protection.observedSockets.filter(socket => !listed.includes(socket))
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
  const listed = (key: 'deniedSockets' | 'escapeSocketDirectories'): string[] => layeredEntries(layers, key)
  const config = {
    ...carried,
    protectedHome: protection.protectedHome,
    protectedHomeReadable: [...protection.protectedHomeReadable],
    deniedSockets: [...new Set([...listed('deniedSockets'), ...protection.deniedSockets])],
    escapeSocketDirectories: [...new Set([...listed('escapeSocketDirectories'), ...protection.escapeSocketDirectories])],
    privateTmp: protection.privateTmp,
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
