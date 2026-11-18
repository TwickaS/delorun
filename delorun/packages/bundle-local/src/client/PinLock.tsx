/**
 * The PIN lock screen: a full-page cover on a device whose home has PIN mode on and whose page holds no unlock. It asks
 * for a PIN on a digit keypad or a passcode in a text field, and shows each unlock outcome in place. It reads the store
 * of [`./pin-lock.ts`](./pin-lock.ts); the typed secret lives in this component's state only until the unlock request
 * is sent.
 */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import {
  Button, IconCloseCircleFillRegular, IconInfoOutlineRegular, IconLinkOutlineRegular, IconPauseOutlineRegular,
  IconShieldOutlineRegular, IconWarningOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PinOutcome, PinSource } from './pin-lock.ts'
import { CodeCells, Keypad, Notice } from '@delorun/brand'
import { BRAND_NAME, DelorunBrandMark } from './brand.tsx'
import css from './PinLock.module.css'

/** Props of the `shell.overlay` entry: the store's view, its unlock action and the lock screen's copy. */
export type PinLockProps = PropsLocale<'delorunPin'> & InjectFace<Pick<PinSource, 'hooks' | 'unlock' | 'dismiss'>>

type Translate = PinLockProps['t']

/** The fewest digits of a PIN the home accepts. */
const MIN_PIN_DIGITS = 6

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

/** The icon and heading key of each outcome that is not a wrong PIN, which the dots report themselves. */
const NOTICE_OF = {
  paused: { Icon: IconPauseOutlineRegular, title: 'paused.title' },
  unreachable: { Icon: IconWarningOutlineRegular, title: 'unreachable.title' },
  address: { Icon: IconLinkOutlineRegular, title: 'address.title' },
  failed: { Icon: IconInfoOutlineRegular, title: 'failed.title' },
} as const

/** Whether the person asked the system for less motion. */
function reducedMotion(): boolean {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * Render the lock screen while the page is locked and an action asked for the unlock.
 * @param props - the store's view, its unlock action and the copy.
 * @returns the lock screen, or nothing while the page is unlocked or PIN mode does not apply.
 */
export function PinLock({ usePin, unlock, dismiss, t }: PinLockProps): ReactNode {
  const view = usePin(current => current)
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const locked = view.phase === 'locked' && view.asked
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
  const outcome = view.outcome
  const wrong = outcome?.kind === 'wrong'
  const notice = outcome === undefined || outcome.kind === 'removed' || outcome.kind === 'wrong' ? undefined : NOTICE_OF[outcome.kind]
  // Each wrong answer is a new outcome object, so the shake restarts; a person who asked for less motion sees none.
  const shake = wrong && !reducedMotion()
  return <div className={css.cover} role="dialog" aria-modal="true" aria-labelledby="delorun-pin-title" data-pin-lock={removed ? 'removed' : outcome?.kind ?? 'ask'}>
    <form className={css.card} onSubmit={submit}>
      <div className={css.brand}><DelorunBrandMark size={22} /><span>{BRAND_NAME}</span></div>
      <div className={css.badge} data-removed={removed ? '' : undefined}>
        {removed ? <IconCloseCircleFillRegular className={css.badgeIcon} aria-hidden="true" /> : <IconShieldOutlineRegular className={css.badgeIcon} aria-hidden="true" />}
      </div>
      <h1 id="delorun-pin-title" className={css.title}>{removed ? t('removed.title') : t('title')}</h1>
      {removed
        ? <p className={css.text} role="alert">{t('removed.body')}</p>
        : <>
          <p className={css.text}>{t(isPin ? 'lead.pin' : 'lead.passcode')}</p>
          {isPin
            ? <CodeCells label={t('label.pin')} length={MIN_PIN_DIGITS} open mask value={value} onChange={setValue} error={wrong} shake={shake} shakeKey={outcome}
              disabled={view.busy} autoComplete="off" name="delorun-pin" autoFocus={globalThis.matchMedia?.('(pointer: fine)').matches === true} inputProps={{ 'data-pin-entry': true }} />
            : <input ref={inputRef} className={css.field} type="password" name="delorun-pin"  aria-label={t('label.passcode')} inputMode="text" autoComplete="off" autoCorrect="off"
              autoCapitalize="off" spellCheck={false} enterKeyHint="go" disabled={view.busy} value={value} onChange={(event) => { setValue(event.target.value) }} />}
          {wrong ? <p className={css.failed} role="alert">{outcomeText(t, outcome)}</p> : null}
          {notice === undefined || outcome === undefined || outcome.kind === 'wrong' || outcome.kind === 'removed' ? null
            : <Notice tone="warning" Icon={notice.Icon} title={t(notice.title)} role="alert" outcome={outcome.kind}>{outcomeText(t, outcome)}</Notice>}
          {isPin ? <Keypad onKey={press} deleteLabel={t('key.delete')} disabled={view.busy} /> : null}
          <Button variant="primary" type="submit" className={css.submit} disabled={!ready}>{t(view.busy ? 'unlocking' : 'unlock')}</Button>
        </>}
      <Button variant="outline" type="button" className={css.submit} disabled={view.busy} onClick={dismiss}>{t(removed ? 'close' : 'notNow')}</Button>
    </form>
  </div>
}
