/**
 * The remote studio's unlock surfaces in one `shell.overlay` entry, so they outlive the surface whose call was refused:
 * the dialog that asks the computer for an unlock and shows the code to type there, the banner while sensitive actions
 * are unlocked, and the notice that they are locked again. Each reads the store of [`./unlock.ts`](./unlock.ts).
 */
import { useEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { Button, IconShieldOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { UnlockOutcome, UnlockSource, UnlockView } from './unlock.ts'
import css from './Unlock.module.css'

/** The command that answers a request to unlock at the computer. */
export const ELEVATE_COMMAND = 'delorun devices elevate'

/** Props of the `shell.overlay` entry: the store's view, its actions and the Devices copy. */
export type UnlockOverlayProps = PropsLocale<'delorunDevices'> & InjectFace<Pick<UnlockSource, 'hooks' | 'request' | 'cancel' | 'lock' | 'dismissEnded'>>

type Translate = UnlockOverlayProps['t']

/**
 * A time of day as the unlock copy names it, in the copy's locale.
 * @param t - the Devices copy, whose `time.locale` names the locale.
 * @param at - milliseconds since the epoch.
 * @returns the hours and minutes.
 */
export function clockTime(t: Translate, at: number): string {
  return new Intl.DateTimeFormat(t('time.locale'), { hour: '2-digit', minute: '2-digit' }).format(new Date(at))
}

/**
 * The code as the dialog shows it: two groups of four digits, which the computer accepts with or without the space.
 * @param code - the eight digits.
 * @returns the grouped code.
 */
export function groupedCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`
}

/** The sentence of each outcome. */
const OUTCOME_KEYS = {
  expired: 'unlock.expired',
  declined: 'unlock.declined',
  unreachable: 'unlock.unreachable',
  limit: 'unlock.limit',
  failed: 'unlock.failed',
} as const satisfies Record<UnlockOutcome, string>

/**
 * Render the dialog, the banner and the locked-again notice for the store's view.
 * @param props - the store's view and actions, and the copy.
 * @returns the surfaces that show, or nothing.
 */
export function UnlockOverlay({ useUnlock, request, cancel, lock, dismissEnded, t }: UnlockOverlayProps): ReactNode {
  const view = useUnlock(current => current)
  return <>
    {view.dialog === null ? null : <UnlockDialogView t={t} view={view} request={request} cancel={cancel} />}
    {view.state.kind === 'elevated'
      ? <div className={css.banner} role="status" aria-live="polite" data-unlock="elevated">
        <IconShieldOutlineRegular aria-hidden="true" />
        {/* A failed Lock now takes the end time's place, so the banner fits a phone's width. */}
        {view.lockFailed
          ? <span className={`${css.bannerText} ${css.bannerFailed}`} role="alert">{t('unlock.lockFailed')}</span>
          : <span className={css.bannerText}>{t('unlock.banner', { time: clockTime(t, view.state.endsAt) })}</span>}
        <span aria-hidden="true">·</span>
        <button type="button" className={css.bannerAction} onClick={() => { void lock() }}>{t('unlock.lockNow')}</button>
      </div>
      : null}
    {view.ended === 0 || view.state.kind === 'elevated'
      ? null
      : <Toast key={view.ended} text={t('unlock.ended')} icon={<IconShieldOutlineRegular />} onDone={dismissEnded} />}
  </>
}

/**
 * The dialog: why it opened, then the code and the wait, then an outcome with Try again.
 * @param props - the copy, the store's view and its request and cancel actions.
 * @returns the dialog.
 */
function UnlockDialogView({ t, view, request, cancel }: {
  t: Translate
  view: UnlockView
  request: () => Promise<void>
  cancel: () => Promise<void>
}): ReactNode {
  const dialog = view.dialog
  const pending = view.state.kind === 'pending' ? view.state : undefined
  const codeRef = useRef<HTMLParagraphElement>(null)
  // Focus moves to the code once it shows, so a screen reader reads it before the wait.
  useEffect(() => { if (pending !== undefined) codeRef.current?.focus() }, [pending?.requestId])
  /* v8 ignore next -- the overlay renders this view only while the dialog shows. */
  if (dialog === null) return null
  const close = (): void => { if (!dialog.busy) void cancel() }
  const outcome = dialog.outcome
  const waiting = pending !== undefined && outcome !== 'expired' && outcome !== 'declined'
  return <Modal open onClose={close} title={t('unlock.title')} closeLabel={t('unlock.close')}
    footer={waiting
      ? <Button variant="outline" data-modal-autofocus disabled={dialog.busy} onClick={close}>{t('unlock.cancel')}</Button>
      : <>
        <Button variant="outline" disabled={dialog.busy} onClick={close}>{t(outcome === undefined ? 'unlock.notNow' : 'unlock.close')}</Button>
        <Button variant="primary" data-modal-autofocus disabled={dialog.busy} onClick={() => { void request() }}>
          {t(outcome === undefined ? 'unlock.start' : 'unlock.retry')}
        </Button>
      </>}>
    <div className={css.body} data-unlock-dialog={waiting ? 'pending' : outcome ?? 'ask'}>
      {waiting
        ? <>
          <p className={css.text}>{t('unlock.code')}</p>
          <p ref={codeRef} tabIndex={-1} className={css.code} aria-label={pending.code.split('').join(' ')}>{groupedCode(pending.code)}</p>
          <p className={css.text}>{t('unlock.where')} <code className={css.command}>{ELEVATE_COMMAND}</code></p>
          <p className={css.wait} role="status" aria-live="polite">
            {outcome === 'unreachable' ? t('unlock.unreachable') : t('unlock.waiting', { time: clockTime(t, pending.expiresAt) })}
          </p>
        </>
        : <>
          {dialog.action === undefined ? null : <p className={css.lead}>{t('unlock.needed')}</p>}
          <p className={css.text}>{t('unlock.explain')}</p>
          {outcome === undefined ? null : <p className={css.failed} role="alert">{t(OUTCOME_KEYS[outcome])}</p>}
        </>}
    </div>
  </Modal>
}
