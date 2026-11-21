/**
 * Who may use each control of the Changes section, from where (C21, "Who may do what from where"; Face ID plan, A1 and A2).
 * The person at the computer may use every control. A paired device is decided by the control's class, the same three
 * classes as `AUTH_CLASSES` in `@delorun/home-auth`:
 *
 * - `free`: any paired device, with no prompt: the controls that only read, take back or tighten (turning protection on,
 *   cancelling or dismissing an update, the update check);
 * - `face`: one Face ID (or one PIN, as a one-action grant) for exactly this call, or, on
 *   a device that holds no passkey, one PIN grant for exactly this call, never an unlock window; while the home
 *   keeps no grant store, they stay at the computer;
 * - `computer`: never from a device: dismissing the notice of a change a device made.
 *
 * The update controls (`@delorun/plugin-update`) sit in the same table. The routes decide from {@link mayUse} before they
 * read a request's body, and the `state` route answers the same decisions as {@link AccessView}, so the screen says what
 * a control needs before the person presses it. This module decides only; the routes attest the request.
 *
 * @module @delorun/plugin-changes/access
 */
import type { AccessView, ActorView, ChangesControl, MayView } from './wire.ts'

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
  'update-continue': 'free',
  'stop': 'face',
}

/** What the home asks of a device for Face ID: whether the home keeps a grant store, and whether the device holds a passkey. */
export interface FaceState {
  readonly enabled: boolean
  readonly hasPasskey: boolean
}

/**
 * Whether a request may use one control now.
 * @param actor - where the request came from.
 * @param control - the control.
 * @param face - whether the home keeps a grant store and whether the device holds a passkey.
 * @returns ok, or what the request needs: the computer, Face ID or a PIN for the call, or an unlock the person enters on the device.
 */
export function mayUse(actor: ActorView, control: ChangesControl, face: FaceState = { enabled: false, hasPasskey: false }): MayView {
  if (actor === 'computer') return { ok: true }
  const level = CONTROL_LEVELS[control]
  if (level === 'free') return { ok: true }
  if (level === 'computer') return { ok: false, needs: 'computer' }
  // A face control takes a grant from every device, a PIN grant where it holds no passkey; with no grant store no grant exists, so it stays at the computer.
  return face.enabled ? { ok: false, needs: 'face' } : { ok: false, needs: 'computer' }
}

/**
 * Every control's decision for one request, as `state` answers it.
 * @param actor - where the request came from.
 * @param face - whether the home keeps a grant store and whether the device holds a passkey.
 * @returns the view.
 */
export function accessView(actor: ActorView, face: FaceState = { enabled: false, hasPasskey: false }): AccessView {
  const may = Object.fromEntries((Object.keys(CONTROL_LEVELS) as ChangesControl[]).map(control => [control, mayUse(actor, control, face)]))
  return { actor, may: may as Record<ChangesControl, MayView> }
}
