/**
 * The states a device shows for something it may not simply do: it needs Face ID or the PIN for each call (the person
 * cancelled the confirmation; trying again asks again), it needs the unlock (the section says so and how long the unlock
 * lasts), or it is done on the computer (the section says why).
 * The Host decides which by the code of its refusal; this module only names the state and its copy.
 * @module @delorun/bundle-local/client/gate
 */
import { hostFailureOf, LOOPBACK_REQUIRED } from './host-api.ts'

/** The Host error code of a refusal a device clears by unlocking. */
export const ELEVATION_REQUIRED = 'ELEVATION_REQUIRED'

/**
 * A refused action: the device can do it with Face ID or its PIN for that one call (`face`: the person cancelled the
 * confirmation), after an unlock, or only at the computer.
 */
export type Gate = { readonly kind: 'face' } | { readonly kind: 'unlock' } | { readonly kind: 'computer' }

/**
 * Whether a refusal is one a Face ID or PIN grant for the call lifts: the home names the grant's `action` in it.
 * @param failure - the refusal's fields.
 * @returns true for an {@link ELEVATION_REQUIRED} refusal that names an action.
 */
export function namesGrantAction(failure: { readonly code: string; readonly fields?: Readonly<Record<string, unknown>> | undefined }): boolean {
  return failure.code === ELEVATION_REQUIRED && typeof failure.fields?.action === 'string'
}

/**
 * The state a caught error stands for.
 * @param error - the caught error.
 * @returns `face` for an {@link ELEVATION_REQUIRED} refusal that names a grant action, `unlock` for any other
 *   {@link ELEVATION_REQUIRED} refusal, `computer` for a `LOOPBACK_REQUIRED` one, and undefined
 *   for any other failure, which the caller reports as it did before.
 */
export function gateOf(error: unknown): Gate | undefined {
  const failure = hostFailureOf(error)
  if (failure.kind !== 'refused') return undefined
  if (namesGrantAction(failure)) return { kind: 'face' }
  if (failure.code === ELEVATION_REQUIRED) return { kind: 'unlock' }
  if (failure.code === LOOPBACK_REQUIRED) return { kind: 'computer' }
  return undefined
}

/** The copy of {@link Gate}, merged into the dictionary of each namespace whose section shows it. */
export const gateEn = {
  'gate.unlock': 'Unlock this device to do this. It stays unlocked while you use it, and locks after {minutes} minutes without a sensitive action.',
  'gate.unlockOne': 'Unlock this device to do this. It stays unlocked while you use it, and locks after 1 minute without a sensitive action.',
  'gate.unlockUnknown': 'Unlock this device to do this. The unlock ends on its own.',
  'gate.unlockButton': 'Unlock',
  'gate.computer': 'Do this on your computer: {reason}',
  'gate.face': 'This needs Face ID, or your PIN, each time. Try again to confirm it.',
} satisfies Record<string, string>

/** Chinese copy of {@link Gate}. */
export const gateZh: typeof gateEn = {
  'gate.unlock': '解锁此设备后即可进行此操作。使用期间保持解锁；{minutes} 分钟没有敏感操作后自动锁定。',
  'gate.unlockOne': '解锁此设备后即可进行此操作。使用期间保持解锁；1 分钟没有敏感操作后自动锁定。',
  'gate.unlockUnknown': '解锁此设备后即可进行此操作。解锁会自行结束。',
  'gate.unlockButton': '解锁',
  'gate.computer': '请在你的电脑上进行此操作：{reason}',
  'gate.face': 'This needs Face ID, or your PIN, each time. Try again to confirm it.',
}

/** A key of {@link gateEn}. */
export type GateKey = keyof typeof gateEn

/** The translate function a namespace that merged {@link gateEn} supplies. */
export type GateTranslate = (key: GateKey, values?: Readonly<Record<string, string>>) => string

/**
 * The sentence for an unlock gate.
 * @param t - the namespace's translate function.
 * @param minutes - the configured unlock length, or undefined before the home has said.
 * @returns the sentence that states the minutes when they are known.
 */
export function unlockSentence(t: GateTranslate, minutes: number | undefined): string {
  if (minutes === undefined) return t('gate.unlockUnknown')
  return minutes === 1 ? t('gate.unlockOne') : t('gate.unlock', { minutes: String(minutes) })
}
