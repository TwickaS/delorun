/**
 * The studio's update routes as the browser reads them: their paths, the refusal codes and the JSON fields each answers
 * with (design `delorun/docs/design/update-and-rollback.md`; contract C19, "The studio's update"). The Host's routes
 * build these fields and the studio's update screens read them; this module imports only types, so both halves share it.
 * The page never holds the home process's channel token or report id: it holds an opaque `handle` the Host maps to the
 * report it kept in memory.
 * @module @delorun/plugin-update/wire
 */
import type { UpdateKind, UpdateNotice, UpdateReport } from '@delorun/contract-update-report'

/** The path prefix of every update route. */
export const UPDATE_ROUTE_PREFIX = '/delorun/update'

/**
 * The update routes. `state` is a `GET`; every other route is a `POST` decided before its body is read (the site, then
 * the control's level for the requester, then the proof).
 *
 * - `check`: run the release check now, answering {@link UpdateCheckedView}.
 * - `prepare`: fetch, verify and install the newest release and answer `{ prepared }` holding its {@link PreparedUpdateView}.
 * - `apply`: begin the update of a prepared release, body {@link UpdateApplyBody}, answering {@link UpdateBegunView}.
 * - `cancel`: end an update or a rollback that still waits for chats, answering {@link UpdateCancelView}.
 * - `rollback`: go back from the committed update, body {@link RollbackBody}, answering {@link UpdateBegunView}.
 * - `dismiss`: forget the outcome record the screen showed, answering `{}`.
 * - `stop`: stop Delorun, body {@link StopBody}, answering {@link StopBegunView}.
 * - `stop-chats`: while an update waits for running chats, stop them and record them for continuing after the update, answering {@link StopChatsView}.
 * - `continue-chat`: send the one continue message to a chat the update stopped, body {@link ContinueChatBody}, answering {@link ContinueChatView}.
 */
export const UPDATE_PATHS = {
  state: `${UPDATE_ROUTE_PREFIX}/state`,
  check: `${UPDATE_ROUTE_PREFIX}/check`,
  prepare: `${UPDATE_ROUTE_PREFIX}/prepare`,
  apply: `${UPDATE_ROUTE_PREFIX}/apply`,
  cancel: `${UPDATE_ROUTE_PREFIX}/cancel`,
  rollback: `${UPDATE_ROUTE_PREFIX}/rollback`,
  dismiss: `${UPDATE_ROUTE_PREFIX}/dismiss`,
  stop: `${UPDATE_ROUTE_PREFIX}/stop`,
  stopChats: `${UPDATE_ROUTE_PREFIX}/stop-chats`,
  continueChat: `${UPDATE_ROUTE_PREFIX}/continue-chat`,
} as const

/**
 * The controls these routes are, in the Changes access table (`@delorun/plugin-changes/access`):
 *
 * - `update-check`, `update-cancel` and `update-dismiss` (which `continue-chat` also uses: it sends one fixed message to a chat the update stopped): class `free`, any paired device with no prompt (they read, or only
 *   take back);
 * - `update-begin` (which `stop-chats` also uses, since it ends running chats to let the update go on), `update-rollback` and `stop`: class `face`, the computer, or a device with a Face ID (or PIN) grant for
 *   exactly that call. While the Face ID flag is off, and for a device with no passkey, the unlock of today applies:
 *   `update-begin` and `update-rollback` while Phone powers is Full, `stop` at either level.
 */
export type UpdateControl = 'update-check' | 'update-begin' | 'update-cancel' | 'update-rollback' | 'update-dismiss' | 'stop'

/** Every {@link UpdateControl}. */
export const UPDATE_CONTROLS: readonly UpdateControl[] = ['update-check', 'update-begin', 'update-cancel', 'update-rollback', 'update-dismiss', 'stop']

/** Whether a request may use a control now, and if not, what it needs: the computer, Face ID for this call, or an unlock entered on the device. */
export type UpdateMayView =
  | { readonly ok: true }
  | { readonly ok: false, readonly needs: 'computer' | 'unlock' | 'face' }

