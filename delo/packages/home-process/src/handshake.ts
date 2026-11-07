/**
 * The update handshake (contract C19, "The update handshake" and "Rollback"): `update.prepare` runs the store's
 * `checking`, `installing` and `reporting` phases and keeps the report for 600 seconds; `update.apply` and `rollback`
 * run `snapshot`, `waiting`, `switching` and `health-check` and end `committed`, `rolled-back` or `aborted`. One
 * update or rollback runs at a time. The journal is written at the start of each phase from `snapshot` on.
 *
 * The rule this module enforces: `current` switches only after the waiting phase has seen zero running chats while
 * new turns are refused. The gate is held from the start of `waiting` until the update ends, and the switch runs
 * only when the gate reports no running chat at that moment.
 *
 * @module @delo/home-process/handshake
 */
import { randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delo/contract-home-layout'
import {
  DRAIN_TIMEOUT_DEFAULT_S,
  REPORT_LIFETIME_MS,
  type DrainPolicy,
  type HomeProcessErrorCode,
  type HomeProcessState,
  type UpdateOutcome,
  type UpdatePhase,
} from '@delo/contract-home-process'
import type { DeloLogger } from '@delo/logs'
import { HomeProcessError } from './errors.ts'
import type { HandoverLine, Successor } from './handover.ts'
import { removeJournal, writeJournal, type JournalledUpdate } from './journal.ts'
import type { ChatGate, PreparedRuntime, ProfileSnapshots, RuntimePointers, RuntimeStore } from './seams.ts'

/** What the handshake needs from the home process it runs in. */
export interface HandshakeSubject {
  /** The version this process runs. */
  readonly running: RuntimeVersion
  /** The resolved Delo home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The journal's path. */
  readonly journal: string
  /** The home process's logger. */
  readonly logger: DeloLogger
  /**
   * The running Host's chats.
   * @returns the gate.
   */
  chats(): ChatGate
  /**
   * Set the home process's state.
   * @param state - the new state.
   */
  setState(state: HomeProcessState): void
  /**
   * Stop the Host and the supervisor this process started, for the switch.
   * @returns when both have stopped.
   */
  suspend(): Promise<void>
  /**
   * Boot the Host and start the supervisor again on this process's runtime, after a failed switch.
   * @returns when the Host runs.
   */
  resume(): Promise<void>
  /**
   * Start the successor from the target's runtime with the handover line.
   * @param handover - the handover line.
   * @returns the successor.
   */
  startSuccessor(handover: HandoverLine): Successor
  /**
   * Hand the home lock to the successor.
   * @param successor - the successor.
   * @param startId - the start id assigned to it.
   * @param to - the version it runs.
   */
  handOver(successor: Successor, startId: StartId, to: RuntimeVersion): void
}

/** The store and profile history the handshake drives. */
export interface UpdateSupport {
  /** C1's runtime store. */
  readonly store: RuntimeStore
  /** C3's profile history. */
  readonly snapshots: ProfileSnapshots
}

/** The fields of a final handshake line after `ok: true`. */
export interface HandshakeResult extends Readonly<Record<string, unknown>> {
  /** The outcome. */
  readonly outcome: UpdateOutcome
  /** The reason code of a `rolled-back` or `aborted` outcome. */
  readonly reason?: HomeProcessErrorCode
}

/** Writes one progress line. */
export type Progress = (fields: Readonly<Record<string, unknown>>) => void

/** The update in progress, as `status` reports it. */
export interface UpdateState {
  /** Its phase. */
  readonly phase: UpdatePhase
  /** Its target version. */
  readonly target: RuntimeVersion
}

/** A report `update.prepare` returned, kept until it expires or is applied. */
interface KeptReport {
  readonly prepared: PreparedRuntime
  readonly expiresAt: number
}

/** Why the waiting phase stopped before running chats reached zero. */
class WaitEnded extends Error {
  constructor(readonly reason: 'DRAIN_TIMEOUT' | 'CANCELLED') {
    super(reason)
  }
}

/**
 * New random identifier: 16 bytes as 32 lowercase hexadecimal digits.
 * @returns the identifier.
 */
function randomId(): string {
  return randomBytes(16).toString('hex')
}

/** The update handshake of one home process. */
export class UpdateHandshake {
  private readonly reports = new Map<string, KeptReport>()
  private busy = false
  private current: UpdateState | undefined
  private waiting: AbortController | undefined
  private settled: Promise<unknown> = Promise.resolve()
  private committedSuccessor: Successor | undefined

  /**
   * @param subject - the home process.
   * @param support - the store and profile history.
   */
  constructor(private readonly subject: HandshakeSubject, private readonly support: UpdateSupport) {}

  /** The update in progress, or `undefined`. */
  get update(): UpdateState | undefined {
    return this.current
  }

  /** The successor an update committed to, which the home process hands the channel to once the final line is sent. */
  get committed(): Successor | undefined {
    return this.committedSuccessor
  }

  /**
   * `update.prepare`: fetch, verify and install the target and return its report.
   * @param target - the version, or `undefined` for the newest release.
   * @param progress - writes progress lines.
   * @returns the final line's fields: the report id and the report.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; the store's `VERIFY_FAILED`.
   */
  async prepare(target: RuntimeVersion | undefined, progress: Progress): Promise<Readonly<Record<string, unknown>>> {
    this.claim()
    try {
      const prepared = await this.support.store.prepare(target, (phase) => {
        this.current = { phase, target: target ?? this.subject.running }
        progress({ phase })
      })
      this.expireReports()
      const reportId = randomId()
      this.reports.set(reportId, { prepared, expiresAt: Date.now() + REPORT_LIFETIME_MS })
      this.subject.logger.info('update prepared', { data: { target: prepared.version } })
      return { reportId, report: prepared.report }
    } finally {
      this.current = undefined
      this.busy = false
    }
  }

  /**
   * `update.apply`: run the handshake to the prepared version.
   * @param reportId - the report `update.prepare` returned.
   * @param wait - how running chats are treated.
   * @param drainTimeoutS - the longest wait for running chats.
   * @param progress - writes progress lines.
   * @returns the outcome.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; `REPORT_EXPIRED` for an unknown or
   *   expired report.
   */
  async apply(reportId: string, wait: DrainPolicy, drainTimeoutS: number | undefined, progress: Progress): Promise<HandshakeResult> {
    this.claim()
    this.expireReports()
    const kept = this.reports.get(reportId)
    this.reports.delete(reportId)
    if (kept === undefined) {
      this.busy = false
      throw new HomeProcessError('REPORT_EXPIRED', 'the report is unknown or older than 600 seconds; prepare the update again')
    }
    return this.track(this.run(kept.prepared, wait, drainTimeoutS ?? DRAIN_TIMEOUT_DEFAULT_S, progress))
  }

  /**
   * `rollback`: run the handshake to the version `previous` names, installing nothing.
   * @param wait - how running chats are treated.
   * @param drainTimeoutS - the longest wait for running chats.
   * @param progress - writes progress lines.
   * @returns the outcome.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; `NO_PREVIOUS` without a `previous`.
   */
  async rollback(wait: DrainPolicy, drainTimeoutS: number | undefined, progress: Progress): Promise<HandshakeResult> {
    this.claim()
    let prepared: PreparedRuntime
    try {
      const { previous } = await this.support.store.pointers()
      if (previous === undefined) throw new HomeProcessError('NO_PREVIOUS', 'no previous runtime is kept')
      this.current = { phase: 'reporting', target: previous }
      progress({ phase: 'reporting' })
      prepared = await this.support.store.reportRollback(previous)
    } catch (error) {
      this.current = undefined
      this.busy = false
      throw error
    }
    return this.track(this.run(prepared, wait, drainTimeoutS ?? DRAIN_TIMEOUT_DEFAULT_S, progress))
  }

  /**
   * `update.cancel`: end an update that has not begun `switching`, leaving the runtime unchanged.
   * @returns when the update has ended, or at once when none runs.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` when the update is past `waiting`.
   */
  async cancel(): Promise<void> {
    if (this.waiting === undefined) {
      if (this.current === undefined) return
      throw new HomeProcessError('UPDATE_IN_PROGRESS', `the update is in ${this.current.phase} and can no longer be cancelled`)
    }
    this.waiting.abort(new WaitEnded('CANCELLED'))
    await this.settled
  }

  /**
   * Whether an update, a prepare or a rollback runs.
   * @returns true while one runs.
   */
  running(): boolean {
    return this.busy
  }

  private claim(): void {
    if (this.busy) throw new HomeProcessError('UPDATE_IN_PROGRESS', 'another update or rollback is running')
    this.busy = true
  }

  private track(run: Promise<HandshakeResult>): Promise<HandshakeResult> {
    this.settled = run.then(() => undefined, () => undefined)
    return run
  }

  private expireReports(): void {
    const now = Date.now()
    for (const [id, kept] of this.reports) if (kept.expiresAt <= now) this.reports.delete(id)
  }

  private async phase(update: JournalledUpdate, phase: UpdatePhase, progress: Progress): Promise<void> {
    this.current = { phase, target: update.to }
    await writeJournal(this.subject.journal, update, phase)
    this.subject.logger.info('update phase', { data: { phase, from: update.from, to: update.to } })
    progress({ phase })
  }

  /**
   * Wait until no chat runs while new turns are refused.
   * @param gate - the Host's chats.
   * @param wait - how running chats are treated.
   * @param drainTimeoutS - the longest wait.
   * @returns `undefined` when no chat runs, or the reason the wait ended.
   */
  private async drain(gate: ChatGate, wait: DrainPolicy, drainTimeoutS: number, cancellation: AbortSignal): Promise<HomeProcessErrorCode | 'CANCELLED' | undefined> {
    if (cancellation.aborted) return 'CANCELLED'
    if (wait === 'abort-if-busy' && gate.running() > 0) return 'CHATS_RUNNING'
    const timeout = new AbortController()
    const timer = setTimeout(() => { timeout.abort(new WaitEnded('DRAIN_TIMEOUT')) }, drainTimeoutS * 1000)
    const signal = AbortSignal.any([cancellation, timeout.signal])
    try {
      if (wait === 'cancel') await gate.cancelAll()
      while (gate.running() > 0) await gate.idle(signal)
      // The cancellation may have arrived as the last chat ended; it still ends the update.
      if (signal.aborted) throw signal.reason as Error
      return undefined
    } catch (error) {
      if (error instanceof WaitEnded) return error.reason === 'CANCELLED' ? 'CANCELLED' : 'DRAIN_TIMEOUT'
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  private async run(prepared: PreparedRuntime, wait: DrainPolicy, drainTimeoutS: number, progress: Progress): Promise<HandshakeResult> {
    const { store, snapshots } = this.support
    const from = this.subject.running
    const to = prepared.version
    let release: (() => void) | undefined
    let switching = false
    let update: JournalledUpdate | undefined
    // `update.cancel` ends the update until the switch begins.
    const cancellation = new AbortController()
    this.waiting = cancellation
    const end = async (result: HandshakeResult): Promise<HandshakeResult> => {
      release?.()
      await removeJournal(this.subject.journal)
      this.subject.setState('running')
      this.subject.logger.info('update ended', { data: { from, to, outcome: result.outcome, reason: result.reason ?? '' } })
      return result
    }
    try {
      const before: RuntimePointers = await store.pointers()
      update = { from, to, previous: before.previous, startedAt: new Date().toISOString() }
      await this.phase(update, 'snapshot', progress)
      await snapshots.save(from, to)

      // New turns are refused from the start of the phase, before it is announced.
      this.subject.setState('waiting')
      const gate = this.subject.chats()
      release = gate.hold()
      await this.phase(update, 'waiting', progress)
      const ended = await this.drain(gate, wait, drainTimeoutS, cancellation.signal)
      if (ended !== undefined) return await end(ended === 'CANCELLED' ? { outcome: 'aborted' } : { outcome: 'aborted', reason: ended })
      // No chat runs and new turns are refused: the switch below never runs under a chat.
      if (gate.running() !== 0) throw new Error('a chat began while new turns were refused')

      switching = true
      this.waiting = undefined
      this.subject.setState('switching')
      await this.phase(update, 'switching', progress)
      await this.subject.suspend()
      let successor: Successor | undefined
      try {
        await store.switchTo(from, to)
        const startId = brandString<StartId>(randomId())
        successor = this.subject.startSuccessor({ type: 'handover', v: 1, home: this.subject.home, profile: this.subject.profile, from, to, startId, disabledPlugins: prepared.disabledPlugins, startedAt: update.startedAt })
        await this.phase(update, 'health-check', progress)
        const answer = await successor.result
        if (answer.type === 'ready') {
          this.subject.handOver(successor, startId, to)
          this.committedSuccessor = successor
          this.current = { phase: 'committed', target: to }
          this.subject.logger.info('update committed', { data: { from, to, successor: successor.pid } })
          return { outcome: 'committed' }
        }
        this.subject.logger.warn('the successor failed its health check', { data: { to, reason: answer.reason } })
      } catch (error) {
        this.subject.logger.error('the switch failed; restoring the runtime that ran before', { err: error, data: { from, to } })
        await this.restore(successor, before, from, to)
        await end({ outcome: 'rolled-back' })
        throw error
      }
      await this.restore(successor, before, from, to)
      return await end({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
    } catch (error) {
      // A failure before the switch changed nothing; the journal of the phase it stopped in goes with it.
      if (!switching) {
        this.subject.logger.error('the update stopped before the switch', { err: error, data: { from, to } })
        await end({ outcome: 'aborted' })
      }
      throw error
    } finally {
      this.waiting = undefined
      if (this.committedSuccessor === undefined) {
        release?.()
        this.current = undefined
        this.busy = false
      }
    }
  }

  /**
   * Undo a switch: stop the successor, restore both pointers and the profile snapshot, and run this process's Host
   * on its own runtime again.
   */
  private async restore(successor: Successor | undefined, before: RuntimePointers, from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    await successor?.stop()
    await this.support.store.restore(before)
    await this.support.snapshots.restore(from, to)
    await this.subject.resume()
  }
}
