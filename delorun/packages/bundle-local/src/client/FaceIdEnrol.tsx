/**
 * Enrolment screens: the pairing step that sets up Face ID straight after the computer's Pair tap (B1), "Add Face ID"
 * on an already paired device, which shows the code to type at the computer, and the computer's own code entry. Each
 * browser call sits in the tap's handler. The code is plain digits, never the shared `CodeCells` entry, which stays on the PIN
 * path.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PasskeyBrowser } from './face-id-browser.ts'
import type { FaceIdKind, PasskeyApi } from './face-id-types.ts'
import css from './FaceId.module.css'

type Translate = PropsLocale<'delorunFaceId'>['t']

/** How often a phone showing a code asks whether the computer accepted it. */
export const CODE_POLL_MS = 2000

/** Props of the pairing step. */
export interface FaceIdPairingStepProps {
  readonly t: Translate
  readonly kind: FaceIdKind
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  /** The enrol ticket the computer's Pair tap minted. */
  readonly ticket: string
  /** Face ID is set up. */
  readonly onDone: () => void
  /** The person skipped, or failed twice: the device stays paired without a passkey. */
  readonly onSkip: () => void
}

/**
 * The pairing step (B1 step 2): one large button, a Skip link, and a retry after a failure.
 * @param props - see {@link FaceIdPairingStepProps}.
 * @returns the step.
 */
export function FaceIdPairingStep({ t, kind, api, browser, ticket, onDone, onSkip }: FaceIdPairingStepProps): ReactNode {
  const [busy, setBusy] = useState(false)
  const [failures, setFailures] = useState(0)
  const alive = useRef(true)
  const method = t(`kind.${kind}`)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const setUp = useCallback(async (): Promise<void> => {
    setBusy(true)
    const fail = (): void => { if (alive.current) { setBusy(false); setFailures(count => count + 1) } }
    let challenge: Awaited<ReturnType<PasskeyApi['registrationOptions']>>
    try {
      challenge = await api.registrationOptions({ ticket })
    } catch {
      fail()
      return
    }
    const created = await browser.create(challenge.options)
    if (!alive.current) return
    if (created.kind !== 'ok') { fail(); return }
    try {
      await api.register({ challengeId: challenge.challengeId, response: created.value })
    } catch {
      fail()
      return
    }
    if (alive.current) onDone()
  }, [api, browser, ticket, onDone])
  const gaveUp = failures >= 2
  return <div className={css.page} data-face-id-step={gaveUp ? 'gave-up' : failures === 1 ? 'retry' : 'ask'}>
    <h1 className={css.title}>{t('pair.title', { method })}</h1>
    <p className={css.body}>{t('pair.body', { method })}</p>
    <p className={css.warn}>{t('pair.protection')}</p>
    {failures === 1 ? <p className={css.status} role="alert">{t('pair.failed', { method })}</p> : null}
    {gaveUp ? <p className={css.status} role="alert">{t('pair.later')}</p> : null}
    {gaveUp
      ? <Button variant="primary" type="button" className={css.confirm} onClick={onSkip}>{t('pair.continue')}</Button>
      : <Button variant="primary" type="button" className={css.confirm} disabled={busy} onClick={() => { void setUp() }}>
        {t(busy ? 'pair.waiting' : failures === 1 ? 'pair.retry' : 'pair.setUp', { method })}
      </Button>}
    {gaveUp ? null : <button type="button" className={css.link} onClick={onSkip}>{t('pair.skip')}</button>}
  </div>
}

/** Props of "Add Face ID" on a paired device. */
export interface AddFaceIdProps {
  readonly t: Translate
  readonly kind: FaceIdKind
  readonly api: PasskeyApi
  readonly browser: PasskeyBrowser
  readonly onDone: () => void
  readonly onCancel: () => void
}

/**
 * "Add Face ID" on a paired device (B4): the tap creates the passkey, then the screen shows the code to type at the computer.
 * @param props - see {@link AddFaceIdProps}.
 * @returns the screen.
 */
