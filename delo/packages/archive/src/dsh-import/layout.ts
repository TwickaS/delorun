/**
 * The layout of a stock DeepSeek Harness home as the stock-home import reads
 * it: which root entries it carries and how, which it leaves behind and why,
 * and the name rules every path it carries passes. The rules restate the names
 * upstream writes: a Session's project directory is `projectKey`'s
 * `--<slug>--` or `_no-cwd`, its directory is `encodeSegment`'s output, and a
 * generation's name is `parseSessionFormatLogFilename`'s canonical name with
 * the Zstandard suffix. Anything the table does not name is unknown and stays
 * behind, so a stock home that grows a new entry is never carried blind.
 *
 * @module @delo/archive/dsh-import/layout
 */
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { DELO_HOME_ENTRIES } from '@delo/contract-home-layout'
import { hasControlCharacter } from '../text.ts'

/** Why the import leaves an entry of the stock home behind. */
export const DSH_IMPORT_SKIP_REASONS = [
  'symbolic-link',
  'hard-link',
  'special-file',
  'mount-point',
  'unsafe-name',
  'unknown',
  'logs',
  'cache',
  'runtime-state',
  'runtimes',
  'dependency-tree',
  'profile-history',
  'delo-entry',
  'desktop-profile',
  'taken',
  'environment-file',
  'identity',
  'permission-grants',
  'scheduled-work',
  'spill',
  'shares',
  'legacy-layout',
  'uncompressed-sessions',
  'newer-session',
  'unreadable',
  'too-large',
  'version-exemptions',
  'lockfile',
  'build-approvals',
  'not-addressed',
  'unfinished-turn',
  'outside-workspace',
  'sensitive-folder',
  'declined',
] as const

/** One reason of {@link DSH_IMPORT_SKIP_REASONS}. */
export type DshImportSkipReason = (typeof DSH_IMPORT_SKIP_REASONS)[number]

/** One sentence per reason, which the preview shows beside the entries it left behind. */
export const DSH_IMPORT_SKIP_SENTENCES: Readonly<Record<DshImportSkipReason, string>> = {
  'symbolic-link': 'a symbolic link, which the import never follows',
  'hard-link': 'a file with more than one hard link, which could be a file from outside the stock home',
  'special-file': 'a pipe, socket or device, which is not a file the import copies',
  'mount-point': 'an entry on another file system than the stock home, such as a mount point, which the import never crosses into',
  'unsafe-name': 'a name DeepSeek Harness does not write: it holds a control character, a separator, `..` or is too long',
  unknown: 'an entry the import does not know, so it is not carried',
  logs: 'logs, which Delo writes its own of',
  cache: 'a cache, which is built again from what the import carries',
  'runtime-state': 'a lock or a half-written file, which its writer creates again',
  runtimes: 'an installed runtime, which Delo installs its own of',
  'dependency-tree': 'installed packages, which `delorun plugin --profile <name> install` installs again',
  'profile-history': 'the profile\'s change history, a git directory whose settings could run commands, so the history starts fresh',
  'delo-entry': 'an entry Delo keeps for itself in its own home',
  'desktop-profile': 'the desktop app\'s own profile, which only the desktop app manages',
  taken: 'the Delo home already holds a different one under that name, which the import never replaces',
  'environment-file': 'an environment file that may hold keys; copy what you need by hand',
  identity: 'this installation\'s anonymous identifier; the Delo home keeps its own',
  'permission-grants': 'permissions a tool was granted, which Delo asks for again',
  'scheduled-work': 'scheduled follow-ups, which would start chats without you; schedule them again in Delo',
  spill: 'tool output a chat set aside; the chats name it by its place in the stock home, which the import leaves in place',
  shares: 'live-share links, which belong to the stock installation',
  'legacy-layout': 'a layout DeepSeek Harness no longer reads',
  'uncompressed-sessions': 'chats stored without compression, which Delo\'s chat store does not read beside compressed ones',
  'newer-session': 'a chat written by a newer DeepSeek Harness than this one reads',
  unreadable: 'a document this version cannot read',
  'too-large': 'a document too large to read',
  'version-exemptions': 'the plugins the stock profile allowed to load outside their supported versions; Delo asks again',
  lockfile: 'the stock profile\'s lockfile, which can pin packages to any address; the install resolves the plugins again',
  'build-approvals': 'the install scripts the stock profile approved; a plugin\'s install script runs only after you approve it in Delo',
  'not-addressed': 'an attachment whose bytes do not match the name it is stored under, so a chat would read other content than it sent',
  'unfinished-turn': 'a chat that stopped in the middle of a turn; resuming it would offer its unfinished tool calls for retry, so finish or close it in DeepSeek Harness first',
  'outside-workspace': 'a chat whose working folder is not inside the folder of the workspace it is filed under',
  'sensitive-folder': 'a workspace or chat in a folder that holds your settings and keys: the root, your home folder itself, a hidden folder of it, or a Harness home; register it in Delo yourself if you mean it',
  declined: 'not copied: you chose not to',
}

