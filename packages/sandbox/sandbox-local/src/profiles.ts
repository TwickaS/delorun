/**
 * Internal platform-profile builders for the local sandbox provider.
 *
 * Each builder expresses one file-effect policy plus the provider's {@link Protection}: the protected home that
 * confined commands can neither read nor write, its read exemptions, and the Unix sockets they cannot connect to.
 * Each dialect uses its own mechanism, and {@link RUNNER_PROTECTION} records which rules each one can express.
 *
 * @module @deepseek-ai/dsh-sandbox-local/profiles
 */

import { existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnsupportedPolicyError, canonicalPath, pathWithin, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** A runner of the local provider's platform chains. */
export type LocalSandboxRunner = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl'

/** Which protection rules one runner's profile can express. */
export interface RunnerProtection {
  /** Confined commands cannot create, change or delete anything under the protected home. */
  readonly homeWrite: boolean
  /** Confined commands cannot read anything under the protected home except its readable entries. */
  readonly homeRead: boolean
  /**
   * Confined commands cannot connect to the denied sockets. bwrap also hides every other socket under the protected
   * home; Seatbelt denies the listed paths only.
   */
  readonly socketConnect: boolean
}

/**
 * The protection rules each runner can express. bwrap hides the home under an empty read-only tmpfs and binds
 * `/dev/null` over each denied socket; Seatbelt denies the home by path and each denied socket by its path literals;
 * Landlock grants reads only outside the home but has no right that governs connecting to a pathname socket; the
 * Windows ACL runner keeps its Low-integrity token from writing outside granted roots but does not confine reads,
 * and its profile adds no socket or pipe rule. A rule marked false here is not enforced on that runner.
 */
export const RUNNER_PROTECTION: Readonly<Record<LocalSandboxRunner, RunnerProtection>> = {
  bwrap: { homeWrite: true, homeRead: true, socketConnect: true },
  landlock: { homeWrite: true, homeRead: true, socketConnect: false },
  seatbelt: { homeWrite: true, homeRead: true, socketConnect: true },
  'windows-acl': { homeWrite: true, homeRead: false, socketConnect: false },
}

/** One readable entry under the protected home. */
export interface ReadableEntry {
  /** The entry's path under the canonical home, where confined commands read it. */
  readonly path: string
  /** The entry's canonical path, which bwrap binds at {@link path}. */
  readonly source: string
}

/** The protection one wrap applies, resolved from the provider's configuration by {@link resolveProtection}. */
export interface Protection {
  /** The canonical protected home, or `undefined` when none is configured. */
  readonly home: string | undefined
  /** The home's readable entries that exist now and do not lead elsewhere inside the home. */
  readonly readable: readonly ReadableEntry[]
  /** Every spelling of every denied socket: as configured, with its directory resolved, and fully resolved. */
  readonly socketSpellings: readonly string[]
  /** The denied sockets' resolved paths that exist now and lie outside the home, which bwrap shadows. */
  readonly shadowedSockets: readonly string[]
}

/** No protected home and no denied socket: every profile is upstream's. */
export const NO_PROTECTION: Protection = { home: undefined, readable: [], socketSpellings: [], shadowedSockets: [] }

/** The provider's validated protection settings: the canonical home, its readable entries and the denied sockets. */
export interface ProtectionSettings {
  /** The canonical protected home, or `undefined` for none. */
  readonly home: string | undefined
  /** Readable entries, relative to the home. */
  readonly readable: readonly string[]
  /** Absolute socket paths. */
  readonly deniedSockets: readonly string[]
}

/**
 * Resolve the protection for one wrap. Readable entries that do not exist now are left out, because they grant
 * nothing, and so is an entry whose resolved path lies elsewhere inside the home, which would expose that path.
 * Sockets are resolved now, so a socket that appears after the wrap is not shadowed by bwrap.
 * @param settings - the provider's validated protection settings.
 * @returns the protection the profile builders apply.
 */
export function resolveProtection(settings: ProtectionSettings): Protection {
  const { home } = settings
  const readable: ReadableEntry[] = []
  if (home !== undefined) {
    for (const entry of settings.readable) {
      const path = join(home, entry)
      if (!existsSync(path)) continue
      const source = canonicalPath(path)
      if (source !== path && pathWithin(source, home)) continue
      readable.push({ path, source })
    }
  }
  const socketSpellings = new Set<string>()
  const shadowedSockets = new Set<string>()
  for (const socket of settings.deniedSockets) {
    const real = canonicalPath(socket)
    for (const spelling of [socket, join(canonicalPath(dirname(socket)), basename(socket)), real]) socketSpellings.add(spelling)
    if (existsSync(real) && (home === undefined || !pathWithin(real, home))) shadowedSockets.add(real)
  }
  return { home, readable, socketSpellings: [...socketSpellings], shadowedSockets: [...shadowedSockets] }
}

/**
 * Build the bwrap profile arguments for one file-effect policy. With a protected home, each denied socket outside it
 * is shadowed by binding `/dev/null` over that one path (never its directory, which holds other sockets), and the
 * home is replaced by an empty tmpfs carrying read-only binds of its readable entries, then remounted read-only.
 * @param policy - file-effect policy to express as bwrap mounts.
 * @param protection - the protected home and denied sockets.
 * @returns profile arguments before the trailing separator and command argv.
 */
export function bwrapProfileArgs(policy: SandboxPolicy, protection: Protection = NO_PROTECTION): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
  if (policy.mode === 'workspace-write') {
    args.push('--tmpfs', '/tmp')
    for (const root of workspaceWritableRoots(policy)) args.push('--bind', root, root)
  }
  for (const socket of protection.shadowedSockets) args.push('--ro-bind', '/dev/null', socket)
  if (protection.home !== undefined) {
    args.push('--tmpfs', protection.home)
    for (const entry of protection.readable) args.push('--ro-bind', entry.source, entry.path)
    args.push('--remount-ro', protection.home)
  }
  return args
}

