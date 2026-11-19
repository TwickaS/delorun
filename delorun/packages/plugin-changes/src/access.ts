/**
 * Who may use each control of the Changes section, from where (C21, "Who may do what from where"; Face ID plan, A1 and A2).
 * The person at the computer may use every control. A paired device is decided by the control's class, the same three
 * classes as `AUTH_CLASSES` in `@delorun/home-auth`:
 *
 * - `free`: any paired device, with no prompt: the controls that only read, take back or tighten (turning protection on,
 *   cancelling or dismissing an update, the update check);
 * - `face`: one Face ID (or one PIN, as a one-action grant) for exactly this call, or, while the Face ID flag is off or on
 *   a device that holds no passkey, the unlock the person entered together with the Phone powers level (the
 *   {@link LEGACY_LEVELS} below, which go with Phone powers);
 * - `computer`: never from a device: dismissing the notice of a change a device made.
 *
 * The update controls (`@delorun/plugin-update`) sit in the same table. The routes decide from {@link mayUse} before they
 * read a request's body, and the `state` route answers the same decisions as {@link AccessView}, so the screen says what
 * a control needs before the person presses it. This module decides only; the routes attest the request.
 *
 * @module @delorun/plugin-changes/access
 */
import type { AccessView, ActorView, ChangesControl, MayView, PhonePowersView } from './wire.ts'

/** How far from the computer a control reaches. */
export type ControlLevel = 'free' | 'face' | 'computer'

/** The class of every control. */
export const CONTROL_LEVELS: Readonly<Record<ChangesControl, ControlLevel>> = {
  'plugin-undo': 'face',
  'plugin-discard': 'face',
  'harness-discard': 'face',
  'protection-on': 'free',
  'plugin-apply': 'face',
  'plugin-other': 'face',
  'harness-apply': 'face',
  'harness-undo': 'face',
  'protection-off': 'face',
  'make-copy': 'face',
  'restart': 'face',
  'notice-seen': 'computer',
  'update-check': 'free',
  'update-begin': 'face',
  'update-rollback': 'face',
  'update-cancel': 'free',
  'update-dismiss': 'free',
  'stop': 'face',
}

/**
 * What a `face` control asked of a device before Face ID: an unlock at either Phone powers level (`unlocked`), or an unlock
 * only while Phone powers is Full (`phone-powers`). Read only while the Face ID flag is off and for a device with no
 * passkey; removed with Phone powers.
 */
export const LEGACY_LEVELS: Readonly<Partial<Record<ChangesControl, 'unlocked' | 'phone-powers'>>> = {
  'plugin-undo': 'unlocked',
  'plugin-discard': 'unlocked',
  'harness-discard': 'unlocked',
  'stop': 'unlocked',
  'plugin-apply': 'phone-powers',
  'plugin-other': 'phone-powers',
  'harness-apply': 'phone-powers',
  'harness-undo': 'phone-powers',
  'protection-off': 'phone-powers',
  'make-copy': 'phone-powers',
  'restart': 'phone-powers',
  'update-begin': 'phone-powers',
  'update-rollback': 'phone-powers',
}

/**
 * Whether a request may use one control now.
 * @param actor - where the request came from.
 * @param powers - the Phone powers level in force; read only for a `face` control on the legacy path.
 * @param control - the control.
 * @param faceReady - whether the home asks this device for Face ID: the flag is on and the device holds a passkey.
 * @returns ok, or what the request needs: the computer, Face ID for the call, or an unlock the person enters on the device.
 */
export function mayUse(actor: ActorView, powers: PhonePowersView['level'], control: ChangesControl, faceReady = false): MayView {
  if (actor === 'computer') return { ok: true }
  const level = CONTROL_LEVELS[control]
  if (level === 'free') return { ok: true }
  if (level === 'computer') return { ok: false, needs: 'computer' }
  // Until Phone powers is removed, a control of the Full set stays at the computer under Careful for every device, with or without a passkey or a grant.
  if (LEGACY_LEVELS[control] === 'phone-powers' && powers !== 'full') return { ok: false, needs: 'computer' }
  if (faceReady) return { ok: false, needs: 'face' }
  return actor === 'device-unlocked' ? { ok: true } : { ok: false, needs: 'unlock' }
}

/**
 * Every control's decision for one request, as `state` answers it.
 * @param actor - where the request came from.
 * @param powers - the Phone powers level in force and whether the person chose it.
 * @param faceReady - whether the home asks this device for Face ID.
 * @returns the view.
 */
export function accessView(actor: ActorView, powers: PhonePowersView, faceReady = false): AccessView {
  const may = Object.fromEntries((Object.keys(CONTROL_LEVELS) as ChangesControl[]).map(control => [control, mayUse(actor, powers.level, control, faceReady)]))
  return { actor, phonePowers: powers, may: may as Record<ChangesControl, MayView> }
}
