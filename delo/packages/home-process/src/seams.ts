/**
 * What the home process calls outside this package (contract C19): the runtime store, the profile's history, the
 * profile's Host and its running chats. Each is an interface here and is implemented by its owner:
 *
 * - {@link RuntimeStore}: `delo/packages/runtime-store` (C1's runtime store, with C2's and C18's checks). Until it
 *   lands, a home process has no store and refuses updates; specs use a fixture store.
 * - {@link ProfileSnapshots}: C3's profile history, with the store.
 * - {@link SessionDataCopies}: C3's session-data copy and the one rollback function, `delo/packages/update`.
 * - {@link HostRunner} and {@link ChatGate}: the profile's Host, booted through upstream's profile runner by
 *   `delorun`, and the Host's update plugin, which counts running chats, refuses new turns and cancels turns
 *   through upstream's cancellation.
 *
 * @module @delo/home-process/seams
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { StudioLink, UpdateJournal } from '@delo/contract-home-process'
import type { ExchangeOptions, ResponseLine, UnsignedRequest } from './client.ts'
import type { LocalDeviceApproval } from './devices-approve.ts'

/** C1's two pointers. */
export interface RuntimePointers {
  /** The version `current` names. */
  readonly current: RuntimeVersion
  /** The version `previous` names, when it exists. */
  readonly previous?: RuntimeVersion
}

/** What C3's health check holds a target to, from the update report. */
export interface HealthExpectations {
  /** H3: the plugins the report names as disabled at boot. */
  readonly disabledPlugins: readonly string[]
  /** H3, H4: the rows the report names, by id or name. */
  readonly namedRows: readonly string[]
  /** H5: the bundle list the report predicts, or `undefined` when the report predicts none. */
  readonly bundles?: readonly string[]
  /** H3, H4: the rows that were disabled or did not load on the previous release. */
  readonly previousFailures: readonly BootRow[]
  /**
   * H3: every row the previous release's Host had at boot, by id and plugin name, so a row that is gone fails unless the
   * report named it or disabled its plugin.
   */
  readonly previousRows: readonly BootRow[]
  /**
   * H3: the sandbox protection the previous release's Host booted with, which the target's may tighten and not loosen;
   * absent where no Host ran before, as in the check after a rollback's restart.
   */
  readonly previousProtection?: HostProtection | undefined
}

/**
 * The confinement a Host's sandbox row gives confined commands, as a successor's H3 compares its own with the previous
 * Host's: the protected home, the entries of it they may read, the sockets they cannot connect to and the directories
 * whose sockets would start programs outside the sandbox. Sockets the start found on the computer, such as Docker's,
 * are left out, because the next start may find others.
 */
export interface HostProtection {
  /** The protected home. */
  readonly protectedHome: string
  /** The entries of the home confined commands may read, relative to it. */
  readonly protectedHomeReadable: readonly string[]
  /** The sockets confined commands cannot connect to. */
  readonly deniedSockets: readonly string[]
  /** The directories whose sockets the sandbox hides. */
  readonly escapeSocketDirectories: readonly string[]
}

/** A row a Host had at boot, as the next release's health check compares it with its own. */
export interface BootRow {
  /** The row's id. */
  readonly id: string
  /** The plugin's name: its package name for a package plugin. */
  readonly name: string
  /**
   * Whether the Loader made the id up because the row's patch gives it none: such an id is new at each boot, so the
   * check matches the row by its plugin instead, and only such a row.
   */
  readonly generated: boolean
  /** For a row of a protected plugin (a guard, consent or sandbox row), the SHA-256 of its canonical config. */
  readonly configHash?: string | undefined
}

/** The health check's answer: passed, or the first criterion that failed. */
export type HealthVerdict =
  | { readonly passed: true }
  | { readonly passed: false, readonly criterion: string, readonly detail: string }