/** Who may use what, for the request that read `state`. */
export interface UpdateAccessView {
  /** Where the request came from. */
  readonly actor: 'computer' | 'device-unlocked' | 'device-grace' | 'device-locked'
  /** The Phone powers level in force. */
  readonly phonePowers: 'careful' | 'full'
  /** Every control's decision. */
  readonly may: Readonly<Record<UpdateControl, UpdateMayView>>
}

/** The refusal codes of these routes, besides those of the Changes routes (`CROSS_SITE`, `LOOPBACK_REQUIRED`, `ELEVATION_REQUIRED`, `BAD_REQUEST`). */
export type UpdateRefusalCode =
  /** The Host runs no installed release under `delorun start`, so it has no home process to update it. */
  | 'UPDATE_UNAVAILABLE'
  /** `stop-chats` while no update waits for running chats. */
  | 'NO_UPDATE_PENDING'
  /** `continue-chat` for a chat the update did not stop, or one already continued. */
  | 'NOT_STOPPED_BY_UPDATE'
  /** The `handle` names no report this Host holds, or its report is older than 600 seconds: prepare again. */
  | 'REPORT_EXPIRED'
  /** A restart or another update or rollback runs. */
  | 'UPDATE_IN_PROGRESS'
  | 'RESTART_IN_PROGRESS'
  /** The report holds an item the person has not ticked (see {@link UpdateConfirmView.ticks}). */
  | 'ACKNOWLEDGEMENT_MISSING'
  /** The report cannot be confirmed: a conflicted harness file or a failed release-log check (see {@link UpdateConfirmView.blocked}). */
  | 'REPORT_BLOCKED'
  /** Changes to the running harness wait for review; the screen links to Settings → Changes. */
  | 'HARNESS_CHANGES_PENDING'
  | 'HARNESS_REPORT_STALE'
  | 'HARNESS_COPY_UNREADABLE'
  | 'DATA_COPY_NO_SPACE'
  | 'CHATS_RUNNING'
  | 'NO_UPDATE_RECORD'
  | 'ROLLBACK_NEEDS_DATA_COPY'
  | 'ROLLBACK_TARGET_UNUSABLE'
  | 'NO_RUNTIME_STORE'
  | 'VERIFY_FAILED'
  | 'CHANNEL_UNREACHABLE'
  | 'GIT_UNAVAILABLE'
  | 'TARGET_LOWER'
  | 'NO_UPDATE_AVAILABLE'
  /** The home process refused with a code this list does not name; the Host log has it. */
  | 'UPDATE_FAILED'

/** How running chats are treated while an update, a rollback or a stop waits: for them to end, or by stopping them. */
export type ChatChoice = 'wait' | 'stop'

/** The answer of the check route and the `check` part of `state`. */
export interface UpdateCheckedView {
  /** Whether the release check is on (Settings → General → Updates); off, there is nothing to show or run. */
  readonly enabled: boolean
  /** When the last check ran, in milliseconds since the epoch; absent before the first. */
  readonly checkedAt?: number
  /** Whether the last check failed. */
  readonly failed?: boolean
  /** The newer release, or absent when none is known. */
  readonly notice?: UpdateNotice
}

/**
 * What the page must still do before the apply route accepts a prepared report. Each tick key names one thing the
 * person has to accept: `item:<index>` for an item of `report.items` the update disables or removes, merges into a
 * harness file neither side had, or could not verify; `log` for a release whose log check did not complete; `data-no-copy`
 * for chat data that changes format when the person declines the copy. The Host refuses `apply` without every key.
 */
export interface UpdateConfirmView {
  /** The tick keys the apply route requires, in report order. */
  readonly ticks: readonly string[]
  /**
   * Why the report cannot be confirmed at all, and so offers no Update: `harness-conflict` for a harness file whose
   * approved content conflicts with the target's, `log-failed` for a failed release-log check.
   */
  readonly blocked?: 'harness-conflict' | 'log-failed'
  /** The index into `report.items` of the chat-data item, when the report has one. */
  readonly dataItem?: number
}

