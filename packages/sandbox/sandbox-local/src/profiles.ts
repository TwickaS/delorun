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
import { basename, dirname, join } from 'node:path'
import { grantArgs as landlockGrantArgs } from '@deepseek-ai/node-addon-system/landlock-run'
import { SandboxUnsupportedPolicyError, canonicalPath, pathWithin, workspaceWritableRoots, writableRoots } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { DATA_VOLUME, aliasCoverage, firmlinkAliases, mountAliases, readMountTable } from './mounts.ts'
import type { AliasCoverage, MountEntry } from './mounts.ts'

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
  /**
   * Other paths that reach the home: other mounts of its filesystem (such as a second mount of the root filesystem
   * or a bind mount) and, on macOS, its Data-volume firmlink spelling. Each is protected like the home.
   */
  readonly homeAliases: readonly string[]
  /**
   * What Landlock leaves out for the aliases: the whole mount that reaches each mount alias, and each firmlink
   * spelling. Such a mount never contains the home, because the deepest mount containing the home is the one it is
   * reached through. Leaving out the mount keeps a wrap from listing its directories, such as a second mount's
   * busy `tmp`.
   */
  readonly homeAliasMounts: readonly string[]
  /** The home's readable entries that exist now and lead neither elsewhere inside the home nor above it. */
  readonly readable: readonly ReadableEntry[]
  /**
   * Whether every mount alias of the home and of each existing denied socket was found: `unknown` when one lies on
   * a filesystem whose aliases cannot be found by device ({@link aliasCoverage}), so a consumer reports the rules
   * that depend on them as unknown rather than enforced.
   */
  readonly aliasCoverage: AliasCoverage
  /** Every spelling of every denied socket: as configured, with its directory resolved, fully resolved, and aliased. */
  readonly socketSpellings: readonly string[]
  /** The denied sockets' resolved paths and mount aliases that exist now and lie outside the home, which bwrap shadows. */
  readonly shadowedSockets: readonly string[]
}

/** No protected home and no denied socket: every profile is upstream's. */
export const NO_PROTECTION: Protection = {
  home: undefined,
  homeAliases: [],
  homeAliasMounts: [],
  aliasCoverage: 'complete',
  readable: [],
  socketSpellings: [],
  shadowedSockets: [],
}

/** The provider's validated protection settings: the canonical home, its readable entries and the denied sockets. */
export interface ProtectionSettings {
  /** The canonical protected home, or `undefined` for none. */
  readonly home: string | undefined
  /** Readable entries, relative to the home. */
  readonly readable: readonly string[]
  /** Absolute socket paths. */
  readonly deniedSockets: readonly string[]
}

/** Whether `path` lies inside or above one of the protected paths. */
function touches(path: string, protectedPaths: readonly string[]): boolean {
  return protectedPaths.some(entry => pathWithin(path, entry) || pathWithin(entry, path))
}

/**
 * Resolve the protection for one wrap. The home's mount and firmlink aliases are found now. Readable entries that do
 * not exist now are left out, because they grant nothing, and so is an entry whose resolved path lies elsewhere
 * inside the home or one of its aliases, or above one of them, which would expose it. Sockets and their aliases are
 * resolved now, so a socket that appears after the wrap, or is recreated after it, is not shadowed by bwrap.
 * @param settings - the provider's validated protection settings.
 * @param mounts - the mount table; read from this process when omitted.
 * @param dataVolume - where macOS mounts the Data volume that firmlinks point into.
 * @param platform - the operating system, which decides whether alias coverage is checked.
 * @returns the protection the profile builders apply.
 * @throws {SandboxUnsupportedPolicyError} when the Linux mount table cannot be read.
 */
export function resolveProtection(
  settings: ProtectionSettings,
  mounts: readonly MountEntry[] | undefined = undefined,
  dataVolume: string = DATA_VOLUME,
  platform: string = process.platform,
): Protection {
  if (settings.home === undefined && settings.deniedSockets.length === 0) return NO_PROTECTION
  const table = mounts ?? readMountTable()
  const aliasesOf = (path: string): string[] => [
    ...mountAliases(path, table).map(alias => alias.path),
    ...firmlinkAliases(path, dataVolume),
  ]
  const { home } = settings
  const homeAliases = home === undefined ? [] : aliasesOf(home)
  const homeAliasMounts = home === undefined
    ? []
    : [...new Set([
      ...mountAliases(home, table).map(alias => alias.mountPoint),
      ...firmlinkAliases(home, dataVolume),
    ])]
  const protectedPaths = home === undefined ? [] : [home, ...homeAliases]
  const readable: ReadableEntry[] = []
  if (home !== undefined) {
    for (const entry of settings.readable) {
      const path = join(home, entry)
      if (!existsSync(path)) continue
      const source = canonicalPath(path)
      if (source !== path && touches(source, protectedPaths)) continue
      readable.push({ path, source })
    }
  }
  const socketSpellings = new Set<string>()
  const shadowedSockets = new Set<string>()
  const covered = [...home === undefined ? [] : [home], ...settings.deniedSockets.map(socket => canonicalPath(socket))]
  for (const socket of settings.deniedSockets) {
    const real = canonicalPath(socket)
    const aliases = existsSync(real) ? aliasesOf(real) : []
    for (const spelling of [socket, join(canonicalPath(dirname(socket)), basename(socket)), real, ...aliases]) socketSpellings.add(spelling)
    for (const path of existsSync(real) ? [real, ...aliases] : []) {
      if (!protectedPaths.some(entry => pathWithin(path, entry))) shadowedSockets.add(path)
    }
  }
  return {
    home,
    homeAliases,
    homeAliasMounts,
    aliasCoverage: covered.some(path => aliasCoverage(path, table, platform) === 'unknown') ? 'unknown' : 'complete',
    readable,
    socketSpellings: [...socketSpellings],
    shadowedSockets: [...shadowedSockets],
  }
}