/** How the import treats one root entry of the stock home. */
export type RootEntryKind =
  | { readonly kind: 'sessions' }
  | { readonly kind: 'attachments' }
  | { readonly kind: 'storages' }
  | { readonly kind: 'profiles' }
  | { readonly kind: 'skills' }
  | { readonly kind: 'credentials' }
  | { readonly kind: 'layer', readonly layer: 'home-patch' | 'settings' }
  | { readonly kind: 'instructions' }
  | { readonly kind: 'skip', readonly reason: DshImportSkipReason }

/** The root entries the import knows, by name; every other name is {@link DshImportSkipReason} `unknown`. */
export const DSH_HOME_ROOT_ENTRIES: Readonly<Record<string, RootEntryKind>> = {
  sessions: { kind: 'sessions' },
  attachments: { kind: 'attachments' },
  storages: { kind: 'storages' },
  profiles: { kind: 'profiles' },
  skills: { kind: 'skills' },
  '.credentials.yaml': { kind: 'credentials' },
  'cordis.patch.yml': { kind: 'layer', layer: 'home-patch' },
  'settings.yaml': { kind: 'layer', layer: 'settings' },
  'AGENTS.md': { kind: 'instructions' },
  '.env': { kind: 'skip', reason: 'environment-file' },
  '.anonymous-user-id': { kind: 'skip', reason: 'identity' },
  logs: { kind: 'skip', reason: 'logs' },
  cache: { kind: 'skip', reason: 'cache' },
  'llm-deepseek': { kind: 'skip', reason: 'cache' },
  'dsh-runtimes': { kind: 'skip', reason: 'runtimes' },
  'dsh-primary-runtime': { kind: 'skip', reason: 'runtimes' },
  spill: { kind: 'skip', reason: 'spill' },
  liveshare: { kind: 'skip', reason: 'shares' },
  '.agent-presets': { kind: 'skip', reason: 'legacy-layout' },
  'settings.yaml.imported': { kind: 'skip', reason: 'legacy-layout' },
  archive: { kind: 'skip', reason: 'delo-entry' },
  trash: { kind: 'skip', reason: 'delo-entry' },
  ...Object.fromEntries(Object.values(DELO_HOME_ENTRIES).map(name => [name, { kind: 'skip', reason: 'delo-entry' } as const])),
}

/** The storage units the import carries or names, by file name under `storages/`. */
export const DSH_STORAGE_UNITS: Readonly<Record<string, DshImportSkipReason | 'workspaces'>> = {
  'workspace.json': 'workspaces',
  'session_projcache.json': 'cache',
  session_projcache: 'cache',
  'schedule.json': 'scheduled-work',
}

/** The storage unit names that hold a tool's permission grants: `cua_permissions_<digest>.json`. */
const PERMISSION_UNIT = /^cua_permissions_[0-9a-f]+\.json$/u

