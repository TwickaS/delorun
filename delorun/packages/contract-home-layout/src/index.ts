/**
 * Types and constants of contract C1, the home layout and runtime store
 * (`delorun/docs/contracts/c01-home-layout.md`): the Delorun home tree, the modes of
 * its directories and protected files, the per-start token, the home lock, the
 * runtime store's pointer files, the launcher's download limits and the
 * confinement rules `delorun verify` reports. Its functions are the pure
 * profile-name check and the environment a runtime start inherits; the contract page is the authority for every value
 * here.
 *
 * @module @delorun/contract-home-layout
 */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Directory name of the default Delorun home under the OS home directory (`~/.delorun`). */
export const DELORUN_HOME_DIR_NAME = '.delorun'

/** Environment variable that selects the Delorun home; blank counts as unset. */
export const DELORUN_HOME_ENV = 'DELORUN_HOME'

/** Environment variable that selects the CLI profile. */
export const DELORUN_PROFILE_ENV = 'DELORUN_PROFILE'

/** Upstream's harness-home variable, set to the resolved Delorun home for every runtime process. */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * Environment variable through which the launcher tells the runtime it starts where its shipped release roots are: the
 * absolute path of the launcher package's `roots/` directory. `delorun verify` anchors the home's stored root on those
 * roots, as the launcher's own start does; a runtime that finds it unset anchors on the stored root only, and says so.
 */
export const DELORUN_LAUNCHER_ROOTS_ENV = 'DELORUN_LAUNCHER_ROOTS'

/**
 * Environment variable through which the launcher tells the runtime it starts its own npm package version, the
 * `version` of the launcher package's `package.json`. `delorun setup` installs the `delorun` command at exactly that
 * version, and `delorun verify` compares it with the `npm` entries of the release's signed manifest.
 */
export const DELORUN_LAUNCHER_VERSION_ENV = 'DELORUN_LAUNCHER_VERSION'

/**
 * Environment variable through which the launcher tells the runtime it starts what its start check of the runtime's
 * files did: one JSON object, `delorun.start-check/1`, which `@delorun/runtime-store`'s `parseStartCheckHandoff` reads. The
 * runtime reports it and never re-hashes to show it; a runtime that finds it unset or unreadable reports the start
 * check as unknown. Any program running as the person can set it, so it informs a report and decides nothing.
 */
export const DELORUN_START_CHECK_ENV = 'DELORUN_START_CHECK'

/**
 * The variables no Delorun process passes to a runtime it starts (the launcher's start, the update's successor, the
 * studio's Check now), matched without regard to case because a Windows environment is case insensitive: Node's own
 * module hooks and caches (`NODE_OPTIONS`, `NODE_PATH`, `NODE_COMPILE_CACHE`, `NODE_V8_COVERAGE`, `NODE_ICU_DATA`), its
 * trust settings (`NODE_EXTRA_CA_CERTS`, `NODE_TLS_REJECT_UNAUTHORIZED`), OpenSSL's configuration and module directories
 * (`OPENSSL_CONF`, `OPENSSL_MODULES`, `OPENSSL_ENGINES`, which load code), and the dynamic loader's and C library's
 * (`LD_*`, `DYLD_*`, `GCONV_PATH`, `LOCPATH`). A process could use any of them to load code into the runtime's Node
 * before it starts or to stand between it and every HTTPS connection. The rest of the environment passes: the runtime
 * runs the person's commands and tools, which need `PATH`, credentials, agents and toolchain variables that an
 * allowlist would remove. None of them is a launch protocol variable.
 */
export const DROPPED_LAUNCH_ENV = /^(?:NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|NODE_COMPILE_CACHE|NODE_V8_COVERAGE|NODE_ICU_DATA|OPENSSL_CONF|OPENSSL_MODULES|OPENSSL_ENGINES|GCONV_PATH|LOCPATH|LD_.*|DYLD_.*)$/iu

/**
 * The environment a Delorun process passes to a runtime it starts: the given one, without {@link DROPPED_LAUNCH_ENV}'s
 * variables and without unset values.
 * @param inherited - the environment to pass on.
 * @returns the variables, each a string.
 */
export function inheritableEnvironment(inherited: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(inherited)) {
    if (value !== undefined && !DROPPED_LAUNCH_ENV.test(name)) environment[name] = value
  }
  return environment
}

/** Upstream's default harness-home directory name; Delorun never reads or writes `~/.dsh`. */
export const UPSTREAM_HOME_DIR_NAME = '.dsh'

/** The CLI profile's name. */
export const CLI_PROFILE = 'default'