/**
 * Build the bwrap profile arguments for one file-effect policy. With a protected home, each denied socket and each of
 * its mount aliases outside the home is shadowed by binding `/dev/null` over that one path (never its directory,
 * which holds other sockets), and the home is replaced by an empty tmpfs carrying read-only binds of its readable
 * entries, then remounted read-only; each alias of the home gets an empty read-only tmpfs too.
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
    for (const alias of protection.homeAliases) args.push('--tmpfs', alias, '--remount-ro', alias)
  }
  return args
}

/**
 * The canonical paths that grant everything beneath `root` except the excluded paths: the entries of each directory
 * on the way from `root` to an excluded path, other than the directories on that way, which are descended into. An
 * entry that resolves into an excluded path or above one is left out, because Landlock follows it and would grant
 * the excluded path. Another mount that reaches the home is excluded whole ({@link Protection.homeAliasMounts}), so
 * its directories, which are the same inodes as those on the way, are never listed or granted. Entries are listed at wrap time, so one
 * created later in those directories is not granted, and grants name resolved paths, which the launcher opens
 * without following links, so a path swapped for a link after this listing fails the run.
 * @param root - the canonical root to grant.
 * @param excluded - the canonical paths to leave out.
 * @returns the grant paths; `[root]` when no excluded path is inside it, none when it lies inside an excluded path.
 * @throws {SandboxUnsupportedPolicyError} when a directory on the way cannot be listed.
 */
function grantsExcluding(root: string, excluded: readonly string[]): string[] {
  if (excluded.some(path => pathWithin(root, path))) return []
  const inside = excluded.filter(path => pathWithin(path, root))
  if (inside.length === 0) return [root]
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch (error) {
    throw new SandboxUnsupportedPolicyError(`Landlock cannot express the protected home: cannot list ${JSON.stringify(root)}: ${String(error)}`)
  }
  const grants: string[] = []
  for (const entry of entries.sort()) {
    const path = join(root, entry)
    let real: string
    try {
      real = realpathSync.native(path)
    } catch {
      // A dangling link grants nothing, and the launcher refuses a grant it cannot open.
      continue
    }
    if (!touches(real, excluded)) grants.push(real)
    else if (real === path && inside.some(target => pathWithin(target, path))) grants.push(...grantsExcluding(path, excluded))
  }
  return grants
}

/**
 * Build the Landlock launcher grants for one file-effect policy. With a protected home, the read grant of `/` and
 * any write grant that contains the home or one of its aliases are replaced by grants of every path beside the way
 * to them ({@link grantsExcluding}), and the home's readable entries are granted read-only by their resolved paths.
 * @param policy - file-effect policy to express as Landlock allow-list grants.
 * @param protection - the protected home; Landlock cannot express the denied sockets.
 * @returns launcher grant arguments before the trailing separator and command argv.
 * @throws {SandboxUnsupportedPolicyError} when a directory on the way to the home cannot be listed.
 */
export function landlockProfileArgs(policy: SandboxPolicy, protection: Protection = NO_PROTECTION): string[] {
  const readWrite = ['/dev/null']
  if (policy.mode === 'workspace-write') {
    readWrite.push(canonicalPath('/tmp'), ...workspaceWritableRoots(policy))
  }
  const home = protection.home
  if (home === undefined) return landlockGrantArgs({ readOnly: ['/'], readWrite })
  const excluded = [home, ...protection.homeAliasMounts]
  return landlockGrantArgs({
    readOnly: [...new Set([...grantsExcluding('/', excluded), ...protection.readable.map(entry => entry.source)])],
    readWrite: [...new Set(readWrite.flatMap(root => grantsExcluding(root, excluded)))],
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
 * writes, reads, hard links and clones under it and each of its aliases (they
 * win over the earlier allows), allow reads of its readable entries, and deny
 * connecting to each denied socket's path literals.
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
    for (const path of [home, ...protection.homeAliases]) {
      forms.push(`(deny file-write* (subpath ${sbplString(path)}))`, `(deny file-read* (subpath ${sbplString(path)}))`)
      forms.push(`(deny file-link file-clone (subpath ${sbplString(path)}))`)
      forms.push(`(allow file-read-metadata (literal ${sbplString(path)}))`)
    }
    if (protection.readable.length > 0) {
      forms.push(`(allow file-read* ${protection.readable.map(entry => `(subpath ${sbplString(entry.path)})`).join(' ')})`)
    }
  }
  for (const socket of protection.socketSpellings) {
    forms.push(`(deny network-outbound (remote unix-socket (path-literal ${sbplString(socket)})))`)
  }
  return ['-p', forms.join(' ')]
}
