/** Host timer over standalone tasks; target Session activation is a delivery operation. */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'schedule': { kind: 'schedule' } & ContextFormed
  }
}
import { SessionId, type Session, type SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  isRecurringScheduleRecord, MIN_EVERY_INTERVAL_SECONDS, renderRecurringReminderBatchFraming, renderReminderFraming,
  resolveRecurringOccurrence, type RecurringOccurrence,
} from './domain.ts'
import { formatScheduleLocalTime } from './domain.ts'
import { appendDelivery } from './delivery-history.ts'
import type { ScheduleTask } from './storage.ts'
import type {
  DeliveryRetentionBounds, ScheduleConsentService, ScheduleDeliveryReceipt, ScheduleDeliveryVerdict, ScheduleId,
  ScheduleSessionCreateSpec,
} from './types.ts'

/** Largest delay Node timers represent without clamping. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Fixed per-task delivery floor interval, timed or manual, of a target other than `new`; it matches the shortest recurrence spacing. */
export const MIN_DELIVERY_INTERVAL_MS = MIN_EVERY_INTERVAL_SECONDS * 1_000

/** Resolved deployment limits of one runtime. */
export interface ScheduleRuntimeLimits {
  /** Retention window and record cap applied on each delivery commit. */
  readonly retention: DeliveryRetentionBounds
  /** Delivery floor interval of one task whose every delivery creates a Session. */
  readonly newSessionIntervalMs: number
}

/** Target Session of one delivery and its live Agent. */
interface DeliveryTarget {
  readonly sessionId: SessionIdType
  readonly agent: Agent
}

/**
 * Target of one delivery found without creating anything: a `session` target's activated Session, the existing
 * Session a target that opens its own reserved, or the Session such a target has yet to open.
 */
type LocatedTarget =
  | { readonly kind: 'session'; readonly sessionId: SessionIdType; readonly agent: Agent }
  | { readonly kind: 'reserved'; readonly sessionId: SessionIdType; readonly agent: Agent; readonly create: ScheduleSessionCreateSpec }
  | { readonly kind: 'unopened'; readonly sessionId: SessionIdType; readonly agent: undefined; readonly create: ScheduleSessionCreateSpec }

/** One refusal the consent seam stores on a task and reports. */
type ConsentRefusal = Extract<ScheduleDeliveryVerdict, { readonly kind: 'refuse' }>

/** The preset one consent review read for its target, or undefined when no consent is composed and nothing was reviewed. */
type ReviewedPreset = { readonly preset: string | undefined } | undefined

/**
 * Text for a value a consent threw, for the log line that reports the failure.
 * @param error - The thrown value.
 * @returns Its string form, or a fixed description when it has none.
 */
function describe(error: unknown): string {
  try {
    return String(error)
  } catch (_error: unknown) {
    // A value without a string conversion, such as an object with no prototype, still needs its log line.
    return 'a thrown value that cannot be converted to text'
  }
}

/** Refusal reason recorded when a consent answers anything but one of the two declared verdicts. */
const UNRECOGNISED_VERDICT = 'the scheduled-task consent returned no verdict the Schedule recognises, so the delivery was refused'

/**
 * Read one consent answer, failing closed: only the declared `allow` delivers, a `refuse` keeps its reason, and any
 * other answer refuses. The answer crosses a plugin seam and its reason is stored on the task, so a consent written
 * against another version of the seam cannot deliver by answering something the runtime does not know.
 * @param answer - The consent's answer, typed as wide as what a consent can return at run time.
 * @returns The refusal to record, or undefined when the consent allowed the delivery.
 */
function refusalOf(answer: { readonly kind?: unknown; readonly reason?: unknown } | null | undefined): ConsentRefusal | undefined {
  if (answer?.kind === 'allow') return undefined
  if (answer?.kind === 'refuse' && typeof answer.reason === 'string' && answer.reason.trim() !== '') {
    return { kind: 'refuse', reason: answer.reason }
  }
  return { kind: 'refuse', reason: UNRECOGNISED_VERDICT }
}

/** Message identity, acknowledgment time, and, while a delivered task holds its slot, Agent activity of one enqueued reminder. */
interface SentReminder {
  readonly messageId: ScheduleDeliveryReceipt['messageId']
  readonly deliveredAt: string
  readonly execution: Promise<void> | undefined
}

/**
 * Return the Session whose due recurring tasks share one message.
 * @param task - Due task.
 * @returns Target Session of a recurring `session` task, or undefined for a task delivered alone.
 */
