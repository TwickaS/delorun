/**
 * The PIN mode settings section. At the home's own computer it shows whether PIN mode is on, turns it on with a PIN or
 * passcode typed twice, changes the idle time and lock-when-hidden (the secret typed again), turns it off and resumes
 * unlocks after a home-wide pause. On a device it shows one read-only line, because a device never sets or changes the
 * PIN. The typed secret lives in this component's state only until the request is sent and is never stored.
 */
import { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { failureSentence, LOOPBACK_REQUIRED, type HostFetch, type Loaded } from './host-api.ts'
import { PIN_MAX_IDLE_MINUTES, readPinMode, resumePin, setPinMode, turnPinOff, type PinMode } from './pin-api.ts'
import { secretProblem } from './pin-rules.ts'
import css from './PinModeSection.module.css'

/** What the plugin supplies. */
export interface PinModeSectionInjected {
  /** Sends the section's same-origin requests: the browser's `fetch`, or a spec's fake. */
  fetch: HostFetch
  /** Whether the page is on the home's own computer. */
  atComputer: () => boolean
}

/** Props the renderer binds for the section. */
export type PinModeSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunPinMode'> & InjectFace<PinModeSectionInjected>

type Translate = PinModeSectionProps['t']

/**
 * The sentence for a failed request.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @returns the localized `LOOPBACK_REQUIRED` sentence, the Host's own sentence for another refusal, or the localized
 *   sentence for an unreachable Host or an unreadable answer.
 */
export function pinModeFailureText(t: Translate, error: unknown): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('loopback') : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * Render the section.
 * @param props - the copy, the request function and the place check.
 * @returns the section.
 */
export function PinModeSection({ t, fetch, atComputer }: PinModeSectionProps): ReactNode {
  const computer = atComputer()
  const [mode, setMode] = useState<Loaded<PinMode | undefined>>({ kind: 'loading' })
  const refresh = useCallback(async (): Promise<void> => {
    try {
      setMode({ kind: 'ready', value: await readPinMode(fetch) })
    } catch (error) {
      setMode({ kind: 'failed', text: pinModeFailureText(t, error) })
    }
  }, [fetch, t])
  useEffect(() => { if (computer) void refresh() }, [computer, refresh])
  return <div className={css.section} data-pin-mode-section>
    <h2 className={css.heading}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    {!computer
      ? <p className={css.line} data-pin-mode-away>{t('atComputer')}</p>
      : mode.kind === 'loading'
        ? <p className={css.line}>{t('loading')}</p>
        : mode.kind === 'failed'
          ? <p className={css.failed} role="alert">{mode.text}</p>
          : mode.value === undefined
            ? <p className={css.line}>{t('unavailable')}</p>
            : <Controls t={t} fetch={fetch} mode={mode.value} onChanged={refresh} />}
  </div>
}

/**
 * The state and its controls.
 * @param props - the copy, the request function, the mode and what runs after a change.
 * @returns the controls.
 */
function Controls({ t, fetch, mode, onChanged }: { t: Translate; fetch: HostFetch; mode: PinMode; onChanged: () => Promise<void> }): ReactNode {
  const id = useId()
  const [secret, setSecret] = useState('')
  const [again, setAgain] = useState('')
  const [idle, setIdle] = useState(String(mode.idleMinutes))
  const [hidden, setHidden] = useState(mode.lockWhenHidden)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | undefined>()

  const run = async (action: () => Promise<void>): Promise<void> => {
    setProblem(undefined)
    setBusy(true)
    try {
      await action()
    } catch (error) {
      setProblem(pinModeFailureText(t, error))
      return
    } finally {
      setBusy(false)
    }
    await onChanged()
  }

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const minutes = Number(idle)
    const weak = secretProblem(secret)
    if (weak !== undefined) return setProblem(t(`problem.${weak}`))
    if (secret !== again) return setProblem(t('problem.mismatch'))
    if (!/^[0-9]+$/.test(idle) || minutes < 1 || minutes > PIN_MAX_IDLE_MINUTES) return setProblem(t('problem.idle'))
    const typed = secret
    // The secret leaves this component's state before the request, whatever the answer.
    setSecret('')
    setAgain('')
    void run(() => setPinMode(fetch, { secret: typed, idleMinutes: minutes, lockWhenHidden: hidden }))
  }

  return <>
    <p className={css.state} data-pin-mode-state={mode.enabled ? 'on' : 'off'}>
      {t(mode.enabled ? (mode.kind === 'passcode' ? 'state.passcode' : 'state.pin') : 'state.off')}
    </p>
    {mode.enabled ? <p className={css.line}>{t('state.settings', { minutes: String(mode.idleMinutes) })}{mode.lockWhenHidden ? ` ${t('state.hidden')}` : ''}</p> : null}
    {mode.paused ? <p className={css.failed} role="status">{t('paused')}</p> : null}
    {mode.paused ? <div className={css.actions}>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(() => resumePin(fetch)) }}>{t('resume')}</Button>
    </div> : null}
    <form className={css.form} onSubmit={submit} noValidate>
      {mode.enabled ? <p className={css.hint}>{t('change.hint')}</p> : null}
      <label className={css.label} htmlFor={`${id}-secret`}>{t('secret.label')}</label>
      <Input id={`${id}-secret`} className={css.field ?? ''} type="password" inputMode="text" autoComplete="new-password"
        autoCapitalize="off" spellCheck={false} value={secret} disabled={busy}
        onChange={(event) => { setSecret(event.target.value) }} />
      <label className={css.label} htmlFor={`${id}-again`}>{t('secret.confirm')}</label>
      <Input id={`${id}-again`} className={css.field ?? ''} type="password" inputMode="text" autoComplete="new-password"
        autoCapitalize="off" spellCheck={false} value={again} disabled={busy}
        onChange={(event) => { setAgain(event.target.value) }} />
      <p className={css.hint}>{t('secret.hint')}</p>
      <label className={css.label} htmlFor={`${id}-idle`}>{t('idle.label')}</label>
      <Input id={`${id}-idle`} className={css.field ?? ''} type="text" inputMode="numeric" autoComplete="off"
        value={idle} disabled={busy} onChange={(event) => { setIdle(event.target.value) }} />
      <p className={css.hint}>{t('idle.hint')}</p>
      <div className={css.check}>
        <span>{t('hidden.label')}</span>
        <Switch checked={hidden} label={t('hidden.label')} disabled={busy} onChange={setHidden} />
      </div>
      {problem === undefined ? null : <p className={css.failed} role="alert">{problem}</p>}
      <div className={css.actions}>
        <Button type="submit" variant="primary" size="sm" disabled={busy}>{t(mode.enabled ? 'change' : 'on')}</Button>
        {mode.enabled ? <Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(() => turnPinOff(fetch)) }}>{t('off')}</Button> : null}
      </div>
    </form>
  </>
}
