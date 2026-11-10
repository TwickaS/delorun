/**
 * The update handshake (contract C19, "The update handshake" and "Rollback"; contract C3, "Rollback"):
 * `update.prepare` runs the store's `checking`, `installing` and `reporting` phases and keeps the report for 600
 * seconds; `update.apply` runs `snapshot`, `waiting`, `switching` and `health-check` and ends `committed`,
 * `rolled-back`, `aborted` or `failed`; `rollback` reads the update record and goes back through C3's rollback table.
 * One update or rollback runs at a time. The update record is written at the start of each phase from `snapshot` on,
 * and with `targetStarted` before the target's process is spawned; the previous update's committed record waits in
 * the stash until the update commits or ends.
 *
 * The rule this module enforces: `current` switches only after the waiting phase has seen zero running chats while
 * new turns are refused. The gate is held from the start of `waiting` until the update ends, and the switch runs
 * only when the gate reports no running chat at that moment. A session-data copy is written only after the Host has
 * stopped, and every way back goes through {@link SessionDataCopies.rollback}, which marks the record `rolling-back`
 * before its first step. Once a step may have run, this process never runs its Host again: it stops, and the record
 * stays for the next start, which completes the rollback.
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
  type UpdateJournal,
  type UpdatePhase,
} from '@delo/contract-home-process'
import type { DeloLogger } from '@delo/logs'
import { HomeProcessError } from './errors.ts'
import type { HandoverLine, Successor } from './handover.ts'
import { endUpdateRecord, journalledUpdate, journalRecord, readJournal, removeJournal, stashCommitted, writeJournal, type JournalledUpdate } from './journal.ts'
import type { ChatGate, HealthExpectations, PreparedRuntime, ProfileSnapshots, RuntimePointers, RuntimeStore, SessionDataCopies } from './seams.ts'

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
   * The rows the running Host could not load at boot, which the successor's H4 allows.
   * @returns their ids or names.
   */
  failedRows(): readonly string[]
  /**
   * Every row the running Host had at boot, which the successor's H3 compares with its own.
   * @returns their ids, or none without a running Host.
   */
  rows(): readonly string[]
  /**
   * Hand the home lock to the successor.
   * @param successor - the successor.
   * @param startId - the start id assigned to it.
   * @param to - the version it runs.
   */
  handOver(successor: Successor, startId: StartId, to: RuntimeVersion): void
}

/** The store, profile history and session-data copies the handshake drives. */
export interface UpdateSupport {
  /** C1's runtime store. */
  readonly store: RuntimeStore
  /** C3's profile history. */
  readonly snapshots: ProfileSnapshots
  /** C3's session-data copies and its one rollback function. */
  readonly copies: SessionDataCopies
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

/**
 * Whether an error is a home-process refusal with one code.
 * @param error - the error.
 * @param code - the code.
 * @returns true when it is.
 */
function isRefusal(error: unknown, code: HomeProcessErrorCode): boolean {
  return error instanceof HomeProcessError && error.code === code
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
  private failedRollback = false

  /**
   * @param subject - the home process.
   * @param support - the store, the profile history and the session-data copies.
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
   * Whether a rollback was refused by C3's table after the switch, or stopped after a step may have run, so this
   * process may not run its Host again and stops once the final line is sent.
   */
  get failed(): boolean {
    return this.failedRollback
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
      }, (line) => { progress({ line }) })
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
   * @param dataCopy - whether a session-data copy is taken before the switch: the person's choice.
   * @param progress - writes progress lines.
   * @returns the outcome.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; `REPORT_EXPIRED` for an unknown or
   *   expired report; `DATA_COPY_NO_SPACE` when the copy does not fit, before anything changed.
   */
  async apply(reportId: string, wait: DrainPolicy, drainTimeoutS: number | undefined, dataCopy: boolean, progress: Progress): Promise<HandshakeResult> {
    this.claim()
    this.expireReports()
    const kept = this.reports.get(reportId)
    this.reports.delete(reportId)
    if (kept === undefined) {
      this.busy = false
      throw new HomeProcessError('REPORT_EXPIRED', 'the report is unknown or older than 600 seconds; prepare the update again')
    }
    return this.track(this.run(kept.prepared, dataCopy, wait, drainTimeoutS ?? DRAIN_TIMEOUT_DEFAULT_S, progress))
  }

