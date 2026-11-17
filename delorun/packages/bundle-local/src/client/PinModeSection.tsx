/**
 * The PIN mode settings section. At the home's own computer it shows whether PIN mode is on, turns it on with a PIN or
 * passcode typed twice. While it is on, the idle time and lock-when-hidden save without the secret, a separate "Change PIN"
 * disclosure takes a new secret twice, turning off asks one in-place confirmation, and unlocks resume after a home-wide
 * pause. On a device it shows one read-only line, because a device never sets or changes the
 * PIN. The typed secret lives in this component's state only until the request is sent and is never stored.
 */
import { useCallback, useEffect, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, IconChevronDownOutlineRegular, IconPauseOutlineRegular, IconShieldOutlineRegular, IconWarningOutlineRegular, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { failureSentence, LOOPBACK_REQUIRED, type HostFetch, type Loaded } from './host-api.ts'
import { PIN_MAX_IDLE_MINUTES, readPinMode, resumePin, setPinMode, setPinOptions, turnPinOff, type PinMode } from './pin-api.ts'
import { secretPairProblem } from './pin-rules.ts'
import { ConfirmAction, Notice, SecretPair, StatusCard } from '@delorun/brand'
import { cardCss, SettingsCard } from '@delorun/settings-controls'
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

/** The settings rows whose whole namespace is computer-only, by namespace, in words. */
const NAMESPACE_WORDS = { 'delorun-home-auth': 'setBack.name.homeAuth', 'delorun-reach': 'setBack.name.reach' } as const

/**
 * Name a setting waiting to be put back in words.
 * @param t - the section's copy.
 * @param setting - the settings row and field.
 * @returns the phrase for a known row, otherwise the row and field with their separators as spaces.
 */
export function settingWords(t: Translate, setting: { readonly ns: string; readonly field: string }): string {
  const known = (NAMESPACE_WORDS as Record<string, 'setBack.name.homeAuth' | 'setBack.name.reach'>)[setting.ns]
  if (known !== undefined && setting.field === '*') return t(known)
  return `${setting.ns} ${setting.field}`.replace(/[-_.]+/g, ' ')
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
  const [changingPin, setChangingPin] = useState(false)
  const [confirmingOff, setConfirmingOff] = useState(false)

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

  /** The idle minutes typed, or undefined after saying why they are wrong. */
  const idleMinutes = (): number | undefined => {
    const minutes = Number(idle)
    if (!/^[0-9]+$/.test(idle) || minutes < 1 || minutes > PIN_MAX_IDLE_MINUTES) {
      setProblem(t('problem.idle'))
      return undefined
    }
    return minutes
  }

  /** The secret typed twice, or undefined after saying why it is wrong. */
  const checkedSecret = (): string | undefined => {
    const wrong = secretPairProblem(secret, again)
    if (wrong === undefined) return secret
    setProblem(t(`problem.${wrong}`))
    return undefined
  }

  /** Send the secret and forget it, whatever the answer. */
  const sendSecret = (typed: string, minutes: number, lock: boolean): void => {
    setSecret('')
    setAgain('')
    setChangingPin(false)
    void run(() => setPinMode(fetch, { secret: typed, idleMinutes: minutes, lockWhenHidden: lock }))
  }

  const turnOn = (event: FormEvent): void => {
    event.preventDefault()
    const typed = checkedSecret()
    const minutes = idleMinutes()
    if (typed === undefined || minutes === undefined) return
    sendSecret(typed, minutes, hidden)
  }

  const saveOptions = (event: FormEvent): void => {
    event.preventDefault()
    const minutes = idleMinutes()
    if (minutes === undefined) return
    setProblem(undefined)
    void run(() => setPinOptions(fetch, { idleMinutes: minutes, lockWhenHidden: hidden }))
  }

  const changePin = (event: FormEvent): void => {
    event.preventDefault()
    const typed = checkedSecret()
    // A new PIN keeps the saved options, not edits not yet saved.
    if (typed !== undefined) sendSecret(typed, mode.idleMinutes, mode.lockWhenHidden)
  }

  const secretFields = <SecretPair label={t('secret.label')} confirmLabel={t('secret.confirm')} help={t('secret.hint')}
    secret={secret} again={again} disabled={busy} onSecret={setSecret} onAgain={setAgain} />
  const optionFields = <>
    <div className={css.fieldRow}>
      <label className={cardCss.title} htmlFor={`${id}-idle`}>{t('idle.label')}</label>
      <p className={css.hint}>{t('idle.hint')}</p>
      <Input id={`${id}-idle`} className={css.field ?? ''} type="text" inputMode="numeric" autoComplete="off"
        value={idle} disabled={busy} onChange={(event) => { setIdle(event.target.value) }} />
    </div>
    <div className={css.check}>
      <div className={css.checkText}>
        <span className={cardCss.title}>{t('hidden.label')}</span>
        <span className={css.hint}>{t('hidden.hint')}</span>
      </div>
      <Switch checked={hidden} label={t('hidden.label')} disabled={busy} onChange={setHidden} />
    </div>
  </>
  const failure = problem === undefined ? null : <p className={css.failed} role="alert">{problem}</p>
  const waiting = mode.setBackWaiting ?? []

  return <div className={cardCss.stack}>
    <SettingsCard title={t('card.status')} group="pin-status">
      <div className={cardCss.block}>
        <StatusCard Icon={IconShieldOutlineRegular} on={mode.enabled} titleAttribute={mode.enabled ? 'on' : 'off'} pill={t(mode.enabled ? 'pill.on' : 'pill.off')}
          title={t(mode.enabled ? (mode.kind === 'passcode' ? 'state.passcode' : 'state.pin') : 'state.off')}
          detail={mode.enabled ? `${t('state.settings', { minutes: String(mode.idleMinutes) })}${mode.lockWhenHidden ? ` ${t('state.hidden')}` : ''}` : undefined} />
      </div>
    </SettingsCard>
    {waiting.length > 0
      ? <div data-pin-mode-set-back>
        <Notice tone="warning" Icon={IconWarningOutlineRegular} title={t('setBack.title')}>
          {t('setBack.waiting', { settings: waiting.map(setting => settingWords(t, setting)).join(', ') })} {t('setBack.auto')}
        </Notice>
      </div>
      : null}
    {mode.paused
      ? <Notice tone="warning" Icon={IconPauseOutlineRegular} title={t('paused.title')}
        actions={<Button variant="outline" size="sm" disabled={busy} onClick={() => { void run(() => resumePin(fetch)) }}>{t('resume')}</Button>}>
        {t('paused')}
      </Notice>
      : null}
    {mode.enabled
      ? <>
        <SettingsCard title={t('card.options')} group="pin-options">
          <form className={`${cardCss.block} ${css.form}`} onSubmit={saveOptions} noValidate data-pin-mode-options>
            {optionFields}
            {changingPin ? null : failure}
            <div className={css.actions}>
              <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('change')}</Button>
            </div>
          </form>
        </SettingsCard>
        <SettingsCard title={t('card.secret')} group="pin-secret">
          <div className={cardCss.block}>
            <button type="button" className={css.disclosure} aria-expanded={changingPin} disabled={busy}
              onClick={() => { setProblem(undefined); if (changingPin) { setSecret(''); setAgain('') } setChangingPin(!changingPin) }}>
              <span>{t('pin.toggle')}</span>
              <IconChevronDownOutlineRegular className={changingPin ? `${css.chevron} ${css.open}` : css.chevron} aria-hidden="true" />
            </button>
            {changingPin
              ? <form className={css.form} onSubmit={changePin} noValidate data-pin-mode-change>
                <p className={css.hint}>{t('pin.hint')}</p>
                {secretFields}
                {failure}
                <div className={css.actions}>
                  <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('pin.save')}</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { setChangingPin(false); setSecret(''); setAgain(''); setProblem(undefined) }}>{t('pin.cancel')}</Button>
                </div>
              </form>
              : null}
          </div>
        </SettingsCard>
        <SettingsCard title={t('card.off')} description={t('off.lead')} group="pin-off">
          <div className={cardCss.block}>
            <ConfirmAction confirming={confirmingOff} disabled={busy} label={t('off')} question={t('off.confirm')} yes={t('off.yes')} no={t('off.no')}
              confirmAttribute="" onAsk={() => { setConfirmingOff(true) }} onCancel={() => { setConfirmingOff(false) }}
              onConfirm={() => { setConfirmingOff(false); void run(() => turnPinOff(fetch)) }} />
          </div>
        </SettingsCard>
      </>
      : <SettingsCard title={t('card.on')} description={t('card.on.lead')} group="pin-on">
        <form className={`${cardCss.block} ${css.form}`} onSubmit={turnOn} noValidate>
          {secretFields}
          {optionFields}
          {failure}
          <div className={css.actions}>
            <Button type="submit" variant="primary" size="sm" disabled={busy}>{t('on')}</Button>
          </div>
        </form>
      </SettingsCard>}
  </div>
}
