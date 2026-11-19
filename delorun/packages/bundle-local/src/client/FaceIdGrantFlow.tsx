/**
 * One Face ID confirmation: the action sheet and, after a cancel or on request, the PIN keypad. The sheet and the keypad
 * each mint a grant for the action's calls through the home; this component only moves between them and reports the
 * outcome once.
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi } from './face-id-types.ts'
import { FaceIdPin } from './FaceIdPin.tsx'
import { FaceIdSheet } from './FaceIdSheet.tsx'

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
 * @returns the sheet or the keypad.
 */
export function FaceIdGrantFlow({ t, action, kind, api, browser, hasPasskey, secret, onGranted, onCancel }: FaceIdGrantFlowProps): ReactNode {
  const [pin, setPin] = useState(false)
  if (pin && secret !== undefined) {
    return <FaceIdPin t={t} action={action} api={api} secret={secret} onGranted={onGranted} onBack={() => { setPin(false) }} />
  }
  return <FaceIdSheet t={t} action={action} kind={kind} api={api} browser={browser} hasPasskey={hasPasskey} fallback={secret === undefined ? 'computer' : 'pin'}
    onGranted={onGranted} onCancel={onCancel} onFallback={() => { if (secret === undefined) onCancel(); else setPin(true) }} />
}