/**
 * The files of a profile the import reads: the manifest, which lands rewritten with its plugin list alone, and the
 * patch layer, which lands split. Every other entry of a profile is named in {@link PROFILE_SKIPS} or unknown.
 */
export const PROFILE_CARRIED_FILES = ['package.json', 'cordis.patch.yml'] as const

/** The entries of a profile the import leaves behind with a known reason. */
export const PROFILE_SKIPS: Readonly<Record<string, DshImportSkipReason>> = {
  'compatibility.json': 'version-exemptions',
  'pnpm-lock.yaml': 'lockfile',
  'pnpm-workspace.yaml': 'build-approvals',
  'delo-safety.json': 'delo-entry',
  node_modules: 'dependency-tree',
  '.dsh-module-fallback': 'dependency-tree',
  '.plugin-manager': 'profile-history',
  lock: 'runtime-state',
}

/** The directory of the Delo home that holds the import's staging roots, its journal, its record and what it held back. */
export const STOCK_IMPORT_DIRECTORY = 'archive/stock-import'

/** A SHA-256 digest as upstream's attachment stores name it. */
const DIGEST = /^[0-9a-f]{64}$/u

/**
 * The content address an attachment's path names: upstream stores an object at `objects/<aa>/<digest>` and
 * `file-objects/<aa>/<digest>`, and a named file at `files/<aa>/<digest>/<name>`, where `<aa>` is the digest's first
 * two characters.
 * @param path - the attachment's home-relative path.
 * @returns the SHA-256 digest its bytes must have, or `undefined` for a path that names none.
 */
export function attachmentAddress(path: string): string | undefined {
  const segments = path.split('/')
  if (segments[0] !== 'attachments' || segments[1] !== 'v1') return undefined
  const [store, prefix, digest] = segments.slice(2)
  const depth = store === 'files' ? 6 : 5
  if (!['objects', 'file-objects', 'files'].includes(store as string) || segments.length !== depth) return undefined
  if (digest === undefined || !DIGEST.test(digest) || prefix !== digest.slice(0, 2)) return undefined
  return digest
}

/** The desktop app's profile name, which only the desktop app manages. */
export const DESKTOP_PROFILE_NAME = 'desktop'

/** The Zstandard suffix of a Session generation in the store Delo's composition configures. */
export const COMPRESSED_SUFFIX = '.zstd'

/** A project directory name `projectKey` writes, or the directory of Sessions without a working directory. */
const PROJECT_NAME = /^(?:_no-cwd|--[A-Za-z0-9._~-]{1,251}--)$/u

/** A Session directory name `encodeSegment` writes: safe code units and `~XXXX` escapes. */
const SESSION_NAME = /^(?:[A-Za-z0-9._-]|~[0-9A-F]{4})+$/u

/** The longest name, in UTF-8 bytes, a file system accepts for one path segment. */
const MAX_SEGMENT_BYTES = 255

/** The line and paragraph separators, which split a line in a terminal like a control does. */
const SEPARATORS = /[\u2028\u2029]/u

/** The device names a Windows path resolves to a device rather than a file. */
const RESERVED_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu

/**
 * Whether one path segment of the stock home is a name the import may carry.
 * @param name - one segment, as `readdir` returned it.
 * @returns false for an empty or over-long name, `.` and `..`, a name with a separator, a control, a bidirectional control or a line separator, and a reserved device name.
 */
export function isSafeSegment(name: string): boolean {
  if (name.length === 0 || name === '.' || name === '..') return false
  if (Buffer.byteLength(name, 'utf8') > MAX_SEGMENT_BYTES) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (hasControlCharacter(name) || SEPARATORS.test(name)) return false
  return !RESERVED_DEVICE.test(name)
}

/** A profile name the import carries: one a person can type after `--profile` without quoting. */
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u

