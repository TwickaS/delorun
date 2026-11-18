/**
 * PIN mode: two large cards choose between setting a PIN and not now; a PIN then opens a setup view with segmented
 * digits (or a passcode field), live checks, a confirm entry and how the secret is stored. A paired phone unlocks
 * sensitive actions with it instead of a code from this computer. The step exists only at the home's own computer with phone access on. The typed secret lives in
 * this component's state until it is sent and is cleared whatever the answer; it is never stored or logged.
 */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { CodeCells, TextField } from '@delorun/brand'
import { failureSentence, LOOPBACK_REQUIRED } from '@delorun/bundle-local/host-api'
import { readPinMode, setPinMode, type PinMode } from '@delorun/bundle-local/pin-api'
import { secretPairProblem, secretProblem } from '@delorun/bundle-local/pin-rules'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, KeyboardEvent, ReactNode } from 'react'
import type { StepServices } from '../types.ts'
import { StateLine } from '../ui/StateLine.tsx'
import type { StepProps } from './shared.ts'
import css from './steps.module.css'
import pinCss from './pin.module.css'

/** The fewest digits of a PIN, which is how many cells the entry always shows. */
const MIN_PIN_DIGITS = 6

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

/** Which view of the step shows: the two cards, or the entry. */
type Phase = 'choose' | 'setup'

/** What a card chooses. */
type Choice = 'set' | 'later'

/** One of the two choice cards: its key prefix and whether it carries the recommended mark. */
const CARDS: readonly { readonly id: Choice; readonly recommended: boolean }[] = [
  { id: 'set', recommended: true },
  { id: 'later', recommended: false },
]

/**
 * The picture on a card: a phone with a lock for setting a PIN, a computer for not now.
 * @param props - which card.
 * @returns a decorative drawing in the current colour.
 */
function CardArt({ id }: { readonly id: Choice }): ReactNode {
  return (
    <svg className={pinCss.art} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {id === 'set' ? (
        <>
          <rect x="13" y="5" width="22" height="38" rx="5" />
          <path d="M21 9h6" />
          <rect x="19" y="23" width="10" height="8" rx="2" />
          <path d="M21 23v-2.5a3 3 0 0 1 6 0V23" />
        </>
      ) : (
        <>
          <rect x="7" y="9" width="34" height="23" rx="3" />
          <path d="M16 40h16M24 32v8" />
        </>
      )}
    </svg>
  )
}

/**
 * The two choice cards as one radio group: arrow keys move the choice, and one card is in the tab order.
 * @param props - the copy, the choice and its setter.
 * @returns the group.
 */
