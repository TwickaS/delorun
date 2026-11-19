/**
 * Parts the update screens share: the dictionary type, plural keys, sizes, what a control's button says about who may
 * use it, and the refusal sentence for a route's refusal code.
 */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdateControl, UpdateStateView } from '../wire.ts'
import type { UpdateRefusal } from './controller.ts'

/** The dictionary the update screens read. */
export type T = TranslateNS<'delorunUpdate'>

/**
 * The key of the singular or the plural copy for a count.
 * @param base - the key without its `.one` or `.other` suffix.
 * @param count - the count the copy states.
 * @returns the key to translate.
 */
export function pluralKey<B extends string>(base: B, count: number) {
  return `${base}.${count === 1 ? 'one' : 'other'}` as const
}

/**
 * Write a byte count the way a person reads disk space.
 * @param bytes - the count.
 * @param t - the dictionary.
 * @returns the count in KB, MB or GB.
 */
export function sizeText(bytes: number, t: T): string {
  if (bytes >= 1024 ** 3) return t('size.gb', { n: (bytes / 1024 ** 3).toFixed(1) })
  if (bytes >= 1024 ** 2) return t('size.mb', { n: String(Math.round(bytes / 1024 ** 2)) })
  return t('size.kb', { n: String(Math.max(1, Math.round(bytes / 1024))) })
}

/** What one control's button does with the state's `access`. */
export interface ControlUse {
  readonly disabled: boolean
  readonly title: string | undefined
}

/**
 * Decide a control's button from the state: one the Phone powers level keeps at the computer is disabled with a hover
 * text; one that needs an unlock stays enabled, and the route's refusal opens the studio's unlock dialog.
 * @param state - the update state.
 * @param control - the control.
 * @param t - the dictionary.
 * @returns whether the button is disabled and its hover text.
 */
export function controlUse(state: UpdateStateView, control: UpdateControl, t: T): ControlUse {
  const may = state.access.may[control]
  if (may.ok) return { disabled: false, title: undefined }
  if (may.needs === 'computer') return { disabled: true, title: t('needs.computer.title') }
  return { disabled: false, title: t(may.needs === 'face' ? 'needs.face' : 'needs.unlock') }
}

/** The refusal codes the dictionary words, as `refusal.<code>` keys. */
const WORDED = new Set<string>(['CROSS_SITE', 'LOOPBACK_REQUIRED', 'ELEVATION_REQUIRED', 'FACE_CANCELLED', 'UPDATE_UNAVAILABLE', 'REPORT_EXPIRED', 'UPDATE_IN_PROGRESS', 'RESTART_IN_PROGRESS', 'ACKNOWLEDGEMENT_MISSING', 'REPORT_BLOCKED', 'HARNESS_CHANGES_PENDING', 'HARNESS_REPORT_STALE', 'HARNESS_COPY_UNREADABLE', 'DATA_COPY_NO_SPACE', 'CHATS_RUNNING', 'NO_UPDATE_RECORD', 'ROLLBACK_NEEDS_DATA_COPY', 'ROLLBACK_TARGET_UNUSABLE', 'NO_RUNTIME_STORE', 'VERIFY_FAILED', 'CHANNEL_UNREACHABLE', 'GIT_UNAVAILABLE', 'TARGET_LOWER', 'NO_UPDATE_AVAILABLE'])

/**
 * The sentence for a refusal: its worded code, or the generic line with the Host's own message.
 * @param refusal - the refusal.
 * @param t - the dictionary.
 * @returns the sentence.
 */
export function refusalText(refusal: UpdateRefusal, t: T): string {
  if (WORDED.has(refusal.code)) return t(`refusal.${refusal.code}` as 'refusal.CROSS_SITE')
  return t('refusal.UPDATE_FAILED', { message: refusal.message })
}