/** A version ready to switch to, with C3's update report against it. */
export interface PreparedRuntime {
  /** The target version, installed and verified. */
  readonly version: RuntimeVersion
  /** C3's update report, returned to the caller as it is. */
  readonly report: unknown
  /** What the health check holds the target to, apart from what the previous release's Host had at boot. */
  readonly health: Omit<HealthExpectations, 'previousFailures' | 'previousRows' | 'previousProtection'>
  /** Whether the report names a data change (C3, "Data formats"). */
  readonly dataDiffers: boolean
}

/**
 * How a home process is started: `successor` starts one in `standby` that reads the handover from the pipe it
 * inherits on file descriptor 3; `start` starts one as `delorun start --foreground` does.
 */
export type HomeCommandMode = 'successor' | 'start'

/** The command that starts a home process from a version's runtime. */
export interface HomeCommand {
  /** The executable. */
  readonly command: string
  /** Its arguments; never a token, which travels on the handover pipe. */
  readonly args: readonly string[]
  /** The working directory. */
  readonly cwd: string
}

/** The store-phase steps of contract C19's handshake: C1's runtime store. */
export interface RuntimeStore {
  /**
   * Read `current` and `previous`.
   * @returns the pointers.
   * @throws when `current` is missing, malformed or names no installed version (C1's `NO_ACTIVE_RUNTIME`).
   */
  pointers(): Promise<RuntimePointers>
  /**
   * The `checking`, `installing` and `reporting` phases: fetch and verify `target`, or the newest release on the
   * person's channel, install it unless it is installed and its files match its manifest, and compute the report.
   * @param target - the version, or `undefined` for the newest release.
   * @param phase - called as each phase starts.
   * @param line - writes one line of the target's install progress, as the launcher prints it.
   * @returns the prepared version.
   * @throws {HomeProcessError} `VERIFY_FAILED` when a check fails.
   */
  prepare(target: RuntimeVersion | undefined, phase: (phase: 'checking' | 'installing' | 'reporting') => void, line: (text: string) => void): Promise<PreparedRuntime>
  /**
   * The `reporting` phase of a rollback: the report against an installed version, installing nothing.
   * @param target - the version `previous` names.
   * @returns the prepared version.
   */
  reportRollback(target: RuntimeVersion): Promise<PreparedRuntime>
  /**
   * Switch: write `previous` with `from`, then `current` with `to`, each by C1's atomic rename, so a process killed
   * between the two writes leaves `current` naming `from`. The handshake's interrupted-update recovery relies on
   * this between-writes state — `previous` written before `current`, so a kill between the writes leaves
   * `previous` holding `from` while the journal records the true one, which the recovery restores from the journal
   * — so implementations must keep this write order.
   * @param from - the running version.
   * @param to - the target version.
   */
  switchTo(from: RuntimeVersion, to: RuntimeVersion): Promise<void>
  /**
   * Restore both pointers to their values before an update, by C1's atomic rename; `previous` is removed when
   * `before` has none.
   * @param before - the pointers read before the update.
   */
  restore(before: RuntimePointers): Promise<void>
  /**
   * The command that starts a home process from a version's runtime.
   * @param version - the installed version.
   * @param mode - a successor, which inherits the handover pipe on file descriptor 3, or a fresh start.
   * @returns the command.
   */
  homeCommand(version: RuntimeVersion, mode: HomeCommandMode): HomeCommand
  /**
   * The check before a home process starts from an installed version, as the launcher checks a version before it
   * starts it: C2's start check of every file and C18's release-log start check.
   * @param version - the installed version.
   * @throws when the version may not start; nothing of it has run then.
   */
  checkLaunch(version: RuntimeVersion): Promise<void>
  /**
   * Keep the versions the pointers name and remove the other installed runtimes, once an update committed.
   * @returns what was removed and what the next run retries.
   */
  retain(): Promise<unknown>
}

