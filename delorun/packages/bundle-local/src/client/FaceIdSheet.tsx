/**
 * The action sheet (B2, B3, A498): the action's glyph and title, a compact list of where it happens, what it allows as
 * the person and how long it lasts, then a full-width Confirm and Cancel. The tap on Confirm fetches the options and
 * calls `get()` in the same handler, so Safari still counts the tap as the person's; nothing prompts when the sheet
 * opens, and nothing takes focus. A cancel or a failure leaves the sheet in place with the way down to the PIN keypad or
 * to the computer, and is never an error colour. On a device with no passkey Confirm reads "Confirm with PIN" and
 * opens the keypad.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@delorun/brand'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi } from './face-id-types.ts'
import { faceIdLastsLine } from './face-id-lasts.ts'
import { FaceIdGlyph } from './face-id-glyph.tsx'
import { FaceIdIcon } from './face-id-icons.tsx'
import { FaceIdLayer, FaceIdSheetBox } from './FaceIdLayer.tsx'
import css from './FaceId.module.css'

/** The most items of a batch the sheet lists before it counts the rest. */
const LISTED_ITEMS = 3

/** How long the options request may take: under Safari's 10 s window for a prompt that follows a tap. */
export const OPTIONS_TIMEOUT_MS = 8000

/** Where the way down from the main button leads. */
export type FaceIdFallback = 'pin' | 'computer'

/** Props of the sheet. */
export interface FaceIdSheetProps {
  readonly t: PropsLocale<'delorunFaceId'>['t']
  readonly action: FaceIdAction
  readonly kind: FaceIdKind
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  /** Whether this device holds a passkey; without one the sheet goes straight to the way down. */
  readonly hasPasskey: boolean
  /** The way down: the PIN keypad when a PIN is set and allowed, otherwise a note to do it at the computer. */
  readonly fallback: FaceIdFallback
  /** Called with the grant the home now holds for the action. */
  readonly onGranted: (grantId: string) => void
  readonly onCancel: () => void
  /** Open the PIN keypad; called only when `fallback` is `pin`. */
  readonly onFallback: () => void
  /** Open Settings → Devices, for a device that holds no passkey. */
  readonly onOpenDevices?: () => void
}

type Phase = 'ready' | 'waiting' | 'cancelled' | 'failed'

/**
 * Render the sheet's content, for a layer that another component owns (the flow keeps one layer for the sheet and the keypad).
 * @param props - see {@link FaceIdSheetProps}.
 * @returns the header, the context list and the buttons.
 */
