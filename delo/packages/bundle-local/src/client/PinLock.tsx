/**
 * The PIN lock screen: a full-page cover on a device whose home has PIN mode on and whose page holds no unlock. It asks
 * for a PIN on a digit keypad or a passcode in a text field, and shows each unlock outcome in place. It reads the store
 * of [`./pin-lock.ts`](./pin-lock.ts); the typed secret lives in this component's state only until the unlock request
 * is sent.
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Button, IconShieldOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PinOutcome, PinSource } from './pin-lock.ts'
import css from './PinLock.module.css'

/** Props of the `shell.overlay` entry: the store's view, its unlock action and the lock screen's copy. */
export type PinLockProps = PropsLocale<'deloPin'> & InjectFace<Pick<PinSource, 'hooks' | 'unlock'>>

type Translate = PinLockProps['t']

/** The fewest digits of a PIN the home accepts. */
const MIN_PIN_DIGITS = 6

/** The keypad's keys in reading order; the empty entry is the blank cell beside 0. */
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'] as const

/**
 * The sentence of an unlock outcome.
 * @param t - the lock screen's copy.
 * @param outcome - what the last unlock came to.
 * @returns the sentence.
 */
function outcomeText(t: Translate, outcome: Exclude<PinOutcome, { kind: 'removed' }>): string {
  switch (outcome.kind) {
    case 'wrong':
      if (outcome.triesLeft === undefined) return t('wrong.unknown')
      return outcome.triesLeft === 1 ? t('wrong.one') : t('wrong.other', { count: String(outcome.triesLeft) })
    case 'paused':
      return t('paused')
    case 'unreachable':
      return t('unreachable')
    case 'address':
      return t('address')
    case 'failed':
      return t('failed')
    /* v8 ignore next 2 -- PinOutcome minus the removed case is closed, so the default holds no reachable statement. */
    default:
      return outcome satisfies never
  }
}

/**
 * Render the lock screen while the page is locked.
 * @param props - the store's view, its unlock action and the copy.
 * @returns the lock screen, or nothing while the page is unlocked or PIN mode does not apply.
 */
export function PinLock({ usePin, unlock, t }: PinLockProps): ReactNode {
  const view = usePin(current => current)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const locked = view.phase === 'locked'
  const removed = view.outcome?.kind === 'removed'
  const isPin = view.secret === 'pin'
  // A phone keeps its keypad on screen; a pointer device types straight away.
  useEffect(() => {
    if (locked && !removed && globalThis.matchMedia?.('(pointer: fine)').matches === true) inputRef.current?.focus()
  }, [locked, removed])
  if (!locked) return null
  const paused = view.paused || view.outcome?.kind === 'paused'
  const ready = !view.busy && !paused && (isPin ? value.length >= MIN_PIN_DIGITS : value !== '')
  const submit = (event?: FormEvent): void => {
    event?.preventDefault()
    if (!ready) return
    const secret = value
    // The field is cleared before the request leaves, so the secret does not outlive the attempt in the page's state.
    setValue('')
    void unlock(secret)
  }
  const press = (key: string): void => {
    if (view.busy) return
    setValue(current => key === '⌫' ? current.slice(0, -1) : current.length < 128 ? current + key : current)
  }
  return <div className={css.cover} role="dialog" aria-modal="true" aria-labelledby="delo-pin-title" data-pin-lock={removed ? 'removed' : view.outcome?.kind ?? 'ask'}>
    <form className={css.card} onSubmit={submit}>
      <IconShieldOutlineRegular className={css.mark} aria-hidden="true" />
      <h1 id="delo-pin-title" className={css.title}>{removed ? t('removed.title') : t('title')}</h1>
      {view.outcome?.kind === 'removed'
        ? <p className={css.text} role="alert">{t('removed.body')}</p>
        : <>
          <p className={css.text}>{t(isPin ? 'lead.pin' : 'lead.passcode')}</p>
          <input ref={inputRef} className={css.field} type="password" name="delo-pin" aria-label={t(isPin ? 'label.pin' : 'label.passcode')}
            inputMode={isPin ? 'numeric' : 'text'} pattern={isPin ? '[0-9]*' : undefined} autoComplete="off" autoCorrect="off"
            autoCapitalize="off" spellCheck={false} enterKeyHint="go" disabled={view.busy} value={value}
            onChange={event => { setValue(isPin ? event.target.value.replace(/\D/g, '') : event.target.value) }} />
          {view.outcome === undefined ? null : <p className={css.failed} role="alert">{outcomeText(t, view.outcome)}</p>}
          {isPin
            ? <div className={css.keypad}>
              {KEYS.map((key, index) => key === ''
                ? <span key={index} />
                : <button key={key} type="button" className={css.key} disabled={view.busy}
                  aria-label={key === '⌫' ? t('key.delete') : key} onClick={() => { press(key) }}>{key}</button>)}
            </div>
            : null}
          <Button variant="primary" type="submit" className={css.submit} disabled={!ready}>{t(view.busy ? 'unlocking' : 'unlock')}</Button>
        </>}
    </form>
  </div>
}
