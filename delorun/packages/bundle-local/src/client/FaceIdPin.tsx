/**
 * The PIN fallback of the action sheet (B3): the shared keypad entry, shown after a cancelled or failed Face ID or on a
 * device with no passkey. A correct secret mints a one-action grant through the home's `/auth/passkey/pin` route, never
 * a window. The secret leaves the page's state before the request does.
 */
import { useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, CodeCells, Keypad } from '@delorun/brand'
import { isRefused } from './host-api.ts'
import type { FaceIdAction, PasskeyApi } from './face-id-types.ts'
import { FaceIdIcon } from './face-id-icons.tsx'
import { faceIdLastsLine } from './face-id-lasts.ts'
import { FaceIdLayer, FaceIdSheetBox } from './FaceIdLayer.tsx'
import css from './FaceId.module.css'

/** The digits a PIN has at least; the home's own rule is the authority. */
const MIN_PIN_DIGITS = 6
const MAX_SECRET_CHARS = 128

/** Props of the PIN fallback. */
export interface FaceIdPinProps {
  readonly t: PropsLocale<'delorunFaceId'>['t']
  readonly action: FaceIdAction
  readonly api: PasskeyApi
  /** Whether the home's secret is a digit PIN (keypad) or a longer passcode (text field). */
  readonly secret: 'pin' | 'passcode'
  readonly onGranted: (grantId: string) => void
  /** Back to the Face ID sheet, or away when there is none; Escape does the same. */
  readonly onBack: () => void
  /** Away, ending the confirmation, when the browser closes the keypad's dialog itself. */
  readonly onCancel: () => void
}

/**
 * Render the PIN entry's content, for a layer that another component owns (the flow slides it in over the sheet).
 * @param props - see {@link FaceIdPinProps}; `onCancel` is not used here.
 * @returns the entry form.
 */
export function FaceIdPinBody({ t, action, api, secret, onGranted, onBack }: Omit<FaceIdPinProps, 'onCancel'>): ReactNode {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [wrong, setWrong] = useState<'wrong' | 'paused' | 'failed' | undefined>(undefined)
  const isPin = secret === 'pin'
  const ready = !busy && (isPin ? value.length >= MIN_PIN_DIGITS : value !== '')
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!ready) return
    const typed = value
    setValue('')
    setBusy(true)
    setWrong(undefined)
    api.pin({ ...action.grant, secret: typed }).then(
      ({ grantId }) => { setBusy(false); onGranted(grantId) },
      (error: unknown) => { setBusy(false); setWrong(isRefused(error, 'PIN_INVALID') ? 'wrong' : isRefused(error, 'PIN_UNLOCKS_PAUSED') ? 'paused' : 'failed') },
    )
  }
  return <form className={css.pane} onSubmit={submit}>
    <header className={css.header}>
      <span className={css.icon}><FaceIdIcon icon={action.icon} /></span>
      <h2 id="delorun-face-id-pin-title" className={css.title}>{action.title}</h2>
    </header>
    <p className={css.body}>{[action.context?.workspace, action.context?.chat, action.stays ?? faceIdLastsLine(t, action, 'pin')].filter(part => part !== undefined).join(' · ')}</p>
    <p className={css.body}>{t(isPin ? 'pin.lead' : 'pin.leadPasscode')}</p>
    {isPin
      ? <>
        <CodeCells label={t('pin.label')} length={MIN_PIN_DIGITS} open mask value={value} onChange={setValue} error={wrong === 'wrong'} disabled={busy}
          autoComplete="off" name="delorun-grant-pin" />
        <Keypad onKey={(key) => { if (!busy) setValue(current => key === '⌫' ? current.slice(0, -1) : current.length < MAX_SECRET_CHARS ? current + key : current) }}
          deleteLabel={t('pin.delete')} disabled={busy} />
      </>
      : <input className={css.field} type="password" name="delorun-grant-pin" aria-label={t('pin.labelPasscode')} autoComplete="off" autoCorrect="off"
        autoCapitalize="off" spellCheck={false} disabled={busy} value={value} onChange={(event) => { setValue(event.target.value) }} />}
    {wrong === undefined ? null : <p className={css.failed} role="alert">{t(`pin.${wrong}`)}</p>}
    <Button variant="primary" type="submit" className={css.confirm} disabled={!ready}>{t(busy ? 'pin.checking' : 'pin.confirm')}</Button>
    <Button variant="secondary" type="button" className={css.secondary} onClick={onBack}>{t('pin.back')}</Button>
  </form>
}

/**
 * Render the PIN entry.
 * @param props - see {@link FaceIdPinProps}.
 * @returns the entry, over the same scrim as the sheet.
 */
export function FaceIdPin(props: FaceIdPinProps): ReactNode {
  return <FaceIdLayer labelledBy="delorun-face-id-pin-title" attributes={{ 'data-face-id-pin': '' }} onEscape={props.onBack} onClosed={props.onCancel}>
    <FaceIdSheetBox><FaceIdPinBody {...props} /></FaceIdSheetBox>
  </FaceIdLayer>
}