function batchSessionOf(task: ScheduleTask): SessionIdType | undefined {
  const { target, record } = task
  return target.kind === 'session' && isRecurringScheduleRecord(record)
    ? target.sessionId
    : undefined
}

/** The preset reads the consent seam makes when a deployment composes the permission-preset service. */
export interface SchedulePermissionPresets {
  /** The permission preset one Session currently runs under. */
  current(session: Session): string
  /**
   * The permission preset a Session opened now runs under: the deployment default that the
   * permission-preset service pins into every fresh Session, which a created target inherits.
   */
  readonly defaultPreset: string
}

/** Owns at most one timer across recomputations; delivery and management share the serialized operation. */
export class ScheduleRuntime {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running: Promise<void> | undefined
  private readonly executing = new Set<ScheduleId>()
  private stopping = false
  private requested = false

  /**
   * @param ctx - Host services used to resume and enqueue.
   * @param tasks - Current durable tasks.
   * @param transact - Serialize delivery against management writes.
   * @param commit - Persist one task value and publish its change; delivery commits status, target, and receipt together.
   * @param changed - Publish a change that has no task write, such as an execution reaching whole-agent idle.
   * @param limits - Resolved retention and new-Session admission limits.
   * @param resolveAgent - Host fallback after embedding activation handlers delegate.
   */
  constructor(
    private readonly ctx: Context,
    private readonly tasks: () => readonly ScheduleTask[],
    private readonly transact: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly commit: (task: ScheduleTask) => Promise<void>,
    private readonly changed: () => void,
    private readonly limits: ScheduleRuntimeLimits,
    private readonly resolveAgent: (sessionId: SessionIdType) => Promise<Agent>,
  ) {}

  /**
   * Recompute the nearest obligation after startup or a durable change.
   * Dispatch failures are logged; refused admission does not retry automatically.
   */
  requestDrive(): void {
    if (this.stopping) return
    this.requested = true
    this.clearTimer()
    if (this.running !== undefined) return
    let run: Promise<void>
    try {
      run = this.ctx.agents.withoutInitiator(async () => {
        while (this.requested && !this.stopping) {
          this.requested = false
          await this.transact(async () => { await this.drive() })
        }
      })
    } catch (error: unknown) {
      // Ancestor unloading closes initiator admission before runtime cleanup runs.
      this.requested = false
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
      return
    }
    this.running = run
    void run.catch((error: unknown) => {
      this.ctx.logger.warn(`schedule: dispatch stopped: ${String(error)}`)
    }).finally(() => {
      this.running = undefined
      /* v8 ignore next -- a request can arrive in the microtask gap between the drive loop and this finalizer. */
      if (this.requested && !this.stopping) this.requestDrive()
    })
  }

  /** Stop the timer and drain an accepted delivery before storage closes. */
  async dispose(): Promise<void> {
    this.stopping = true
    this.clearTimer()
    // requestDrive reports execution failures; teardown only waits for quiescence.
    await this.running?.catch(() => undefined)
  }

  /**
   * Queue one manual execution without consuming or moving its scheduled occurrence.
   * @param id - Canonical task identity resolved again inside the shared transaction.
   * @param signal - Cancellation checked after entering the transaction and before delivery.
   * @returns Admission and task state after durable Session inbox acknowledgement, or undefined when deleted first.
   */
  async runNow(id: ScheduleId, signal?: AbortSignal): Promise<
    { readonly task: ScheduleTask; readonly admitted: boolean } | undefined
  > {
    return this.ctx.agents.withoutInitiator(() => this.transact(async () => {
      signal?.throwIfAborted()
      const stored = this.tasks().find(candidate => candidate.record.id === id)
      if (stored === undefined) return
      if (this.executing.has(id) || this.nextAdmissionAt(stored) > Date.now()) return { task: stored, admitted: false }
      const recovered = await this.recoverOutstandingExecution(stored)
      if (recovered === 'held') return { task: stored, admitted: false }
      if (recovered !== 'free') throw new RemoteError('schedule/consent-refused', recovered.reason, { reason: recovered.reason })
      const located = await this.locateTarget(stored)
      // The consent reviews before a target that opens its own Session creates it, so a refusal creates nothing.
      const reviewed = await this.reviewDelivery(stored, located)
      const { target, task } = await this.openTarget(stored, located)
      if (this.stopping) throw new Error('Schedule runtime is stopping')
      if (this.presetMoved(reviewed, target)) await this.reviewDelivery(task, target)
      // Sample the occurrence after Session restoration, which can take longer than one recurrence interval.
      const occurrenceAt = new Date(Date.now()).toISOString()
      const held = task.target.kind !== 'new' ? [id] : []
      const sent = await this.send(target.agent, renderReminderFraming({ ...task.record, scheduledAt: occurrenceAt }), held)
      const committed = new Set<ScheduleId>()
      try {
        const delivered = this.delivered(task, {
          scheduledAt: occurrenceAt, deliveredAt: sent.deliveredAt, messageId: sent.messageId, targetSessionId: target.sessionId,
        })
        await this.commit(delivered)
        committed.add(id)
        return { task: delivered, admitted: true }
      } finally {
        this.settle(held, committed, sent.execution)
      }
    }))
  }

