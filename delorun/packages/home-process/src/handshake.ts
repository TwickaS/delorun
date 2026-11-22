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
 * @module @delorun/home-process/handshake
 */
import { randomBytes } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { RuntimeVersion, StartId } from '@delorun/contract-home-layout'
import {
  DRAIN_TIMEOUT_DEFAULT_S,
  REPORT_LIFETIME_MS,
  type DrainPolicy,
  type HomeProcessErrorCode,
  type HomeProcessState,
  type UpdateOutcome,
  type UpdateJournal,
  type UpdatePhase,
} from '@delorun/contract-home-process'
import type { DelorunLogger } from '@delorun/logs'
import { HomeProcessError, isRollbackRefusal } from './errors.ts'
import type { HandoverLine, Successor } from './handover.ts'
import { removeUpdateResult, updateResultPath, writeUpdateResult, type UpdateResultRecord } from './update-result.ts'
import { endUpdateRecord, journalledUpdate, journalRecord, readJournal, removeJournal, stashCommitted, writeJournal, type JournalledUpdate } from './journal.ts'
import type { BootRow, ChatGate, HarnessCarry, HealthExpectations, HostProtection, PreparedRuntime, ProfileSnapshots, RuntimePointers, RuntimeStore, SessionDataCopies } from './seams.ts'

/** What the handshake needs from the home process it runs in. */
export interface HandshakeSubject {
  /** The version this process runs. */
  readonly running: RuntimeVersion
  /** The resolved Delorun home. */
  readonly home: string
  /** The CLI profile. */
  readonly profile: string
  /** The journal's path. */
  readonly journal: string
  /** The home process's logger. */
  readonly logger: DelorunLogger
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
   * Stop the Host and the supervisor this process started, for the switch, keeping this process.
   * @param limitS - the longest wait for the Host's teardown, the update's `drainTimeoutS`.
   * @returns when both have stopped.
   * @throws {HomeProcessError} `HOST_STOP_FAILED` when the Host's teardown fails or does not finish within `limitS`;
   *   the supervisor is stopped either way, and no Host runs.
   */
  suspend(limitS: number): Promise<void>
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
   * The rows the running Host had disabled or that did not load at boot, which the successor's H3 and H4 allow.
   * @returns the rows, or none without a running Host.
   */
  failedRows(): readonly BootRow[]
  /**
   * Every row the running Host had at boot, which the successor's H3 compares with its own.
   * @returns their ids and plugin names, or none without a running Host.
   */
  rows(): readonly BootRow[]
  /**
   * The sandbox protection the running Host booted with, which the successor's H3 holds its own to.
   * @returns the protection, or `undefined` without a running Host or without a sandbox row that sets one.
   */
  protection(): HostProtection | undefined
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
  /** The person's approved harness files, carried to the target as the runtime switches. */
  readonly harness: HarnessCarry
}

/** The fields of a final handshake line after `ok: true`. */
export interface HandshakeResult extends Readonly<Record<string, unknown>> {
  /** The outcome. */
  readonly outcome: UpdateOutcome
  /** The reason code of a `rolled-back` or `aborted` outcome. */
  readonly reason?: HomeProcessErrorCode
  /** The first of C3's health criteria the target failed, such as `H2-host-ready`, when its Host named one. */
  readonly criterion?: string
  /** What the person reads about a rollback that ended `rolled-back`, one line each, such as the chats it set aside. */
  readonly lines?: readonly string[]
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
  readonly reason: 'DRAIN_TIMEOUT' | 'CANCELLED'

