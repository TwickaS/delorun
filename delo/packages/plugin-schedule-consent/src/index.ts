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
  ScheduleConsentService, ScheduleDeliveryReview, ScheduleDeliveryVerdict, ScheduleEffect,
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
 * Name what one approved Schedule management call creates: the recurrence it
 * arms or keeps, the chat its deliveries reach, and that chat's permission
 * preset. The text joins the approval's reason, so the ask states what would
 * start running before the person answers it.
 * @param schedule - The effect the approved call would create.
 * @returns The naming, or undefined when the effect names no recurrence.
 */
export function nameConsentEffect(schedule: ScheduleEffect): string | undefined {
  if (schedule.recurrence === '') return undefined
  const target = schedule.targetSessionId === undefined
    ? 'a new chat that its first delivery opens'
    : `the chat ${schedule.targetSessionId}`
  const preset = schedule.targetPreset === undefined
    ? ''
    : `, which runs the ${schedule.targetPreset} permission preset`
  return `The task delivers on "${schedule.recurrence}" into ${target}${preset}.`
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
 * The `scheduleConsent` service. It holds no state and reads no other service:
 * the runtime hands it both presets to compare, and the tools hand it the effect
 * to name. Mounting it fills the seam's context slot; disposing it empties the
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

  reviewDelivery(review: ScheduleDeliveryReview): ScheduleDeliveryVerdict {
    return reviewConsentDelivery(review)
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
  ctx.plugin(ScheduleConsent)
}
