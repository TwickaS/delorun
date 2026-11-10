/**
 * Types and constants of contract C19, the home process and update handshake
 * (`delo/docs/contracts/c19-home-process.md`): the home process's states, the
 * update channel's requests and responses, the handshake's phases and
 * outcomes, the update journal and every limit. The package holds no runtime
 * behaviour; the contract page is the authority for every value here.
 *
 * @module @delo/contract-home-process
 */

import type { RuntimeVersion, StartId, StartToken } from '@delo/contract-home-layout'

/** The update channel's protocol version. */
export const UPDATE_PROTOCOL_VERSION = 1

/** Home processes per CLI profile. */
export const HOME_PROCESSES_PER_PROFILE = 1

/** Longest wait of `delorun start` for `running`, in milliseconds. */
export const START_WAIT_MS = 120_000

/** Largest request line, in bytes. */
export const REQUEST_MAX_BYTES = 16_384

/** Time from connect to the request line, in milliseconds. */
export const REQUEST_DEADLINE_MS = 5_000

/** Open connections on the update channel. */
export const MAX_CONNECTIONS = 8

/** Refused-authentication log lines per second. */
export const AUTH_FAILURE_LOG_LINES_PER_SECOND = 1

/** Lifetime of an update report returned by `update.prepare`, in milliseconds. */
export const REPORT_LIFETIME_MS = 600_000

/** Smallest `drainTimeoutS`, in seconds. */
export const DRAIN_TIMEOUT_MIN_S = 60

/** Largest `drainTimeoutS`, in seconds. */
export const DRAIN_TIMEOUT_MAX_S = 86_400

/** Default `drainTimeoutS`, and the drain of `delorun stop`, in seconds. */
export const DRAIN_TIMEOUT_DEFAULT_S = 1_800

/** Time for a successor to report `ready` and pass its health check, in milliseconds. */
export const HEALTH_CHECK_TIMEOUT_MS = 120_000

/** File descriptor of the handover pipe a successor inherits. */
export const HANDOVER_FD = 3

/** Restarts a login item makes after failures within {@link LOGIN_RESTART_WINDOW_MS}. */
export const LOGIN_RESTART_LIMIT = 3

/** Window of {@link LOGIN_RESTART_LIMIT}, in milliseconds. */
export const LOGIN_RESTART_WINDOW_MS = 300_000

/** Exit code of `delorun status` when no home process runs. */
export const STATUS_EXIT_NOT_RUNNING = 3

/** A state of the home process. */
export type HomeProcessState = 'starting' | 'running' | 'waiting' | 'switching' | 'stopping' | 'standby'

/**
 * A phase of the update handshake, in order, then `rolling-back`: the update record's phase once a rollback has
 * begun its first step, kept until the runtime rolled back to has passed its health check.
 */
export type UpdatePhase = 'checking' | 'installing' | 'reporting' | 'snapshot' | 'waiting' | 'switching' | 'health-check' | 'committed' | 'rolling-back'

/** The final outcome of an update or rollback. */
export type UpdateOutcome = 'committed' | 'rolled-back' | 'aborted' | 'failed'

/** How the waiting phase treats running chats. */
export type DrainPolicy = 'drain' | 'abort-if-busy' | 'cancel'

/** How `stop` treats running chats. */
export type StopMode = 'drain' | 'cancel'

/** Fields every update-channel request carries. */
interface RequestBase {
  /** The protocol version. */
  readonly v: typeof UPDATE_PROTOCOL_VERSION
  /** The current start's token. */
  readonly token: StartToken
}

/** The `status` request. */
export interface StatusRequest extends RequestBase {
  /** The operation. */
  readonly op: 'status'
}

/** The `update.prepare` request. */
export interface UpdatePrepareRequest extends RequestBase {
  /** The operation. */
  readonly op: 'update.prepare'
  /** Arguments. */
  readonly args: {
    /** The target version; omitted for the newest release on the person's channel. */
    readonly target?: RuntimeVersion
  }
}