function Choices({ t, choice, onChoice }: { readonly t: StepServices['t']; readonly choice: Choice; readonly onChoice: (next: Choice) => void }): ReactNode {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const move = (event: KeyboardEvent, from: number): void => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const to = (from + step + CARDS.length) % CARDS.length
    onChoice(CARDS[to]?.id ?? 'set')
    refs.current[to]?.focus()
  }
  return (
    <div className={pinCss.cards} role="radiogroup" aria-label={t('pin.choice.label')}>
      {CARDS.map(({ id, recommended }, index) => (
        <button key={id} type="button" role="radio" aria-checked={choice === id} tabIndex={choice === id ? 0 : -1}
          ref={(element) => { refs.current[index] = element }} className={pinCss.card} data-checked={choice === id ? '' : undefined}
          onClick={() => { onChoice(id) }} onKeyDown={(event) => { move(event, index) }}>
          <span className={pinCss.cardTop}>
            <CardArt id={id} />
            {recommended && <span className={pinCss.badge}>{t('pin.choice.recommended')}</span>}
          </span>
          <span className={pinCss.cardTitle}>{t(`pin.choice.${id}.title`)}</span>
          <span className={pinCss.promise}>{t(`pin.choice.${id}.promise`)}</span>
          <span className={pinCss.bullets}>
            {[1, 2, 3].map(number => <span key={number} className={pinCss.bullet}>{t(`pin.choice.${id}.${number as 1 | 2 | 3}`)}</span>)}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The live checks: each is a quiet tick or ring beside its words, with the state also in text for assistive technology.
 * @param props - the copy and the checks.
 * @returns the list.
 */
function Checks({ t, items }: { readonly t: StepServices['t']; readonly items: readonly { readonly text: string; readonly met: boolean }[] }): ReactNode {
  return (
    <ul className={pinCss.checks} aria-label={t('pin.checks.label')}>
      {items.map(item => (
        <li key={item.text} className={pinCss.check} data-met={item.met ? '' : undefined}>
          <svg className={pinCss.tick} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" />
            {item.met && <path d="M5.25 8.25l2 2 3.5-4" />}
          </svg>
          <span>{item.text}</span>
          <span className={css.visuallyHidden}>{item.met ? t('pin.check.met') : t('pin.check.unmet')}</span>
        </li>
      ))}
    </ul>
  )
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
  const [passcode, setPasscode] = useState(false)
  const [phase, setPhase] = useState<Phase>('choose')
  const [choice, setChoice] = useState<Choice>('set')
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

  const enabled = mode?.enabled === true || done !== undefined
  const kind = done ?? mode?.kind

  // Continue on the cards either leaves PIN mode off or opens the entry and holds; on the entry it sets the PIN, so a
  // typed PIN is never dropped by moving on.
  const latest = useRef({ submit, phase, choice })
  latest.current = { submit, phase, choice }
  const gated = mode !== undefined && !enabled
  useEffect(() => {
    guide.setGate('pin', gated ? async () => {
      const now = latest.current
      if (now.phase === 'setup') return now.submit()
      if (now.choice === 'later') return true
      setPhase('setup')
      return false
    } : undefined)
    return () => { guide.setGate('pin', undefined) }
  }, [guide, gated])

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault()
    void submit()
  }
  const switchKind = (): void => {
    setPasscode(!passcode)
    setSecret('')
    setAgain('')
    setProblem(undefined)
  }
  const back = (): void => {
    setPhase('choose')
    setSecret('')
    setAgain('')
    setProblem(undefined)
  }

  const shape = secretProblem(secret)
  const lengthMet = passcode ? [...secret].length >= 10 : [...secret].length >= 6
  const shapeMet = lengthMet && shape !== 'pinWeak' && shape !== 'passcodeRepeat'
  const checks = [
    { text: t(passcode ? 'pin.check.pass.length' : 'pin.check.pin.length'), met: lengthMet },
    { text: t(passcode ? 'pin.check.pass.shape' : 'pin.check.pin.shape'), met: shapeMet },
    { text: t('pin.check.match'), met: secret !== '' && secret === again },
  ]
  const invalid = problem !== undefined
  // An entry that changed answers the last refusal, so a stale sentence never sits beside a valid pair.
  const editSecret = (next: string): void => { setSecret(next); setProblem(undefined) }
  const editAgain = (next: string): void => { setAgain(next); setProblem(undefined) }

  return (
    <div className={`${css.stack} ${pinCss.root}`}>
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
      {mode !== undefined && !enabled && phase === 'choose' && (
        <>
          <p className={css.lead}>{t('pin.lead')}</p>
          <Choices t={t} choice={choice} onChoice={setChoice} />
          <p className={`${css.hint} ${pinCss.note}`}>{t('pin.here')}</p>
        </>
      )}
      {mode !== undefined && !enabled && phase === 'setup' && (
        <form className={pinCss.setup} onSubmit={onSubmit} noValidate>
          <div className={pinCss.setupHead}>
            <h3 className={pinCss.setupTitle}>{t('pin.setup.title')}</h3>
            <p className={css.lead}>{t('pin.setup.lead')}</p>
          </div>
          <div className={pinCss.setupBody}>
            <div className={pinCss.entries}>
              {passcode ? (
                <>
                  <TextField type="password" inputMode="text" autoComplete="new-password" autoCapitalize="off" spellCheck={false} disabled={busy}
                    label={t('pin.setup.passLabel')} value={secret} onChange={(event) => { editSecret(event.target.value) }} />
                  <TextField type="password" inputMode="text" autoComplete="new-password" autoCapitalize="off" spellCheck={false} disabled={busy}
                    label={t('pin.setup.confirm')} error={problem} value={again} onChange={(event) => { editAgain(event.target.value) }} />
                </>
              ) : (
                <>
                  <CodeCells showLabel label={t('pin.setup.pinLabel')} length={MIN_PIN_DIGITS} open mask value={secret} onChange={editSecret} disabled={busy} autoComplete="new-password" />
                  <CodeCells showLabel label={t('pin.setup.confirm')} length={MIN_PIN_DIGITS} open mask value={again} onChange={editAgain} disabled={busy} error={invalid} autoComplete="new-password" />
                  {problem !== undefined && <p className={pinCss.problem} role="alert">{problem}</p>}
                </>
              )}
              <Checks t={t} items={checks} />
              <div className={pinCss.actions}>
                <button type="button" className={pinCss.textAction} onClick={switchKind}>{t(passcode ? 'pin.setup.usePin' : 'pin.setup.usePasscode')}</button>
                <button type="button" className={pinCss.textAction} onClick={back}>{t('pin.setup.back')}</button>
              </div>
            </div>
            <aside className={pinCss.stored} aria-labelledby="pin-stored">
              <h4 className={pinCss.storedTitle} id="pin-stored">{t('pin.stored.title')}</h4>
              <ul className={pinCss.storedList}>
                {([1, 2, 3] as const).map(number => <li key={number}>{t(`pin.stored.${number}`)}</li>)}
              </ul>
              <p className={pinCss.storedNote}>{t('pin.here')}</p>
            </aside>
          </div>
        </form>
      )}
    </div>
  )
}
