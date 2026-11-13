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

/** Longest wait of `delorun stop --now` for the home process's final line, in milliseconds. */
export const STOP_NOW_ANSWER_MS = 60_000

/** Wait of `delorun stop --now` for a home process it sent `SIGTERM` to exit before it sends `SIGKILL`, in milliseconds. */
export const STOP_TERM_GRACE_MS = 30_000

/** Wait of `delorun stop --now` for a home process it sent `SIGKILL` to exit, in milliseconds. */
export const STOP_KILL_WAIT_MS = 5_000

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

/**
 * The `devices.approve` request: C5's local approval at the home's own computer. Without arguments it opens the approval
 * window and answers once a request is pending or the window closed; with `requestId` and `typedCode` it approves that
 * request; with `cancelRequestId` alone it cancels that pending request, which frees its place among the 5 pending.
 * Accepted only with the token the person's own `delorun` reads from the token file, and refused with
 * `LOOPBACK_REQUIRED` for the Host's channel token, which acts for studio sessions on every listener.
 */
export interface DevicesApproveRequest extends RequestBase {
  /** The operation. */
  readonly op: 'devices.approve'
  /** Arguments. */
  readonly args: {
    /** The pending request to approve. */
    readonly requestId?: string
    /** The 8-digit match code the person typed from the new device's screen. */
    readonly typedCode?: string
    /** The pending request to cancel; it comes without `requestId` and `typedCode`. */
    readonly cancelRequestId?: string
  }
}

/**
 * The `devices.remove` request: removing a trusted device at the home's own computer, which ends its sessions and closes
 * its reach connections at once. Accepted only with the token the person's own `delorun` reads from the token file, and
 * refused with `LOOPBACK_REQUIRED` for the Host's channel token.
 */
export interface DevicesRemoveRequest extends RequestBase {
  /** The operation. */
  readonly op: 'devices.remove'
  /** Arguments. */
  readonly args: {
    /** The device to remove, as `delorun devices list` names it. */
    readonly deviceId: string
  }
}

/**
 * The `devices.elevate` request: the person at the home's own computer answers a device's request to unlock sensitive
 * actions (C14, "Elevation"). Without arguments it answers the waiting requests and the running elevations; with
 * `requestId` and `typedCode` it approves that request with the code the device shows; with `revokeId` alone it declines
 * that request or ends that elevation. Accepted only with the token the person's own `delorun` reads from the token file,
 * and refused with `LOOPBACK_REQUIRED` for the Host's channel token.
 */
export interface DevicesElevateRequest extends RequestBase {
  /** The operation. */
  readonly op: 'devices.elevate'
  /** Arguments. */
  readonly args: {
    /** The waiting request to approve. */
    readonly requestId?: string
    /** The 8-digit code the person typed from the device's screen. */
    readonly typedCode?: string
    /** The request to decline or the elevation to end; it comes without `requestId` and `typedCode`. */
    readonly revokeId?: string
  }
}

/**
 * The `permission.reload` request: the per-workspace permission store of `@delo/plugin-permission-defaults` was changed
 * at the home's own computer by `delorun workspace full-access`, which writes the store itself; the running Host reads
 * it again, and sets the open chats of a workspace that lost its grant back to the safer preset. Accepted with either
 * token, because it changes nothing the store does not already hold.
 */
export interface PermissionReloadRequest extends RequestBase {
  /** The operation. */
  readonly op: 'permission.reload'
}

/**
 * The `mcp.list` request: the stdio MCP servers whose start the running Host's add-time consent refused, and the
 * accepted starts its acceptance store holds. Accepted with either token.
 */
export interface McpListRequest extends RequestBase {
  /** The operation. */
  readonly op: 'mcp.list'
}

/** Arguments of an answer to one pending MCP server review. */
export interface McpReviewArgs {
  /** The server's configured name, `[A-Za-z0-9_-]{1,32}`. */
  readonly serverName: string
  /** The review id `mcp.list` showed: 32 lowercase hexadecimal digits. */
  readonly reviewId: string
}

/**
 * The `mcp.accept` request: the person accepted, at the home's own computer, the server start that `mcp.list` showed
 * with this review id; the Host records it and starts the server's refused rows again. Accepted only with the token the
 * person's own `delorun` reads from the token file, and refused with `LOOPBACK_REQUIRED` for the Host's channel token.
 */
export interface McpAcceptRequest extends RequestBase {
  /** The operation. */
  readonly op: 'mcp.accept'
  /** Arguments. */
  readonly args: McpReviewArgs
}