/** The desktop app's upstream profile, which `delorun` refuses to run or manage. */
export const DESKTOP_PROFILE = 'desktop'

/**
 * Upstream's `headless` profile, which `delorun headless` boots through Delorun's composition with only its sandbox
 * protection checked, and whose run directory is `run/headless/`.
 */
export const HEADLESS_PROFILE = 'headless'

/**
 * Directory under `run/` that holds one record per process using the home's shared stores (C1,
 * "`run/data-users/<pid>`"); it is never a profile's run directory.
 */
export const DATA_USERS_DIRECTORY = 'data-users'

/** Upstream's package layer for every profile, `profiles/node_modules/`, a name upstream refuses as a profile. */
const UPSTREAM_PROFILES_PACKAGES = 'node_modules'

/** The device names Windows reserves in every folder, which no file or folder may take: `con`, `prn`, `aux`, `nul`, `com1` to `com9` and `lpt1` to `lpt9`. */
export const WINDOWS_DEVICE_NAMES: readonly string[] = ['con', 'prn', 'aux', 'nul', ...Array.from({ length: 9 }, (_, at) => `com${String(at + 1)}`), ...Array.from({ length: 9 }, (_, at) => `lpt${String(at + 1)}`)]

/**
 * Names no CLI profile may take (C1, "Profiles"), each mapped to the reason its refusal gives: a CLI profile of the
 * name would share a directory under `profiles/` or `run/` with something else in the same home, or be booted by a
 * command other than the CLI profile's start, or be a Windows device name ({@link WINDOWS_DEVICE_NAMES}). Upstream's
 * template names that nothing boots in a Delorun home, such as `web` and `tui`, stay usable.
 */
export const RESERVED_PROFILE_NAMES: ReadonlyMap<string, string> = new Map([
  [DESKTOP_PROFILE, 'it is the desktop app\'s own profile, which only the desktop app runs or changes'],
  [HEADLESS_PROFILE, 'it is the profile `delorun headless` boots, which Delorun checks for its sandbox protection only, not for every protection a CLI profile\'s start requires'],
  [DATA_USERS_DIRECTORY, 'run/data-users/ holds the records of every process that uses the home\'s shared stores, so a profile\'s run directory there would escape the home-wide exclusion'],
  [UPSTREAM_PROFILES_PACKAGES, 'profiles/node_modules/ is upstream\'s package layer for every profile, which upstream refuses as a profile'],
  ...WINDOWS_DEVICE_NAMES.map(name => [name, 'it is a Windows device name, which Windows does not let a folder take, so the profile\'s folders could not exist there'] as const),
])

// The reserved names hold only letters, digits, hyphens and underscores, which are literal in a pattern outside a
// character class.
const RESERVED_ALTERNATIVES = [...RESERVED_PROFILE_NAMES.keys()].join('|')

/**
 * A CLI profile's name (C1, "Profiles"): 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a
 * letter or a digit, and none of {@link RESERVED_PROFILE_NAMES}. A name that matches never leaves `profiles/` and a
 * shell passes it unquoted. Callers check a name with {@link profileNameProblem}, whose refusal says why.
 */
export const PROFILE_NAME_PATTERN = new RegExp(`^(?!(?:${RESERVED_ALTERNATIVES})$)[a-z0-9][a-z0-9_-]{0,31}$`, 'u')

/**
 * The spelling of a profile name alone, without the reserved names: a name that matches never leaves `profiles/` and a
 * shell passes it unquoted. Code that builds a path under a profile's directory for any profile, including the reserved
 * `headless` profile that `delorun headless` boots, checks this; a name offered as a new CLI profile uses
 * {@link profileNameProblem}.
 */
export const PROFILE_NAME_SYNTAX = /^[a-z0-9][a-z0-9_-]{0,31}$/u

/**
 * Why a name cannot be a CLI profile (C1, "Profiles"). The launcher and `delorun` refuse every name this check
 * refuses, before the name becomes a path. A reserved name is recognised in any letter case, since the home may lie on
 * a case-insensitive filesystem.
 * @param name - the candidate profile name.
 * @returns a sentence that quotes the name and says why it is refused, or `undefined` for a usable name.
 */
export function profileNameProblem(name: string): string | undefined {
  const reserved = RESERVED_PROFILE_NAMES.get(name.toLowerCase())
  if (reserved !== undefined) return `${JSON.stringify(name)} is reserved: ${reserved}`
  if (!PROFILE_NAME_PATTERN.test(name)) {
    return `${JSON.stringify(name)} is not a profile name: a profile is 1 to 32 lowercase letters, digits, hyphens or underscores, starting with a letter or digit`
  }
  return undefined
}

