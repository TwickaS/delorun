/**
 * The home process (contract C19, "The home process"): one operating-system process per CLI profile that holds
 * `run/<profile>/home.lock` for its life, writes a new start token at each start, serves the update channel, launches
 * the Docker supervisor when the machine is set up for Docker, runs the profile's Host in the same process and moves
 * the profile to another runtime only through the update handshake.
 *
 * A fresh start runs C19's start sequence in order and stops at the first failure, which it logs and throws; its Host
 * stops through a teardown that ends no process, and when that teardown fails or overruns, nothing rolls the data back
 * or starts again and the lock stays held until the process ends ({@link HostNotStoppedError}). A successor started by
 * a handover boots its Host in `standby`, answers the predecessor and takes the lock, the token and the channel only
 * once the predecessor has handed the lock over. Whatever way the process ends, a `exit` listener removes this start's
 * token file and socket and releases the lock while each is still this start's.
 *
 * From the moment a fresh start holds the lock, or a successor starts booting its Host, the process holds the one
 * listener for `SIGTERM` and `SIGINT` (`options.onSignal`): the first signal runs {@link HomeProcess.shutdown} with
 * the signal's exit code, and a second one while that stop runs ends the process at once.
 *
 * @module @delorun/home-process/home-process
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DELORUN_HOME_ENTRIES, type RuntimeVersion, type StartId, type StartToken } from '@delorun/contract-home-layout'
import {
  DRAIN_TIMEOUT_DEFAULT_S,
  UPDATE_PROTOCOL_VERSION,
  HEALTH_CHECK_TIMEOUT_MS,
  type HomeProcessState,
  type HomeStatus,
  type StopMode,
  type UpdateChannelRequest,
  type UpdateJournal,
} from '@delorun/contract-home-process'
import {
  acquireHomeLock,
  adoptHomeLock,
  checkPrivateDirectory,
  readHomeLock,
  newStartToken,
  removeStartTokenFile,
  runDirectory,
  startTokenFile,
  writeNewStartToken,
  type HolderProbe,
  type HomeLock,
  type TokenSocket,
} from '@delorun/home'
import { startAgeChecks, type DelorunLogger, type Redactor } from '@delorun/logs'
import { listenUpdateChannel, updateSocketPath } from './channel.ts'
import { exchangeLines } from './client.ts'
import { HomeProcessError, isRollbackRefusal } from './errors.ts'
import { hostStopFailure, HostNotStoppedError, REFUSED_HOST_STOP_S, stopHostWithin } from './host-stop.ts'
import { startSuccessor, type HandoverPipe, type Successor } from './handover.ts'
import { UpdateHandshake, type HandshakeSubject, type UpdateSupport } from './handshake.ts'
import { endUpdateRecord, hasStash, journalledUpdate, journalPath, markCommitted, readJournal, removeJournal, removeStash, writeJournal } from './journal.ts'
import type { BootRow, ChatGate, HostProtection, HostRunner, RunningHost, RuntimePointers, UpdateChannelAccess } from './seams.ts'
import { SIGNAL_EXIT_CODES, type HomeSignal } from './signals.ts'
import { ChannelTokenCheck, studioOpenToken } from './studio-link.ts'
import { approveDevices, changePin, elevateDevices, removeDevice } from './devices-approve.ts'
import { reloadChanges } from './reload.ts'
import { acceptServer, declineServer, listServers, reloadPermissions, revokeServer } from './consents.ts'
import { reachApply, reachStatus } from './reach.ts'
import { launchSupervisor, type LaunchedSupervisor, type SupervisorSetup } from './supervisor-launch.ts'

/** What a home process runs with; `delorun` supplies every value. */
export interface HomeProcessOptions {
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The runtime version this process runs. */
  readonly running: RuntimeVersion
  /** This start's id: new for a fresh start, the predecessor's choice for a successor. The log carries it too. */
  readonly startId: StartId
  /** Boots the profile's Host. */
  readonly host: HostRunner
  /**
   * The start's steps before any Host boots, run by a fresh start once it holds the home lock and before it finishes an
   * interrupted update: the CLI's ordered pre-start list, which finishes an interrupted restore of a session-data copy
   * (contract C3, "Rollback"). A successor does not run them. A throw refuses the start.
   * @returns when the steps are done.
   */
  readonly preStart: () => Promise<void>
  /** Asks a live lock holder for its status: `updateChannelProbe` of this home and profile. */
  readonly probe: HolderProbe
  /** The home process's logger, on C20's `home-<profile>` surface. */
  readonly logger: DelorunLogger
  /** The log's redactor, with which the start token is registered. */
  readonly redactor: Redactor
  /** The clock of the hourly log age check, in milliseconds since the epoch; the system clock by default. */
  readonly now?: () => number
  /** The runtime store and profile history, or `undefined` in a build without the runtime store: updates are refused. */
  readonly updates: UpdateSupport | undefined
  /** The supervisor's launch values, or `undefined` when the machine is not set up for Docker. */
  readonly supervisor: SupervisorSetup | undefined
  /**
   * Registers a listener for this process's exit.
   * @param listener - runs synchronously as the process exits.
   */
  readonly onExit: (listener: () => void) => void
  /**
   * Registers the process's one listener for `SIGTERM` and `SIGINT`; `listenProcessSignals` in a real home
   * process, whose Host's profile runner then installs no signal handler of its own.
   * @param listener - runs with the signal's name each time one arrives.
   * @returns the disposer that removes the listener.
   */
  readonly onSignal: (listener: (signal: HomeSignal) => void) => () => void
  /**
   * Ends the process after a stop or a committed handover.
   * @param code - the exit code.
   */
  readonly exit: (code: number) => void
}

