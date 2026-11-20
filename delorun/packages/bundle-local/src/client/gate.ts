/**
 * The states a device shows for something it may not simply do: it needs Face ID or the PIN for each call (the person
 * cancelled the confirmation; trying again asks again), or it is done on the computer (the section says why).
 * The Host decides which by the code of its refusal; this module only names the state and its copy.
 * @module @delorun/bundle-local/client/gate
 */
import { hostFailureOf, LOOPBACK_REQUIRED } from './host-api.ts'

/** The Host error code of a refusal that a Face ID or PIN grant for the call lifts. */
export const ELEVATION_REQUIRED = 'ELEVATION_REQUIRED'

/** A refused action: the device can do it with Face ID or its PIN for that one call (`face`), or only at the computer. */
export type Gate = { readonly kind: 'face' } | { readonly kind: 'computer' }

/**
 * The state a caught error stands for.
 * @param error - the caught error.
 * @returns `face` for an {@link ELEVATION_REQUIRED} refusal that names the grant `action` the Face ID step asks for,
 *   `computer` for a `LOOPBACK_REQUIRED` one, and undefined for any other failure, which the caller reports with the
 *   failure's own sentence: an {@link ELEVATION_REQUIRED} that names no action, such as a body too large to confirm, is
 *   one no grant lifts, so trying again would only fail again.
 */
export function gateOf(error: unknown): Gate | undefined {
  const failure = hostFailureOf(error)
  if (failure.kind !== 'refused') return undefined
  if (failure.code === ELEVATION_REQUIRED) {
    const action = failure.fields?.['action']
    return typeof action === 'string' && action !== '' ? { kind: 'face' } : undefined
  }
  if (failure.code === LOOPBACK_REQUIRED) return { kind: 'computer' }
  return undefined
}

/** The copy of {@link Gate}, merged into the dictionary of each namespace whose section shows it. */
export const gateEn = {
  'gate.computer': 'Do this on your computer: {reason}',
  'gate.face': 'This needs Face ID, or your PIN, each time. Try again to confirm it.',
} satisfies Record<string, string>

/** Chinese copy of {@link Gate}. */
export const gateZh: typeof gateEn = {
  'gate.computer': '请在你的电脑上进行此操作：{reason}',
  'gate.face': '这需要每次都使用 Face ID 或你的 PIN。请重试并确认。',
}

/** A key of {@link gateEn}. */
export type GateKey = keyof typeof gateEn

/** The translate function a namespace that merged {@link gateEn} supplies. */
export type GateTranslate = (key: GateKey, values?: Readonly<Record<string, string>>) => string