  /**
   * `rollback`: go back from the update the update record names, through C3's rollback table: the data, the profile
   * snapshot and the runtime, or the profile alone with `profileOnly`.
   * @param wait - how running chats are treated.
   * @param drainTimeoutS - the longest wait for running chats.
   * @param profileOnly - restore only the profile snapshot and keep this runtime.
   * @param progress - writes progress lines.
   * @returns the outcome.
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; `NO_UPDATE_RECORD` without a committed
   *   update this process runs; `ROLLBACK_NEEDS_DATA_COPY` or `ROLLBACK_TARGET_UNUSABLE` from the table, with
   *   nothing changed and this Host running again.
   */
  async rollback(wait: DrainPolicy, drainTimeoutS: number | undefined, profileOnly: boolean, progress: Progress): Promise<HandshakeResult> {
    this.claim()
    let record: UpdateJournal
    let prepared: PreparedRuntime | undefined
    try {
      const found = await readJournal(this.subject.journal)
      if (found?.phase !== 'committed' || found.to !== this.subject.running) {
        throw new HomeProcessError('NO_UPDATE_RECORD', `no committed update to ${this.subject.running} is recorded; nothing to roll back`)
      }
      record = found
      this.announce('reporting', record.from, progress)
      if (!profileOnly) prepared = await this.support.store.reportRollback(record.from)
    } catch (error) {
      this.current = undefined
      this.busy = false
      throw error
    }
    return this.track(this.runRollback(record, prepared, wait, drainTimeoutS ?? DRAIN_TIMEOUT_DEFAULT_S, progress))
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

  private announce(phase: UpdatePhase, target: RuntimeVersion, progress: Progress): void {
    this.current = { phase, target }
    progress({ phase })
  }

  private async phase(update: JournalledUpdate, phase: UpdatePhase, progress: Progress): Promise<void> {
    // The journal is written before the phase is announced: a kill while this runs leaves the journal at most one
    // phase ahead of what `status` reports, never behind, and either state recovers the same way.
    await writeJournal(this.subject.journal, update, phase)
    this.subject.logger.info('update phase', { data: { phase, from: update.from, to: update.to } })
    this.announce(phase, update.to, progress)
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

  /**
   * Hold new turns and wait for running chats, as the `waiting` phase does.
   * @returns the gate's release and the reason the wait ended, `undefined` when no chat runs.
   */
  private async quiesce(wait: DrainPolicy, drainTimeoutS: number, cancellation: AbortSignal, enter: () => Promise<void>): Promise<{ readonly release: () => void, readonly ended: HomeProcessErrorCode | 'CANCELLED' | undefined }> {
    // New turns are refused from the start of the phase, before it is announced.
    this.subject.setState('waiting')
    const gate = this.subject.chats()
    const release = gate.hold()
    await enter()
    const ended = await this.drain(gate, wait, drainTimeoutS, cancellation)
    // No chat runs and new turns are refused: the switch after this never runs under a chat.
    if (ended === undefined && gate.running() !== 0) throw new Error('a chat began while new turns were refused')
    return { release, ended }
  }

  /**
   * What the successor's health check holds it to: the report's expectations and what the running Host had at boot,
   * read while that Host still runs.
   */
  private expectations(health: PreparedRuntime['health']): HealthExpectations {
    return { ...health, previousFailures: this.subject.failedRows(), previousRows: this.subject.rows() }
  }

  /**
   * End a handshake that may not run this process's Host again: the process stops once the final line is sent, and
   * the record stays for the next start.
   */
  private stopServing(result: HandshakeResult, message: string, error: unknown, data: Readonly<Record<string, unknown>>): HandshakeResult {
    this.failedRollback = true
    this.subject.setState('stopping')
    this.subject.logger.error(message, { err: error, data })
    return result
  }

  private async run(prepared: PreparedRuntime, dataCopy: boolean, wait: DrainPolicy, drainTimeoutS: number, progress: Progress): Promise<HandshakeResult> {
    const { store, snapshots, copies } = this.support
    const journal = this.subject.journal
    const from = this.subject.running
    const to = prepared.version
    let release: (() => void) | undefined
    let switching = false
    // Set once a committed record is stashed and this update owns the record.
    let recorded = false
    let copyAttempted = false
    // `update.cancel` ends the update until the switch begins.
    const cancellation = new AbortController()
    this.waiting = cancellation
    const end = async (result: HandshakeResult): Promise<HandshakeResult> => {
      release?.()
      // The copy goes before the record, so a kill between the two leaves a record that names the copy to remove.
      if (result.outcome === 'aborted' && copyAttempted) await copies.discard(to)
      if (recorded) await endUpdateRecord(journal)
      this.subject.setState('running')
      this.subject.logger.info('update ended', { data: { from, to, outcome: result.outcome, reason: result.reason ?? '' } })
      return result
    }
    try {
      const before: RuntimePointers = await store.pointers()
      let update: JournalledUpdate = {
        from, to, previous: before.previous, startedAt: new Date().toISOString(), dataDiffers: prepared.dataDiffers, copy: dataCopy, targetStarted: false, health: prepared.health,
      }
      // A copy that cannot fit refuses the update before anything is written.
      if (dataCopy) await copies.plan()
      await stashCommitted(journal)
      recorded = true
      await this.phase(update, 'snapshot', progress)
      update = { ...update, snapshot: await snapshots.save(from, to, prepared.report) }

      const quiet = await this.quiesce(wait, drainTimeoutS, cancellation.signal, () => this.phase(update, 'waiting', progress))
      release = quiet.release
      if (quiet.ended !== undefined) return await end(quiet.ended === 'CANCELLED' ? { outcome: 'aborted' } : { outcome: 'aborted', reason: quiet.ended })

      switching = true
      this.waiting = undefined
      this.subject.setState('switching')
      await this.phase(update, 'switching', progress)
      const health = this.expectations(prepared.health)
      await this.subject.suspend()
      if (dataCopy) {
        copyAttempted = true
        try {
          await copies.save(from, to)
        } catch (error) {
          // Nothing switched: the Host runs again on this runtime and the update ends.
          this.subject.logger.error('the session-data copy could not be written; the update stops', { err: error, data: { from, to } })
          await this.subject.resume()
          await end({ outcome: 'aborted' })
          throw error
        }
      }
      let successor: Successor | undefined
      try {
        await store.switchTo(from, to)
        // Written and synced before the spawn: from here a rollback treats the data as opened by `to`.
        update = { ...update, targetStarted: true }
        await this.phase(update, 'health-check', progress)
        const startId = brandString<StartId>(randomId())
        successor = this.subject.startSuccessor({
          type: 'handover', v: 1, home: this.subject.home, profile: this.subject.profile, from, to, startId, health, startedAt: update.startedAt,
        })
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
        this.subject.logger.error('the switch failed; rolling back', { err: error, data: { from, to } })
        const back = await this.rollBackFailedUpdate(successor, before, update, end)
        if (back.outcome === 'failed') return back
        throw error
      }
      return await this.rollBackFailedUpdate(successor, before, update, end)
    } catch (error) {
      // A failure before the switch changed nothing; the record of the phase it stopped in goes with it.
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
   * C3's automatic rollback after a failed switch or health check: stop the successor and apply the rollback table
   * with the pointers restored to their values before the update; on success this process's Host runs again, the
   * record goes and the stashed record returns. When the table refuses, nothing is restored: the record stays with
   * `refused`, the pointers name `to`, and this process stops. When a step may have run, the record stays
   * `rolling-back` and this process stops; the next start completes the rollback.
   */
  private async rollBackFailedUpdate(successor: Successor | undefined, before: RuntimePointers, update: JournalledUpdate, end: (result: HandshakeResult) => Promise<HandshakeResult>): Promise<HandshakeResult> {
    await successor?.stop()
    const journal = this.subject.journal
    const phase: UpdatePhase = update.targetStarted ? 'health-check' : 'switching'
    const data = { from: update.from, to: update.to }
    try {
      await this.support.copies.rollback(journalRecord(update, phase), {
        profileOnly: false,
        switchRuntime: () => this.support.store.restore(before),
        markRollingBack: () => writeJournal(journal, update, 'rolling-back'),
      })
    } catch (error) {
      if (isRefusal(error, 'ROLLBACK_NEEDS_DATA_COPY')) {
        await writeJournal(journal, { ...update, refused: true }, phase)
        return this.stopServing({ outcome: 'failed', reason: 'ROLLBACK_NEEDS_DATA_COPY' }, 'the target failed its health check and the rollback needs a session-data copy that was not taken; run delorun recover rollback --profile-only or start in safe mode', error, data)
      }
      if (isRefusal(error, 'ROLLBACK_TARGET_UNUSABLE')) {
        return this.stopServing({ outcome: 'failed', reason: 'ROLLBACK_TARGET_UNUSABLE' }, 'the target failed its health check and the version to roll back to cannot run; run delorun recover', error, data)
      }
      return this.stopServing({ outcome: 'failed' }, 'the rollback stopped after a step may have run; the next start completes it', error, data)
    }
    await this.subject.resume()
    return end({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED' })
  }

  /**
   * The person's rollback while this process runs the update's target: wait for running chats, stop the Host, apply
   * C3's rollback table, and start the version rolled back to as a successor, which removes the record once its health
   * check passed; with `profileOnly`, run this Host again and remove the record. A refusal runs this Host again with
   * nothing changed; any other failure, and a successor that fails its health check, stop this process with the
   * record `rolling-back`, so the next start completes the rollback.
   */
  private async runRollback(record: UpdateJournal, prepared: PreparedRuntime | undefined, wait: DrainPolicy, drainTimeoutS: number, progress: Progress): Promise<HandshakeResult> {
    const { store, copies } = this.support
    const journal = this.subject.journal
    const running = this.subject.running
    const data = { from: record.from, to: record.to }
    let release: (() => void) | undefined
    const cancellation = new AbortController()
    this.waiting = cancellation
    const end = (result: HandshakeResult): HandshakeResult => {
      release?.()
      this.subject.setState('running')
      this.subject.logger.info('rollback ended', { data: { ...data, outcome: result.outcome, reason: result.reason ?? '' } })
      return result
    }
    try {
      const quiet = await this.quiesce(wait, drainTimeoutS, cancellation.signal, async () => { this.announce('waiting', record.from, progress) })
      release = quiet.release
      if (quiet.ended !== undefined) return end(quiet.ended === 'CANCELLED' ? { outcome: 'aborted' } : { outcome: 'aborted', reason: quiet.ended })
      this.waiting = undefined
      this.subject.setState('switching')
      this.announce('switching', record.from, progress)
      const health = prepared === undefined ? undefined : this.expectations(prepared.health)
      await this.subject.suspend()
      try {
        await copies.rollback(record, {
          profileOnly: health === undefined,
          switchRuntime: () => store.switchTo(running, record.from),
          // A profile-only rollback keeps this runtime, so its record stays `committed` and the person can run it again.
          markRollingBack: health === undefined ? async () => {} : () => writeJournal(journal, journalledUpdate(record), 'rolling-back'),
        })
      } catch (error) {
        if (isRefusal(error, 'ROLLBACK_NEEDS_DATA_COPY') || isRefusal(error, 'ROLLBACK_TARGET_UNUSABLE')) {
          // Refused before any step: this Host runs again with nothing changed.
          await this.subject.resume()
          end({ outcome: 'aborted' })
          throw error
        }
        return this.stopServing({ outcome: 'failed' }, 'the rollback stopped after a step may have run; the next start completes it', error, data)
      }
      if (health === undefined) {
        await this.subject.resume()
        await removeJournal(journal)
        return end({ outcome: 'rolled-back' })
      }
      this.announce('health-check', record.from, progress)
      const startId = brandString<StartId>(randomId())
      const successor = this.subject.startSuccessor({
        type: 'handover', v: 1, home: this.subject.home, profile: this.subject.profile, from: running, to: record.from, startId, health, startedAt: new Date().toISOString(),
      })
      const answer = await successor.result
      if (answer.type === 'ready') {
        this.subject.handOver(successor, startId, record.from)
        this.committedSuccessor = successor
        this.current = { phase: 'committed', target: record.from }
        return { outcome: 'rolled-back' }
      }
      // The data and the profile are back for `from`, so `to` may not run on them: the pointers stay on `from`.
      await successor.stop()
      return this.stopServing({ outcome: 'failed', reason: 'HEALTH_CHECK_FAILED' }, 'the version rolled back to failed its health check; the next start completes the rollback', undefined, data)
    } finally {
      this.waiting = undefined
      if (this.committedSuccessor === undefined) {
        release?.()
        this.current = undefined
        this.busy = false
      }
    }
  }
}
