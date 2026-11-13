/**
 * @delo/plugin-schedule-consent: the `scheduleConsent` Service Provider of the
 * Schedule consent seam. The seam lives in upstream's `packages/schedule`: the
 * schedule tools join `nameEffect`'s naming into every `schedule_create` and
 * `schedule_edit` approval ask, and the delivery runtime asks `reviewDelivery`
 * about each due delivery before it wakes its Session. With the plugin absent,
 * or with `enabled` off, `ctx.get('scheduleConsent')` stays empty and every
 * consumer keeps upstream's approval text and delivery behaviour.
 * @module @delo/plugin-schedule-consent
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {
  ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict, ScheduleEffect, ScheduleSessionCreateSpec,
} from '@deepseek-ai/dsh-schedule'

import { z } from 'zod'

/** The schedule consent plugin's configuration. */
export interface Config {
  /**
   * Whether the plugin mounts the consent service: off, the seam stays empty
   * and scheduled-task approvals and deliveries are exactly upstream's.
   * Delo's C16 switch `scheduled_task_consent` is this field.
   */
  readonly enabled: boolean
}

/** The schema of {@link Config}; its `enabled` default is the switch's parity value. */
export const ConfigSchema = z.object({
  enabled: z.boolean().default(false),
}).default({ enabled: false })

/**
 * Name what one approved Schedule management call creates: the task's title,
 * the start of the instruction it sends, the recurrence it arms or keeps, the
 * chat its deliveries reach — by title when it has one, or the directory a new
 * chat opens in — and that chat's permission preset. The text joins the
 * approval's reason, so the ask states what would start running before the
 * person answers it. The runtime hands over every text fact bounded and free of
 * control characters.
 * @param schedule - The effect the approved call would create.
 * @returns The naming, or undefined when the effect names no recurrence.
 */
export function nameConsentEffect(schedule: ScheduleEffect): string | undefined {
  if (schedule.recurrence === '') return undefined
  const opened = schedule.targetCwd === undefined ? 'a new chat' : `a new chat in ${schedule.targetCwd}`
  const chat = schedule.targetTitle === undefined
    ? `the chat ${schedule.targetSessionId}`
    : `the chat "${schedule.targetTitle}" (${schedule.targetSessionId})`
  const target = schedule.targetSessionId === undefined ? `${opened} that its first delivery opens` : chat
  const preset = schedule.targetPreset === undefined
    ? ''
    : `, which runs the ${schedule.targetPreset} permission preset`
  return `The task "${schedule.title}" sends "${schedule.prompt}" on "${schedule.recurrence}" into ${target}${preset}.`
}

/** The per-workspace defaults `@delo/plugin-permission-defaults` provides as `permissionDefaults`. */
export interface WorkspacePresets {
  /** The preset new chats in a workspace start with. */
  defaultPreset(cwd: string): string
}

/**
 * The preset a chat opened in a directory starts with: its workspace's, which
 * `@delo/plugin-permission-defaults` seeds into every new chat. Unknown without
 * that service or a directory, so the runtime keeps the deployment default and
 * reviews the opened chat again under the preset it really got.
 * @param defaults - The `permissionDefaults` service, when it is mounted.
 * @param create - Creation values of the chat a delivery opens.
 * @returns The workspace's preset, or undefined.
 */
export function workspacePreset(defaults: WorkspacePresets | undefined, create: ScheduleSessionCreateSpec): string | undefined {
  return create.cwd === undefined ? undefined : defaults?.defaultPreset(create.cwd)
}

/**
 * Quote a preset name the way a refusal states it.
 * @param preset - The permission preset's name.
 * @returns The quoted name.
 */
function quoted(preset: string): string {
  return `"${preset}"`
}

/**
 * Review one due delivery: it may proceed only while the target chat still runs
 * the permission preset the task was approved under. A chat that moved wider
 * since the approval — to any preset the approval did not name, narrower
 * included — is refused with the reason the refusal surfaces, and so is a
 * delivery whose preset cannot be read any more; the runtime pauses the refused
 * task so no later occurrence retries it.
 * @param review - The preset the task captured at creation, the preset the target chat runs under now, and the target chat.
 * @returns The verdict: deliver, or refuse with the reason.
 */