/** A prepared update: the report the Host holds, and the handle the page applies it with. */
export interface PreparedUpdateView {
  /** An opaque handle for `apply`; it never carries the home process's report id. */
  readonly handle: string
  /** When the Host drops the report, in milliseconds since the epoch (600 seconds after it was made). */
  readonly expiresAt: number
  /** C3's report for this installation and the target release; render every string as text. */
  readonly report: UpdateReport
  /** How far the target moves from the running release. */
  readonly kind: UpdateKind
  /** The release's one-line summary and verified notes, which the page labels "Release note:"; never an instruction. */
  readonly releaseNote?: string
  /** What the person must tick, and whether the report can be confirmed. */
  readonly confirm: UpdateConfirmView
  /** How many chats run now. */
  readonly runningChats: number
}

/** The body of the apply route. */
export interface UpdateApplyBody {
  /** {@link PreparedUpdateView.handle}. */
  readonly handle: string
  /** `wait` drains running chats, up to the Host's configured limit; `stop` cancels them. */
  readonly chats: ChatChoice
  /** Whether a session-data copy is taken before the switch; the report's data item says what it costs. */
  readonly dataCopy: boolean
  /** The tick keys the person ticked. */
  readonly acknowledged: readonly string[]
}

/** The body of the rollback route. */
export interface RollbackBody {
  /** `wait` drains running chats; `stop` cancels them. */
  readonly chats: ChatChoice
  /** Restore only the profile's settings and keep the running release (offered when no data copy exists). */
  readonly profileOnly: boolean
}

/** The body of the stop route. */
export interface StopBody {
  /** `wait` lets running chats end first, up to the home process's drain limit; `stop` cancels them. */
  readonly chats: ChatChoice
}

/** The answer of the apply and rollback routes: the home process began, and the answer comes before the Host stops. */
export interface UpdateBegunView {
  readonly kind: 'update-begun' | 'rollback-begun'
  /** The version the Host moves to. */
  readonly target: string
  /** How many chats run now. */
  readonly runningChats: number
}

/** The answer of the cancel route. */
export interface UpdateCancelView {
  /** False when nothing waited. */
  readonly cancelled: boolean
}

/** The answer of the stop route; nothing in the studio starts Delorun again. */
export interface StopBegunView {
  readonly kind: 'stopping'
  readonly runningChats: number
}

/** The phases the page shows while an update or a rollback runs, as the home process names them. */
export type UpdatePhaseView = 'checking' | 'installing' | 'reporting' | 'snapshot' | 'waiting' | 'switching' | 'health-check' | 'committed' | 'rolling-back'

/** What the Host is doing about an update now. */
export type UpdateProgressView =
  | { readonly kind: 'idle' }
  /** `update.prepare` runs: the home process's install progress, one line each. */
  | { readonly kind: 'preparing', readonly phase?: UpdatePhaseView, readonly lines: readonly string[] }
  /** `update.apply` or `rollback` runs. `waiting` refuses new turns with `UPDATE_PENDING`; `switching` and `health-check` end this Host's answers. */
  | { readonly kind: 'applying' | 'rolling-back', readonly phase: UpdatePhaseView, readonly target: string, readonly runningChats: number }
  /** A stop waits for chats. */
  | { readonly kind: 'stopping', readonly runningChats: number }

/** How an update or a rollback ended, as the home process recorded it in `run/<profile>/update-result.json`. */
export interface UpdateResultView {
  /** Whether the person's update or the person's rollback ended. */
  readonly kind: 'update' | 'rollback'
  /**
   * `committed`: the new release runs; `rolled-back`: it did not work and Delorun went back (an update) or the
   * rollback finished; `aborted`: nothing changed; `failed`: Delorun stopped before it could finish (the launcher's
   * next start finishes it; the recovery screen is the way in the meantime).
   */
  readonly outcome: 'committed' | 'rolled-back' | 'aborted' | 'failed'
  /** The version that ran before. */
  readonly from: string
  /** The version the attempt moved to. */
  readonly to: string
  /** The refusal or failure code, for `rolled-back`, `aborted` and `failed`. */
  readonly reason?: string
  /** The first health criterion the target failed, such as `H2-host-ready`. */
  readonly criterion?: string
  /** When it ended, as an RFC 3339 UTC time. */
  readonly at: string
}