/** Arguments of a handshake that drains running chats. */
export interface DrainArgs {
  /** How running chats are treated. */
  readonly wait: DrainPolicy
  /** Longest wait for running chats, from {@link DRAIN_TIMEOUT_MIN_S} to {@link DRAIN_TIMEOUT_MAX_S}. */
  readonly drainTimeoutS?: number
}

/** The `update.apply` request. */
export interface UpdateApplyRequest extends RequestBase {
  /** The operation. */
  readonly op: 'update.apply'
  /** Arguments. */
  readonly args: DrainArgs & {
    /** The report `update.prepare` returned. */
    readonly reportId: string
    /** Whether a session-data copy is taken before the switch (C3, "Data formats"): the person's choice. */
    readonly dataCopy: boolean
  }
}

/** The `update.cancel` request. */
export interface UpdateCancelRequest extends RequestBase {
  /** The operation. */
  readonly op: 'update.cancel'
}

/** The `rollback` request: back from the update the update record names, through C3's rollback table. */
export interface RollbackRequest extends RequestBase {
  /** The operation. */
  readonly op: 'rollback'
  /** Arguments. */
  readonly args: DrainArgs & {
    /** Restore only the profile snapshot and keep the running runtime (C3's `--profile-only`). */
    readonly profileOnly: boolean
  }
}

/** The `stop` request. */
export interface StopRequest extends RequestBase {
  /** The operation. */
  readonly op: 'stop'
  /** Arguments. */
  readonly args: {
    /** How running chats are treated. */
    readonly mode: StopMode
  }
}

/**
 * The `studio.open-token` request: a fresh studio sign-in link for the person at the computer. The home process
 * accepts it only with the start token from the token file, never with the token the Host's own requests carry.
 */
export interface StudioOpenTokenRequest extends RequestBase {
  /** The operation. */
  readonly op: 'studio.open-token'
  /** Arguments; omitted for a link to the studio's own port. */
  readonly args?: {
    /**
     * A loopback port, 1 to 65535, that forwards to the studio, such as the local end of an SSH port forward: the
     * link names the studio's loopback host with this port, and signs in only there.
     */
    readonly port?: number
  }
}

/** Every request the update channel accepts; no request carries a path, an archive, a URL or a command. */
export type UpdateChannelRequest =
  | StatusRequest
  | UpdatePrepareRequest
  | UpdateApplyRequest
  | UpdateCancelRequest
  | RollbackRequest
  | StopRequest
  | StudioOpenTokenRequest

/** Error codes of this contract. */
export type HomeProcessErrorCode =
  | 'UNAUTHENTICATED'
  | 'SCHEMA_VIOLATION'
  | 'REQUEST_TIMEOUT'
  | 'REQUEST_TOO_LARGE'
  | 'BUSY'
  | 'UPDATE_IN_PROGRESS'
  | 'REPORT_EXPIRED'
  | 'UPDATE_PENDING'
  | 'CHATS_RUNNING'
  | 'DRAIN_TIMEOUT'
  | 'HEALTH_CHECK_FAILED'
  | 'VERIFY_FAILED'
  | 'NO_PREVIOUS'
  | 'NO_UPDATE_RECORD'
  | 'DATA_COPY_NO_SPACE'
  | 'ROLLBACK_NEEDS_DATA_COPY'
  | 'ROLLBACK_TARGET_UNUSABLE'
  | 'STUDIO_UNAVAILABLE'

