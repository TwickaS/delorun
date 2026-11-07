/**
 * The home process (contract C19, "The home process"): one operating-system process per CLI profile that holds
 * `run/<profile>/home.lock` for its life, writes a new start token at each start, serves the update channel, launches
 * the Docker supervisor when the machine is set up for Docker, runs the profile's Host in the same process and moves
 * the profile to another runtime only through the update handshake.
 *
 * A fresh start runs C19's start sequence in order and stops at the first failure, which it logs and throws. A
 * successor started by a handover boots its Host in `standby`, answers the predecessor and takes the lock, the
 * token and the channel only once the predecessor has handed the lock over. Whatever way the process ends, a `exit`
 * listener removes this start's token file and socket and releases the lock while each is still this start's.
 *
 * @module @delo/home-process/home-process
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { DELO_HOME_ENTRIES, type RuntimeVersion, type StartId, type StartToken } from '@delo/contract-home-layout'
import {
  DRAIN_TIMEOUT_DEFAULT_S,
  UPDATE_PROTOCOL_VERSION,
  HEALTH_CHECK_TIMEOUT_MS,
  type HomeProcessState,
  type HomeStatus,
  type StopMode,
  type UpdateChannelRequest,
  type UpdateJournal,
} from '@delo/contract-home-process'
import {
  acquireHomeLock,
  adoptHomeLock,
  checkPrivateDirectory,
  readHomeLock,
  removeStartTokenFile,
  runDirectory,
  StartTokenCheck,
  startTokenFile,
  writeNewStartToken,
  type HolderProbe,
  type HomeLock,
  type TokenSocket,
} from '@delo/home'
import type { DeloLogger, Redactor } from '@delo/logs'
import { listenUpdateChannel, updateSocketPath } from './channel.ts'
import { exchangeLines } from './client.ts'
import { HomeProcessError } from './errors.ts'
import { startSuccessor, type HandoverPipe, type Successor } from './handover.ts'
import { UpdateHandshake, type HandshakeSubject, type UpdateSupport } from './handshake.ts'
import { journalPath, readJournal, removeJournal } from './journal.ts'
import type { ChatGate, HostRunner, RunningHost, UpdateChannelAccess } from './seams.ts'
import { launchSupervisor, type LaunchedSupervisor, type SupervisorSetup } from './supervisor-launch.ts'

/** What a home process runs with; `delorun` supplies every value. */
export interface HomeProcessOptions {
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The runtime version this process runs. */
  readonly running: RuntimeVersion
  /** This start's id: new for a fresh start, the predecessor's choice for a successor. The log carries it too. */
  readonly startId: StartId
  /** Boots the profile's Host. */
  readonly host: HostRunner
  /** Asks a live lock holder for its status: `updateChannelProbe` of this home and profile. */
  readonly probe: HolderProbe
  /** The home process's logger, on C20's `home-<profile>` surface. */
  readonly logger: DeloLogger
  /** The log's redactor, with which the start token is registered. */
  readonly redactor: Redactor
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
   * Ends the process after a stop or a committed handover.
   * @param code - the exit code.
   */
  readonly exit: (code: number) => void
}

/** The update's journal states that a start after a killed home process finishes. */
const SWITCH_PHASES: ReadonlySet<UpdateJournal['phase']> = new Set(['switching', 'health-check'])

/** A running home process. */
export class HomeProcess implements HandshakeSubject {
  private state: HomeProcessState = 'starting'
  private lock: HomeLock | undefined
  private token: StartToken | undefined
  private channel: TokenSocket | undefined
  private host: RunningHost | undefined
  private launched: LaunchedSupervisor | undefined
  private readonly handshake: UpdateHandshake | undefined
  private recovering: UpdateJournal | undefined
  private stopRequested = false
  private ended = false
  private readonly access: UpdateChannelAccess = {
    send: async (request, options) => {
      if (this.token === undefined || this.channel === undefined) throw new Error('the update channel is not open')
      return exchangeLines(this.socketPath, JSON.stringify({ v: UPDATE_PROTOCOL_VERSION, token: this.token, ...request }), options)
    },
  }