/** The profile history versions an update saves and restores (contract C3). */
export interface ProfileSnapshots {
  /**
   * The `snapshot` phase: save a profile history version named for the update, with the home patch and the report.
   * @param from - the running version.
   * @param to - the target version.
   * @param report - C3's report the person confirmed.
   * @returns the id of the profile history version, which the update record keeps as `snapshot`.
   */
  save(from: RuntimeVersion, to: RuntimeVersion, report: unknown): Promise<string>
}

/** The steps of a rollback its caller owns. */
export interface RollbackSteps {
  /** Restore only the profile snapshot and keep the running runtime. */
  readonly profileOnly: boolean
  /**
   * Switch the runtime pointers back, in the way the caller's path does it.
   * @returns when the pointers name the version rolled back to.
   */
  readonly switchRuntime: () => Promise<void>
  /**
   * Record durably that the rollback has begun, before its first step: the caller rewrites the update record with
   * phase `rolling-back`, or does nothing where an interruption leaves nothing to complete.
   * @returns when the record is synced.
   */
  readonly markRollingBack: () => Promise<void>
}

/**
 * The session-data copies and the one rollback function of contract C3: every way back reads the update record and
 * applies C3's rollback table through {@link SessionDataCopies.rollback}; none swaps the pointers on its own.
 */
export interface SessionDataCopies {
  /**
   * Check, before an update writes anything, that no other process uses the home's chat data, and that a copy of it
   * fits now when the person chose one.
   * @param copy - whether the update takes a session-data copy.
   * @throws {HomeProcessError} `CHATS_RUNNING` while another process, another profile's home process included, uses the
   *   chat data; `DATA_COPY_NO_SPACE` when the chosen copy does not fit.
   */
  plan(copy: boolean): Promise<void>
  /**
   * Check again that no other process uses the home's chat data, after the update record exists and right before the
   * Host stops for the switch: a process that registered before the record was written is seen here, and one that
   * registers later sees the record and refuses to start.
   * @throws {HomeProcessError} `CHATS_RUNNING` while another process, another profile's home process included, uses the
   *   chat data.
   */
  confirmSoleUser(): Promise<void>
  /**
   * Write the session-data copy for an update, after the Host has stopped and before the switch.
   * @param from - the running version.
   * @param to - the target version.
   */
  save(from: RuntimeVersion, to: RuntimeVersion): Promise<void>
  /**
   * Remove the copy of an update that ended before the switch, whole or unfinished; does nothing when none exists.
   * @param to - the update's target version.
   */
  discard(to: RuntimeVersion): Promise<void>
  /**
   * An update committed: keep only its copy, when it has one, and remove every other. Running it again does nothing
   * more.
   * @param to - the committed update's target version.
   */
  commit(to: RuntimeVersion): Promise<void>
  /**
   * Apply C3's rollback table for the update a record names, in this order: the preflight, which refuses or goes on;
   * the caller's {@link RollbackSteps.markRollingBack}; the data; the profile snapshot; and, through the caller's
   * step, the runtime.
   * @param record - the update record.
   * @param steps - whether only the profile goes back, the caller's record mark and its runtime switch.
   * @throws {HomeProcessError} `ROLLBACK_NEEDS_DATA_COPY` when the data differs, the target started and no copy
   *   exists, `ROLLBACK_TARGET_UNUSABLE` when the version rolled back to is not installed or fails its start check,
   *   `CHATS_RUNNING` while another process uses the chat data, or `GIT_UNAVAILABLE` when the git the profile history
   *   runs cannot start; each is thrown before any step, with nothing changed. Any other error means a step may have
   *   run.
   * @returns what the person reads about the rollback, one line each, such as the chats it set aside.
   */
  rollback(record: UpdateJournal, steps: RollbackSteps): Promise<readonly string[]>
}

