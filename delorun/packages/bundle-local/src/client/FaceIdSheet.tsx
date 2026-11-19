/**
 * The action sheet (B2, B3): what is about to happen in plain words and one large Confirm button. The tap on Confirm
 * fetches the options and calls `get()` in the same handler, so Safari still counts the tap as the person's; nothing
 * prompts when the sheet opens. A cancel or a failure leaves the sheet in place with the way down to the PIN keypad or to
 * the computer, and is never an error colour.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdAction, FaceIdKind, PasskeyApi } from './face-id-types.ts'
import { DelorunBrandMark } from './brand.tsx'
import css from './FaceId.module.css'

/** The most items of a batch the sheet lists before it counts the rest. */
const LISTED_ITEMS = 3

/** How long the options request may take: under Safari's 10 s window for a prompt that follows a tap. */
export const OPTIONS_TIMEOUT_MS = 8000

/** Where the small link under the button leads. */
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
 * Render the sheet.
 * @param props - see {@link FaceIdSheetProps}.
 * @returns the sheet: a bottom sheet on a phone and a centred dialog from 480px.
 */
export function FaceIdSheet({ t, action, kind, api, browser, hasPasskey, fallback, onGranted, onCancel, onFallback, onOpenDevices }: FaceIdSheetProps): ReactNode {
  const [phase, setPhase] = useState<Phase>('ready')
  const [available, setAvailable] = useState<boolean | undefined>(undefined)
  const confirmRef = useRef<HTMLButtonElement>(null)
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
  useEffect(() => { confirmRef.current?.focus() }, [available])
  useEffect(() => {
    const close = (event: KeyboardEvent): void => { if (event.key === 'Escape') onCancel() }
    // Capture phase: a card that holds the sheet stops Escape from bubbling to the document.
    document.addEventListener('keydown', close, true)
    return () => { document.removeEventListener('keydown', close, true) }
  }, [onCancel])
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
    const result = await browser.get(options)
    if (!alive.current) return
    if (result.kind !== 'ok') { setPhase(result.kind); return }
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
  const status = !hasPasskey ? t('sheet.noPasskey', { method }) : available === false ? t('sheet.unsupported', { method })
    : phase === 'cancelled' ? t('sheet.cancelled', { method }) : phase === 'failed' ? t('sheet.failed', { method }) : undefined
  const label = phase === 'waiting' ? t('sheet.waiting', { method }) : phase === 'ready' ? t('sheet.confirm', { method }) : t('sheet.again', { method })
  const showFallback = !usable || phase === 'cancelled' || phase === 'failed'
  const faceOnly = showFallback && action.noPin === true
  return <div className={css.scrim} data-face-id-sheet={phase}>
    <div className={css.sheet} role="dialog" aria-modal="true" aria-labelledby="delorun-face-id-title">
      <h2 id="delorun-face-id-title" className={css.title}>{action.title}</h2>
      <p className={css.body}>{action.body}</p>
      {listed.length === 0 ? null : <ul className={css.items}>
        {listed.map(item => <li key={item}>{item}</li>)}
        {rest > 0 ? <li>{t('sheet.more', { count: String(rest) })}</li> : null}
      </ul>}
      <div className={css.glyph} aria-hidden="true"><DelorunBrandMark size={96} /></div>
      {faceOnly ? <p className={css.status} role="status">{t('sheet.faceOnly', { method })}</p> : null}
      {status === undefined ? null : <p className={css.status} role="status">{status}</p>}
      {usable
        ? <Button ref={confirmRef} variant="primary" type="button" className={css.confirm} disabled={phase === 'waiting'}
          onClick={() => { void confirm() }}>{label}</Button>
        : !hasPasskey && onOpenDevices !== undefined
          ? <Button variant="primary" type="button" className={css.confirm} onClick={onOpenDevices}>{t('sheet.openDevices')}</Button>
          : null}
      {showFallback && fallback === 'pin'
        ? <button type="button" className={css.link} data-face-id-fallback="pin" onClick={onFallback}>{t('sheet.usePin')}</button> : null}
      {showFallback && fallback === 'computer' ? <p className={css.status} data-face-id-fallback="computer">{t('sheet.askComputer')}</p> : null}
      <button type="button" className={css.link} onClick={onCancel}>{t('sheet.cancel')}</button>
    </div>
  </div>
}
