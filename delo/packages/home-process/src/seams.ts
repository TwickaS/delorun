/**
 * What the home process calls outside this package (contract C19): the runtime store, the profile's history, the
 * profile's Host and its running chats. Each is an interface here and is implemented by its owner:
 *
 * - {@link RuntimeStore}: `delo/packages/runtime-store` (C1's runtime store, with C2's and C18's checks). Until it
 *   lands, a home process has no store and refuses updates; specs use a fixture store.
 * - {@link ProfileSnapshots}: C3's profile history, with the store.
 * - {@link HostRunner} and {@link ChatGate}: the profile's Host, booted through upstream's profile runner by
 *   `delorun`, and the Host's update plugin, which counts running chats, refuses new turns and cancels turns
 *   through upstream's cancellation.
 *
 * @module @delo/home-process/seams
 */
import type { RuntimeVersion } from '@delo/contract-home-layout'
import type { ExchangeOptions, ResponseLine, UnsignedRequest } from './client.ts'

/** C1's two pointers. */
export interface RuntimePointers {
  /** The version `current` names. */
  readonly current: RuntimeVersion
  /** The version `previous` names, when it exists. */
  readonly previous?: RuntimeVersion
}

/** A version ready to switch to, with C3's update report against it. */
export interface PreparedRuntime {
  /** The target version, installed and verified. */
  readonly version: RuntimeVersion
  /** C3's update report, returned to the caller as it is. */
  readonly report: unknown
  /** The plugin ids the report names as disabled at boot; the health check refuses any other. */
  readonly disabledPlugins: readonly string[]
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
   * @returns the prepared version.
   * @throws {HomeProcessError} `VERIFY_FAILED` when a check fails.
   */
  prepare(target: RuntimeVersion | undefined, phase: (phase: 'checking' | 'installing' | 'reporting') => void): Promise<PreparedRuntime>
  /**
   * The `reporting` phase of a rollback: the report against an installed version, installing nothing.
   * @param target - the version `previous` names.
   * @returns the prepared version.
   */
  reportRollback(target: RuntimeVersion): Promise<PreparedRuntime>
  /**
   * Switch: write `previous` with `from`, then `current` with `to`, each by C1's atomic rename, so a process killed
   * between the two writes leaves `current` naming `from`.
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
}

/** The profile history versions an update saves and restores (contract C3). */
export interface ProfileSnapshots {
  /**
   * The `snapshot` phase: save a profile history version named for the update, with the home patch.
   * @param from - the running version.
   * @param to - the target version.
   */
  save(from: RuntimeVersion, to: RuntimeVersion): Promise<void>
  /**
   * C3's rollback steps after a failed health check: restore the snapshot the update saved.
   * @param from - the version the update started from.
   * @param to - the version it failed to reach.
   */
  restore(from: RuntimeVersion, to: RuntimeVersion): Promise<void>
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
 * The Host's way to the home process: the update channel, with the current start's token held in memory. The
 * Host's update plugin sends the studio's "Update now" and rollback through it, for a studio session the studio's
 * own authentication admitted; the Host has no other handle on the home process.
 */
export interface UpdateChannelAccess {
  /**
   * Send one request over the update channel with the current start's token.
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
   * @throws when the profile does not boot.
   */
  boot(access: UpdateChannelAccess): Promise<RunningHost>
}

/** A booted Host. */
export interface RunningHost {
  /** Its running chats. */
  readonly chats: ChatGate
  /**
   * The plugins it disabled at boot.
   * @returns their ids.
   */
  disabledPlugins(): readonly string[]
  /**
   * Whether the studio listener answers its health request.
   * @returns true when it answers.
   */
  healthy(): Promise<boolean>
  /**
   * Stop the Host.
   * @returns when it has stopped.
   */
  close(): Promise<void>
}