/**
 * Top-level entries Delorun adds to the home; every other entry is upstream's. Each is a directory that the home tree's
 * creation makes at {@link PRIVATE_DIR_MODE}; `home-entries.spec.ts` fails on Delorun code that builds a top-level path
 * this list does not name.
 */
export const DELORUN_HOME_ENTRIES = {
  /** The runtime store. */
  runtimes: 'runtimes',
  /** Runtime installs in progress, outside the store on the same filesystem. */
  staging: 'staging',
  /** Plugin packs, verified and unpacked per release: `packs/<release>/<pack>/` (C1, C2). */
  packs: 'packs',
  /** The verified release root, timestamp and log checkpoint (C2, C18). */
  trust: 'trust',
  /** Each installation's update status record (C3). */
  status: 'status',
  /** The verified catalogue index and revocation list (C13). */
  catalogue: 'catalogue',
  /** Secret files, one directory per owning contract. */
  secrets: 'secrets',
  /** Per-profile run directories (`run/<profile>/`). */
  run: 'run',
  /** The Docker supervisor's roots file (C9). */
  supervisor: 'supervisor',
  /** The launcher copy used by the install script and login items. */
  bin: 'bin',
  /** Signed certificate-alert files (C5). */
  alerts: 'alerts',
  /** The session-data copy an update took and a restore's journal (C3). */
  dataCopies: 'data-copies',
  /** Chat data a rollback set aside (C3). */
  dataSetAside: 'data-set-aside',
  /** Trashed chats and workspaces until their retention ends or the person restores them (C8). */
  trash: 'trash',
  /** Workspace archive imports: their staging root and the imported workspaces (C8). */
  archive: 'archive',
  /** Approved plugin content, the change log, the protection setting and work sessions (Changes). */
  changes: 'changes',
} as const

/** Top-level files of the Delorun home that Delorun code writes, as opposed to the directories of {@link DELORUN_HOME_ENTRIES}. */
export const DELORUN_HOME_FILES = {
  /** The data-format record the running release keeps beside its chat data (C3). */
  dataFormat: 'data-format.json',
  /** The full list of what setup's import would copy from DeepSeek Harness, for the person to read (C11). */
  importPreview: 'import-preview.txt',
} as const

/**
 * Paths below the home that confined commands may read and execute. None
 * holds a secret, and no component writes a secret under one.
 */
export const READ_EXEMPTIONS = ['runtimes', 'skills', 'dsh-runtimes'] as const

/** Entries of `run/<profile>/`. */
export const RUN_ENTRIES = {
  /** The home lock, held by one home process per profile. */
  lock: 'home.lock',
  /** The start token written by each home-process start. */
  startToken: 'start-token',
  /** The update channel's Unix socket (C19). */
  updateSocket: 'update.sock',
  /** The Docker supervisor's Unix socket (C9). */
  supervisorSocket: 'supervisor.sock',
  /** The update journal (C19). */
  updateJournal: 'update.json',
  /** How the last update or rollback of the studio or terminal ended, until the person dismisses it (C19, "The outcome record"). */
  updateResult: 'update-result.json',
  /** The update check's record (C3, "Update check"). */
  updateCheck: 'update-check.json',
  /** The verified release notes of the update check's newest release (C3, "Update check"). */
  updateNotes: 'update-notes.txt',
  /** Fixtures of the confinement probes run at each start. */
  probe: 'probe',
} as const

/** The supervisor's roots file, relative to the home (C9). */
export const SUPERVISOR_ROOTS_FILE = 'supervisor/roots.json'

/** Mode of the home and of every directory Delorun creates under it. */
export const PRIVATE_DIR_MODE = 0o700

/** Mode of every protected file. */
export const PROTECTED_FILE_MODE = 0o600

/** Group and other permission bits; any of them makes a protected path laxer than its contract. */
export const FORBIDDEN_MODE_BITS = 0o077

/** Longest channel socket path, in bytes. */
export const SOCKET_PATH_MAX_BYTES = 103

/** Prefix of the Windows named pipes; the full name is `<prefix><homeId>-<profile>-<channel>`. */
export const WINDOWS_PIPE_PREFIX = '\\\\.\\pipe\\delorun-'

/** Number of lowercase hexadecimal digits of the home path's SHA-256 digest in `homeId`. */
export const HOME_ID_HEX_DIGITS = 16

/** Random bytes in one start token. */
export const START_TOKEN_BYTES = 32

/** Characters of one start token in base64url without padding. */
export const START_TOKEN_LENGTH = 43

/** Time a contender waits for the lock holder's `status` answer before reporting `HOME_UNRESPONSIVE`, in milliseconds. */
export const HOME_STATUS_TIMEOUT_MS = 2_000