  constructor(reason: 'DRAIN_TIMEOUT' | 'CANCELLED') {
    super(reason)
    this.reason = reason
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
  /** The update or rollback that runs, which the outcome record names. */
  private attempt: { readonly kind: UpdateResultRecord['kind'], readonly from: RuntimeVersion, readonly to: RuntimeVersion } | undefined

  /** The home process. */
  private readonly subject: HandshakeSubject
  /** The store, the profile history and the session-data copies. */
  private readonly support: UpdateSupport

  /**
   * @param subject - the home process.
   * @param support - the store, the profile history and the session-data copies.
   */
  constructor(subject: HandshakeSubject, support: UpdateSupport) {
    this.subject = subject
    this.support = support
  }

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
   * @throws {HomeProcessError} `UPDATE_IN_PROGRESS` while another update runs; `HARNESS_CHANGES_PENDING` while changes
   *   to the running harness wait for review; the store's `VERIFY_FAILED`, `CHANNEL_UNREACHABLE`, `GIT_UNAVAILABLE` or
   *   `CHATS_RUNNING`.
   */
  async prepare(target: RuntimeVersion | undefined, progress: Progress): Promise<Readonly<Record<string, unknown>>> {
    this.claim()
    try {
      await this.support.harness.check(this.subject.running)
      const prepared = await this.support.store.prepare(target, (phase) => {
        this.current = { phase, target: target ?? this.subject.running }
        progress({ phase })
      }, (install) => { progress({ install }) })
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
   *   update this process runs; `ROLLBACK_NEEDS_DATA_COPY`, `ROLLBACK_TARGET_UNUSABLE`, `CHATS_RUNNING` or
   *   `GIT_UNAVAILABLE` from the table, with nothing changed and this Host running again.
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
      this.rollbackPhase(record, 'reporting', progress)
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

  /**
   * Announce a phase of the person's rollback and log it, as {@link phase} logs an update's: the rollback goes from
   * the record's target, which runs, back to its source.
   * @param record - the update record the rollback undoes.
   * @param phase - the phase.
   * @param progress - writes progress lines.
   */
  private rollbackPhase(record: UpdateJournal, phase: UpdatePhase, progress: Progress): void {
    this.subject.logger.info('rollback phase', { data: { phase, from: record.to, to: record.from } })
    this.announce(phase, record.from, progress)
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
   * read while that Host still runs. An update's successor is also held to the running Host's sandbox protection; a
   * rollback's is not, because the version rolled back to may protect less than the one it replaced and must still run.
   * @param health - the report's expectations.
   * @param kind - an update's successor, or a rollback's.
   * @returns the expectations.
   */
  private expectations(health: PreparedRuntime['health'], kind: 'update' | 'rollback'): HealthExpectations {
    const protection = kind === 'update' ? this.subject.protection() : undefined
    return { ...health, previousFailures: this.subject.failedRows(), previousRows: this.subject.rows(), ...protection === undefined ? {} : { previousProtection: protection } }
  }

  /**
   * End a handshake that may not run this process's Host again: the process stops once the final line is sent, and
   * the record stays for the next start.
   */
  private async stopServing(result: HandshakeResult, message: string, error: unknown, data: Readonly<Record<string, unknown>>): Promise<HandshakeResult> {
    this.failedRollback = true
    this.subject.setState('stopping')
    this.subject.logger.error(message, { err: error, data })
    await this.saveResult(result)
    return result
  }

  /**
   * Begin the outcome record of an update or a rollback: the previous record goes, so a record always names the latest attempt.
   * @param kind - what runs.
   * @param from - the version that runs.
   * @param to - the version it moves to.
   */
  private async beginAttempt(kind: UpdateResultRecord['kind'], from: RuntimeVersion, to: RuntimeVersion): Promise<void> {
    this.attempt = { kind, from, to }
    try {
      await removeUpdateResult(updateResultPath(this.subject.home, this.subject.profile))
    } catch (error) {
      this.subject.logger.warn('the previous outcome record could not be removed', { err: error })
    }
  }

  /**
   * Write the outcome record of the attempt that ended. A record that cannot be written is logged and changes nothing:
   * the record only reports.
   * @param result - how the attempt ended.
   */
  private async saveResult(result: HandshakeResult): Promise<void> {
    const attempt = this.attempt
    if (attempt === undefined) return
    try {
      await writeUpdateResult(updateResultPath(this.subject.home, this.subject.profile), {
        v: 1, kind: attempt.kind, outcome: result.outcome, from: attempt.from, to: attempt.to, at: new Date().toISOString(),
        ...result.reason === undefined ? {} : { reason: result.reason },
        ...result.criterion === undefined ? {} : { criterion: result.criterion },
      })
    } catch (error) {
      this.subject.logger.warn('the outcome record could not be written', { err: error })
    }
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
    await this.beginAttempt('update', from, to)
    const end = async (result: HandshakeResult): Promise<HandshakeResult> => {
      release?.()
      // The copy goes before the record, so a kill between the two leaves a record that names the copy to remove.
      if (result.outcome === 'aborted' && copyAttempted) await copies.discard(to)
      if (recorded) await endUpdateRecord(journal)
      this.subject.setState('running')
      this.subject.logger.info('update ended', { data: { from, to, outcome: result.outcome, reason: result.reason ?? '' } })
      await this.saveResult(result)
      return result
    }
    try {
      const before: RuntimePointers = await store.pointers()
      let update: JournalledUpdate = {
        from, to, previous: before.previous, startedAt: new Date().toISOString(), dataDiffers: prepared.dataDiffers, copy: dataCopy, targetStarted: false, health: prepared.health,
      }
      // Another process on the chat data, or a chosen copy that cannot fit, refuses the update before anything is written.
      await copies.plan(dataCopy)
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
      const health = this.expectations(prepared.health, 'update')
      // The target is checked as the launcher checks a version before it starts it, while nothing has changed yet.
      try {
        await store.checkLaunch(to)
      } catch (error) {
        this.subject.logger.error('the target failed its check before a start; the update stops with nothing changed', { err: error, data: { from, to } })
        return await end({ outcome: 'aborted', reason: 'VERIFY_FAILED' })
      }
      // A process that registered on the chat data after the plan check and before the record was written refuses the
      // update here, with nothing changed; the record goes with it.
      try {
        await copies.confirmSoleUser()
      } catch (error) {
        this.subject.logger.error('another process uses the chat data; the update stops with nothing changed', { err: error, data: { from, to } })
        await end({ outcome: 'aborted' })
        throw error
      }
      try {
        await this.subject.suspend(drainTimeoutS)
      } catch (error) {
        // Nothing switched and no copy was written: the record goes, as for an update that ended before switching.
        const result = await end({ outcome: 'aborted', reason: 'HOST_STOP_FAILED' })
        await this.resumeAfterStopFailed(error, { from, to })
        return result
      }
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
      let criterion: string | undefined
      let switchStarted = false
      try {
        await this.support.harness.carry(from, to, prepared.report, async () => {
          switchStarted = true
          await store.switchTo(from, to)
        })
        // Written and synced before the spawn: from here a rollback treats the data as opened by `to`.
        update = { ...update, targetStarted: true }
        await this.phase(update, 'health-check', progress)
        const startId = brandString<StartId>(randomId())
        successor = this.subject.startSuccessor({
          type: 'handover', purpose: 'update', v: 1, home: this.subject.home, profile: this.subject.profile, from, to, startId, health, startedAt: update.startedAt,
        })
        const answer = await successor.result
        if (answer.type === 'ready') {
          this.subject.handOver(successor, startId, to)
          this.committedSuccessor = successor
          this.current = { phase: 'committed', target: to }
          this.subject.logger.info('update committed', { data: { from, to, successor: successor.pid } })
          await this.saveResult({ outcome: 'committed' })
          return { outcome: 'committed' }
        }
        this.subject.logger.warn('the successor failed its health check', { data: { to, reason: answer.reason, criterion: answer.criterion ?? '' } })
        criterion = answer.criterion
      } catch (error) {
        if (!switchStarted) {
          // The carry removed what it wrote for the target, and nothing switched: the Host runs again on this runtime.
          this.subject.logger.error('the harness changes could not be carried; the update stops', { err: error, data: { from, to } })
          await this.subject.resume()
          await end({ outcome: 'aborted' })
          throw error
        }
        this.subject.logger.error('the switch failed; rolling back', { err: error, data: { from, to } })
        const back = await this.rollBackFailedUpdate(successor, before, update, end)
        if (back.outcome === 'failed') return back
        throw error
      }
      return await this.rollBackFailedUpdate(successor, before, update, end, criterion)
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
   * After the Host did not stop for a switch, with nothing switched: boot this process's Host again. A teardown that
   * is still running may keep the new Host from booting; then {@link HandshakeSubject.resume} stops this process, and
   * the next start runs the version `current` names, which the update or rollback did not change.
   * @param error - why the Host did not stop.
   * @param data - the update's versions, for the log.
   */
  private async resumeAfterStopFailed(error: unknown, data: Readonly<Record<string, unknown>>): Promise<void> {
    this.subject.logger.error('the Host did not stop for the switch; nothing was switched and the Host runs again', { err: error, data })
    try {
      await this.subject.resume()
    } catch (_bootFailed) {
      // `resume` logged the boot failure and stopped this process; the update has already ended with nothing switched.
    }
  }

  /**
   * C3's automatic rollback after a failed switch or health check: stop the successor and apply the rollback table
   * with the pointers restored to their values before the update; on success this process's Host runs again, the
   * record goes and the stashed record returns. When the table refuses, nothing is restored: the record stays with
   * `refused`, the pointers name `to`, and this process stops. A rolled-back outcome carries the health criterion the
   * successor named, when it named one. When a step may have run, the record stays
   * `rolling-back` and this process stops; the next start completes the rollback.
   */
  private async rollBackFailedUpdate(successor: Successor | undefined, before: RuntimePointers, update: JournalledUpdate, end: (result: HandshakeResult) => Promise<HandshakeResult>, criterion?: string): Promise<HandshakeResult> {
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
      if (isRefusal(error, 'CHATS_RUNNING')) {
        return this.stopServing({ outcome: 'failed', reason: 'CHATS_RUNNING' }, 'the target failed its health check and another process uses the chat data, so the rollback did not start; stop it, and the next start completes the rollback', error, data)
      }
      if (isRefusal(error, 'GIT_UNAVAILABLE')) {
        return this.stopServing({ outcome: 'failed', reason: 'GIT_UNAVAILABLE' }, 'the target failed its health check and git, which restores the profile, cannot run, so the rollback did not start; install git, and the next start completes the rollback', error, data)
      }
      return this.stopServing({ outcome: 'failed' }, 'the rollback stopped after a step may have run; the next start completes it', error, data)
    }
    await this.subject.resume()
    return end({ outcome: 'rolled-back', reason: 'HEALTH_CHECK_FAILED', ...criterion === undefined ? {} : { criterion } })
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
    await this.beginAttempt('rollback', running, record.from)
    const end = async (result: HandshakeResult): Promise<HandshakeResult> => {
      release?.()
      this.subject.setState('running')
      this.subject.logger.info('rollback ended', { data: { ...data, outcome: result.outcome, reason: result.reason ?? '' } })
      await this.saveResult(result)
      return result
    }
    try {
      const quiet = await this.quiesce(wait, drainTimeoutS, cancellation.signal, async () => { this.rollbackPhase(record, 'waiting', progress) })
      release = quiet.release
      if (quiet.ended !== undefined) return end(quiet.ended === 'CANCELLED' ? { outcome: 'aborted' } : { outcome: 'aborted', reason: quiet.ended })
      this.waiting = undefined
      this.subject.setState('switching')
      this.rollbackPhase(record, 'switching', progress)
      const health = prepared === undefined ? undefined : this.expectations(prepared.health, 'rollback')
      if (health !== undefined) {
        try {
          await store.checkLaunch(record.from)
        } catch (error) {
          this.subject.logger.error('the version to roll back to failed its check before a start; the rollback stops with nothing changed', { err: error, data })
          return end({ outcome: 'aborted', reason: 'VERIFY_FAILED' })
        }
      }
      try {
        await this.subject.suspend(drainTimeoutS)
      } catch (error) {
        // No step of the rollback ran: the record stays as it was.
        const result = await end({ outcome: 'aborted', reason: 'HOST_STOP_FAILED' })
        await this.resumeAfterStopFailed(error, data)
        return result
      }
      let lines: readonly string[]
      try {
        lines = await copies.rollback(record, {
          profileOnly: health === undefined,
          switchRuntime: () => store.switchTo(running, record.from),
          // A profile-only rollback keeps this runtime, so its record stays `committed` and the person can run it again.
          markRollingBack: health === undefined ? async () => {} : () => writeJournal(journal, journalledUpdate(record), 'rolling-back'),
        })
      } catch (error) {
        if (isRollbackRefusal(error)) {
          // Refused before any step: this Host runs again with nothing changed.
          await this.subject.resume()
          await end({ outcome: 'aborted' })
          throw error
        }
        return this.stopServing({ outcome: 'failed' }, 'the rollback stopped after a step may have run; the next start completes it', error, data)
      }
      if (health === undefined) {
        await this.subject.resume()
        await removeJournal(journal)
        return end({ outcome: 'rolled-back', lines })
      }
      this.rollbackPhase(record, 'health-check', progress)
      const startId = brandString<StartId>(randomId())
      const successor = this.subject.startSuccessor({
        type: 'handover', purpose: 'rollback', v: 1, home: this.subject.home, profile: this.subject.profile, from: running, to: record.from, startId, health, startedAt: new Date().toISOString(),
      })
      const answer = await successor.result
      if (answer.type === 'ready') {
        this.subject.handOver(successor, startId, record.from)
        this.committedSuccessor = successor
        this.current = { phase: 'committed', target: record.from }
        this.subject.logger.info('rollback committed', { data: { from: record.to, to: record.from, successor: successor.pid } })
        await this.saveResult({ outcome: 'rolled-back' })
        return { outcome: 'rolled-back', lines }
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
