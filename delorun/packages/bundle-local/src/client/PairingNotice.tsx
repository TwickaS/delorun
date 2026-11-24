/**
 * The pop-up and the notice for a device that asks to pair without an approval window (contract C5, "Pop-up pairing"),
 * in `shell.overlay`. At the home's own computer a request opens a dialog titled "A device wants to pair": the device's
 * details and how long the request has left, one field for the 8 digits the device shows, and a footer with "Not you
 * making this request?" (which declines it), "Don't show this pop-up again" and Submit. Several waiting requests show one
 * at a time, oldest first, with "1 of 2". Close, Escape and the dimmed page leave every request waiting; they stay listed in
 * Settings → Devices.
 *
 * The pop-up never takes focus from a field being typed in: while one has focus the quiet notice shows instead, with Enter
 * code and Decline, and the pop-up opens once the person moves to Enter code or out of the field. With `showRequest:
 * notice` only the notice shows; with `none` nothing shows here. A remote studio never receives requests, so it shows
 * nothing.
 */
import { useEffect, useRef, useState } from 'react'
import type { ClipboardEvent, FormEvent, ReactNode } from 'react'
import { Checkbox, IconCloseOutlineRegular, IconInfoOutlineRegular, IconWarningOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { ALERT_CLASSES, CodeCells, Dialog } from '@delorun/brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PAIRING_WRONG_CODES } from '@delorun/home-auth/wire'
import type { PendingDevice } from './devices-api.ts'
import type { PairingSource } from './pairing-source.ts'
import { failureSentence } from './host-api.ts'
import css from './PairingNotice.module.css'

/** Full-opacity hold of the notice: a sentence and two actions to read. */
const NOTICE_HOLD_MS = 20000

/** The digits of a pairing code. */
const CODE_LENGTH = 8

/** The error code of a wrong match code. */
const CODE_MISMATCH = 'APPROVAL_CODE_MISMATCH'

/** How often the countdown redraws. */
const TICK_MS = 1000

/** What the plugin supplies the entry: the store, its actions, and the switch behind "Don't show this pop-up again". */
export interface PairingNoticeInjected extends PairingSource {
  /** Write `pairing.showRequest: notice`, so requests show as the quiet notice from now on. @returns whether it was saved. */
  readonly showAsNotice: () => Promise<boolean>
}

/** Props of the `shell.overlay` entry. */
export type PairingNoticeProps = PropsLocale<'delorunDevices'> & InjectFace<PairingNoticeInjected>

type Translate = PairingNoticeProps['t']

/**
 * Whether the keyboard focus is in a field the person may be typing in.
 * @param element - the focused element.
 * @returns true for an input, textarea, select or editable element.
 */
export function isTypingIn(element: Element | null): boolean {
  if (element === null) return false
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return true
  return element instanceof HTMLElement && element.isContentEditable === true
}

/**
 * The Tailscale user a request names, as the notice shows it.
 * @param t - the copy.
 * @param request - the request.
 * @returns the display name, or a sentence that none was named.
 */
export function userOf(t: Translate, request: PendingDevice): string {
  return request.identity?.name ?? t('pairing.unknownUser')
}

/**
 * The digits in a pasted code, without the spaces, hyphens or other marks between its groups.
 * @param text - what was pasted.
 * @returns every digit in it; the pop-up takes the paste only when there are exactly 8.
 */
export function pastedDigits(text: string): string {
  return text.replace(/\D/gu, '')
}

/**
 * Who asked, as the pop-up remembers a requester it was told to stop opening for: the Tailscale login and the address
 * the request came through.
 * @param request - the request.
 * @returns the key.
 */
export function requesterOf(request: PendingDevice): string {
  return JSON.stringify([request.identity?.login ?? null, request.address])
}

/**
 * A time left as minutes and seconds.
 * @param ms - milliseconds left; none below zero.
 * @returns such as `4:05`.
 */
export function timeLeft(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Render the pop-up, the notice and the outcome of the last answer.
 * @param props - the store, its actions and the copy.
 * @returns the pop-up, the notice, the outcome, or nothing.
 */
export function PairingNotice({ usePairing, start, openCode, closeCode, quiet, decline, approve, showAsNotice, t }: PairingNoticeProps): ReactNode {
  const pairing = usePairing(current => current)
  const [done, setDone] = useState<{ readonly seq: number; readonly text: string; readonly failed: boolean } | undefined>()
  const [hideFuture, setHideFuture] = useState(false)
  /** Requests the pop-up opened for by itself, or that the person closed; it does not open for them again. */
  const autoOpened = useRef(new Set<string>())
  /**
   * Requesters (see {@link requesterOf}) the person declined with "Not you" or closed the pop-up on. Their later requests
   * show only as the quiet notice for the rest of this studio session, so asking again cannot bring the pop-up back.
   */
  const turnedAway = useRef(new Set<string>())
  /** Whether the person asked for no more pop-ups here; holds until the home's choice reads `notice`. */
  const hidden = useRef(false)
  /** The request this studio is answering or closing, whose leaving the list needs no sentence. */
  const settling = useRef<string | undefined>(undefined)
  const shown = useRef<PendingDevice | undefined>(undefined)
  useEffect(() => start(), [start])

  const chosen = pairing.view?.showRequest
  if (chosen !== 'dialog') hidden.current = false
  const mode = hidden.current ? 'notice' : chosen
  const waiting = pairing.place === 'computer' && mode !== 'none' ? pairing.requests : []
  const next = waiting.find(request => !autoOpened.current.has(request.requestId) && !turnedAway.current.has(requesterOf(request)))
  useEffect(() => {
    if (mode !== 'dialog' || pairing.open !== undefined || next === undefined || isTypingIn(globalThis.document.activeElement)) return
    autoOpened.current.add(next.requestId)
    openCode(next.requestId)
  }, [mode, pairing.open, next, openCode, pairing.requests])

  const report = (text: string, failed: boolean): void => { setDone(current => ({ seq: (current?.seq ?? 0) + 1, text, failed })) }
  const open = waiting.find(request => request.requestId === pairing.open)
  // A request that leaves the list while its pop-up shows, without an answer from here, expired or was answered elsewhere.
  useEffect(() => {
    const before = shown.current
    shown.current = open
    if (before === undefined || open !== undefined || before.requestId === settling.current) return
    report(t(Date.now() >= before.expiresAt ? 'pairing.box.expiredToast' : 'pairing.box.gone', { label: before.label }), true)
  }, [open, t])
  const notice = open === undefined ? waiting.find(request => !pairing.quieted.includes(request.requestId)) : undefined
  const failed = (failure: Parameters<typeof failureSentence>[0]): string =>
    failureSentence(failure, { refused: (_code, message) => message, unreachable: t('failed.unreachable'), unreadable: t('failed.unreadable') })
  /** Close the pop-up, applying "Don't show this pop-up again" when it is ticked. */
  const closePopUp = (): void => {
    if (hideFuture) {
      hidden.current = true
      setHideFuture(false)
      void showAsNotice().then((saved) => { if (!saved) report(t('pairing.failed'), true) })
    }
    closeCode()
  }
  /** Close, Escape or the dimmed page: every request stays waiting, quietly, in Settings → Devices. */
  const dismiss = (): void => {
    settling.current = pairing.open
    for (const request of waiting) {
      autoOpened.current.add(request.requestId)
      turnedAway.current.add(requesterOf(request))
      quiet(request.requestId)
    }
    closePopUp()
  }
  const declineRequest = async (request: PendingDevice): Promise<void> => {
    settling.current = request.requestId
    turnedAway.current.add(requesterOf(request))
    if (open !== undefined) closePopUp()
    const outcome = await decline(request.requestId)
    if (outcome.kind === 'done') report(t('pairing.declined', { label: request.label }), false)
    else report(failed(outcome.failure), true)
  }
  const outcomeToast = done === undefined ? null
    : done.failed
      ? <Toast key={done.seq} text={done.text} icon={<IconWarningOutlineRegular />} onDone={() => { setDone(undefined) }} />
      : <Toast key={done.seq} text={done.text} tone="success" onDone={() => { setDone(undefined) }} />
  return <>
    {open === undefined ? null : <PairingDialog key={open.requestId} t={t} request={open}
      place={waiting.indexOf(open) + 1} total={waiting.length}
      hide={chosen === 'dialog' ? { checked: hideFuture, onChange: setHideFuture } : undefined}
      onClose={dismiss} onDecline={() => declineRequest(open)}
      onApprove={async (typed) => {
        settling.current = open.requestId
        const outcome = await approve(open.requestId, typed)
        if (outcome.kind === 'done') {
          closePopUp()
          report(t('pairing.connected', { label: open.label }), false)
          return undefined
        }
        if (!outcome.gone) {
          settling.current = undefined
          return failed(outcome.failure)
        }
        closePopUp()
        report(outcome.failure.kind === 'refused' && outcome.failure.code === CODE_MISMATCH ? t('pairing.box.cancelled') : failed(outcome.failure), true)
        return undefined
      }} />}
    {notice === undefined ? null
      : <Toast key={notice.requestId} text={t('pairing.notice', { user: userOf(t, notice), label: notice.label, platform: notice.platform })}
        icon={<IconWarningOutlineRegular />} holdMs={NOTICE_HOLD_MS}
        actions={[
          { label: t('pairing.notice.enter'), prefix: ' ', onClick: () => { openCode(notice.requestId) } },
          { label: t('pairing.notice.decline'), prefix: ' ', onClick: () => { void declineRequest(notice) } },
        ]}
        onDone={() => { quiet(notice.requestId) }} />}
    {outcomeToast}
  </>
}

/**
 * The time now, redrawn every second while mounted.
 * @returns milliseconds since the epoch.
 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const untilNext = (): number => TICK_MS - (Date.now() % TICK_MS)
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      setNow(Date.now())
      timer = setTimeout(tick, untilNext())
    }
    timer = setTimeout(tick, untilNext())
    return () => { clearTimeout(timer) }
  }, [])
  return now
}

/** What {@link PairingDialog} is given. */
export interface PairingDialogProps {
  readonly t: Translate
  readonly request: PendingDevice
  /** The request's place among the waiting ones, 1-based. */
  readonly place: number
  /** How many requests wait; "1 of 2" shows when more than one does. */
  readonly total: number
  /** "Don't show this pop-up again", offered while the home shows requests as the pop-up. */
  readonly hide: { readonly checked: boolean; readonly onChange: (checked: boolean) => void } | undefined
  /** Close, Escape or the dimmed page; the request stays waiting. */
  readonly onClose: () => void
  /** "Not you making this request?", which declines it. */
  readonly onDecline: () => Promise<void>
  /** Submit the code; answers a sentence when the code was refused and the request still waits. */
  readonly onApprove: (typed: string) => Promise<string | undefined>
}

/**
 * The pop-up for one request: its details, the code field, and the footer.
 * @param props - see {@link PairingDialogProps}.
 * @returns the dialog.
 */
export function PairingDialog({ t, request, place, total, hide, onClose, onDecline, onApprove }: PairingDialogProps): ReactNode {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  /** The digit count of a paste that was not taken because it did not hold exactly 8. */
  const [refusedPaste, setRefusedPaste] = useState<number | undefined>()
  const now = useNow()
  const left = request.expiresAt - now
  const expired = left <= 0
  const ready = typed.length === CODE_LENGTH && !busy && !expired
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (!ready) return
    setBusy(true)
    setFailure(undefined)
    const sentence = await onApprove(typed)
    setBusy(false)
    if (sentence !== undefined) { setFailure(sentence); setTyped('') }
  }
  const paste = (event: ClipboardEvent<HTMLDivElement>): void => {
    // The field holds 8 characters, so a browser would cut a grouped code such as `1234 5678` short before reading it.
    event.preventDefault()
    const digits = pastedDigits(event.clipboardData.getData('text'))
    // A paste of any other length is refused whole, so a code cut short or run long never spends one of the 3 tries.
    if (digits.length !== CODE_LENGTH) {
      setRefusedPaste(digits.length)
      return
    }
    setRefusedPaste(undefined)
    setTyped(digits)
  }
  const triesLeft = PAIRING_WRONG_CODES - request.wrongCodes
  const wrong = request.wrongCodes === 0 ? undefined
    : triesLeft === 1 ? t('pairing.box.wrongLast') : t('pairing.box.wrong', { left: String(triesLeft) })
  const title = t('pairing.box.title')
  return <Dialog open headless title={title} onClose={onClose} className={css.dialog as string}>
    <form className={css.frame} onSubmit={(event) => { void submit(event) }} noValidate>
      <header className={css.header}>
        <span className={css.icon} aria-hidden="true"><IconInfoOutlineRegular size={14} /></span>
        <h2 className={`${ALERT_CLASSES.title} ${css.title as string}`}>{title}</h2>
        {total > 1 ? <span className={css.count} data-pairing-count>{t('pairing.box.count', { n: String(place), total: String(total) })}</span> : null}
        <button type="button" className={`${ALERT_CLASSES.close} ${css.close as string}`} aria-label={t('pairing.box.close')} onClick={onClose}>
          <IconCloseOutlineRegular size={12} />
        </button>
      </header>
      <div className={css.body}>
        <section className={css.device} aria-label={t('pairing.box.details')}>
          <p className={css.label}>{request.label}</p>
          {request.platform === '' ? null : <p className={css.platform}>{request.platform}</p>}
          <dl className={css.facts}>
            <div data-fact="user">
              <dt>{t('pairing.box.user')}</dt>
              <dd>
                {request.identity === null ? t('pairing.box.noUser') : request.identity.name}
                {request.identity === null || request.identity.login === request.identity.name ? null : <span className={css.login}>{request.identity.login}</span>}
              </dd>
            </div>
            <div data-fact="address"><dt>{t('pairing.box.address')}</dt><dd>{request.address}</dd></div>
            <div data-fact="asked">
              <dt>{t('pairing.box.asked')}</dt>
              <dd>{new Intl.DateTimeFormat(t('time.locale'), { timeStyle: 'short' }).format(new Date(request.createdAt))}</dd>
            </div>
            <div data-fact="left"><dt>{t('pairing.box.left')}</dt><dd className={css.left} role="timer">{timeLeft(left)}</dd></div>
          </dl>
        </section>
        <p className={css.explain}>{t('pairing.box.explain', { label: request.label })}</p>
        <div onPasteCapture={paste}>
          <CodeCells label={t('pairing.box.code')} showLabel length={CODE_LENGTH} value={typed} onChange={(next) => { setRefusedPaste(undefined); setTyped(next) }} autoComplete="one-time-code"
            disabled={busy || expired} error={wrong !== undefined && typed === ''} shakeKey={request.wrongCodes}
            inputProps={{ 'data-modal-autofocus': true }} />
        </div>
        {busy ? <p className={css.line} role="status">{t('pairing.box.checking')}</p> : null}
        {expired ? <p className={css.failed} role="alert">{t('pairing.box.expired')}</p>
          : refusedPaste !== undefined ? <p className={css.failed} role="alert">{t('pairing.box.pasteLength', { count: String(refusedPaste) })}</p>
          : wrong !== undefined ? <p className={css.failed} role="alert">{wrong}</p>
            : failure === undefined ? null : <p className={css.failed} role="alert">{failure}</p>}
      </div>
      <footer className={css.footer}>
        <div className={css.aside}>
          <button type="button" className={css.notYou} disabled={busy} onClick={() => { void onDecline() }}>{t('pairing.box.notYou')}</button>
          {hide === undefined ? null : <Checkbox className={css.hide} checked={hide.checked} onChange={hide.onChange} label={t('pairing.box.hide')} />}
        </div>
        <div className={`${ALERT_CLASSES.dialogActions} ${css.actions as string}`}>
          <button type="submit" className={`${ALERT_CLASSES.primary} ${css.submit as string}`} disabled={!ready}>{t('pairing.box.submit')}</button>
        </div>
      </footer>
    </form>
  </Dialog>
}