/** Entries of the runtime store under `runtimes/`. */
export const STORE_ENTRIES = {
  /** The store's layout record, `{"layout":1}`. */
  layout: 'store.json',
  /** Pointer to the active version. */
  current: 'current',
  /** Pointer to the version kept for rollback. */
  previous: 'previous',
  /** Lock taken by install, switch and removal. */
  lock: 'store.lock',
} as const

/** Hexadecimal digits of the random name of one directory under `staging/`. */
export const STAGING_NAME_HEX_DIGITS = 16

/** Files under `trust/`; each is replaced atomically and never with an older version. */
export const TRUST_FILES = {
  /** The newest root that verified (C2). */
  root: 'root.json',
  /** The newest timestamp that verified; its `version` is the highest stored (C2). */
  timestamp: 'timestamp.json',
  /** The latest log checkpoint that verified (C18). */
  checkpoint: 'checkpoint.json',
  /** The release-log check state of each installed release (C18, "Check states"). */
  releaseLog: 'release-log.json',
  /** The release channel and log the launcher that installed the runtime was built for, which updates fetch from (C1). */
  channel: 'channel.json',
} as const

/**
 * Directory under `trust/` that holds the root chain an install walked, one `<n>.root.json` per version, oldest first
 * (C2, "Root metadata"): the proof a stored root newer than every root a launcher ships descends from one it ships.
 */
export const TRUST_ROOTS_DIRECTORY = 'roots'

/** Source of the regular expression one filed root's name matches: `<n>.root.json`, where `n` is its version. */
export const ROOT_FILE_NAME_PATTERN = '^([1-9][0-9]*)\\.root\\.json$'

/** Files under `status/`, one per installation (C3). */
export const STATUS_FILES = {
  /** Written by the CLI home. */
  cliHome: 'cli-home.json',
  /** Written by the desktop app. */
  desktopHost: 'desktop-host.json',
} as const

/** Files under `catalogue/` (C13). */
export const CATALOGUE_FILES = {
  /** The newest catalogue index that verified. */
  index: 'index.json',
  /** The newest revocation list that verified. */
  revocations: 'revocations.json',
  /** Each file's `sequence` and fetch time. */
  state: 'state.json',
} as const

/** The store layout number this contract defines. */
export const STORE_LAYOUT = 1

/** The launch protocol number this contract defines. */
export const LAUNCH_PROTOCOL = 1

/** Source of the regular expression a runtime version name matches. */
export const RUNTIME_VERSION_PATTERN = '^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$'

/** Longest runtime version name, in characters. */
export const RUNTIME_VERSION_MAX_LENGTH = 64

/** Largest pointer file, in bytes: one version and one newline. */
export const POINTER_FILE_MAX_BYTES = 65

/** Installed runtime versions the store keeps: `current` and `previous`. */
export const RETAINED_RUNTIME_VERSIONS = 2

/** Longest wait for `store.lock`, in milliseconds. */
export const STORE_LOCK_WAIT_MS = 30_000

/** Longest total retry time of a Windows pointer rename, in milliseconds. */
export const POINTER_RENAME_RETRY_MS = 2_000

/** Largest runtime archive the launcher downloads, in bytes (1 GiB). */
export const ARCHIVE_MAX_BYTES = 1_073_741_824

/** Largest signed manifest the launcher downloads, in bytes (4 MiB). */
export const MANIFEST_MAX_BYTES = 4_194_304

/** Time for a download connection to open, in milliseconds. */
export const DOWNLOAD_CONNECT_TIMEOUT_MS = 30_000

/** Time a download may deliver no byte before it fails, in milliseconds. */
export const DOWNLOAD_STALL_TIMEOUT_MS = 60_000

/**
 * The only hosts a release-file download may reach, redirects included. This list covers release files and nothing
 * else: the release-log check of contract C18 reads under a host list of its own, which names the log's origin and the
 * witness network's distributor, so neither list has to name the other's hosts.
 */
export const RELEASE_DOWNLOAD_HOSTS = ['releases.delorun.com', 'releases.delo.run', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] as const

/** A Delorun release version naming one directory of the runtime store. */
export type RuntimeVersion = Branded<'DelorunRuntimeVersion'>

/** The random id of one home-process start: 32 lowercase hexadecimal digits; not a secret. */
export type StartId = Branded<'DelorunStartId'>

/** One start token: 43 base64url characters; a secret that is never logged. */
export type StartToken = Branded<'DelorunStartToken'>

/** Contents of `runtimes/store.json`. */
export interface StoreLayoutRecord {
  /** The store layout number. */
  readonly layout: typeof STORE_LAYOUT
}