export function AddFaceId({ t, kind, api, browser, onDone, onCancel }: AddFaceIdProps): ReactNode {
  const [state, setState] = useState<{ readonly kind: 'ask' } | { readonly kind: 'busy' } | { readonly kind: 'failed' } | { readonly kind: 'code'; readonly code: string } | { readonly kind: 'refused' }>({ kind: 'ask' })
  const alive = useRef(true)
  const method = t(`kind.${kind}`)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  const start = useCallback(async (): Promise<void> => {
    setState({ kind: 'busy' })
    const fail = (): void => { if (alive.current) setState({ kind: 'failed' }) }
    let challenge: Awaited<ReturnType<PasskeyApi['registrationOptions']>>
    try {
      challenge = await api.registrationOptions({})
    } catch {
      fail()
      return
    }
    const created = await browser.create(challenge.options)
    if (!alive.current) return
    if (created.kind !== 'ok') { fail(); return }
    try {
      const sent = await api.register({ challengeId: challenge.challengeId, response: created.value })
      if (!alive.current) return
      if (sent.kind === 'done') onDone()
      else setState({ kind: 'code', code: sent.code })
    } catch {
      fail()
    }
  }, [api, browser, onDone])
  const code = state.kind === 'code'
  useEffect(() => {
    if (!code) return undefined
    const timer = setInterval(() => {
      void api.registrationState().then((answer) => {
        if (!alive.current) return
        if (answer === 'done') onDone()
        else if (answer === 'refused') setState({ kind: 'refused' })
      }, () => undefined)
    }, CODE_POLL_MS)
    return () => { clearInterval(timer) }
  }, [code, api, onDone])
  return <div className={css.page} data-face-id-add={state.kind}>
    <h1 className={css.title}>{t('add.title', { method })}</h1>
    {state.kind === 'code'
      ? <>
        <p className={css.body}>{t('add.codeBody')}</p>
        <p className={css.digits} aria-label={t('add.codeLabel')} data-face-id-code>{state.code}</p>
        <p className={css.status} role="status">{t('add.waiting')}</p>
      </>
      : <>
        <p className={css.body}>{t('add.body', { method })}</p>
        <p className={css.warn}>{t('pair.protection')}</p>
        {state.kind === 'failed' ? <p className={css.status} role="alert">{t('pair.failed', { method })}</p> : null}
        {state.kind === 'refused' ? <p className={css.status} role="alert">{t('add.refused')}</p> : null}
        <Button variant="primary" type="button" className={css.confirm} disabled={state.kind === 'busy'} onClick={() => { void start() }}>
          {t(state.kind === 'busy' ? 'pair.waiting' : 'add.start', { method })}
        </Button>
      </>}
    <button type="button" className={css.link} onClick={onCancel}>{t('sheet.cancel')}</button>
  </div>
}

/** Props of the computer's code entry. */
export interface PasskeyCodeEntryProps {
  readonly t: Translate
  readonly api: PasskeyApi
  readonly onDone: () => void
}

/**
 * The computer's side of "Add Face ID": the person types the digits the phone shows.
 * @param props - see {@link PasskeyCodeEntryProps}.
 * @returns the entry.
 */
export function PasskeyCodeEntry({ t, api, onDone }: PasskeyCodeEntryProps): ReactNode {
  const [typed, setTyped] = useState('')
  const [mismatch, setMismatch] = useState(false)
  const [busy, setBusy] = useState(false)
  const digits = typed.replace(/[\s-]/g, '')
  const ready = /^\d{8}$/.test(digits) && !busy
  const submit = async (): Promise<void> => {
    if (!ready) return
    setBusy(true)
    try {
      const { matched } = await api.confirmCode(digits)
      if (matched) onDone()
      else setMismatch(true)
    } catch {
      setMismatch(true)
    } finally {
      setBusy(false)
    }
  }
  return <form className={css.card} onSubmit={(event) => { event.preventDefault(); void submit() }} data-face-id-code-entry>
    <h3 className={css.cardTitle}>{t('code.title')}</h3>
    <p className={css.meta}>{t('code.body')}</p>
    <input className={css.field} type="text" inputMode="numeric" autoComplete="off" aria-label={t('code.label')} value={typed}
      aria-invalid={mismatch ? true : undefined} onChange={(event) => { setTyped(event.target.value); setMismatch(false) }} />
    {mismatch ? <p className={css.failed} role="alert">{t('code.mismatch')}</p> : null}
    <Button variant="primary" type="submit" className={css.action} disabled={!ready}>{t('code.confirm')}</Button>
  </form>
}