/** One section's bullets of a version's notes. */
export interface UpdateNotesArea {
  /** The area the bullets belong to, such as `Studio`. */
  readonly area: string
  /** The bullets, with their section (`Added`, `Fixed`, and so on). */
  readonly items: readonly { readonly section: string, readonly text: string }[]
}

/** One version's notes from the installed release's changelog. */
export interface UpdateNotesVersion {
  readonly version: string
  /** The day the version was assembled, `YYYY-MM-DD`, when the changelog records it. */
  readonly date?: string
  /** Up to three one-line highlights: the version's headlines, or its first bullets when it has none. */
  readonly highlights: readonly string[]
  /** The full entries, by area. */
  readonly areas: readonly UpdateNotesArea[]
}

/**
 * The notes of a finished update, newest version first: every version after the one that ran before, up to the one that
 * runs now, read from the installed release. At most 20 versions and about 64 KB; `truncated` says a cap cut the list.
 */
export interface UpdateNotesView {
  readonly versions: readonly UpdateNotesVersion[]
  readonly truncated: boolean
}

/** A chat that runs now, as the Stop running chats confirm step names it. */
export interface RunningChatView {
  readonly sessionId: string
  /** The chat's title; empty when it has none yet. */
  readonly title: string
}

/** How a chat the update stopped stands: waiting for the update, continued once, skipped, or left for the person's Continue button. */
export type StoppedChatState = 'stopped' | 'continued' | 'skipped-missing' | 'skipped-running' | 'failed'

/** One chat the update stopped. */
export interface StoppedChatView extends RunningChatView {
  readonly state: StoppedChatState
}

/** The chats the update stopped, until the person dismisses the outcome card. */
export interface StoppedChatsView {
  /** Whether the Host continues them by itself after the update (the setting was on when it started). */
  readonly automatic: boolean
  readonly chats: readonly StoppedChatView[]
}

/** The answer of the stop-chats route. */
export interface StopChatsView {
  /** The chats stopped and recorded. */
  readonly chats: readonly RunningChatView[]
}

/** The body of the continue-chat route. */
export interface ContinueChatBody {
  readonly sessionId: string
}

/** The answer of the continue-chat route. */
export interface ContinueChatView {
  readonly state: StoppedChatState
}

/** What a rollback needs, from the committed update record. */
export interface RollbackStateView {
  /** Whether a committed update record names the release this Host runs, so Go back is offered. */
  readonly available: boolean
  /** The version Go back returns to. */
  readonly to?: string
  /** Whether the two releases' chat data differs, and the update took no copy, so only the settings can go back (`profileOnly`). */
  readonly dataCopyMissing?: boolean
}

/** The answer of the state route. */
export interface UpdateStateView {
  /** The release this Host runs; the page reloads once when its own loaded release differs. */
  readonly release: { readonly delorun: string, readonly dsh: string }
  /** Whether this Host has a home process that can update, roll back and stop it. */
  readonly available: boolean
  readonly access: UpdateAccessView
  readonly check: UpdateCheckedView
  readonly progress: UpdateProgressView
  /** The prepared report this Host holds, until it expires or is applied. */
  readonly prepared?: PreparedUpdateView
  /** How the last update or rollback ended, until the person dismisses it. */
  readonly result?: UpdateResultView
  readonly rollback: RollbackStateView
  /** The notes of the update the `result` records, present only for a committed update whose changelog the install holds. */
  readonly notes?: UpdateNotesView
  /** The chats running now, for the Stop running chats confirm step; only for a request that may begin an update, and only while an update waits. */
  readonly runningChats?: readonly RunningChatView[]
  /** The chats the update stopped, with how each stands. */
  readonly stopped?: StoppedChatsView
  /** Whether the Host continues stopped chats by itself after an update (Settings → Updates). */
  readonly continueStopped: boolean
}