/** The update's journal states that a start after a killed home process finishes. */
const SWITCH_PHASES: ReadonlySet<UpdateJournal['phase']> = new Set(['switching', 'health-check'])

/**
 * Stop a Host for a switch within a bound, keeping this process.
 * @param host - the running Host.
 * @param limitS - the longest wait, in seconds.
 * @returns when the Host has stopped.
 * @throws {HomeProcessError} `HOST_STOP_FAILED` when its teardown fails or has not finished after `limitS`; a teardown
 *   still running then goes on, and no Host is in use.
 */
async function suspendWithin(host: RunningHost, limitS: number): Promise<void> {
  const outcome = await stopHostWithin(() => host.suspend(), limitS)
  if (outcome.stopped) return
  throw new HomeProcessError('HOST_STOP_FAILED', outcome.kind === 'overran'
    ? `the Host did not stop within ${String(limitS)} seconds; nothing was switched`
    : `the Host's teardown failed (${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}); nothing was switched`)
}

/** A running home process. */
export class HomeProcess implements HandshakeSubject {
  private state: HomeProcessState = 'starting'
  private lock: HomeLock | undefined
  private token: StartToken | undefined
  /** The token the Host's requests carry, held only in memory; it cannot ask for a studio link, approve or remove a device. */
  private hostToken: StartToken | undefined
  private channel: TokenSocket | undefined
  private host: RunningHost | undefined
  private launched: LaunchedSupervisor | undefined
  private readonly handshake: UpdateHandshake | undefined
  /** An interrupted update whose target this start's Host checks. */
  private recovering: UpdateJournal | undefined
  /** An interrupted rollback whose runtime rolled back to this start's Host checks. */
  private verifyingRollback: UpdateJournal | undefined
  /** The version a failed start starts again on, once it has released the lock. */
  private restartOn: RuntimeVersion | undefined
  private stopRequested = false
  /** The final line of the stop that waits for running chats, which a later stop request joins. */
  private stopping: Promise<Readonly<Record<string, unknown>>> | undefined
  private ended = false
  /** Whether {@link shutdown} has run: this start's parts are released and the process is told to exit. */
  private stopped = false
  /** Whether a termination signal has arrived; a further one ends the process at once. */
  private signalled = false
  /** Removes the signal listener. */
  private stopSignals: (() => void) | undefined
  private stopAgeChecks: (() => void) | undefined
  private readonly access: UpdateChannelAccess = {
    send: async (request, options) => {
      if (this.hostToken === undefined || this.channel === undefined) throw new Error('the update channel is not open')
      return exchangeLines(this.socketPath, JSON.stringify({ v: UPDATE_PROTOCOL_VERSION, token: this.hostToken, ...request }), options)
    },
  }

  private readonly options: HomeProcessOptions

  private constructor(options: HomeProcessOptions) {
    this.options = options
    this.handshake = options.updates === undefined ? undefined : new UpdateHandshake(this, options.updates)
  }

  /** @inheritdoc */
  get running(): RuntimeVersion {
    return this.options.running
  }

  /** @inheritdoc */
  get home(): string {
    return this.options.home
  }

  /** @inheritdoc */
  get profile(): string {
    return this.options.profile
  }

  /** @inheritdoc */
  get journal(): string {
    return journalPath(this.options.home, this.options.profile)
  }

  /** @inheritdoc */
  get logger(): DelorunLogger {
    return this.options.logger
  }

  /** The update channel's socket path. */
  get socketPath(): string {
    return updateSocketPath(this.options.home, this.options.profile)
  }

  /**
   * Start a home process: C19's start sequence.
   * @param options - the launch values.
   * @returns the process, in `running`.
   * @throws {HomeLayoutError} `HOME_MODE` for a laxer directory, `HOME_RUNNING` or `HOME_UNRESPONSIVE` when another
   *   home process holds the lock, `SOCKET_PATH_TOO_LONG` for a long socket path.
   * @throws {HomeProcessError} `HEALTH_CHECK_FAILED` when a start that finished an interrupted update or rollback
   *   rolled back or completed a rollback and starts again on the version rolled back to, or when the runtime of an
   *   interrupted rollback fails its check; `ROLLBACK_NEEDS_DATA_COPY` when the record says C3's table refused the
   *   automatic rollback; `NO_RUNTIME_STORE` when an unfinished update record exists and `options.updates` is
   *   `undefined`, leaving the record in place.
   * @throws the Host's boot failure, or an `Error` when a termination signal stopped the process while its Host booted.
   */
  static async start(options: HomeProcessOptions): Promise<HomeProcess> {
    const home = new HomeProcess(options)
    try {
      await home.checkDirectories()
      home.lock = await acquireHomeLock({ runDirectory: runDirectory(options.home, options.profile), runtime: options.running, probe: options.probe, startId: options.startId })
      options.onExit(() => { home.cleanUpSync() })
      home.listenSignals()
      home.runAgeChecks()
      await options.preStart()
      await home.finishInterruptedUpdate()
      await home.listen()
      home.startSupervisor()
      await home.bootHost()
      home.enterRunning()
      return home
    } catch (error) {
      // A signal's shutdown has released this start's parts, the lock among them, so nothing may roll back here.
      if (home.stopped) throw error
      options.logger.error('the home process could not start', { err: error })
      const failure = await home.closeStarted(error)
      if (failure instanceof HostNotStoppedError) {
        // A Host that may still run keeps the data in use: nothing rolls it back or starts again, and the lock stays
        // held until the process ends. Without the signal listener, a signal ends the process as Node's default does.
        home.releaseListeners()
        options.logger.error('a Host may still run, so no rollback or new start runs and the lock stays held until this process ends')
        throw failure
      }
      // The rollback runs while the lock is held, so no other start runs a Host on the data while it changes.
      await home.rollBackInterruptedUpdate()
      home.lock?.release()
      home.releaseListeners()
      await home.startAgain()
      throw error
    }
  }

