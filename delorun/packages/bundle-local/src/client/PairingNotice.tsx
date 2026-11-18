/**
 * The notice and the code box for a device that asks to connect without an approval window (contract C5, "Pop-up
 * pairing"), in `shell.overlay`. At the home's own computer a request that arrived outside a window shows "A device asks
 * to connect" with Enter code and Decline; Enter code opens a box with one field for the 8 digits the device shows,
 * which submits itself at the eighth digit. The notice never takes keyboard focus. With `showRequest: dialog` the box opens
 * by itself, but only while no field is being typed in; otherwise the notice shows and the box opens at the next read.
 * With `showRequest: none` nothing shows here and the request is listed in Settings → Devices. A remote studio never
 * receives requests, so it shows nothing.
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, IconWarningOutlineRegular, Modal, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodeCells } from '@delorun/brand'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { PAIRING_WRONG_CODES } from '@delorun/home-auth/wire'
import type { PendingDevice } from './devices-api.ts'
import type { PairingSource } from './pairing-source.ts'
import { codeDigits } from './pairing-source.ts'
import { failureSentence } from './host-api.ts'
import css from './PairingNotice.module.css'

/** Full-opacity hold of the notice: a sentence and two actions to read. */
const NOTICE_HOLD_MS = 20000

/** The digits of a pairing code. */
const CODE_LENGTH = 8

/** The error code of a wrong match code. */
const CODE_MISMATCH = 'APPROVAL_CODE_MISMATCH'

/** What the plugin supplies the entry: the store and its actions. */
export type PairingNoticeInjected = PairingSource

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
 * Render the notice and the code box.
 * @param props - the store, its actions and the copy.
 * @returns the notice, the box, the outcome of the last answer, or nothing.
 */
export function PairingNotice({ usePairing, start, openCode, closeCode, quiet, decline, approve, t }: PairingNoticeProps): ReactNode {
  const pairing = usePairing(current => current)
  const [done, setDone] = useState<{ readonly seq: number; readonly text: string; readonly failed: boolean } | undefined>()
  const autoOpened = useRef(new Set<string>())
  useEffect(() => start(), [start])

  const mode = pairing.view?.showRequest
  const waiting = pairing.place === 'computer' && mode !== 'none' ? pairing.requests : []
  const next = waiting.find(request => !autoOpened.current.has(request.requestId))
  useEffect(() => {
    if (mode !== 'dialog' || pairing.open !== undefined || next === undefined || isTypingIn(globalThis.document.activeElement)) return
    autoOpened.current.add(next.requestId)
    openCode(next.requestId)
  }, [mode, pairing.open, next, openCode, pairing.requests])

  const report = (text: string, failed: boolean): void => { setDone(current => ({ seq: (current?.seq ?? 0) + 1, text, failed })) }
  const open = waiting.find(request => request.requestId === pairing.open)
  const notice = waiting.find(request => !pairing.quieted.includes(request.requestId))
  const declineRequest = async (request: PendingDevice): Promise<void> => {
    closeCode()
    const outcome = await decline(request.requestId)
    if (outcome.kind === 'done') report(t('pairing.declined', { label: request.label }), false)
    else report(failureSentence(outcome.failure, { refused: (_code, message) => message, unreachable: t('failed.unreachable'), unreadable: t('failed.unreadable') }), true)
  }
  const outcomeToast = done === undefined ? null
    : done.failed
      ? <Toast key={done.seq} text={done.text} icon={<IconWarningOutlineRegular />} onDone={() => { setDone(undefined) }} />
      : <Toast key={done.seq} text={done.text} tone="success" onDone={() => { setDone(undefined) }} />
  return <>
    {open === undefined ? null : <CodeBox key={open.requestId} t={t} request={open}
      onClose={closeCode} onDecline={() => declineRequest(open)}
      onApprove={async (typed) => {
        const outcome = await approve(open.requestId, typed)
        if (outcome.kind === 'done') {
          closeCode()
          report(t('pairing.connected', { label: open.label }), false)
          return undefined
        }
        const sentence = failureSentence(outcome.failure, { refused: (_code, message) => message, unreachable: t('failed.unreachable'), unreadable: t('failed.unreadable') })
        if (!outcome.gone) return sentence
        closeCode()
        report(outcome.failure.kind === 'refused' && outcome.failure.code === CODE_MISMATCH ? t('pairing.box.cancelled') : sentence, true)
        return undefined
      }} />}
    {open !== undefined || notice === undefined ? null
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
 * The box that takes the 8 digits one device shows.
 * @param props - the copy, the request, and the close, decline and approve actions; approve answers a sentence when the
 *   code was refused and the request still waits.
 * @returns the dialog.
 */
export function CodeBox({ t, request, onClose, onDecline, onApprove }: {
  readonly t: Translate
  readonly request: PendingDevice
  readonly onClose: () => void
  readonly onDecline: () => Promise<void>
  readonly onApprove: (typed: string) => Promise<string | undefined>
}): ReactNode {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const submit = async (digits: string): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    const sentence = await onApprove(digits)
    setBusy(false)
    if (sentence !== undefined) { setFailure(sentence); setTyped('') }
  }
  const change = (value: string): void => {
    const digits = codeDigits(value).replace(/\D/g, '').slice(0, CODE_LENGTH)
    setTyped(digits)
    if (digits.length === CODE_LENGTH && !busy) void submit(digits)
  }
  return <Modal open onClose={onClose} title={t('pairing.box.title')} closeLabel={t('pairing.box.close')}
    footer={<Button variant="outline" disabled={busy} onClick={() => { void onDecline() }}>{t('pairing.box.decline')}</Button>}>
    <p className={css.who}>{t('pairing.box.user', { user: userOf(t, request) })}</p>
    <p className={css.device}>{t('pairing.box.device', { label: request.label, platform: request.platform })}</p>
    <p className={css.explain}>{t('pairing.box.explain', { label: request.label })}</p>
    <CodeCells label={t('pairing.box.code')} length={CODE_LENGTH} value={typed} onChange={change} autoComplete="one-time-code" disabled={busy}
      inputProps={{ 'data-modal-autofocus': true }} />
    {busy ? <p className={css.line} role="status">{t('pairing.box.checking')}</p> : null}
    {request.wrongCodes > 0
      ? <p className={css.failed} role="alert">{t('pairing.box.wrong', { count: String(request.wrongCodes), max: String(PAIRING_WRONG_CODES) })}</p>
      : null}
    {failure === undefined || request.wrongCodes > 0 ? null : <p className={css.failed} role="alert">{failure}</p>}
  </Modal>
}