  /**
   * Whether a queued or running execution holds this task's slot.
   * @param id - Task identity.
   * @returns Whether a delivery to the task's reused target Session has not yet reached whole-agent idle; a `new` target holds no slot.
   */
  isExecutionActive(id: ScheduleId): boolean {
    return this.executing.has(id)
  }

  /**
   * End of this task's current minimum delivery interval.
   * @param task - Current durable task state.
   * @returns Epoch milliseconds while the interval remains in the future.
   */
  deliveryFloorEnd(task: ScheduleTask): number | undefined {
    const end = this.nextAdmissionAt(task)
    return end > Date.now() ? end : undefined
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drive(): Promise<void> {
    this.clearTimer()
    const failed = new Set<ScheduleId>()
    const handled = new Set<ScheduleId>()
    const scanNow = Date.now()
    const due = this.tasks().filter(task => task.status === 'active'
      && !this.executing.has(task.record.id)
      && Date.parse(task.record.scheduledAt) <= scanNow)
    for (const task of due) {
      if (this.stopping) return
      if (handled.has(task.record.id)) continue
      const session = batchSessionOf(task)
      const group = session === undefined ? [task] : due.filter(candidate => batchSessionOf(candidate) === session)
      for (const member of group) handled.add(member.record.id)
      for (const id of await this.deliverDue(group, session !== undefined)) failed.add(id)
    }
    if (this.stopping) return
    const next = this.tasks().filter(task => task.status === 'active'
      && !failed.has(task.record.id)
      && !this.executing.has(task.record.id))
      .reduce<number | undefined>((at, task) => {
        const target = Math.max(Date.parse(task.record.scheduledAt), this.nextAdmissionAt(task))
        return at === undefined ? target : Math.min(at, target)
      }, undefined)
    if (next !== undefined) {
      this.timer = setTimeout(() => { this.timer = undefined; this.requestDrive() },
        Math.max(0, Math.min(next - Date.now(), MAX_TIMER_DELAY_MS)))
      this.timer.unref()
    }
  }

  /**
   * Deliver one due group in one message and advance each committed member.
   * @param group - One task, or the due recurring tasks of one target Session.
   * @param batch - Whether the message uses the batch framing.
   * @returns Members that remain due after a failure; the timer skips them until the next drive request.
   */
  private async deliverDue(group: readonly ScheduleTask[], batch: boolean): Promise<readonly ScheduleId[]> {
    let admitted = group
    const committed = new Set<ScheduleId>()
    try {
      const candidates: ScheduleTask[] = []
      for (const member of group) {
        if (this.nextAdmissionAt(member) > Date.now() || await this.recoverOutstandingExecution(member) !== 'free') continue
        candidates.push(member)
      }
      // The check precedes target resolution, so a target made future by clock rollback creates no Session.
      const checkedAt = Date.now()
      admitted = candidates.filter(member => Date.parse(member.record.scheduledAt) <= checkedAt)
      const first = admitted[0]
      if (first === undefined) return []
      const located = await this.locateTarget(first)
      // The consent screens before a target that opens its own Session creates it, so a refusal creates nothing.
      const screened = await this.screenDelivery(admitted, located)
      admitted = screened.kept
      if (admitted.length === 0) return []
      const opened = await this.openTarget(first, located)
      const { target } = opened
      // Opening a target that creates its Session records the reservation; later writes keep it.
      admitted = admitted.map(member => member === first ? opened.task : member)
      if (this.stopping) return []
      if (this.presetMoved(screened.reviewed, target)) admitted = (await this.screenDelivery(admitted, target)).kept
      const now = Date.now()
      // Session restoration can span a wall-clock rollback; future members keep their timer obligation.
      admitted = admitted.filter(member => Date.parse(member.record.scheduledAt) <= now)
      const deliveries = admitted.map(task => ({
        task, occurrence: isRecurringScheduleRecord(task.record)
          ? resolveRecurringOccurrence(task.record, now) : { occurrenceAt: task.record.scheduledAt },
      }))
      const single = deliveries[0]
      if (single === undefined) return []
      const text = batch
        ? renderRecurringReminderBatchFraming(deliveries.map(({ task, occurrence }) => ({
          record: task.record, occurrenceAt: occurrence.occurrenceAt,
        })))
        : renderReminderFraming({ ...single.task.record, scheduledAt: single.occurrence.occurrenceAt })
      const held = deliveries.filter(({ task }) => task.target.kind !== 'new').map(({ task }) => task.record.id)
      const sent = await this.send(target.agent, text, held)
      try {
        for (const { task, occurrence } of deliveries) {
          await this.commit(this.advanced(task, occurrence, {
            scheduledAt: occurrence.occurrenceAt, deliveredAt: sent.deliveredAt, messageId: sent.messageId,
            targetSessionId: target.sessionId,
          }))
          committed.add(task.record.id)
        }
      } finally {
        this.settle(held, committed, sent.execution)
      }
      return []
    } catch (error: unknown) {
      // Successful commits and targets made future by clock rollback keep their timer obligation.
      const pending = admitted.filter(member => !committed.has(member.record.id))
      const failedAt = Date.now()
      const ids = pending.map(member => member.record.id)
      this.ctx.logger.warn(`schedule: reminders ${JSON.stringify(ids)} were not acknowledged: ${String(error)}`)
      return pending.filter(member => Date.parse(member.record.scheduledAt) <= failedAt).map(member => member.record.id)
    }
  }

  /** Earliest wall-clock instant at which this task may admit another delivery. */
  private nextAdmissionAt(task: ScheduleTask): number {
    const receipt = task.lastDelivery
    if (receipt === undefined) return Number.NEGATIVE_INFINITY
    const interval = task.target.kind === 'new' ? this.limits.newSessionIntervalMs : MIN_DELIVERY_INTERVAL_MS
    const occurrence = Date.parse(receipt.scheduledAt)
    // An occurrence whose successor already keeps the interval anchors the floor, so acknowledgment latency neither
    // accumulates across occurrences nor carries a deferral forward.
    const anchor = Date.parse(task.record.scheduledAt) - occurrence >= interval ? occurrence : Date.parse(receipt.deliveredAt)
    return anchor + interval
  }

  /** Whether the Workspace registry lists this Session as archived; without a registry, no Session is archived. */
  private archived(sessionId: SessionIdType): boolean {
    return this.ctx.get('workspaceRegistry')?.archivedSessionIds.includes(sessionId) ?? false
  }

  /**
   * Review one delivery through the optional consent seam, resolved opportunistically with
   * `ctx.get('scheduleConsent')`: without a consent this is a no-op and delivery is exactly
   * upstream's. A refusal never delivers: the task pauses so no later occurrence retries it,
   * and the refusal surfaces as the typed `schedule/consent-refused` error.
   * @param task - Due task whose delivery is pending.
   * @param target - Delivery target, with its live Agent once its Session exists.
   * @returns The preset the consent reviewed, or undefined when no consent is composed.
   * @throws RemoteError `schedule/consent-refused` carrying the consent's reason.
   * @throws RemoteError `schedule/consent-failed` when the consent could not review; the task stays armed.
   */
  private async reviewDelivery(task: ScheduleTask, target: DeliveryTarget | LocatedTarget): Promise<ReviewedPreset> {
    const { refusals, reviewed } = await this.screenDelivery([task], target)
    const refusal = refusals.get(task.record.id)
    if (refusal !== undefined) throw new RemoteError('schedule/consent-refused', refusal.reason, { reason: refusal.reason })
    return reviewed
  }

  /**
   * Pause one task for a refused delivery, recording the reason the consent gave so the paused
   * task states why it stopped instead of leaving it in the log alone.
   * @param task - Task whose delivery the consent refused.
   * @param reason - The consent's refusal reason.
   * @returns The paused value to commit.
   */
  private refused(task: ScheduleTask, reason: string): ScheduleTask {
    const refusedAt = new Date(Date.now()).toISOString()
    return { ...task, status: 'paused', consentRefusal: { reason, refusedAt }, updatedAt: refusedAt }
  }

  /**
   * Screen one due group through the consent seam before the shared message is built; a refused
   * member pauses instead of delivering, and the remaining members keep one message. Every member
   * is reviewed under one reading of the target's preset.
   * @param group - Due members of one delivery message.
   * @param target - Delivery target, with its live Agent once its Session exists.
   * @returns The members whose delivery the consent allows, the refusals of the others, and the preset the consent
   *   reviewed them under.
   * @throws RemoteError `schedule/consent-failed` when the consent could not review; every member stays armed.
   */
  private async screenDelivery(group: readonly ScheduleTask[], target: DeliveryTarget | LocatedTarget): Promise<{
    readonly kept: readonly ScheduleTask[]
    readonly refusals: ReadonlyMap<ScheduleId, ConsentRefusal>
    readonly reviewed: ReviewedPreset
  }> {
    const refusals = new Map<ScheduleId, ConsentRefusal>()
    const consent = this.ctx.get('scheduleConsent')
    if (consent === undefined) return { kept: group, refusals, reviewed: undefined }
    const ids = group.map(task => task.record.id)
    let preset: string | undefined
    try {
      preset = this.presetOf(target)
    } catch (error: unknown) {
      throw this.consentFailure(ids, error)
    }
    const verdicts: Array<{ readonly task: ScheduleTask; readonly refusal: ConsentRefusal | undefined }> = []
    // Every member is asked before any refusal is written, so a consent that throws for one member leaves all armed.
    for (const task of group) verdicts.push({ task, refusal: this.consentVerdict(consent, task, target, preset) })
    const kept: ScheduleTask[] = []
    for (const { task, refusal } of verdicts) {
      if (refusal === undefined) {
        kept.push(task)
        continue
      }
      refusals.set(task.record.id, refusal)
      await this.commit(this.refused(task, refusal.reason))
      this.ctx.logger.warn(`schedule: delivery of task "${task.record.id}" was refused (schedule_consent_refused): ${refusal.reason}`)
    }
    return { kept, refusals, reviewed: { preset } }
  }

  /**
   * Ask the composed consent about one pending delivery.
   * @param consent - The composed consent service.
   * @param task - Due task whose delivery is pending.
   * @param target - Delivery target, with its live Agent once its Session exists.
   * @param preset - The preset the target runs under, read once for the group.
   * @returns The refusal, or undefined when the delivery may proceed.
   * @throws RemoteError `schedule/consent-failed` when the consent throws.
   */
  private consentVerdict(
    consent: ScheduleConsentService,
    task: ScheduleTask,
    target: DeliveryTarget | LocatedTarget,
    preset: string | undefined,
  ): ConsentRefusal | undefined {
    let verdict: ScheduleDeliveryVerdict
    try {
      verdict = consent.reviewDelivery({
        creationPreset: task.creationPreset,
        currentPreset: preset,
        targetSessionId: target.agent?.session.id ?? target.sessionId,
      })
    } catch (error: unknown) {
      throw this.consentFailure([task.record.id], error)
    }
    return refusalOf(verdict)
  }

  /**
   * Report one review the consent could not complete and build its typed failure.
   * @param ids - Tasks whose delivery was under review.
   * @param error - What the consent or the preset read threw.
   * @returns The `schedule/consent-failed` error; the tasks stay armed.
   */
  private consentFailure(ids: readonly ScheduleId[], error: unknown): RemoteError<'schedule/consent-failed'> {
    this.ctx.logger.warn(`schedule: the consent could not review the delivery of task ${ids.map(id => `"${id}"`).join(', ')}: ${describe(error)}`)
    return new RemoteError('schedule/consent-failed', 'The scheduled-task consent could not review this delivery.', {}, { cause: error })
  }

  /**
   * Read the permission preset one target runs under: its live Session's, or, for a Session not opened yet, the
   * preset the consent says a Session opened with the target's creation values gets — such as its Workspace's —
   * and otherwise the deployment default a fresh Session is pinned to.
   * @param target - Delivery target, with its live Agent once its Session exists.
   * @returns The preset, or undefined when no preset service is composed.
   */
  private presetOf(target: DeliveryTarget | LocatedTarget): string | undefined {
    const presets = this.ctx.get('permissionPresets') as SchedulePermissionPresets | undefined
    if (!('kind' in target) || target.kind !== 'unopened') return presets?.current(target.agent.session)
    if (presets === undefined) return undefined
    return this.ctx.get('scheduleConsent')?.presetFor?.(target.create) ?? presets.defaultPreset
  }

  /**
   * Whether the target's preset is no longer the one the consent reviewed, read again after its Session was opened
   * and its Workspace joined. Such a target is reviewed again before it is woken.
   * @param reviewed - The preset the consent reviewed, or undefined when nothing was reviewed.
   * @param target - Target after its Session was opened.
   * @returns Whether the target needs another review.
   */
  private presetMoved(reviewed: ReviewedPreset, target: DeliveryTarget): boolean {
    if (reviewed === undefined) return false
    try {
      return this.presetOf(target) !== reviewed.preset
    } catch (_error: unknown) {
      // The second review reads the preset again and reports the same failure as `schedule/consent-failed`.
      return true
    }
  }

  /**
   * Review a reminder that is still queued from an earlier delivery before recovery wakes it: the preset its chat
   * runs may have changed since it was reviewed. A task the consent already refused counts as refused. On a refusal
   * the reminder leaves the inbox, so no turn ever reads it, and each refused task pauses with its reason.
   * @param agent - Live Agent of the reminder's Session.
   * @param message - The queued reminder.
   * @param receipt - The delivery that queued it.
   * @returns The tasks the reminder serves that were refused; empty when no consent is composed or all are allowed.
   * @throws RemoteError `schedule/consent-failed` when the consent could not review; the reminder stays queued.
   */
  private async reviewQueuedReminder(
    agent: Agent,
    message: { readonly id: ScheduleDeliveryReceipt['messageId'] },
    receipt: ScheduleDeliveryReceipt,
  ): Promise<ReadonlyMap<ScheduleId, ConsentRefusal>> {
    const refused = new Map<ScheduleId, ConsentRefusal>()
    const consent = this.ctx.get('scheduleConsent')
    if (consent === undefined) return refused
    const served = this.tasks().filter(candidate => candidate.lastDelivery?.messageId === receipt.messageId
      && candidate.lastDelivery.targetSessionId === receipt.targetSessionId)
    const target: DeliveryTarget = { sessionId: receipt.targetSessionId, agent }
    let preset: string | undefined
    try {
      preset = this.presetOf(target)
    } catch (error: unknown) {
      throw this.consentFailure(served.map(task => task.record.id), error)
    }
    for (const task of served) {
      const refusal = task.consentRefusal === undefined
        ? this.consentVerdict(consent, task, target, preset)
        : { kind: 'refuse' as const, reason: task.consentRefusal.reason }
      if (refusal !== undefined) refused.set(task.record.id, refusal)
    }
    if (refused.size === 0) return refused
    agent.inbox.remove(message.id)
    const flushed = await this.ctx.sessions.flush(agent.session)
    if (!flushed) throw new Error('Session persistence did not acknowledge the withdrawn reminder')
    for (const task of served) {
      const refusal = refused.get(task.record.id)
      if (refusal === undefined || task.consentRefusal !== undefined) continue
      await this.commit(this.refused(task, refusal.reason))
      this.ctx.logger.warn(`schedule: the queued reminder of task "${task.record.id}" was withdrawn (schedule_consent_refused): ${refusal.reason}`)
    }
    return refused
  }

  /**
   * Reconstruct a still-queued last delivery after a Host restart without storing model completion state.
   * @param task - Task whose last delivered message may still wait in its target inbox.
   * @returns `held` while the task holds its slot for that delivery (a woken reminder of a `new` target holds none),
   *   the consent's refusal when it withdrew the reminder, and otherwise `free`.
   */
  private async recoverOutstandingExecution(task: ScheduleTask): Promise<'held' | 'free' | ConsentRefusal> {
    if (this.executing.has(task.record.id)) return 'held'
    const receipt = task.lastDelivery
    // The archived-Session gate blocks the turn that a requeued reminder would wake.
    if (receipt === undefined || this.archived(receipt.targetSessionId)) return 'free'
    let agent: Agent
    try {
      agent = await this.activate(receipt.targetSessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`schedule: could not restore the last delivery's Session for task "${task.record.id}": ${String(error)}`)
      return 'free'
    }
    const message = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].find(candidate => candidate.id === receipt.messageId)
    if (message === undefined) return 'free'
    const withdrawn = await this.reviewQueuedReminder(agent, message, receipt)
    if (withdrawn.size > 0) return withdrawn.get(task.record.id) ?? 'free'
    const held = this.tasks().filter(candidate => candidate.target.kind !== 'new'
      && candidate.lastDelivery?.messageId === receipt.messageId
      && candidate.lastDelivery.targetSessionId === receipt.targetSessionId).map(candidate => candidate.record.id)
    for (const id of held) this.executing.add(id)
    try {
      if (agent.status === 'idle') {
        // A restored inbox does not wake an idle Agent by itself. Requeue the
        // same identity at the next-turn tail so followup opens its driver
        // without creating a second logical delivery or Session.
        agent.inbox.remove(message.id)
        agent.followup(message)
        const execution = held.length > 0 ? agent.whenIdle() : undefined
        const flushed = await this.ctx.sessions.flush(agent.session)
        if (!flushed) throw new Error('Session persistence did not acknowledge the recovered reminder')
        if (execution !== undefined) this.watchExecution(held, execution)
      } else if (held.length > 0) {
        this.watchExecution(held, agent.whenIdle())
      }
      return held.includes(task.record.id) ? 'held' : 'free'
    } catch (error: unknown) {
      for (const id of held) this.executing.delete(id)
      throw error
    }
  }