export function FaceIdSheetBody({ t, action, kind, api, browser, hasPasskey, fallback, onGranted, onCancel, onFallback, onOpenDevices }: FaceIdSheetProps): ReactNode {
  const [phase, setPhase] = useState<Phase>('ready')
  const [available, setAvailable] = useState<boolean | undefined>(undefined)
  const alive = useRef(true)
  const method = t(`kind.${kind}`)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  useEffect(() => {
    let current = true
    void browser.available().then((value) => { if (current) setAvailable(value) })
    return () => { current = false }
  }, [browser])
  const confirm = useCallback(async (): Promise<void> => {
    setPhase('waiting')
    let options: Awaited<ReturnType<PasskeyApi['options']>>
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error('the options request timed out')) }, OPTIONS_TIMEOUT_MS) })
      options = await Promise.race([api.options(action.grant), expired])
    } catch {
      if (alive.current) setPhase('failed')
      return
    } finally {
      clearTimeout(timer)
    }
    // A sheet whose call was withdrawn meanwhile (its panel closed) asks the phone for no Face ID.
    if (!alive.current) return
    const result = await browser.get(options)
    if (!alive.current) return
    if (result.kind !== 'ok') { setPhase(result.kind); return }
    // Once `verify` is sent the home may mint the grant even if the sheet goes; that grant names this one call's action and
    // hash, so only the same call, sent again before the grant expires, can use it.
    try {
      const { grantId } = await api.verify(result.value)
      if (alive.current) onGranted(grantId)
    } catch {
      if (alive.current) setPhase('failed')
    }
  }, [api, browser, action, onGranted])
  const usable = hasPasskey && available !== false
  const listed = action.items?.slice(0, LISTED_ITEMS) ?? []
  const rest = (action.items?.length ?? 0) - listed.length
  // With no passkey and no PIN to fall back on, the sheet can only say how to get one; it offers no keypad.
  const stranded = !hasPasskey && fallback === 'computer'
  const status = stranded ? t(action.noPin === true ? 'sheet.setUpFirst' : 'sheet.nothingToConfirm', { method })
    : !hasPasskey ? t('sheet.noPasskey', { method }) : available === false ? t('sheet.unsupported', { method })
    : phase === 'cancelled' ? t('sheet.cancelled', { method }) : phase === 'failed' ? t('sheet.failed', { method }) : undefined
  const label = phase === 'waiting' ? t('sheet.waiting', { method }) : phase === 'ready' ? t('sheet.confirm', { method }) : t('sheet.again', { method })
  const showFallback = !usable || phase === 'cancelled' || phase === 'failed'
  const faceOnly = showFallback && action.noPin === true
  // Without a usable Face ID the PIN is the way to confirm, so it takes the main button.
  const pinMain = !usable && fallback === 'pin'
  const context: readonly (readonly [string, string])[] = [
    ...action.context?.workspace === undefined ? [] : [[t('sheet.workspace'), action.context.workspace] as const],
    ...action.context?.chat === undefined ? [] : [[t('sheet.chat'), action.context.chat] as const],
    [t('sheet.allows'), action.body],
    [t('sheet.lasts'), faceIdLastsLine(t, action, usable ? 'passkey' : 'pin')],
    ...action.stays === undefined ? [] : [[t('sheet.stays'), action.stays] as const],
  ]
  return <>
    <header className={css.header}>
      <span className={css.icon}><FaceIdIcon icon={action.icon} /></span>
      <h2 id="delorun-face-id-title" className={css.title}>{action.title}</h2>
    </header>
    <dl className={css.context}>
      {context.map(([name, value]) => <div key={name} className={css.contextRow}><dt>{name}</dt><dd>{value}</dd></div>)}
    </dl>
    {listed.length === 0 ? null : <ul className={css.items}>
      {listed.map(item => <li key={item}>{item}</li>)}
      {rest > 0 ? <li>{t('sheet.more', { count: String(rest) })}</li> : null}
    </ul>}
    {faceOnly && !stranded ? <p className={css.status} role="status">{t('sheet.faceOnly', { method })}</p> : null}
    {status === undefined ? null : <p className={css.status} role="status">{status}</p>}
    {usable
      ? <Button variant="primary" type="button" className={css.confirm} disabled={phase === 'waiting'}
        onClick={() => { void confirm() }}><FaceIdGlyph kind={kind} />{label}</Button>
      : pinMain
        ? <Button variant="primary" type="button" className={css.confirm} data-face-id-fallback="pin" onClick={onFallback}>{t('sheet.confirmPin')}</Button>
        : !hasPasskey && onOpenDevices !== undefined
          ? <Button variant="primary" type="button" className={css.confirm} onClick={onOpenDevices}>{t('sheet.openDevices')}</Button>
          : null}
    {showFallback && fallback === 'pin' && !pinMain
      ? <Button variant="secondary" type="button" className={css.secondary} data-face-id-fallback="pin" onClick={onFallback}>{t('sheet.usePin')}</Button> : null}
    {showFallback && fallback === 'computer' && !stranded ? <p className={css.status} data-face-id-fallback="computer">{t('sheet.askComputer')}</p> : null}
    <Button variant="secondary" type="button" className={css.secondary} onClick={onCancel}>{t('sheet.cancel')}</Button>
  </>
}

/**
 * Render the sheet.
 * @param props - see {@link FaceIdSheetProps}.
 * @returns the sheet: a bottom sheet on a phone and a centred dialog from 480px.
 */
export function FaceIdSheet(props: FaceIdSheetProps): ReactNode {
  return <FaceIdLayer labelledBy="delorun-face-id-title" attributes={{ 'data-face-id-sheet': '' }} onEscape={props.onCancel} onClosed={props.onCancel}>
    <FaceIdSheetBox><div className={css.pane}><FaceIdSheetBody {...props} /></div></FaceIdSheetBox>
  </FaceIdLayer>
}
