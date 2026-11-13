/**
 * Types and constants of contract C20, the operational logs
 * (`delo/docs/contracts/c20-operational-logs.md`): the surfaces and their
 * files, the log record, rotation and retention, the redactor's key names and
 * limits, and `delorun logs`. The package holds no runtime behaviour; the
 * contract page is the authority for every value here.
 *
 * @module @delo/contract-operational-logs
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
// Type-only: the `deloSecrets` service augmentation below.
import type {} from '@deepseek-ai/cordis'

/** Upstream's session id; the same branded type as `SessionId` of `@deepseek-ai/dsh-session`. */
export type SessionId = Branded<'SessionId'>

/** Upstream's workspace id; the same branded type as `WorkspaceId` of `@deepseek-ai/dsh-workspace`. */
export type WorkspaceId = Branded<'WorkspaceId'>

/** A surface kind; the home process and the supervisor are named per profile. */
export type SurfaceKind = 'home' | 'supervisor' | 'desktop-host' | 'relay'

/** A surface name: `home-<profile>`, `supervisor-<profile>`, `desktop-host` or `relay`. */
export type SurfaceName = `home-${string}` | `supervisor-${string}` | 'desktop-host' | 'relay'

/** Active file of each surface: a path relative to the Delo home, or the relay container's absolute path. */
export const SURFACE_FILES = {
  /** `<profile>` is replaced by the CLI profile. */
  home: 'logs/home-<profile>/home.log',
  /** `<profile>` is replaced by the CLI profile. */
  supervisor: 'logs/supervisor-<profile>/supervisor.log',
  /** Written by the desktop app's main process. */
  'desktop-host': 'logs/desktop-host/desktop-host.log',
  /** Inside the relay container, on the volume its guide names. */
  relay: '/var/log/delo-relay/relay.log',
} as const

/** Glob of upstream's startup reports under the Delo home, which `delorun` never writes. */
export const UPSTREAM_STARTUP_REPORTS = 'logs/startup-*.log'

/** A record's level. */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

/** One log record, one JSON line. */
export interface LogRecord {
  /** RFC 3339 UTC time with milliseconds. */
  readonly ts: string
  /** The level. */
  readonly level: LogLevel
  /** The writing surface. */
  readonly surface: SurfaceName
  /** The writing process id. */
  readonly pid: number
  /** C1's start id, on the home-process and supervisor surfaces. */
  readonly startId?: string
  /** The Cordis logger name, or `stdout` or `stderr` for captured output. */
  readonly logger: string
  /** Whether Delo wrote the record or captured it from upstream code's output. */
  readonly source: 'delo' | 'captured'
  /** The redacted message. */
  readonly msg: string
  /** Upstream's session id, when the record belongs to a session. */
  readonly sessionId?: SessionId
  /** The number of upstream's `turn/start` event, when the record belongs to a turn. */
  readonly turn?: number
  /** Upstream's workspace id, when the record belongs to a workspace. */
  readonly workspaceId?: WorkspaceId
  /** The redacted error, on error records. */
  readonly err?: {
    /** The error's name. */
    readonly name: string
    /** The error's code, when it has one. */
    readonly code?: string
    /** The redacted message. */
    readonly message: string
    /** The redacted stack. */
    readonly stack?: string
  }
  /** Bytes removed to fit {@link RECORD_MAX_BYTES}. */
  readonly truncated?: number
}

/** Largest record line, newline included, in bytes. */
export const RECORD_MAX_BYTES = 16_384

/** Largest captured line held while its newline is awaited, in bytes. */
export const CAPTURED_LINE_MAX_BYTES = 65_536

/** Size at which the active file rotates, in bytes (10 MiB). */
export const ROTATE_BYTES = 10_485_760

/** Files kept per surface: the active file and 4 rotated files. */
export const KEPT_FILES = 5

/** Age after which a file whose oldest record is older is deleted, in milliseconds (14 days). */
export const RETENTION_MS = 1_209_600_000

/** Interval of the age check while a Delo process runs, in milliseconds. */
export const AGE_CHECK_INTERVAL_MS = 3_600_000

/** Mode of log directories. */
export const LOG_DIR_MODE = 0o700

/** Mode of log files. */
export const LOG_FILE_MODE = 0o600

/** Shortest secret value the redactor registers, in characters. */
export const MIN_REGISTERED_SECRET_LENGTH = 8

/** Substrings of object keys whose values the redactor replaces, compared without case. */
export const REDACTED_KEY_PARTS = ['key', 'token', 'secret', 'password', 'passwd', 'cookie', 'credential', 'authorization', 'session'] as const

/** Record fields exempt from key-name redaction. */
export const REDACTION_EXEMPT_FIELDS = ['sessionId', 'startId', 'workspaceId'] as const

/** Kinds of registered secret values, shown as `[redacted:<kind>]`. */
export type SecretKind =
  | 'model-key'
  | 'start-token'
  | 'session-secret'
  | 'cookie'
  | 'owner-code'
  | 'pairing-code'
  | 'device-key'
  | 'relay-key'
  | 'helper-key'
  | 'deploy-key'
  | 'repository-token'

/** Where a process registers the secret values it loads or mints, so its log redacts them (C20, "Redaction", step 1). */
export interface SecretSink {
  /**
   * Register a secret value as it is loaded or minted, before it can reach a record.
   * @param value - the secret; a value shorter than 8 characters is not matched.
   * @param kind - what the value is.
   * @returns a disposer that drops this registration, for a value that is dropped or rotated.
   */
  register(value: string, kind: SecretKind): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The home process's secret registry; absent where no log redactor runs, such as in a plugin's own specs. */
    deloSecrets?: SecretSink
  }
}

/** Records `delorun logs` prints by default. */
export const DEFAULT_TAIL_RECORDS = 50

/** Most records `-n` prints. */
export const MAX_TAIL_RECORDS = 10_000

/** Surface names `delorun logs` accepts. */
export const CLI_SURFACES = ['home', 'supervisor', 'desktop-host', 'startup', 'relay'] as const