/**
 * Whether a stock profile's name is one the import carries. The preview prints commands that name the profile, so a
 * name a shell would split or act on is never carried.
 * @param name - a directory name under `profiles/`.
 * @returns true for letters, digits, `.`, `_` and `-`, starting with a letter or digit, up to 64 characters, other than `node_modules`.
 */
export function isProfileName(name: string): boolean {
  return PROFILE_NAME.test(name) && name !== 'node_modules'
}

/**
 * Whether a name is a Session project directory upstream writes.
 * @param name - a directory name under `sessions/`.
 * @returns true for `_no-cwd` and `--<slug>--`.
 */
export function isProjectName(name: string): boolean {
  return PROJECT_NAME.test(name)
}

/**
 * Whether a name is a Session directory upstream writes.
 * @param name - a directory name under a project directory.
 * @returns true for an encoded Session identifier.
 */
export function isSessionName(name: string): boolean {
  return SESSION_NAME.test(name) && Buffer.byteLength(name, 'utf8') <= MAX_SEGMENT_BYTES
}

/**
 * The Session identifier a Session directory's name encodes, as `encodeSegment` writes it: safe code units stay
 * literal and every other code unit is `~` followed by its four hexadecimal digits.
 * @param name - a name {@link isSessionName} accepts.
 * @returns the identifier.
 */
export function decodeSessionName(name: string): string {
  return name.replace(/~([0-9A-F]{4})/gu, (_escape, code: string) => String.fromCharCode(Number.parseInt(code, 16)))
}

/** What one file name in a Session directory is. */
export type SessionFileKind =
  | { readonly kind: 'generation', readonly version: number }
  | { readonly kind: 'uncompressed' }
  | { readonly kind: 'runtime-state' }
  | { readonly kind: 'unknown' }

/**
 * Classify one file name of a Session directory.
 * @param name - the file name.
 * @returns a compressed generation with its format version, an uncompressed generation, runtime state, or unknown.
 */
export function sessionFileKind(name: string): SessionFileKind {
  if (name.endsWith(COMPRESSED_SUFFIX)) {
    const version = parseSessionFormatLogFilename(name.slice(0, -COMPRESSED_SUFFIX.length))
    if (version !== undefined) return { kind: 'generation', version }
  }
  if (parseSessionFormatLogFilename(name) !== undefined) return { kind: 'uncompressed' }
  if (isRuntimeState(name)) return { kind: 'runtime-state' }
  return { kind: 'unknown' }
}

/**
 * Whether a file name is a lock or a half-written file that its writer creates again.
 * @param name - the file name.
 * @returns true for a `.lock` or `.tmp` suffix and a `.tmp-` infix.
 */
export function isRuntimeState(name: string): boolean {
  return name.endsWith('.lock') || name.endsWith('.tmp') || name.includes('.tmp-')
}

/**
 * The reason a storage unit is left behind, or that it is the workspace registry.
 * @param name - a file or directory name under `storages/`.
 * @returns `workspaces` for the registry, otherwise the reason it stays.
 */
export function storageUnitKind(name: string): DshImportSkipReason | 'workspaces' {
  if (Object.hasOwn(DSH_STORAGE_UNITS, name)) return DSH_STORAGE_UNITS[name] as DshImportSkipReason | 'workspaces'
  if (PERMISSION_UNIT.test(name)) return 'permission-grants'
  return isRuntimeState(name) ? 'runtime-state' : 'unknown'
}

/**
 * How the import treats one root entry.
 * @param name - a root entry name of the stock home.
 * @returns its kind; a lock or half-written file is runtime state and any other unlisted name is unknown.
 */
export function rootEntryKind(name: string): RootEntryKind {
  if (Object.hasOwn(DSH_HOME_ROOT_ENTRIES, name)) return DSH_HOME_ROOT_ENTRIES[name] as RootEntryKind
  return { kind: 'skip', reason: isRuntimeState(name) ? 'runtime-state' : 'unknown' }
}
