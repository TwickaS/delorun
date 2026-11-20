/**
 * The sheet's "Covers" line: how long one confirmation of an action holds. A Face ID that opens a pass (A499) covers
 * strong actions on this phone for the pass's minutes (`passLastsLine` in `./face-id-pass.ts`); otherwise the action is
 * confirmed just this once, and a terminal or the folder picker stays open under its hold.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { passLastsLine } from './face-id-pass.ts'
import type { FaceIdAction } from './face-id-types.ts'

/**
 * @param t - the Face ID copy.
 * @param action - the action the sheet confirms.
 * @param factor - what confirms it: a passkey, or the PIN (a PIN grant never opens a pass).
 * @returns the plain sentence saying how long the confirmation lasts.
 */
export function faceIdLastsLine(t: PropsLocale<'delorunFaceId'>['t'], action: FaceIdAction, factor: 'passkey' | 'pin'): string {
  const held = (feature: string): boolean => 'actions' in action.grant && action.grant.actions.some(entry => entry.hold?.feature === feature)
  return passLastsLine(t, action, factor) ?? t(held('terminal') ? 'lasts.terminal' : held('picker') ? 'lasts.picker' : 'lasts.once')
}
