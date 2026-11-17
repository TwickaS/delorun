/**
 * Who may use each control of the Changes section, from where (C21, "Who may do what from where"; C14, "Phone powers").
 * The person at the computer may use every control. A paired device may use a control only with an unlock the person
 * entered for it (a code or a PIN, never the approval grace), and only when the control's level allows a device:
 *
 * - `unlocked`: at either Phone powers level: the controls that only take something back or tighten (Undo of a plugin's
 *   change, Discard of a plugin's change or of a change to Delorun itself, turning protection on);
 * - `phone-powers`: only while Phone powers is Full, which lets an unlocked phone do what the computer can: every other
 *   plugin and harness action, Apply included, turning protection off, Make my copy and Restart;
 * - `computer`: never from a device: dismissing the notice of a change a device made;
 * - `open`: any paired device, unlocked or not: the controls that only read, such as the update check.
 *
 * The update controls (`@delorun/plugin-update`) sit in the same table: `update-check` is `open`; `update-begin` and
 * `update-rollback` are `phone-powers`, so a Careful phone updates at the computer; `update-cancel`, `update-dismiss`
 * and `stop` are `unlocked`.
 *
 * The routes decide from {@link mayUse} before they read a request's body, and the `state` route answers the same
 * decisions as {@link AccessView}, so the screen says what a control needs before the person presses it. This module
 * decides only; the routes attest the request.
 *
 * @module @delorun/plugin-changes/access
 */
import type { AccessView, ActorView, ChangesControl, MayView, PhonePowersView } from './wire.ts'

/** How far from the computer a control reaches. */
export type ControlLevel = 'open' | 'phone-powers' | 'unlocked' | 'computer'

/** The level of every control. */
export const CONTROL_LEVELS: Readonly<Record<ChangesControl, ControlLevel>> = {
  'plugin-undo': 'unlocked',
  'plugin-discard': 'unlocked',
  'harness-discard': 'unlocked',
  'protection-on': 'unlocked',
  'plugin-apply': 'phone-powers',
  'plugin-other': 'phone-powers',
  'harness-apply': 'phone-powers',
  'harness-undo': 'phone-powers',
  'protection-off': 'phone-powers',
  'make-copy': 'phone-powers',
  'restart': 'phone-powers',
  'notice-seen': 'computer',
  'update-check': 'open',
  'update-begin': 'phone-powers',
  'update-rollback': 'phone-powers',
  'update-cancel': 'unlocked',
  'update-dismiss': 'unlocked',
  'stop': 'unlocked',
}

/**
 * Whether a request may use one control now.
 * @param actor - where the request came from.
 * @param powers - the Phone powers level in force.
 * @param control - the control.
 * @returns ok, or what the request needs: the computer, or an unlock the person enters on the device.
 */
export function mayUse(actor: ActorView, powers: PhonePowersView['level'], control: ChangesControl): MayView {
  if (actor === 'computer') return { ok: true }
  const level = CONTROL_LEVELS[control]
  if (level === 'open') return { ok: true }
  if (level === 'computer' || (level === 'phone-powers' && powers !== 'full')) return { ok: false, needs: 'computer' }
  return actor === 'device-unlocked' ? { ok: true } : { ok: false, needs: 'unlock' }
}

/**
 * Every control's decision for one request, as `state` answers it.
 * @param actor - where the request came from.
 * @param powers - the Phone powers level in force and whether the person chose it.
 * @returns the view.
 */
export function accessView(actor: ActorView, powers: PhonePowersView): AccessView {
  const may = Object.fromEntries((Object.keys(CONTROL_LEVELS) as ChangesControl[]).map(control => [control, mayUse(actor, powers.level, control)]))
  return { actor, phonePowers: powers, may: may as Record<ChangesControl, MayView> }
}