  /**
   * Run as the successor of a handover: boot the Host in `standby`, answer the predecessor, and take the lock, the
   * token and the channel once the predecessor has handed the lock over.
   * @param options - the launch values; `running` and `startId` come from the handover line.
   * @param pipe - the handover pipe.
   * @returns the process, in `running`.
   * @throws {HomeProcessError} `HEALTH_CHECK_FAILED` when the Host fails its health check or the predecessor stops
   *   before handing the lock over.
   */
  static async takeOver(options: HomeProcessOptions, pipe: HandoverPipe): Promise<HomeProcess> {
    const home = new HomeProcess(options)
    home.state = 'standby'
    const { handover } = pipe
    try {
      await home.checkDirectories()
      home.listenSignals()
      home.runAgeChecks()
      let healthy = false
      let criterion: string | undefined
      try {
        home.host = await home.bootedHost()
        options.logger.info('the Host booted on the new runtime; checking its health', { data: { to: handover.to } })
        const verdict = await home.host.check(handover.health)
        if (!verdict.passed) {
          options.logger.warn('the Host failed its health check on the new runtime', { data: { criterion: verdict.criterion, detail: verdict.detail } })
          criterion = verdict.criterion
        }
        healthy = verdict.passed
      } catch (error) {
        options.logger.error('the Host did not boot on the new runtime', { err: error })
        // The predecessor is told the check failed and boots its Host again, while this refused Host may still run.
        if (error instanceof HostNotStoppedError) {
          pipe.send({ type: 'failed', reason: 'HEALTH_CHECK_FAILED' })
          throw error
        }
      }
      if (!healthy) {
        pipe.send({ type: 'failed', reason: 'HEALTH_CHECK_FAILED', ...criterion === undefined ? {} : { criterion } })
        throw new HomeProcessError('HEALTH_CHECK_FAILED', `the Host on ${handover.to} failed its health check${criterion === undefined ? '' : ` (${criterion})`}`)
      }
      pipe.send({ type: 'ready' })
      const committed = await pipe.committed
      const directory = runDirectory(options.home, options.profile)
      if (!committed && readHomeLock(directory)?.startId !== options.startId) throw new HomeProcessError('HEALTH_CHECK_FAILED', 'the predecessor stopped before it handed the lock over')
      home.lock = adoptHomeLock(directory, options.startId)
      options.onExit(() => { home.cleanUpSync() })
      await home.listen()
      home.startSupervisor()
      home.enterRunning()
      await home.settleRecord(handover.to)
      options.logger.info('took over from the previous runtime', { data: { from: handover.from, to: handover.to } })
      return home
    } catch (error) {
      if (home.stopped) throw error
      options.logger.error('the successor could not take over', { err: error })
      const failure = await home.closeStarted(error)
      // A Host that may still run keeps the data in use, so a lock this successor adopted stays held until it ends.
      if (!(failure instanceof HostNotStoppedError)) home.lock?.release()
      home.releaseListeners()
      throw failure
    } finally {
      pipe.close()
    }
  }

  /**
   * The `status` answer.
   * @returns the status.
   */
  async status(): Promise<HomeStatus> {
    const pointers = this.options.updates === undefined ? { current: this.running } : await this.options.updates.store.pointers()
    const update = this.handshake?.update
    const studio = this.host?.studio()
    return {
      state: this.state,
      pid: process.pid,
      startId: this.options.startId,
      runtime: { current: pointers.current, ...pointers.previous === undefined ? {} : { previous: pointers.previous }, running: this.running },
      chats: this.host?.chats.running() ?? 0,
      ...studio === undefined ? {} : { studio },
      ...update === undefined ? {} : { update },
    }
  }

  /**
   * Stop this home process: new turns are refused, running chats are waited for at most 1,800 seconds (`drain`) or
   * cancelled (`cancel`), and then the Host, the token, the channel, the supervisor and the lock go in that order.
   * A stop requested while another waits joins it and returns the same final line; a joining `cancel` first cancels
   * the running chats, so `delorun stop --now` ends a draining stop's wait. Once accepted, a stop always returns its
   * final line and the process ends after sending it: a failed cancellation is logged and the stop goes on, and a
   * status that cannot be read is left out of the line.
   * @param mode - how running chats are treated.
   * @param progress - writes progress lines.
   * @returns the final line's fields, with `status` when it could be read; the process ends once the line is sent.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while an update or rollback runs.
   */
  async requestStop(mode: StopMode, progress: (fields: Readonly<Record<string, unknown>>) => void): Promise<Readonly<Record<string, unknown>>> {
    if (this.handshake?.running() === true) throw new HomeProcessError('UPDATE_IN_PROGRESS', 'an update or rollback is running; cancel it or wait for it to end')
    if (this.stopped) return this.stopLine()
    if (this.stopping !== undefined) {
      if (mode === 'cancel') await this.cancelChats()
      return this.stopping
    }
    this.state = 'stopping'
    this.stopping = this.stopAfterChats(mode, progress)
    return this.stopping
  }