  private constructor(private readonly options: HomeProcessOptions) {
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
  get logger(): DeloLogger {
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
   * @throws {HomeProcessError} `HEALTH_CHECK_FAILED` when a start that finished an interrupted update rolled it back.
   * @throws the Host's boot failure.
   */
  static async start(options: HomeProcessOptions): Promise<HomeProcess> {
    const home = new HomeProcess(options)
    try {
      await home.checkDirectories()
      home.lock = await acquireHomeLock({ runDirectory: runDirectory(options.home, options.profile), runtime: options.running, probe: options.probe, startId: options.startId })
      options.onExit(() => { home.cleanUpSync() })
      await home.finishInterruptedUpdate()
      await home.listen()
      home.startSupervisor()
      await home.bootHost()
      home.enterRunning()
      return home
    } catch (error) {
      options.logger.error('the home process could not start', { err: error })
      await home.abandon()
      await home.restartFromInterruptedUpdate()
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
      let healthy = false
      try {
        home.host = await options.host.boot(home.access)
        const allowed = new Set(handover.disabledPlugins)
        const unexpected = home.host.disabledPlugins().filter(id => !allowed.has(id))
        if (unexpected.length > 0) options.logger.warn('the Host disabled plugins the update report did not name', { data: { plugins: unexpected.join(',') } })
        healthy = unexpected.length === 0 && await home.host.healthy()
      } catch (error) {
        options.logger.error('the Host did not boot on the new runtime', { err: error })
      }
      if (!healthy) {
        pipe.send({ type: 'failed', reason: 'HEALTH_CHECK_FAILED' })
        throw new HomeProcessError('HEALTH_CHECK_FAILED', `the Host on ${handover.to} failed its health check`)
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
      await removeJournal(home.journal)
      options.logger.info('took over from the previous runtime', { data: { from: handover.from, to: handover.to } })
      return home
    } catch (error) {
      options.logger.error('the successor could not take over', { err: error })
      await home.abandon()
      throw error
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
    return {
      state: this.state,
      pid: process.pid,
      startId: this.options.startId,
      runtime: { current: pointers.current, ...pointers.previous === undefined ? {} : { previous: pointers.previous }, running: this.running },
      chats: this.host?.chats.running() ?? 0,
      ...update === undefined ? {} : { update },
    }
  }

  /**
   * Stop this home process: new turns are refused, running chats are waited for at most 1,800 seconds (`drain`) or
   * cancelled (`cancel`), and then the Host, the token, the channel, the supervisor and the lock go in that order.
   * @param mode - how running chats are treated.
   * @param progress - writes progress lines.
   * @returns the final line's fields; the process ends once the line is sent.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while an update or rollback runs.
   */
  async requestStop(mode: StopMode, progress: (fields: Readonly<Record<string, unknown>>) => void): Promise<Readonly<Record<string, unknown>>> {
    if (this.handshake?.running() === true) throw new HomeProcessError('UPDATE_IN_PROGRESS', 'an update or rollback is running; cancel it or wait for it to end')
    if (this.state === 'stopping') return { status: await this.status() }
    this.state = 'stopping'
    const gate = this.host?.chats
    if (gate !== undefined) {
      gate.hold()
      if (mode === 'cancel') await gate.cancelAll()
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
    this.stopRequested = true
    return { status: await this.status() }
  }

  /**
   * Stop at once, as a termination signal does: the same order as {@link requestStop} without waiting for chats.
   * @param code - the exit code.
   * @returns when the process has been told to exit.
   */
  async shutdown(code: number): Promise<void> {
    if (this.ended) return
    this.ended = true
    this.state = 'stopping'
    await this.closeHost()
    this.removeToken()
    await this.channel?.close()
    this.channel = undefined
    await this.launched?.stop()
    this.launched = undefined
    this.lock?.release()
    this.logger.info('stopped', { data: { code } })
    this.options.exit(code)
  }

  // HandshakeSubject

  /** @inheritdoc */
  chats(): ChatGate {
    if (this.host === undefined) throw new Error('the Host is not running')
    return this.host.chats
  }

  /** @inheritdoc */
  setState(state: HomeProcessState): void {
    this.state = state
  }

  /** @inheritdoc */
  async suspend(): Promise<void> {
    await this.closeHost()
    await this.launched?.stop()
    this.launched = undefined
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

  // The update channel

  private async listen(): Promise<void> {
    const { home, profile, redactor, logger } = this.options
    this.token = await writeNewStartToken(home, profile)
    redactor.register(this.token, 'start-token')
    this.channel = await listenUpdateChannel({
      socketPath: this.socketPath,
      check: new StartTokenCheck(this.token),
      logger,
      handle: async (request, progress) => this.dispatch(request, progress),
      answered: (request) => { this.answered(request) },
    })
    logger.info('update channel listening')
  }

  private async dispatch(request: UpdateChannelRequest, progress: (fields: Readonly<Record<string, unknown>>) => void): Promise<Readonly<Record<string, unknown>>> {
    switch (request.op) {
      case 'status':
        return { status: await this.status() }
      case 'stop':
        return this.requestStop(request.args.mode, progress)
      case 'update.prepare':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('VERIFY_FAILED', 'this build has no runtime store, so no release can be fetched and verified')
        return this.handshake.prepare(request.args.target, progress)
      case 'update.apply':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('REPORT_EXPIRED', 'no update was prepared')
        return this.handshake.apply(request.args.reportId, request.args.wait, request.args.drainTimeoutS, progress)
      case 'update.cancel':
        await this.handshake?.cancel()
        return { status: await this.status() }
      case 'rollback':
        this.refuseOutsideRunning()
        if (this.handshake === undefined) throw new HomeProcessError('NO_PREVIOUS', 'this build has no runtime store')
        return this.handshake.rollback(request.args.wait, request.args.drainTimeoutS, progress)
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
    await checkPrivateDirectory(join(home, DELO_HOME_ENTRIES.secrets))
    await checkPrivateDirectory(runDirectory(home, profile))
  }

  /**
   * Step 3: read the journal a killed home process left. A journal before `switching` is removed; one in `switching`
   * or `health-check` with `current` naming `from` is removed; one with `current` naming `to` makes this start's Host
   * boot the health check of `to`.
   */
  private async finishInterruptedUpdate(): Promise<void> {
    const journal = await readJournal(this.journal)
    if (journal === undefined) return
    if (this.options.updates === undefined) {
      this.logger.warn('an update journal exists, and this build has no runtime store to finish it with; it is left in place', { data: { from: journal.from, to: journal.to, phase: journal.phase } })
      return
    }
    const { current } = await this.options.updates.store.pointers()
    if (!SWITCH_PHASES.has(journal.phase) || current === journal.from) {
      this.logger.info('an interrupted update had not switched the runtime; nothing changed', { data: { from: journal.from, to: journal.to, phase: journal.phase } })
      await removeJournal(this.journal)
      return
    }
    if (current !== journal.to || this.running !== journal.to) throw new Error(`the update journal names ${journal.from} to ${journal.to}, current names ${current} and this process runs ${this.running}; start Delo through its launcher`)
    this.logger.info('finishing an interrupted update: checking the health of the new runtime', { data: { from: journal.from, to: journal.to } })
    this.recovering = journal
  }

  /**
   * After a failed start that was finishing an interrupted update: restore the pointers to `from`, restore the
   * profile snapshot, and start a home process on `from`.
   */
  private async restartFromInterruptedUpdate(): Promise<void> {
    const journal = this.recovering
    const updates = this.options.updates
    if (journal === undefined || updates === undefined) return
    this.recovering = undefined
    await updates.store.restore({ current: journal.from, previous: journal.to })
    await updates.snapshots.restore(journal.from, journal.to)
    await removeJournal(this.journal)
    const command = updates.store.homeCommand(journal.from, 'start')
    spawn(command.command, [...command.args], { cwd: command.cwd, stdio: 'ignore', detached: true }).unref()
    this.logger.warn('the interrupted update failed its health check; rolled back and starting on the previous runtime', { data: { from: journal.from, to: journal.to } })
  }

  private startSupervisor(): void {
    const setup = this.options.supervisor
    if (setup === undefined || this.token === undefined) return
    const { home, profile, startId, logger } = this.options
    this.launched = launchSupervisor(setup, { home, profile, startId, token: this.token }, logger)
    logger.info('launched the supervisor', { data: { pid: this.launched.pid } })
  }

  private async bootHost(): Promise<void> {
    this.host = await this.options.host.boot(this.access)
    if (this.recovering !== undefined) {
      if (!await this.host.healthy()) throw new HomeProcessError('HEALTH_CHECK_FAILED', `the Host on ${this.recovering.to} failed its health check after an interrupted update`)
      await removeJournal(this.journal)
      this.logger.info('finished an interrupted update', { data: { from: this.recovering.from, to: this.recovering.to } })
      this.recovering = undefined
    }
  }

  private enterRunning(): void {
    this.state = 'running'
    this.logger.info('running', { data: { runtime: this.running, supervisor: this.launched === undefined ? 'not launched' : 'launched' } })
  }

  // Teardown

  private async closeHost(): Promise<void> {
    const host = this.host
    this.host = undefined
    await host?.close()
  }

  private removeToken(): void {
    if (this.token !== undefined) removeStartTokenFile(startTokenFile(this.options.home, this.options.profile), this.token)
  }

  /** Undo a start that failed: each part this start created goes, in the clean stop's order. */
  private async abandon(): Promise<void> {
    this.ended = true
    await this.closeHost().catch((error: unknown) => { this.logger.error('the Host did not close', { err: error }) })
    this.removeToken()
    await this.channel?.close()
    this.channel = undefined
    await this.launched?.stop()
    this.launched = undefined
    this.lock?.release()
  }

  /** The exit listener: whatever ends the process, this start's token file, socket and lock go while each is its own. */
  private cleanUpSync(): void {
    this.removeToken()
    this.channel?.removeSocketSync()
    this.lock?.release()
  }
}
