/**
 * The restart (contract C19, "The restart"): the home process starts a successor on the runtime it already runs, so a
 * change to Delorun itself that the person applied or undid runs, and keeps its own Host when the successor fails.
 *
 * It is its own path beside the update handshake and shares only the chat gate, the Host's stop and boot, the successor
 * start and C3's health check with it. It writes no runtime pointer, moves no update record or stash, commits no
 * session-data copy and runs no retention: the successor's handover line has the type `restart`, and a successor of a
 * restart settles no update record. It refuses while an update or a rollback runs, while the update record is in any
 * phase but `committed` (which it never reads further or writes), and while another restart runs.
 *
 * The order: `waiting` holds the gate (new turns are refused, as an update's `waiting` refuses them), cancels the
 * running chats when asked, and waits for none to run within its bound; `starting` stops the Host, starts the
 * successor and holds it to H1 to H5 with no plugin named, against this Host's own failed rows, rows and sandbox
 * protection, so any plugin the successor disables at boot beyond those already disabled fails it. On `ready` the lock
 * goes to the successor and this process ends. On any failure the successor's process group is killed, this process's
 * Host boots again, and {@link RestartSupport.leaveOut} leaves the newest harness change out when the successor carried
 * one this Host does not run. A Host that does not boot again stops this process, as after a failed update's switch.
 *
 * @module @delorun/home-process/restart
 */
import { randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delorun/contract-home-layout'
import type { HomeProcessState } from '@delorun/contract-home-process'
import type { DelorunLogger } from '@delorun/logs'
import { HomeProcessError } from './errors.ts'
import type { HandoverLine, Successor } from './handover.ts'
import { readJournal } from './journal.ts'
import type { BootRow, ChatGate, HealthExpectations, HostProtection } from './seams.ts'

/** The change a failed restart left out. */
export interface LeftOutChange {
  /** Its id in the harness's change log. */
  readonly id: string
  /** Its file, relative to the runtime, under `app/`. */
  readonly file: string
}

/** What a restart needs beyond the home process: the leave-out after a failed successor, which Changes owns. */
export interface RestartSupport {
  /**
   * Leave the runtime's newest harness change out after a successor failed, when it is a change the running Host does
   * not run.
   * @param failure - why the successor failed, for the change log.
   * @returns the change left out, or undefined when none was.
   */
  leaveOut(failure: string): Promise<LeftOutChange | undefined>
}

/** Why a restart ended without a new Host. */
export type RestartFailureReason =
  /** The successor exited, failed or did not answer within its health check. */
  | 'health'
  /** Chats still ran when the wait's bound passed; nothing was stopped. */
  | 'chats'
  /** The Host did not stop for the switch; nothing was started and the Host runs again. */
  | 'host'

/** The restart as the studio reads it. */
export type RestartView =
  | { readonly kind: 'idle' }
  | {
    readonly kind: 'restarting'
    /** RFC 3339 UTC time it began. */
    readonly since: string
    /** `waiting`: the Host answers and refuses new turns; `starting`: no Host answers until the successor or this one runs. */
    readonly phase: 'waiting' | 'starting'
    /** The chats it waits for now. */
    readonly runningChats: number
  }
  | {
    readonly kind: 'failed'
    /** RFC 3339 UTC time it ended. */
    readonly at: string
    /** Why, in the person's words, without a path under the home. */
    readonly failure: string
    readonly reason: RestartFailureReason
    /** The change it left out, when it left one out. */
    readonly leftOut?: LeftOutChange
  }

/** How a restart treats running chats. */
export interface RestartRequest {
  /** Cancel running turns and background jobs instead of waiting for them. */
  readonly stopChats: boolean
  /** The longest wait for running chats, in seconds, and the bound of the Host's stop. */
  readonly drainTimeoutS: number
}

/** How a restart ended. */
export type RestartOutcome =
  /** The successor took over; this process ends. */
  | { readonly outcome: 'restarted' }
  /** This process's Host runs; {@link RestartView}'s `failed` says why. */
  | { readonly outcome: 'kept', readonly reason: RestartFailureReason }
  /** The wait was cancelled; nothing changed. */
  | { readonly outcome: 'cancelled' }

/** The restart as the Host and the update channel drive it. */
export interface RestartControl {
  /**
   * The restart now, or the last one's failure.
   * @returns the view.
   */
  view(): RestartView
  /**
   * The running chats a restart would wait for now.
   * @returns their number; 0 while no Host runs.
   */
  runningChats(): number
  /**
   * Begin a restart. Refusals come before anything changes; once begun, the restart runs on after this returns, so a
   * studio request is answered before its Host stops.
   * @param request - how running chats are treated.
   * @returns the chats it waits for, and the outcome once it has ended.
   * @throws {HomeProcessError} `RESTART_IN_PROGRESS` while a restart runs; `UPDATE_IN_PROGRESS` while an update or a
   *   rollback runs, the update record is in a phase other than `committed`, or the home process is not `running`;
   *   `NO_RUNTIME_STORE` without the runtime store.
   */
  begin(request: RestartRequest): Promise<{ readonly runningChats: number, readonly done: Promise<RestartOutcome> }>
  /**
   * End a restart that still waits for running chats.
   * @returns whether one was waiting; false once it is `starting` or when none runs.
   */
  cancel(): Promise<boolean>
  /** Forget the last restart's failure, as the next decision about a change to Delorun itself does. */
  clearFailure(): void
}

/** What a restart needs from the home process it runs in. */
export interface RestartSubject {
  /** The version this process runs. */
  readonly running: RuntimeVersion
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The update record's path. */
  readonly journal: string
  /** The home process's logger. */
  readonly logger: DelorunLogger
  /**
   * The home process's state.
   * @returns it.
   */
  state(): HomeProcessState
  /**
   * Set the home process's state.
   * @param state - the new state.
   */
  setState(state: HomeProcessState): void
  /**
   * Whether an update, a prepare or a rollback runs.
   * @returns true while one runs.
   */
  updating(): boolean
  /**
   * The running Host's chats.
   * @returns the gate, or undefined while no Host runs.
   */
  chats(): ChatGate | undefined
  /** @returns the rows that were disabled or did not load when the running Host booted. */
  failedRows(): readonly BootRow[]
  /** @returns every row the running Host had at boot. */
  rows(): readonly BootRow[]
  /** @returns the sandbox protection the running Host booted with. */
  protection(): HostProtection | undefined
  /**
   * Stop the Host, keeping this process.
   * @param limitS - the longest wait, in seconds.
   * @throws {HomeProcessError} `HOST_STOP_FAILED` when its teardown failed or overran.
   */
  suspend(limitS: number): Promise<void>
  /**
   * Boot this process's Host again; a boot that fails stops this process.
   * @throws the boot's failure, after this process was told to stop.
   */
  resume(): Promise<void>
  /**
   * Start the successor with a handover line.
   * @param handover - the line.
   * @returns the successor.
   * @throws {Error} without the runtime store.
   */
  startSuccessor(handover: HandoverLine): Successor
  /**
   * Hand the lock to the successor.
   * @param successor - the successor.
   * @param startId - its start id.
   * @param to - the version it runs.
   */
  handOver(successor: Successor, startId: StartId, to: RuntimeVersion): void
  /**
   * Hand the channel to a successor that took the lock, and end this process.
   * @param successor - the successor.
   * @returns when this process was told to exit.
   */
  finish(successor: Successor): Promise<void>
}

/** A wait that ended before every chat did. */
class WaitEnded extends Error {
  readonly reason: 'cancelled' | 'timeout'

  /** @param reason - why it ended. */
  constructor(reason: 'cancelled' | 'timeout') {
    super(reason)
    this.reason = reason
  }
}

/** The words of a failed restart, by reason; a successor's health criterion is added to `health`'s. */
const FAILURE_WORDS: Readonly<Record<RestartFailureReason, string>> = {
  health: 'Delorun did not start with the changes, so it kept running as before',
  chats: 'chats were still running when the wait ended, so Delorun did not restart',
  host: 'Delorun could not stop to restart, so it kept running as before',
}

/** One restart at a time for one home process. */
export class Restart implements RestartControl {
  private current: RestartView = { kind: 'idle' }
  private waiting: AbortController | undefined
  private settled: Promise<unknown> = Promise.resolve()

  private readonly subject: RestartSubject
  private readonly support: RestartSupport | undefined

  /**
   * @param subject - the home process.
   * @param support - the leave-out after a failed successor, or undefined without the runtime store.
   */
  constructor(subject: RestartSubject, support: RestartSupport | undefined) {
    this.subject = subject
    this.support = support
  }

  /** @inheritdoc */
  view(): RestartView {
    if (this.current.kind !== 'restarting') return this.current
    return { ...this.current, runningChats: this.runningChats() }
  }

  /** @inheritdoc */
  runningChats(): number {
    return this.subject.chats()?.running() ?? 0
  }

  /** Whether a restart runs. */
  get running(): boolean {
    return this.current.kind === 'restarting'
  }

  /** @inheritdoc */
  async begin(request: RestartRequest): Promise<{ readonly runningChats: number, readonly done: Promise<RestartOutcome> }> {
    if (this.running) throw new HomeProcessError('RESTART_IN_PROGRESS', 'Delorun is already restarting')
    if (this.support === undefined) throw new HomeProcessError('NO_RUNTIME_STORE', 'Delorun runs from a source checkout, which it cannot restart itself; stop it and start it again')
    if (this.subject.updating()) throw new HomeProcessError('UPDATE_IN_PROGRESS', 'an update or rollback is running; restart once it has ended')
    if (this.subject.state() !== 'running') throw new HomeProcessError('UPDATE_IN_PROGRESS', `the home process is ${this.subject.state()}`)
    const record = await readJournal(this.subject.journal)
    if (record !== undefined && record.phase !== 'committed') throw new HomeProcessError('UPDATE_IN_PROGRESS', `an update is recorded in its ${record.phase} phase; restart once it has ended`)
    // Checked again after the read: another request may have begun meanwhile.
    if (this.running) throw new HomeProcessError('RESTART_IN_PROGRESS', 'Delorun is already restarting')
    if (this.subject.updating() || this.subject.state() !== 'running') throw new HomeProcessError('UPDATE_IN_PROGRESS', 'an update or rollback is running; restart once it has ended')
    const runningChats = this.runningChats()
    this.current = { kind: 'restarting', since: new Date().toISOString(), phase: 'waiting', runningChats }
    const cancellation = new AbortController()
    this.waiting = cancellation
    const done = this.run(request, cancellation.signal)
    this.settled = done.then(() => undefined, () => undefined)
    return { runningChats, done }
  }

  /** @inheritdoc */
  async cancel(): Promise<boolean> {
    const waiting = this.waiting
    if (waiting === undefined) return false
    waiting.abort(new WaitEnded('cancelled'))
    await this.settled
    return true
  }

  /** @inheritdoc */
  clearFailure(): void {
    if (this.current.kind === 'failed') this.current = { kind: 'idle' }
  }

  private async run(request: RestartRequest, cancellation: AbortSignal): Promise<RestartOutcome> {
    const { logger } = this.subject
    const runtime = this.subject.running
    let release: (() => void) | undefined
    try {
      logger.info('restart: waiting for running chats', { data: { runtime, chats: this.runningChats(), stopChats: request.stopChats } })
      this.subject.setState('waiting')
      const gate = this.subject.chats()
      release = gate?.hold()
      const ended = gate === undefined ? undefined : await this.drain(gate, request, cancellation)
      // A cancel that came once the wait had ended still counts: nothing has stopped yet.
      if (ended === 'cancelled' || cancellation.aborted) {
        this.end('running', { kind: 'idle' }, release)
        logger.info('restart: cancelled while it waited')
        return { outcome: 'cancelled' }
      }
      if (ended === 'timeout') return this.fail('chats', FAILURE_WORDS.chats, undefined, release)

      // Read while the Host still runs and the state is `waiting`, so a failure here ends the restart with nothing stopped.
      const health = this.expectations()
      this.waiting = undefined
      this.current = { ...this.current as Extract<RestartView, { kind: 'restarting' }>, phase: 'starting' }
      this.subject.setState('switching')
      try {
        await this.subject.suspend(request.drainTimeoutS)
      } catch (error) {
        logger.error('restart: the Host did not stop; nothing was started and it runs again', { err: error })
        return await this.keep('host', FAILURE_WORDS.host, undefined, release)
      }
      const startId = brandString<StartId>(randomBytes(16).toString('hex'))
      let successor: Successor | undefined
      let criterion: string | undefined
      try {
        successor = this.subject.startSuccessor({
          type: 'restart', v: 1, home: this.subject.home, profile: this.subject.profile, from: runtime, to: runtime, startId, health, startedAt: new Date().toISOString(),
        })
        const answer = await successor.result
        if (answer.type === 'ready') {
          this.subject.handOver(successor, startId, runtime)
          logger.info('restart: the successor took over', { data: { successor: successor.pid } })
          await this.subject.finish(successor)
          return { outcome: 'restarted' }
        }
        criterion = answer.criterion
        logger.warn('restart: the successor failed its health check', { data: { criterion: criterion ?? '' } })
      } catch (error) {
        logger.error('restart: the successor could not be started', { err: error })
      }
      await successor?.stop()
      const failure = criterion === undefined ? FAILURE_WORDS.health : `${FAILURE_WORDS.health} (${criterion})`
      const leftOut = await this.support!.leaveOut(failure).catch((error: unknown) => {
        logger.error('restart: the newest change to Delorun itself could not be left out', { err: error })
        return undefined
      })
      return await this.keep('health', failure, leftOut, release)
    } catch (error) {
      // An unexpected failure before the Host stopped: the Host still runs, so the restart ends with nothing changed.
      if (this.subject.state() === 'waiting') {
        logger.error('restart: stopped before the switch', { err: error })
        return this.fail('host', FAILURE_WORDS.host, undefined, release)
      }
      throw error
    } finally {
      this.waiting = undefined
    }
  }

  /**
   * Wait until no chat runs while new turns are refused.
   * @returns undefined once none runs, or why the wait ended first.
   */
  private async drain(gate: ChatGate, request: RestartRequest, cancellation: AbortSignal): Promise<'cancelled' | 'timeout' | undefined> {
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new WaitEnded('timeout')) }, request.drainTimeoutS * 1000)
    const signal = AbortSignal.any([cancellation, timeout.signal])
    try {
      if (request.stopChats) await gate.cancelAll()
      while (gate.running() > 0) await gate.idle(signal)
      if (signal.aborted) throw signal.reason as Error
      return undefined
    } catch (error) {
      if (error instanceof WaitEnded) return error.reason
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * What the successor's health check holds it to: no plugin named, and this Host's own failed rows, rows and sandbox
   * protection, read while it still runs.
   * @returns the expectations.
   */
  private expectations(): HealthExpectations {
    const protection = this.subject.protection()
    return { disabledPlugins: [], namedRows: [], previousFailures: this.subject.failedRows(), previousRows: this.subject.rows(), ...protection === undefined ? {} : { previousProtection: protection } }
  }

  /** Boot this Host again after the switch began, then record the failure. */
  private async keep(reason: RestartFailureReason, failure: string, leftOut: LeftOutChange | undefined, release: (() => void) | undefined): Promise<RestartOutcome> {
    try {
      await this.subject.resume()
    } catch (error) {
      this.current = { kind: 'failed', at: new Date().toISOString(), failure, reason, ...leftOut === undefined ? {} : { leftOut } }
      throw error
    }
    return this.fail(reason, failure, leftOut, release)
  }

  private fail(reason: RestartFailureReason, failure: string, leftOut: LeftOutChange | undefined, release: (() => void) | undefined): RestartOutcome {
    this.end('running', { kind: 'failed', at: new Date().toISOString(), failure, reason, ...leftOut === undefined ? {} : { leftOut } }, release)
    this.subject.logger.warn('restart: kept the running Host', { data: { reason, leftOut: leftOut?.id ?? '' } })
    return { outcome: 'kept', reason }
  }

  private end(state: HomeProcessState, view: RestartView, release: (() => void) | undefined): void {
    release?.()
    this.current = view
    this.subject.setState(state)
  }
}
