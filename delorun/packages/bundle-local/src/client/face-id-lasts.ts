/**
 * The sheet's "Lasts" line: how long one confirmation of an action holds. This is the seam the Face ID pass lane fills
 * in (A499): until a pass exists, every action is confirmed just this once, and a terminal stays open under its hold.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { FaceIdAction } from './face-id-types.ts'

/**
 * @param t - the Face ID copy.
 * @param action - the action the sheet confirms.
 * @param _factor - what confirms it: a passkey, or the PIN (a PIN grant never opens a pass).
 * @returns the plain sentence saying how long the confirmation lasts.
 */
export function faceIdLastsLine(t: PropsLocale<'delorunFaceId'>['t'], action: FaceIdAction, _factor: 'passkey' | 'pin'): string {
  const terminal = 'actions' in action.grant && action.grant.actions.some(entry => entry.hold?.feature === 'terminal')
  return t(terminal ? 'lasts.terminal' : 'lasts.once')
}