/** Contents of `run/<profile>/home.lock`. */
export interface HomeLockRecord {
  /** Record version. */
  readonly v: 1
  /** Process id of the holder. */
  readonly pid: number
  /** The holder's start id. */
  readonly startId: StartId
  /** The runtime version the holder runs. */
  readonly runtime: RuntimeVersion
  /** RFC 3339 UTC time the holder took the lock. */
  readonly startedAt: string
  /**
   * The holder process's start identity (C1, "The home lock"); absent where the platform has none and in records
   * written before it existed, which are judged by `pid` alone.
   */
  readonly processStart?: string
  /**
   * The pid namespace `pid` is numbered in, `pid:[<inode>]` (C1, "The home lock"); Linux only. A holder whose
   * namespace differs from the reader's is never judged dead.
   */
  readonly pidNamespace?: string
  /**
   * Present, `true`, while the holder's update channel listens on its socket: the holder writes it once the channel
   * is bound and removes it before the channel closes (C1, "The home lock"). A handed-over record has none until the
   * successor's channel listens.
   */
  readonly listening?: true
}

/** A confinement rule that Delorun's sandbox profiles add to upstream's dialects. */
export type ConfinementRule = 'home-write' | 'home-read' | 'token-read' | 'home-connect' | 'docker-connect' | 'wsl-interop'

/** The confinement rules, in the contract's order. */
export const CONFINEMENT_RULES: readonly ConfinementRule[] = ['home-write', 'home-read', 'token-read', 'home-connect', 'docker-connect', 'wsl-interop']

/** A sandbox dialect, or `none` when commands run without one. */
export type SandboxDialect = 'bwrap' | 'landlock' | 'seatbelt' | 'windows-acl' | 'none'

/** How one rule holds on this machine at this start. */
export type RuleStatus = 'enforced' | 'not-enforced' | 'unconfined' | 'unknown'

/** Why a rule is not `enforced`. */
export type RuleReason =
  | 'dialect-cannot-express'
  | 'docker-endpoint-network'
  | 'not-proven-on-platform'
  | 'probe-failed'
  | 'probe-not-run'
  | 'aliases-unknown'
  | 'no-sandbox'
  | 'full-access'

/** The state of one rule as `delorun verify` reports it. */
export interface RuleFinding {
  /** The rule's state. */
  readonly status: RuleStatus
  /** Present unless the status is `enforced`. */
  readonly reason?: RuleReason
}

/** The Docker endpoint of the active context, as the confinement probes resolved it. */
export interface DockerEndpoint {
  /** Transport of the endpoint. */
  readonly kind: 'unix' | 'npipe' | 'tcp' | 'ssh'
  /** The context's socket or pipe path, for `unix` and `npipe`. */
  readonly path?: string
  /** The socket's resolved real path, for `unix`. */
  readonly realPath?: string
}

/** The confinement rules' states recorded at one home-process start. */
export interface ConfinementReport {
  /** The dialect upstream's sandbox provider selected. */
  readonly dialect: SandboxDialect
  /** One finding per rule. */
  readonly rules: Readonly<Record<ConfinementRule, RuleFinding>>
  /** The Docker endpoint, when a Docker context exists. */
  readonly dockerEndpoint?: DockerEndpoint
}

/** A path whose mode or DACL is laxer than this contract allows, with its fix. */
export interface ModeFinding {
  /** Absolute path. */
  readonly path: string
  /** Whether the path is a directory or a protected file. */
  readonly kind: 'directory' | 'file'
  /** The mode found, on Linux and macOS. */
  readonly found?: number
  /** The mode required, on Linux and macOS. */
  readonly required?: typeof PRIVATE_DIR_MODE | typeof PROTECTED_FILE_MODE
  /** The command that fixes it: `chmod` on Linux and macOS, `icacls` on Windows. */
  readonly fix: string
}

/** Error codes of this contract. */
export type HomeLayoutErrorCode =
  | 'HOME_INVALID'
  | 'HOME_IS_DSH_HOME'
  | 'HOME_MODE'
  | 'SECRET_FILE_MODE'
  | 'SOCKET_PATH_TOO_LONG'
  | 'HOME_IN_WRITABLE_ROOT'
  | 'HOME_RUNNING'
  | 'HOME_UNRESPONSIVE'
  | 'STORE_BUSY'
  | 'NO_ACTIVE_RUNTIME'
  | 'POINTER_REPLACE_FAILED'
  | 'RUNTIME_INCOMPATIBLE'
  | 'INSTALL_VERIFY_FAILED'
  | 'DOWNLOAD_REFUSED'