/**
 * The paths that grant everything beneath `root` except `excluded`: the entries of each directory on the way from
 * `root` to `excluded`, other than the next step towards it. An entry that resolves to the excluded path, to a path
 * inside it or to one of its ancestors is left out, because Landlock follows it and would grant the excluded path.
 * Entries are listed at wrap time, so one created later in those directories is not granted.
 * @param root - the canonical root to grant.
 * @param excluded - the canonical path to leave out.
 * @returns the grant paths; `[root]` when `excluded` is outside it, none when they are equal.
 * @throws {SandboxUnsupportedPolicyError} when a directory on the way cannot be listed.
 */
function grantsExcluding(root: string, excluded: string): string[] {
  if (!pathWithin(excluded, root)) return [root]
  const grants: string[] = []
  let directory = root
  for (const segment of relative(root, excluded).split(sep).filter(part => part !== '')) {
    const next = join(directory, segment)
    let entries: string[]
    try {
      entries = readdirSync(directory)
    } catch (error) {
      throw new SandboxUnsupportedPolicyError(`Landlock cannot express the protected home: cannot list ${JSON.stringify(directory)}: ${String(error)}`)
    }
    for (const entry of entries.sort()) {
      const path = join(directory, entry)
      if (path === next) continue
      let real: string
      try {
        real = realpathSync.native(path)
      } catch {
        // A dangling link grants nothing, and the launcher refuses a grant it cannot open.
        continue
      }
      if (pathWithin(real, excluded) || pathWithin(excluded, real)) continue
      grants.push(path)
    }
    directory = next
  }
  return grants
}

/**
 * Build the Landlock launcher grants for one file-effect policy. With a protected home, the read grant of `/` and
 * any write grant that contains the home are replaced by grants of every path beside the way to the home
 * ({@link grantsExcluding}), and the home's readable entries are granted read-only.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param protection - the protected home; Landlock cannot express the denied sockets.
 * @returns launcher grant arguments before the trailing separator and command argv.
 * @throws {SandboxUnsupportedPolicyError} when a directory on the way to the home cannot be listed.
 */
export function landlockProfileArgs(policy: SandboxPolicy, protection: Protection = NO_PROTECTION): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push('/tmp', ...workspaceWritableRoots(policy))
  }
  const home = protection.home
  if (home === undefined) return landlockGrantArgs({ readOnly: ['/'], readWrite })
  return landlockGrantArgs({
    readOnly: [...grantsExcluding('/', home), ...protection.readable.map(entry => entry.path)],
    readWrite: readWrite.flatMap(root => grantsExcluding(canonicalPath(root), home)),
  })
}

/** Quote one path as an SBPL string literal. */
function sbplString(path: string): string {
  return `"${path.replaceAll('\\', String.raw`\\`).replaceAll('"', String.raw`\"`)}"`
}

/**
 * Build the sandbox-exec arguments and SBPL profile for one policy. The
 * workspace-owned writable roots (workspace plus explicit extra directories)
 * come from the shared {@link writableRoots} helper (canonical, deduplicated)
 * so the Seatbelt grant and the in-process fs fence
 * (`@deepseek-ai/dsh-fs-sandbox`) can never drift apart; the helper adds the
 * documented Seatbelt temp areas. With a protected home, later forms deny
 * writes and reads under it (they win over the earlier allows), allow reads of
 * its readable entries, and deny connecting to each denied socket's path literals.
 * @param policy - file-effect policy to express as an SBPL profile.
 * @param protection - the protected home and denied sockets.
 * @returns sandbox-exec arguments before the trailing separator and command argv.
 */
export function seatbeltProfileArgs(policy: SandboxPolicy, protection: Protection = NO_PROTECTION): string[] {
  const forms = ['(version 1)', '(allow default)', '(deny file-write*)', `(allow file-write* (literal ${sbplString('/dev/null')}))`]
  const roots = writableRoots(policy)
  if (roots.length > 0) {
    forms.push(`(allow file-write* ${roots.map(root => `(subpath ${sbplString(root)})`).join(' ')})`)
  }
  const home = protection.home
  if (home !== undefined) {
    forms.push(`(deny file-write* (subpath ${sbplString(home)}))`, `(deny file-read* (subpath ${sbplString(home)}))`)
    forms.push(`(allow file-read-metadata (literal ${sbplString(home)}))`)
    if (protection.readable.length > 0) {
      forms.push(`(allow file-read* ${protection.readable.map(entry => `(subpath ${sbplString(entry.path)})`).join(' ')})`)
    }
  }
  for (const socket of protection.socketSpellings) {
    forms.push(`(deny network-outbound (remote unix-socket (path-literal ${sbplString(socket)})))`)
  }
  return ['-p', forms.join(' ')]
}