  /**
   * Stop at once, as a termination signal does: the same order as {@link requestStop} without waiting for chats. A
   * Host that fails to close is logged and the remaining parts still go; the process is told to exit in any case.
   * @param code - the exit code.
   * @returns when the process has been told to exit.
   */
  async shutdown(code: number): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.stopped = true
    this.state = 'stopping'
    try {
      await this.closeHost()
      this.removeToken()
      await this.channel?.close()
      this.channel = undefined
      await this.launched?.stop()
      this.launched = undefined
      this.lock?.release()
      this.logger.info('stopped', { data: { code } })
    } finally {
      this.releaseListeners()
      this.options.exit(code)
    }
  }

  // HandshakeSubject

  /** @inheritdoc */
  chats(): ChatGate {
    if (this.host === undefined) throw new Error('the Host is not running')
    return this.host.chats
  }

  /** @inheritdoc */
  failedRows(): readonly BootRow[] {
    return this.host?.failedRows() ?? []
  }

  /** @inheritdoc */
  rows(): readonly BootRow[] {
    return this.host?.rows() ?? []
  }

  /** @inheritdoc */
  protection(): HostProtection | undefined {
    return this.host?.protection()
  }

  /** @inheritdoc */
  setState(state: HomeProcessState): void {
    this.state = state
  }

  /** @inheritdoc */
  async suspend(limitS: number): Promise<void> {
    const host = this.host
    this.host = undefined
    try {
      if (host !== undefined) await suspendWithin(host, limitS)
    } finally {
      await this.launched?.stop()
      this.launched = undefined
    }
  }

  /** @inheritdoc */
  async resume(): Promise<void> {
    try {
      await this.bootHost()
      this.startSupervisor()
    } catch (error) {
      // The pointers name the version this process runs, so the next start runs it; this process cannot serve.
      this.logger.error('the Host did not boot again after the failed switch; stopping', { err: error })
      await this.shutdown(1)
      throw error
    }
  }

  /** @inheritdoc */
  startSuccessor(handover: Parameters<HandshakeSubject['startSuccessor']>[0]): Successor {
    if (this.options.updates === undefined) throw new Error('no runtime store')
    return startSuccessor(this.options.updates.store.homeCommand(handover.to, 'successor'), handover, HEALTH_CHECK_TIMEOUT_MS)
  }

  /** @inheritdoc */
  handOver(successor: Successor, startId: StartId, to: RuntimeVersion): void {
    if (this.lock === undefined) throw new Error('the home lock is not held')
    this.lock.handOver({ pid: successor.pid, startId, runtime: to })
  }

  // Stopping

  /**
   * A stop's wait and its final line, the request marked as a stop to end the process once the line is sent.
   * @param mode - how running chats are treated.
   * @param progress - writes the progress line with the running chats.
   * @returns the final line's fields; never rejects.
   */
  private async stopAfterChats(mode: StopMode, progress: (fields: Readonly<Record<string, unknown>>) => void): Promise<Readonly<Record<string, unknown>>> {
    await this.waitForChats(mode, progress)
    const line = await this.stopLine()
    this.stopRequested = true
    return line
  }

  /**
   * A stop's wait: hold the gate, cancel the running chats for `cancel`, and wait at most 1,800 seconds for none to run.
   * @param mode - how running chats are treated.
   * @param progress - writes the progress line with the running chats.
   * @returns once no chat runs or the limit passed.
   */
  private async waitForChats(mode: StopMode, progress: (fields: Readonly<Record<string, unknown>>) => void): Promise<void> {
    const gate = this.host?.chats
    if (gate === undefined) return
    gate.hold()
    if (mode === 'cancel') await this.cancelChats()
    progress({ state: 'stopping', chats: gate.running() })
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new Error('drain timeout')) }, DRAIN_TIMEOUT_DEFAULT_S * 1000)
    try {
      while (gate.running() > 0) await gate.idle(controller.signal)
    } catch (_timeout) {
      // The drain's 1,800 seconds passed; C19's stop goes on with the chats that still run.
      this.logger.warn('stopping with chats still running after the drain limit', { data: { chats: gate.running() } })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Cancel the Host's running chats for a stop; a failure is logged, and the stop goes on with the chats that still run. */
  private async cancelChats(): Promise<void> {
    try {
      await this.host?.chats.cancelAll()
    } catch (error) {
      this.logger.error('the stop could not cancel the running chats; it goes on with them', { err: error })
    }
  }

  /**
   * A stop's final line, which never fails, so an accepted stop is always answered and ends the process.
   * @returns the status, or no field when it cannot be read.
   */
  private async stopLine(): Promise<Readonly<Record<string, unknown>>> {
    try {
      return { status: await this.status() }
    } catch (error) {
      this.logger.warn('the stop\'s final line carries no status, which could not be read', { err: error })
      return {}
    }
  }

  /**
   * Run the log retention check now and every hour while the process runs ({@link startAgeChecks}, contract C20): a home
   * process that runs for weeks deletes records past 14 days without a `delorun` command to prune them. What a check
   * deleted and what it could not delete go to the log.
   */
  private runAgeChecks(): void {
    const { home, now, logger } = this.options
    this.stopAgeChecks = startAgeChecks({
      home,
      now: now ?? Date.now,
      onReport: (report) => {
        if (report.deleted.length > 0) logger.info('deleted expired log files', { data: { files: report.deleted.length } })
        for (const failure of report.failures) logger.warn('the log age check left a file as it was', { err: failure })
      },
    })
  }

  /** Remove the signal listener and stop the hourly log age check. */
  private releaseListeners(): void {
    this.stopSignals?.()
    this.stopAgeChecks?.()
    this.stopAgeChecks = undefined
  }

  private listenSignals(): void {
    this.stopSignals = this.options.onSignal((signal) => { this.onSignal(signal) })
  }

  /**
   * The first termination signal stops the process in C19's order; a further one, while that stop runs, ends the
   * process at once with the signal's code.
   * @param signal - the signal.
   */
  private onSignal(signal: HomeSignal): void {
    const code = SIGNAL_EXIT_CODES[signal]
    this.logger.info('received a termination signal', { data: { signal } })
    if (this.signalled) {
      this.options.exit(code)
      return
    }
    this.signalled = true
    void this.shutdown(code)
  }

  // The update channel

  private async listen(): Promise<void> {
    const { home, profile, redactor, logger } = this.options
    this.token = await writeNewStartToken(home, profile)
    redactor.register(this.token, 'start-token')
    this.hostToken = newStartToken()
    redactor.register(this.hostToken, 'start-token')
    const check = new ChannelTokenCheck(this.token, this.hostToken)
    this.channel = await listenUpdateChannel({
      socketPath: this.socketPath,
      check,
      logger,
      handle: async (request, progress) => this.dispatch(request, progress, check),
      answered: (request) => { this.answered(request) },
    })
    logger.info('update channel listening')
  }

  private async dispatch(request: UpdateChannelRequest, progress: (fields: Readonly<Record<string, unknown>>) => void, check: ChannelTokenCheck): Promise<Readonly<Record<string, unknown>>> {
    switch (request.op) {
      case 'status':
        return { status: await this.status() }
      case 'stop':
        return this.requestStop(request.args.mode, progress)
      case 'studio.open-token':
        return studioOpenToken(request, check, this.host)
      case 'update.prepare':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('VERIFY_FAILED', 'this build has no runtime store, so no release can be fetched and verified')
        return this.handshake.prepare(request.args.target, progress)
      case 'update.apply':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('REPORT_EXPIRED', 'no update was prepared')
        return this.handshake.apply(request.args.reportId, request.args.wait, request.args.drainTimeoutS, request.args.dataCopy, progress)
      case 'update.cancel':
        await this.handshake?.cancel()
        return { status: await this.status() }
      case 'rollback':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('NO_UPDATE_RECORD', 'this build has no runtime store')
        return this.handshake.rollback(request.args.wait, request.args.drainTimeoutS, request.args.profileOnly, progress)
      case 'devices.approve':
        return approveDevices(request, check.callerOf(request.token), this.host?.devices)
      case 'devices.remove':
        return removeDevice(request, check.callerOf(request.token), this.host?.devices)
      case 'devices.elevate':
        return elevateDevices(request, check.callerOf(request.token), this.host?.devices)
      case 'pin.set':
      case 'pin.options':
      case 'pin.off':
      case 'pin.resume':
        return changePin(request, check.callerOf(request.token), this.host?.devices)
      case 'permission.reload':
        return reloadPermissions(this.host?.consents)
      case 'mcp.list':
        return listServers(this.host?.consents)
      case 'mcp.accept':
        return acceptServer(request, check.callerOf(request.token), this.host?.consents)
      case 'mcp.decline':
        return declineServer(request, check.callerOf(request.token), this.host?.consents)
      case 'mcp.revoke':
        return revokeServer(request, check.callerOf(request.token), this.host?.consents)
      case 'reach.status':
        return reachStatus(request, check.callerOf(request.token), this.host?.reach)
      case 'reach.apply':
        return reachApply(request, check.callerOf(request.token), this.host?.reach)
      case 'changes.reload':
        this.refuseOutsideRunning()
        // `running` is entered only after the Host booted, and left before it closes.
        return reloadChanges(check.callerOf(request.token), () => this.host!.reload())
      default: {
        const unknown: never = request
        throw new HomeProcessError('SCHEMA_VIOLATION', `unknown op ${String((unknown as { readonly op: unknown }).op)}`)
      }
    }
  }

  private refuseOutsideRunning(): void {
    if (this.handshake?.running() === true) throw new HomeProcessError('UPDATE_IN_PROGRESS', 'another update or rollback is running')
    if (this.state !== 'running') throw new HomeProcessError('UPDATE_IN_PROGRESS', `the home process is ${this.state}`)
  }

  /**
   * After a final line has been sent: a stop ends the process, and a committed update hands the channel to the
   * successor and ends this process.
   */
  private answered(request: UpdateChannelRequest): void {
    if (request.op === 'stop' && this.stopRequested) {
      void this.shutdown(0)
      return
    }
    if ((request.op === 'update.apply' || request.op === 'rollback') && this.handshake?.failed === true) {
      // A rollback was refused after the switch or stopped after a step may have run: this Host may not run on the
      // data again. The record stays, so the next start refuses with ROLLBACK_NEEDS_DATA_COPY or completes the rollback.
      void this.shutdown(1)
      return
    }
    const successor = this.handshake?.committed
    if ((request.op === 'update.apply' || request.op === 'rollback') && successor !== undefined) void this.finishHandover(successor)
  }

  private async finishHandover(successor: Successor): Promise<void> {
    this.ended = true
    await this.channel?.close()
    this.channel = undefined
    this.removeToken()
    await successor.commit()
    this.logger.info('handed the profile to the new runtime', { data: { successor: successor.pid } })
    this.options.exit(0)
  }

  // Start sequence steps

  private async checkDirectories(): Promise<void> {
    const { home, profile } = this.options
    await checkPrivateDirectory(home)
    await checkPrivateDirectory(join(home, DELORUN_HOME_ENTRIES.secrets))
    await checkPrivateDirectory(runDirectory(home, profile))
  }

  /**
   * Step 3: settle the update record a killed home process left, and the stash beside it.
   *
   * - Without the runtime store: a stash and a `committed` record stay as they are; any other record fails the start
   *   with `NO_RUNTIME_STORE` and stays.
   * - No record and a stash: the update was killed before it wrote its own record; the stashed record returns.
   * - `refused`: C3's table refused the automatic rollback; the start fails with `ROLLBACK_NEEDS_DATA_COPY`.
   * - `committed`: the record stays while `current` names `to`, and a stash left by a kill after the commit goes;
   *   the record goes once `current` names `from`.
   * - A phase before `switching`, or `switching` or `health-check` with `current` naming `from`: nothing switched.
   *   `previous` is restored from the record, the update's copy is discarded, and the record goes with the stashed
   *   record returning.
   * - `switching` or `health-check` with `current` naming `to`: `targetStarted` is recorded and this start's Host
   *   boots as the health check of `to`, held to the record's expectations.
   * - `rolling-back` with `current` naming `to`: the rollback is completed before any Host boots, and the start fails
   *   and starts again on `from`. With `current` naming `from`: this start's Host boots as its health check.
   */
  private async finishInterruptedUpdate(): Promise<void> {
    const journal = this.journal
    let record = await readJournal(journal)
    if (record === undefined && !await hasStash(journal)) return
    const updates = this.options.updates
    if (updates === undefined) {
      // A committed record and a stash only keep a later rollback's way back; any other record is an update that has
      // not finished, which no Host may run under.
      if (record === undefined || record.phase === 'committed') {
        this.logger.warn('an update record exists, and this build has no runtime store to settle it with; it is left in place', { data: { from: record?.from ?? '', to: record?.to ?? '', phase: record?.phase ?? 'stash' } })
        return
      }
      throw new HomeProcessError('NO_RUNTIME_STORE', `an update from Delorun ${record.from} to ${record.to} stopped in ${record.refused === true ? 'a refused rollback' : `its ${record.phase} phase`}, and this delorun runs outside the Delorun home's runtime store, so it cannot finish or roll the update back and starts no Host. Start Delorun through the launcher the Delorun home installs, or run delorun recover status, then delorun recover rollback.`)
    }
    if (record === undefined) {
      this.logger.info('an update stopped before it wrote its record; the previous update\'s record returns')
      await endUpdateRecord(journal)
      record = await readJournal(journal)
      if (record === undefined) return
    }
    const data = { from: record.from, to: record.to, phase: record.phase }
    if (record.refused === true) {
      throw new HomeProcessError('ROLLBACK_NEEDS_DATA_COPY', `Delorun ${record.to} failed its health check after the update from ${record.from}, and going back needs a session-data copy that was not taken, so neither version starts on this data. Run delorun recover rollback --profile-only to restore the profile and keep Delorun ${record.to}, or delorun recover safe-mode.`)
    }
    const { current } = await updates.store.pointers()
    if (record.phase === 'committed') {
      if (current === record.to) {
        if (await hasStash(journal)) {
          this.logger.info('an update committed before its stashed record went; it goes now', { data })
          await this.recordCommitted(record.from, record.to)
          await updates.copies.commit(record.to)
          await removeStash(journal)
        }
        return
      }
      if (current === record.from) {
        this.logger.info('a rollback of the recorded update completed; its record goes', { data })
        await removeJournal(journal)
      }
      return
    }
    if (record.phase === 'rolling-back') {
      await this.finishInterruptedRollback(record, current)
      return
    }
    if (!SWITCH_PHASES.has(record.phase) || current === record.from) {
      this.logger.info('an interrupted update had not switched the runtime; nothing changed', { data })
      // A kill between the store's two pointer writes leaves `previous` holding `from` while the record keeps the
      // true rollback target; it is restored, or removed when the record has none, before the record goes.
      await updates.store.restore(record.previous === undefined ? { current } : { current, previous: record.previous })
      if (record.copy) await updates.copies.discard(record.to)
      await endUpdateRecord(journal)
      return
    }
    if (current !== record.to || this.running !== record.to) throw new Error(`the update journal names ${record.from} to ${record.to}, current names ${current} and this process runs ${this.running}; start Delorun through its launcher`)
    this.logger.info('finishing an interrupted update: checking the health of the new runtime', { data })
    // This start's Host opens the data as `to`: a rollback from here on treats the target as started.
    const started: UpdateJournal = { ...record, targetStarted: true }
    await writeJournal(journal, journalledUpdate(started), record.phase)
    this.recovering = started
  }

  /**
   * A record in `rolling-back`: with `current` naming `to`, complete the rollback through C3's table while the lock is
   * held and before any Host boots, then fail this start so it starts again on `from`; with `current` naming `from`,
   * this start's Host boots as the health check of `from`.
   * @throws {HomeProcessError} `HEALTH_CHECK_FAILED` once the rollback completed; the table's refusal or a step's
   *   failure, with the record left in place.
   */
  private async finishInterruptedRollback(record: UpdateJournal, current: RuntimeVersion): Promise<void> {
    const updates = this.options.updates
    if (updates === undefined) return
    const data = { from: record.from, to: record.to }
    if (current === record.to) {
      this.logger.warn('completing an interrupted rollback before any Host starts', { data })
      // `current` names `to`, and the store reads only an installed version as `current`, so `previous` may name it.
      const after: RuntimePointers = { current: record.from, previous: record.to }
      await updates.copies.rollback(record, { profileOnly: false, switchRuntime: () => updates.store.restore(after), markRollingBack: async () => {} })
      this.restartOn = record.from
      throw new HomeProcessError('HEALTH_CHECK_FAILED', `an interrupted rollback from ${record.to} to ${record.from} completed; Delorun starts again on ${record.from}`)
    }
    if (current !== record.from || this.running !== record.from) throw new Error(`the update record rolls ${record.to} back to ${record.from}, current names ${current} and this process runs ${this.running}; start Delorun through its launcher`)
    this.logger.info('finishing an interrupted rollback: checking the health of the runtime rolled back to', { data })
    this.verifyingRollback = record
  }

  /**
   * After a failed start that was finishing an interrupted update, with the lock still held and no Host running:
   * apply C3's rollback table with both pointers restored to their values before the update from the record, and
   * start again on `from` once the lock is released. The record stays `rolling-back` until that start's Host passes
   * its check. When the table refuses, nothing is restored and the record gains `refused`; when a step fails, the
   * record stays `rolling-back` for the next start. Failures are logged, never thrown.
   */
  private async rollBackInterruptedUpdate(): Promise<void> {
    const record = this.recovering
    const updates = this.options.updates
    if (record === undefined || updates === undefined) return
    this.recovering = undefined
    const journal = this.journal
    const update = journalledUpdate(record)
    const data = { from: record.from, to: record.to }
    const before: RuntimePointers = record.previous === undefined ? { current: record.from } : { current: record.from, previous: record.previous }
    try {
      await updates.copies.rollback(record, { profileOnly: false, switchRuntime: () => updates.store.restore(before), markRollingBack: () => writeJournal(journal, update, 'rolling-back') })
    } catch (error) {
      if (isRollbackRefusal(error)) {
        this.logger.error('the interrupted update failed its health check and C3\'s table refuses the rollback; run delorun recover rollback --profile-only or delorun recover safe-mode', { err: error, data })
        if (error instanceof HomeProcessError && error.code === 'ROLLBACK_NEEDS_DATA_COPY') await writeJournal(journal, { ...update, refused: true }, record.phase).catch((writeError: unknown) => { this.logger.error('the refusal could not be recorded', { err: writeError, data }) })
        return
      }
      this.logger.error('the rollback of an interrupted update stopped after a step may have run; the next start completes it', { err: error, data })
      return
    }
    this.restartOn = record.from
    this.logger.warn('the interrupted update failed its health check; rolled back and starting on the previous runtime', { data })
  }

  /** Start a home process on the version {@link restartOn} names, once this start has released the lock. */
  /**
   * After an interrupted update was rolled back while this start held the lock, start a home process again on the
   * version rolled back to, detached: once that version passes the check the launcher runs before a start. A version
   * that fails it, or a spawn that fails, is logged and nothing starts; the next `delorun start` reports it.
   */
  private async startAgain(): Promise<void> {
    const version = this.restartOn
    const updates = this.options.updates
    if (version === undefined || updates === undefined) return
    this.restartOn = undefined
    try {
      await updates.store.checkLaunch(version)
    } catch (error) {
      this.logger.error('the version rolled back to failed its check before a start, so no home process starts on it', { err: error, data: { version } })
      return
    }
    const command = updates.store.homeCommand(version, 'start')
    const child = spawn(command.command, [...command.args], { cwd: command.cwd, stdio: 'ignore', detached: true })
    child.once('error', (error) => { this.logger.error('the home process could not be started again', { err: error, data: { version } }) })
    child.unref()
  }

  /**
   * A successor that took over settles the record: a rollback's record goes, because the runtime rolled back to has
   * passed its health check, and the stashed record returns when one exists; an update's record is marked
   * `committed` so a later rollback reads it, only its copy is kept, and the stash goes.
   * @param to - the version this successor runs.
   */
  private async settleRecord(to: RuntimeVersion): Promise<void> {
    const record = await readJournal(this.journal)
    if (record === undefined) return
    if (record.phase === 'rolling-back') {
      await endUpdateRecord(this.journal)
      this.logger.info('the rollback completed; its record goes', { data: { from: record.from, to: record.to } })
      return
    }
    await markCommitted(this.journal)
    await this.recordCommitted(record.from, record.to)
    await this.options.updates?.copies.commit(to)
    await removeStash(this.journal)
    // The committed update leaves `current` and `previous`, which the record names; every other runtime goes.
    const retained = await this.options.updates?.store.retain().catch((error: unknown) => {
      this.logger.warn('the runtime store could not remove the runtimes the update left; the next update retries it', { err: error })
    })
    if (retained !== undefined) this.logger.info('retained the runtimes the pointers name', { data: { retention: retained } })
  }

  /**
   * Record in the profile that an update committed. The update has committed whatever this write does, so a failure
   * is logged as a warning and the start goes on; `delorun recover status` then names the update as applying.
   * @param from - the version the update left.
   * @param to - the version it committed to.
   */
  private async recordCommitted(from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    try {
      await this.options.updates?.snapshots.committed(from, to)
    } catch (error) {
      this.logger.warn('the profile\'s record of the update could not be marked committed; delorun recover status names it as applying', { err: error, data: { from, to } })
    }
  }

  private startSupervisor(): void {
    const setup = this.options.supervisor
    if (setup === undefined || this.token === undefined) return
    const { home, profile, startId, logger } = this.options
    this.launched = launchSupervisor(setup, { home, profile, startId, token: this.token }, logger)
    logger.info('launched the supervisor', { data: { pid: this.launched.pid } })
  }

  /**
   * Boot a Host through `options.host`.
   * @returns the Host.
   * @throws {Error} when the process stopped while the Host booted; that Host is closed first.
   */
  private async bootedHost(): Promise<RunningHost> {
    const host = await this.options.host.boot(this.access)
    if (!this.stopped) return host
    await host.close()
    throw new Error('the home process stopped while its Host booted')
  }

  private async bootHost(): Promise<void> {
    this.host = await this.bootedHost()
    const recovering = this.recovering
    if (recovering !== undefined) {
      const expect = recovering.health === undefined ? undefined : { ...recovering.health, previousFailures: [], previousRows: [] }
      const verdict = await this.host.check(expect)
      if (!verdict.passed) throw new HomeProcessError('HEALTH_CHECK_FAILED', `the Host on ${recovering.to} failed ${verdict.criterion} after an interrupted update: ${verdict.detail}`)
      await markCommitted(this.journal)
      // Committed: a failure from here on is no reason to roll the update back.
      this.recovering = undefined
      await this.recordCommitted(recovering.from, recovering.to)
      await this.options.updates?.copies.commit(recovering.to)
      await removeStash(this.journal)
      this.logger.info('finished an interrupted update', { data: { from: recovering.from, to: recovering.to } })
    }
    const verifying = this.verifyingRollback
    if (verifying !== undefined) {
      const verdict = await this.host.check(undefined)
      if (!verdict.passed) throw new HomeProcessError('HEALTH_CHECK_FAILED', `the Host on ${verifying.from} failed ${verdict.criterion} after a rollback from ${verifying.to}: ${verdict.detail}; the record stays for the next start`)
      this.verifyingRollback = undefined
      await endUpdateRecord(this.journal)
      this.logger.info('finished an interrupted rollback', { data: { from: verifying.from, to: verifying.to } })
    }
  }

  private enterRunning(): void {
    this.state = 'running'
    this.logger.info('running', { data: { runtime: this.running, supervisor: this.launched === undefined ? 'not launched' : 'launched' } })
  }

  // Teardown

  /** Close the Host; a failure is logged, and the parts a stop releases after it still go. */
  private async closeHost(): Promise<void> {
    const host = this.host
    this.host = undefined
    try {
      await host?.close()
    } catch (error) {
      this.logger.error('the Host did not close', { err: error })
    }
  }

  private removeToken(): void {
    if (this.token !== undefined) removeStartTokenFile(startTokenFile(this.options.home, this.options.profile), this.token)
  }

  /**
   * Undo a start that failed, keeping the lock: each part this start created goes, in the clean stop's order. The Host
   * stops through its own teardown, which ends no process, within {@link REFUSED_HOST_STOP_S}, so the failed start's
   * rollback and its report still run; a teardown that fails or overruns is logged and returned.
   * @param error - why the start failed.
   * @returns `error`, or a {@link HostNotStoppedError} carrying it when the Host's teardown did not finish.
   */
  private async closeStarted(error: unknown): Promise<unknown> {
    this.ended = true
    const host = this.host
    this.host = undefined
    const outcome = host === undefined ? undefined : await stopHostWithin(() => host.suspend(), REFUSED_HOST_STOP_S)
    const failure = outcome === undefined || outcome.stopped || error instanceof HostNotStoppedError ? error : new HostNotStoppedError(error, outcome)
    if (outcome !== undefined && !outcome.stopped) this.logger.error('the failed start\'s Host did not stop', { ...outcome.kind === 'failed' ? { err: outcome.error } : {}, data: { detail: hostStopFailure(outcome) } })
    this.removeToken()
    await this.channel?.close()
    this.channel = undefined
    await this.launched?.stop()
    this.launched = undefined
    return failure
  }

  /** The exit listener: whatever ends the process, this start's token file, socket and lock go while each is its own. */
  private cleanUpSync(): void {
    this.removeToken()
    this.channel?.removeSocketSync()
    this.lock?.release()
  }
}