export function reviewConsentDelivery(review: ScheduleDeliveryReview): ScheduleDeliveryVerdict {
  const { creationPreset, currentPreset } = review
  if (creationPreset === currentPreset) return { kind: 'allow' }
  if (currentPreset === undefined) {
    // The equal case already returned, so a created preset is named here.
    return {
      kind: 'refuse',
      reason: `the target chat's permission preset cannot be read to compare with the ${quoted(creationPreset as string)} preset the task was approved under`,
    }
  }
  if (creationPreset === undefined) {
    return {
      kind: 'refuse',
      reason: `the target chat runs the ${quoted(currentPreset)} permission preset, which the task's approval did not name`,
    }
  }
  return {
    kind: 'refuse',
    reason: `the target chat moved from the ${quoted(creationPreset)} permission preset to ${quoted(currentPreset)} after the task was approved`,
  }
}

/**
 * The `scheduleConsent` service. It holds no state: the runtime hands it both
 * presets to compare, and the tools hand it the effect to name. Its one read is
 * the workspace preset a new chat starts with, from `permissionDefaults` when
 * that service is mounted. Mounting it fills the seam's context slot; disposing it empties the
 * slot again, so a plugin that mounts or disposes it mid-session changes only
 * the later approvals and deliveries.
 */
export class ScheduleConsent extends Service implements ScheduleConsentService {
  constructor(ctx: Context) {
    super(ctx, 'scheduleConsent')
  }

  nameEffect(schedule: ScheduleEffect): string | undefined {
    return nameConsentEffect(schedule)
  }

  presetFor(create: ScheduleSessionCreateSpec): string | undefined {
    // The service is optional and declares no typed `Context` slot, so it is read by name.
    return workspacePreset(this.ctx.get('permissionDefaults') as WorkspacePresets | undefined, create)
  }

  reviewDelivery(review: ScheduleDeliveryReview): ScheduleDeliveryVerdict {
    return reviewConsentDelivery(review)
  }
}

const FAILED_STUB: unique symbol = Symbol.for('delo.fail-closed-stub') as typeof FAILED_STUB

/** The row that mounts this plugin in Delo's composition, named in a refusal. */
export const SCHEDULE_CONSENT_ROW = 'delo-schedule-consent'

/**
 * The `scheduleConsent` service mounted when {@link ScheduleConsent} failed to activate while the switch is on: it
 * refuses every delivery, so a crashed consent never reads as a composition without one.
 */
export class FailedScheduleConsent extends Service implements ScheduleConsentService {
  /** Read by the CLI's boot invariant; the key is `FAIL_CLOSED_STUB_KEY` of `@delo/home`, which this package does not depend on. */
  readonly [FAILED_STUB] = true as const
  private readonly failure: string

  /**
   * @param ctx - the plugin context.
   * @param reason - why the real service failed.
   */
  constructor(ctx: Context, reason: string) {
    super(ctx, 'scheduleConsent')
    this.failure = reason
  }

  nameEffect(): string | undefined {
    return undefined
  }

  reviewDelivery(): ScheduleDeliveryVerdict {
    return {
      kind: 'refuse',
      reason: `the scheduled-task consent row ${SCHEDULE_CONSENT_ROW} is on but its service failed to start (${this.failure}), so no scheduled task is delivered. `
        + 'To recover, restart Delorun; if it fails again, read the Delo logs for the row\'s failure, or start in safe mode with `delorun recover safe-mode`, then resume the paused tasks.',
    }
  }
}

/**
 * Mount the plugin in the scope that loads it. With `enabled` off — the
 * schema's default, and the value the parity replay keeps — nothing is mounted
 * and the seam stays empty.
 * @param ctx - The scope that loads the plugin.
 * @param config - The mounting row's configuration, or undefined for a bare mount.
 */
export function apply(ctx: Context, config?: unknown): void {
  const parsed = ConfigSchema.parse(config ?? {})
  if (!parsed.enabled) return
  let disposed = false
  ctx.effect(() => () => { disposed = true })
  ctx.plugin(ScheduleConsent).await().catch((error: unknown) => {
    // The row stays active, so nothing else shows the seam empty by a failure; a refusing service takes its slot.
    if (disposed) return
    const reason = error instanceof Error ? error.message : 'no reason was given'
    ctx.logger.error(`schedule-consent: the service of the row ${SCHEDULE_CONSENT_ROW} failed to start, so every scheduled delivery is refused until Delorun restarts: ${reason}`)
    ctx.plugin(FailedScheduleConsent, reason)
  })
}
