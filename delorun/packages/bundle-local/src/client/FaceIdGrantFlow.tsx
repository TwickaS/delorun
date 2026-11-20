/**
 * One Face ID confirmation: the action sheet and, after a cancel or on request, the PIN keypad, in one dialog; a device with no passkey opens on the keypad. The sheet
 * and the keypad each mint a grant for the action's calls through the home; this component only slides between them and
 * reports the outcome once. The sheet stays mounted under the keypad so a cancelled Face ID still reads as cancelled on
 * the way back; the keypad starts empty each time it opens.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi } from './face-id-types.ts'
import { FaceIdLayer, FaceIdSheetBox } from './FaceIdLayer.tsx'
import { FaceIdPinBody } from './FaceIdPin.tsx'
import { FaceIdSheetBody } from './FaceIdSheet.tsx'
import css from './FaceId.module.css'

/** Props of the flow. */
export interface FaceIdGrantFlowProps {
  readonly t: PropsLocale<'delorunFaceId'>['t']
  readonly action: FaceIdAction
  readonly kind: FaceIdKind
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  /** Whether this device holds a passkey. */
  readonly hasPasskey: boolean
  /** The home's secret for the keypad, or undefined when none is set (the sheet then ends with Cancel). */
  readonly secret: 'pin' | 'passcode' | undefined
  /** Called with the grant the home now holds for the action. */
  readonly onGranted: (grantId: string) => void
  /** Called when the person leaves without a grant. */
  readonly onCancel: () => void
}

/**
 * Render the flow.
 * @param props - see {@link FaceIdGrantFlowProps}.
 * @returns the dialog, showing the sheet or the keypad.
 */
export function FaceIdGrantFlow({ t, action, kind, api, browser, hasPasskey, secret, onGranted, onCancel }: FaceIdGrantFlowProps): ReactNode {
  const keypad = secret !== undefined && action.noPin !== true
  // A device with no passkey opens on the keypad: its PIN mints a one-action grant (A483), never a page unlock. Any other
  // device reaches it from the sheet's PIN button. `round` counts the keypad's openings: it empties the keypad each
  // time and tells the sheet it slid back in.
  const [view, setView] = useState({ keypad: !hasPasskey && keypad, round: 0 })
  const onKeypad = view.keypad && keypad
  // With no passkey there is no sheet to go back to, so leaving the keypad ends the confirmation.
  const back = (): void => { if (hasPasskey) setView(current => ({ ...current, keypad: false })); else onCancel() }
  return <FaceIdLayer labelledBy={onKeypad ? 'delorun-face-id-pin-title' : 'delorun-face-id-title'}
    attributes={onKeypad ? { 'data-face-id-pin': '' } : { 'data-face-id-sheet': '' }} onEscape={onKeypad ? back : onCancel} onClosed={onCancel}>
    <FaceIdSheetBox>
      {hasPasskey || !keypad
        ? <div className={view.round > 0 ? `${css.pane} ${css.slideBack}` : css.pane} hidden={onKeypad}>
          <FaceIdSheetBody t={t} action={action} kind={kind} api={api} browser={browser} hasPasskey={hasPasskey} fallback={keypad ? 'pin' : 'computer'}
            onGranted={onGranted} onCancel={onCancel} onFallback={() => { setView(current => ({ keypad: true, round: current.round + 1 })) }} />
        </div>
        : null}
      {onKeypad
        ? <div className={css.slide}><FaceIdPinBody key={view.round} t={t} action={action} api={api} secret={secret} onGranted={onGranted} onBack={back} /></div>
        : null}
    </FaceIdSheetBox>
  </FaceIdLayer>
}
