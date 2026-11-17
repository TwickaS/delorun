/**
 * PIN mode: choose a PIN or passcode, typed twice, so a paired phone unlocks sensitive actions with it instead of a code
 * from this computer. The step exists only at the home's own computer with phone access on. The typed secret lives in
 * this component's state until it is sent and is cleared whatever the answer; it is never stored or logged.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SecretPair } from '@delorun/brand'
import { failureSentence, LOOPBACK_REQUIRED } from '@delorun/bundle-local/host-api'
import { readPinMode, setPinMode, type PinMode } from '@delorun/bundle-local/pin-api'
import { secretPairProblem } from '@delorun/bundle-local/pin-rules'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { StepServices } from '../types.ts'
import { StateLine } from '../ui/StateLine.tsx'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'
import pinCss from './pin.module.css'

/** Where the read of PIN mode stands. */
type Reading = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly mode: PinMode | undefined } | { readonly kind: 'failed'; readonly text: string }

/**
 * The sentence for a failed request.
 * @param t - this plugin's copy.
 * @param error - the caught error.
 * @returns the localized sentence for a refusal away from the computer, an unreachable home or an unreadable answer, or the home's own sentence for another refusal.
 */
function failureText(t: StepServices['t'], error: unknown): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('pin.loopback') : message,
    unreachable: t('pin.unreachable'),
    unreadable: t('pin.unreadable'),
  })
}

/**
 * The PIN step.
 * @param props - the services and the guide.
 * @returns the step body.
 */
export function PinStep({ services, guide }: StepProps): ReactNode {
  const { t, pin } = services
  const [reading, setReading] = useState<Reading>({ kind: 'loading' })
  const [secret, setSecret] = useState('')
  const [again, setAgain] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>()
  const [done, setDone] = useState<'pin' | 'passcode' | undefined>()

  const read = useCallback(async (): Promise<void> => {
    try {
      setReading({ kind: 'ready', mode: await readPinMode(pin.fetch) })
    } catch (error) {
      setReading({ kind: 'failed', text: failureText(t, error) })
    }
  }, [pin, t])
  useEffect(() => { void read() }, [read])

  const mode = reading.kind === 'ready' ? reading.mode : undefined

  /** Check, send and forget the secret. Resolves whether the PIN is now set. */
  const submit = useCallback(async (): Promise<boolean> => {
    if (mode === undefined) return true
    const wrong = secretPairProblem(secret, again)
    if (wrong !== undefined) {
      setProblem(t(`pin.problem.${wrong}`))
      return false
    }
    const typed = secret
    setProblem(undefined)
    setBusy(true)
    // The typed text leaves state before the request, so no answer path keeps it.
    setSecret('')
    setAgain('')
    try {
      await setPinMode(pin.fetch, { secret: typed, idleMinutes: mode.idleMinutes, lockWhenHidden: mode.lockWhenHidden })
    } catch (error) {
      setProblem(failureText(t, error))
      return false
    } finally {
      setBusy(false)
    }
    setDone(/^[0-9]+$/.test(typed) ? 'pin' : 'passcode')
    return true
  }, [mode, secret, again, pin, t])

  // Continue with something typed and not yet set sets it, so a typed PIN is never dropped by moving on.
  const latest = useRef(submit)
  latest.current = submit
  const pending = secret !== '' || again !== ''
  useEffect(() => {
    guide.setGate('pin', pending ? () => latest.current() : undefined)
    return () => { guide.setGate('pin', undefined) }
  }, [guide, pending])

  const enabled = mode?.enabled === true || done !== undefined
  const kind = done ?? mode?.kind
  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    void submit()
  }

  return (
    <div className={`${css.stack} ${pinCss.root}`}>
      <p className={css.lead}>{t('pin.lead')}</p>
      <p className={`${css.hint} ${pinCss.note}`}>{t('pin.here')}</p>
      <div className={pinCss.live} aria-live="polite">
        {reading.kind === 'loading' && <p className={css.status}>{t('pin.reading')}</p>}
        {reading.kind === 'failed' && <StateLine tone="error" action={{ label: t('pin.retry'), onClick: () => { setReading({ kind: 'loading' }); void read() } }}>{reading.text}</StateLine>}
        {reading.kind === 'ready' && mode === undefined && <p className={css.status} data-tone="attention">{t('pin.unavailable')}</p>}
      </div>
      {mode !== undefined && enabled && (
        <div className={pinCss.on}>
          <StateLine tone="success"><strong>{t('pin.on')}</strong>. <span>{kind === undefined ? '' : t(kind === 'pin' ? 'pin.on.pin' : 'pin.on.passcode')}</span></StateLine>
          <Button variant="outline" size="sm" className={pinCss.link} onClick={pin.openSettings}>{t('pin.changeInSettings')}</Button>
        </div>
      )}
      {mode !== undefined && !enabled && (
        <form className={pinCss.form} onSubmit={onSubmit} noValidate>
          <SecretPair label={t('pin.label')} confirmLabel={t('pin.confirm')} help={t('pin.help')} error={problem}
            secret={secret} again={again} disabled={busy} onSecret={setSecret} onAgain={setAgain} />
          <p className={`${css.hint} ${pinCss.note}`}>{t('pin.skipNote')}</p>
        </form>
      )}
    </div>
  )
}