/**
 * The `mcp.decline` request: the person set aside, at the home's own computer, the server start that `mcp.list` showed
 * with this review id; the server stays stopped. Accepted only with the token from the token file, and refused with
 * `LOOPBACK_REQUIRED` for the Host's channel token.
 */
export interface McpDeclineRequest extends RequestBase {
  /** The operation. */
  readonly op: 'mcp.decline'
  /** Arguments. */
  readonly args: McpReviewArgs
}

/**
 * The `mcp.revoke` request: the person withdrew, at the home's own computer, the acceptance of one server that
 * `mcp.list` showed with this acceptance id; the Host drops it, records the start as revoked and stops that server's
 * running rows, leaving every other server's acceptance. Accepted only with the token from the token file, and refused
 * with `LOOPBACK_REQUIRED` for the Host's channel token.
 */
export interface McpRevokeRequest extends RequestBase {
  /** The operation. */
  readonly op: 'mcp.revoke'
  /** Arguments. */
  readonly args: {
    /** The acceptance id `mcp.list` showed: 32 lowercase hexadecimal digits. */
    readonly acceptanceId: string
  }
}

/**
 * The `reach.status` request: the live state of each reach option of contract C7 in the running Host. Accepted only with
 * the token the person's own `delorun` reads from the token file, and refused with `LOOPBACK_REQUIRED` for the Host's
 * channel token, because the answer names the tailnet address and each option's failure.
 */
export interface ReachStatusRequest extends RequestBase {
  /** The operation. */
  readonly op: 'reach.status'
}

/**
 * The `reach.apply` request: the running Host's reach service restarts its options from the `delo-reach` row the
 * profile now holds, after `delorun reach on|off` wrote it, and answers each option's state once its start settled.
 * Accepted only with the token from the token file, and refused with `LOOPBACK_REQUIRED` for the Host's channel token,
 * because C14 keeps managing remote access at the home's own computer.
 */
export interface ReachApplyRequest extends RequestBase {
  /** The operation. */
  readonly op: 'reach.apply'
}

/** One reach option's state as `reach.status` and `reach.apply` answer it (contract C7, "Provider states"). */
export interface ReachOptionStatus {
  /** C7's option id, such as `tailscale-private`. */
  readonly option: string
  /** C7's state, such as `ready` or `blocked`. */
  readonly state: string
  /** The option's studio address, once its row names one. */
  readonly address?: string
  /** C7's code, for `blocked` and `failed`, and for `degraded` when the cause is known. */
  readonly cause?: string
  /** The sentence that says what to do, with `cause`. */
  readonly detail?: string
}

/**
 * Every request the update channel accepts. No request carries a path, an archive or a URL the home process opens or
 * fetches, or a command it runs; `mcp.revoke` names an accepted start only by its acceptance id.
 */
export type UpdateChannelRequest =
  | StatusRequest
  | UpdatePrepareRequest
  | UpdateApplyRequest
  | UpdateCancelRequest
  | RollbackRequest
  | StopRequest
  | StudioOpenTokenRequest
  | DevicesApproveRequest
  | DevicesRemoveRequest
  | DevicesElevateRequest
  | PermissionReloadRequest
  | McpListRequest
  | McpAcceptRequest
  | McpDeclineRequest
  | McpRevokeRequest
  | ReachStatusRequest
  | ReachApplyRequest

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
  | 'CHANNEL_UNREACHABLE'
  | 'GIT_UNAVAILABLE'
  | 'NO_PREVIOUS'
  | 'NO_UPDATE_RECORD'
  | 'DATA_COPY_NO_SPACE'
  | 'ROLLBACK_NEEDS_DATA_COPY'
  | 'ROLLBACK_TARGET_UNUSABLE'
  | 'STUDIO_UNAVAILABLE'
  | 'HOST_STOP_FAILED'
  | 'NO_RUNTIME_STORE'
  | 'LOOPBACK_REQUIRED'
  | 'APPROVAL_FAILED'
  | 'APPROVALS_UNAVAILABLE'
  | 'REMOVAL_FAILED'
  | 'ELEVATION_FAILED'
  | 'CONSENT_UNAVAILABLE'
  | 'STALE_REVIEW'
  | 'CONSENT_FAILED'
  | 'REACH_UNAVAILABLE'

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
  | { readonly ok: true, readonly options: readonly ReachOptionStatus[] }
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

/**
 * A message on the handover pipe from successor to predecessor. A `failed` message names the first of C3's health
 * criteria the successor's Host failed, such as `H2-host-ready`, when it booted far enough to run the check.
 */
export type HandoverMessage = { readonly type: 'ready' } | { readonly type: 'failed', readonly reason: HomeProcessErrorCode, readonly criterion?: string | undefined }