  /**
   * Enqueue one reminder and wait for Session persistence to acknowledge it.
   * The held tasks hold their slots from the enqueue; a failure releases them.
   */
  private async send(agent: Agent, text: string, held: readonly ScheduleId[]): Promise<SentReminder> {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'schedule' } })
    for (const id of held) this.executing.add(id)
    try {
      agent.followup(message)
      // Capture the activity immediately after wakeup. Waiting for durable flush
      // can miss the whole lifecycle of a fast target Agent.
      const execution = held.length > 0 ? agent.whenIdle() : undefined
      const flushed = await this.ctx.sessions.flush(agent.session)
      if (!flushed) throw new Error('Session persistence did not acknowledge the reminder')
      return { messageId: message.id, deliveredAt: new Date(Date.now()).toISOString(), execution }
    } catch (error: unknown) {
      for (const id of held) this.executing.delete(id)
      throw error
    }
  }

  /** Release each uncommitted held slot now and each committed one at the target Agent's whole-agent idle boundary. */
  private settle(held: readonly ScheduleId[], committed: ReadonlySet<ScheduleId>, execution: Promise<void> | undefined): void {
    for (const id of held) {
      if (!committed.has(id)) this.executing.delete(id)
    }
    const watched = held.filter(id => committed.has(id))
    if (watched.length > 0 && execution !== undefined) this.watchExecution(watched, execution)
  }

  /** Release admitted executions at the target Agent's whole-agent idle boundary, then recompute the timer. */
  private watchExecution(ids: readonly ScheduleId[], execution: Promise<void>): void {
    const finish = (): void => {
      for (const id of ids) this.executing.delete(id)
      if (this.stopping) return
      this.changed()
      this.requestDrive()
    }
    void execution.then(finish, finish)
  }

  /** Apply one receipt to the target, involved Sessions, and history while keeping the scheduled occurrence. */
  private delivered(task: ScheduleTask, receipt: ScheduleDeliveryReceipt): ScheduleTask {
    // A delivery that reaches its target settles any earlier refusal the task recorded.
    const { consentRefusal: _cleared, ...keeping } = task
    return {
      ...keeping,
      target: task.target.kind === 'new_once' ? { kind: 'session', sessionId: receipt.targetSessionId } : task.target,
      // Each delivery of a `new` target creates a Session; recording them all would grow the task without bound.
      involvedSessionIds: task.target.kind === 'new'
        ? task.involvedSessionIds
        : [...new Set([...task.involvedSessionIds, receipt.targetSessionId])],
      updatedAt: new Date(Math.max(
        Date.parse(receipt.deliveredAt),
        task.updatedAt === undefined ? Date.parse(receipt.deliveredAt) : Date.parse(task.updatedAt) + 1,
      )).toISOString(),
      pendingDelivery: undefined,
      ...appendDelivery(task, receipt, this.limits.retention),
    }
  }

  /** Apply one timed receipt and advance the rule that owns dispatch to its next target. */
  private advanced(task: ScheduleTask, occurrence: RecurringOccurrence, receipt: ScheduleDeliveryReceipt): ScheduleTask {
    const scheduledAt = occurrence.nextScheduledAt ?? occurrence.occurrenceAt
    return {
      ...this.delivered(task, receipt),
      record: { ...task.record, scheduledAt },
      status: occurrence.nextScheduledAt === undefined ? 'ended' : 'active',
    }
  }

  /**
   * Find the delivery target without creating anything: activate a `session` target, or pick the Session a target
   * that opens its own uses — the stored reserved identity, resolved to its live Agent when a Session already has it,
   * or a fresh identity for a `new` target that holds no reservation.
   */
  private async locateTarget(task: ScheduleTask): Promise<LocatedTarget> {
    const { target } = task
    const reserved = target.kind === 'new' ? task.pendingDelivery?.targetSessionId : target.sessionId
    // An archived Session cannot run the reminder, including a retry in an already-created reserved Session.
    if (reserved !== undefined && this.archived(reserved)) {
      throw new RemoteError('schedule/target-archived', `Session ${reserved} is archived`, { sessionId: reserved })
    }
    if (target.kind === 'session') {
      return { kind: 'session', sessionId: target.sessionId, agent: await this.activate(target.sessionId) }
    }
    const sessionId = reserved ?? SessionId(`session-${randomUUID()}`)
    const agent = reserved === undefined ? undefined : await this.reservedAgent(reserved)
    return agent === undefined
      ? { kind: 'unopened', sessionId, agent, create: target.create }
      : { kind: 'reserved', sessionId, agent, create: target.create }
  }

  /**
   * Open a located target's Session and return its live Agent.
   * A `new` target reserves its Session identity in the task before creation, so a failed delivery retries the same
   * Session instead of creating another. A stored reserved identity is resolved first and created only when no Session
   * has it, because the Session controller creates a Session with a different id when the named Session has already
   * started a turn. A created Session joins the Workspace registered at `create.cwd` and takes the task title; a `new`
   * target's title adds its launch time in the task's time zone. Neither step blocks delivery.
   * @returns The opened target, and the task as stored after opening it, with any reservation it recorded.
   */
  private async openTarget(
    task: ScheduleTask,
    located: LocatedTarget,
  ): Promise<{ readonly target: DeliveryTarget; readonly task: ScheduleTask }> {
    if (located.kind === 'session') return { target: located, task }
    const { sessionId, create } = located
    let stored = task
    let agent: Agent
    if (located.kind === 'unopened') {
      if (task.target.kind === 'new' && task.pendingDelivery === undefined) {
        stored = { ...task, pendingDelivery: { targetSessionId: sessionId } }
        await this.commit(stored)
      }
      agent = await this.createAgent(sessionId, create)
    } else {
      agent = located.agent
    }
    await this.joinWorkspace(sessionId, create.cwd)
    this.nameSession(agent, stored)
    return { target: { sessionId, agent }, task: stored }
  }

  /** Resolve the live Agent of a reserved Session; `undefined` means that no Session has its id yet. */
  private async reservedAgent(sessionId: SessionIdType): Promise<Agent | undefined> {
    try {
      return await this.activate(sessionId)
    } catch (error: unknown) {
      if (error instanceof SessionPersistenceNotFoundError
        || (error instanceof RemoteError && error.code === 'session/not-found')) return undefined
      throw error
    }
  }

  /** Resolve through the embedding's activation owner, with the injected Web controller as fallback. */
  private activate(sessionId: SessionIdType): Promise<Agent> {
    return this.ctx.waterfall('schedule/resolve-agent', sessionId, () => this.resolveAgent(sessionId))
  }

  /** Create a reserved Session with the target's working directory and Agent preset, then resolve its live Agent. */
  private async createAgent(sessionId: SessionIdType, create: ScheduleSessionCreateSpec): Promise<Agent> {
    const controller = this.ctx.get('sessionController')
    if (controller === undefined) throw new Error('schedule: no Session creation provider')
    await controller.create({
      sessionId,
      ...(create.cwd === undefined ? {} : { cwd: create.cwd }),
      ...(create.agentPreset === undefined ? {} : { agentPreset: create.agentPreset }),
    })
    return this.activate(sessionId)
  }

  /** Attach a created Session to the Workspace registered at its directory; a failure is logged and does not stop delivery. */
  private async joinWorkspace(sessionId: SessionIdType, cwd: string | undefined): Promise<void> {
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined || cwd === undefined) return
    try {
      await (await registry.resolveByPath(cwd))?.attachSession(sessionId)
    } catch (error: unknown) {
      this.ctx.logger.warn(`schedule: Session ${sessionId} did not join the Workspace at ${cwd}: ${String(error)}`)
    }
  }

  /** Name a created Session that has no title yet; a failure is logged and does not stop delivery. */
  private nameSession(agent: Agent, task: ScheduleTask): void {
    const titles = this.ctx.get('sessionTitle')
    if (titles === undefined || titles.get(agent.session) !== undefined) return
    const { title } = task.record
    try {
      titles.rename(agent.session, task.target.kind === 'new' ? `${title} · ${formatScheduleLocalTime(task.record, new Date().toISOString()).slice(0, 16).replace('T', ' ')}` : title)
    } catch (error: unknown) {
      this.ctx.logger.warn(`schedule: Session ${agent.id} was not named: ${String(error)}`)
    }
  }
}