/** The running chats of one Host: sessions with an active turn or a running background job. */
export interface ChatGate {
  /**
   * The running chats now.
   * @returns their number.
   */
  running(): number
  /**
   * Refuse new turns with `UPDATE_PENDING` and hold scheduled deliveries until the returned release is called.
   * @returns the release; a second call does nothing.
   */
  hold(): () => void
  /**
   * Wait until no chat runs.
   * @param signal - stops the wait.
   * @returns when {@link running} is zero, or rejects with the signal's reason.
   */
  idle(signal: AbortSignal): Promise<void>
  /**
   * Cancel running turns and background jobs through upstream's cancellation.
   * @returns when the cancellation has been requested; {@link idle} reports when they have ended.
   */
  cancelAll(): Promise<void>
}

/**
 * The Host's way to the home process: the update channel, with the Host's channel token held in memory, which the
 * channel accepts for every operation but `studio.open-token`. The Host's update plugin sends the studio's "Update
 * now" and rollback through it, for a studio session the studio's own authentication admitted; the Host has no
 * other handle on the home process.
 */
export interface UpdateChannelAccess {
  /**
   * Send one request over the update channel with the Host's channel token.
   * @param request - the request without `v` and `token`.
   * @param options - a line listener and a deadline.
   * @returns every response line.
   * @throws {Error} while the channel is not open, as in a successor's `standby`; the connection's error.
   */
  send(request: UnsignedRequest, options?: ExchangeOptions): Promise<ResponseLine[]>
}

/** The profile's Host, booted in the home process. */
export interface HostRunner {
  /**
   * Boot the Host.
   * @param access - the Host's way to the update channel.
   * @returns the running Host.
   * @throws when the profile does not boot; a `HostNotStoppedError` when a check refused the booted Host and its
   *   teardown did not finish, so it may still run in this process.
   */
  boot(access: UpdateChannelAccess): Promise<RunningHost>
}

/** A studio link, or the reason the Host cannot make one that reaches the studio from this computer. */
export type StudioLinkResult =
  | { readonly kind: 'link', readonly link: StudioLink }
  | { readonly kind: 'unavailable', readonly reason: string }

/** A booted Host. */
export interface RunningHost {
  /** Its running chats. */
  readonly chats: ChatGate
  /**
   * The studio's loopback address.
   * @returns the URL, or `undefined` when the Host serves no studio.
   */
  studio(): string | undefined
  /**
   * Mint a studio sign-in link for one opening, as `studio.open-token` returns it.
   * @param port - a loopback port that forwards to the studio, or `undefined` for the studio's own port.
   * @returns the link, or why none can be made for this computer.
   */
  studioLink(port: number | undefined): StudioLinkResult
  /**
   * The rows that were disabled or did not load at boot, which a successor's H3 and H4 allow.
   * @returns the rows.
   */
  failedRows(): readonly BootRow[]
  /**
   * Every row the Host had at boot, which a successor's H3 compares with its own.
   * @returns their ids and plugin names.
   */
  rows(): readonly BootRow[]
  /** The local device approval, when the profile loads `@delo/home-auth`; `devices.approve` drives it. */
  readonly devices?: LocalDeviceApproval
  /**
   * The sandbox protection the Host booted with, which a successor's H3 holds its own to.
   * @returns the protection, or `undefined` when the Host has no sandbox row that sets one.
   */
  protection(): HostProtection | undefined
  /**
   * Contract C3's health check: H1 to H5 against the report's expectations, or H1 and H2 alone without them.
   * @param expect - what the report predicted, or `undefined` for a start whose record keeps no expectations, such
   *   as the check of a runtime rolled back to.
   * @returns the verdict.
   */
  check(expect: HealthExpectations | undefined): Promise<HealthVerdict>
  /**
   * Stop the Host as this process stops. Its teardown may end the process when it overruns the Host's own bound.
   * @returns when it has stopped.
   */
  close(): Promise<void>
  /**
   * Stop the Host and keep this process, for an update's or a rollback's switch or after a failed start: afterwards
   * this process boots another Host, hands over to a successor, or finishes the failed start. It never ends the
   * process, however long the teardown takes; the home process bounds the wait.
   * @returns when it has stopped.
   * @throws when the teardown fails.
   */
  suspend(): Promise<void>
}