/** The body of a `status` response line. */
export interface HomeStatus {
  /** The home process's state. */
  readonly state: HomeProcessState
  /** Its process id. */
  readonly pid: number
  /** Its start id. */
  readonly startId: StartId
  /** Runtime versions. */
  readonly runtime: {
    /** The version `current` names. */
    readonly current: RuntimeVersion
    /** The version `previous` names, when it exists. */
    readonly previous?: RuntimeVersion
    /** The version this process runs. */
    readonly running: RuntimeVersion
  }
  /** Running chats on this Host. */
  readonly chats: number
  /** The studio's loopback address, such as `http://127.0.0.1:5173/`, once the Host serves it. */
  readonly studio?: string
  /** The update in progress, when one runs. */
  readonly update?: {
    /** Its phase. */
    readonly phase: UpdatePhase
    /** Its target version. */
    readonly target: RuntimeVersion
  }
}

/** The answer to `studio.open-token`. */
export interface StudioLink {
  /** The studio's loopback address with a launch token, such as `http://127.0.0.1:3080/?token=…`. */
  readonly url: string
  /**
   * Whether the token works once and for at most 60 seconds (C4, "Loopback sessions"); false when the profile keeps
   * upstream's reusable launch token.
   */
  readonly oneTime: boolean
}

/** One response line; the final line of a handshake carries `outcome`. */
export type UpdateChannelResponse =
  | { readonly ok: true, readonly status: HomeStatus }
  | ({ readonly ok: true } & StudioLink)
  | { readonly ok: true, readonly phase: UpdatePhase }
  /** One line of the target's install progress during `update.prepare`, as the launcher prints it, newline included. */
  | { readonly ok: true, readonly line: string }
  | { readonly ok: true, readonly reportId: string, readonly report: unknown }
  | { readonly ok: true, readonly outcome: UpdateOutcome, readonly reason?: HomeProcessErrorCode }
  | { readonly ok: false, readonly error: HomeProcessErrorCode }

/** What C3's health check holds an update's target to, from the update report, as the update record keeps it. */
export interface UpdateHealth {
  /** H3: the plugins the report names as disabled at boot. */
  readonly disabledPlugins: readonly string[]
  /** H3, H4: the rows the report names, by id or name. */
  readonly namedRows: readonly string[]
  /** H5: the bundle list the report predicts; absent when the report predicts none. */
  readonly bundles?: readonly string[]
}

/**
 * Contents of `run/<profile>/update.json`, the update record: written at each phase from `snapshot` on and marked
 * `committed` by the successor once it runs, so a later rollback reads it. A rollback rewrites it with phase
 * `rolling-back` before its first step, and the record goes only once the runtime rolled back to has passed its
 * health check. An update that ends before switching removes it. While an update runs, the previous update's
 * committed record waits in `run/<profile>/update.previous.json` and returns when the update ends without committing.
 */
export interface UpdateJournal {
  /** Record version. */
  readonly v: 1
  /** The version that ran before the update. */
  readonly from: RuntimeVersion
  /** The target version. */
  readonly to: RuntimeVersion
  /** The version the `previous` pointer named before the update; absent when no `previous` pointer existed. */
  readonly previous?: RuntimeVersion
  /** The phase that started last. */
  readonly phase: UpdatePhase
  /** RFC 3339 UTC time the update started. */
  readonly startedAt: string
  /** Whether the two releases' chat data differs (C3, "Data formats"). */
  readonly dataDiffers: boolean
  /** Whether the update takes a session-data copy. */
  readonly copy: boolean
  /** Whether the target's process was spawned; written and synced before the spawn. */
  readonly targetStarted: boolean
  /** The id of the profile history version the `snapshot` phase saved; absent until it is saved. */
  readonly snapshot?: string
  /**
   * Present when C3's table refused the automatic rollback: the pointers name `to`, and a start refuses to run until
   * the person rolls back the profile alone or starts in safe mode.
   */
  readonly refused?: true
  /** What the health check holds `to` to, so a start that finishes an interrupted update runs H1 to H5. */
  readonly health?: UpdateHealth
}

/** A message on the handover pipe from successor to predecessor. */
export type HandoverMessage = { readonly type: 'ready' } | { readonly type: 'failed', readonly reason: HomeProcessErrorCode }
