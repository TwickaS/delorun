/**
 * Phone access: the switch, the preview the home reads from Tailscale before it changes anything, and what follows once
 * it is on: the PIN link and the switch that holds plugin changes for review. Turning it on or off is done at the
 * home's own computer; elsewhere the row only says whether it is on. The trust statement is the copy of
 * `TRUST_STATEMENT` in `@delorun/setup-apply`, which `tests/setup-commands-section.client.spec.tsx` holds equal.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostFetch } from './host-api.ts'
import { previewReach, readProtection, setReach, turnProtectionOn, type ReachPreview, type ReachWritten, type RunState } from './run-settings-api.ts'
import { runFailureText, type RunTranslate } from './RunDangerous.tsx'
import type { SetupCommandsLocaleKey } from './setup-commands-locales.ts'
import css from './SetupCommandsSection.module.css'

/** How many sentences the trust statement has. */
export const TRUST_LINES = 8

/** Props of {@link ReachRow}. */
export interface ReachRowProps {
  readonly t: RunTranslate
  readonly fetch: HostFetch
  readonly state: RunState
  /** Whether this studio runs on the home's own computer, where phone access is turned on and off. */
  readonly computer: boolean
  /** Opens the PIN mode section. */
  readonly openPin: () => void
  /** Runs after the profile changed, so the section reads the state again. */
  readonly onChanged: () => void
}

/**
 * Render the row's control and what follows it.
 * @param props - see {@link ReachRowProps}.
 * @returns the control and its panels.
 */
export function ReachRow({ t, fetch, state, computer, openPin, onChanged }: ReachRowProps): ReactNode {
  const [preview, setPreview] = useState<ReachPreview | 'checking' | undefined>()
  const [written, setWritten] = useState<ReachWritten | undefined>()
  const [failure, setFailure] = useState<unknown>()
  const [busy, setBusy] = useState(false)
  const [protection, setProtection] = useState<'on' | 'off' | undefined>()
  const on = state.reach.on
  useEffect(() => {
    if (!computer || !on) return
    let current = true
    readProtection(fetch).then((value) => { if (current) setProtection(value) }, () => { /* The switch stays out of the row: the Changes section holds it too. */ })
    return () => { current = false }
  }, [computer, on, fetch])
  const turn = async (next: boolean): Promise<void> => {
    setFailure(undefined)
    setWritten(undefined)
    if (next) {
      setPreview('checking')
      try {
        setPreview(await previewReach(fetch))
      } catch (error) {
        setPreview(undefined)
        setFailure(error)
      }
      return
    }
    setBusy(true)
    try {
      setWritten(await setReach(fetch, { on: false }))
      onChanged()
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  const confirm = async (ticket: string): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      setWritten(await setReach(fetch, { on: true, ticket }))
      setPreview(undefined)
      onChanged()
    } catch (error) {
      setFailure(error)
      setPreview(undefined)
    } finally {
      setBusy(false)
    }
  }
  const protect = async (): Promise<void> => {
    try {
      await turnProtectionOn(fetch)
      setProtection('on')
    } catch (error) {
      setFailure(error)
    }
  }
  return <>
    <div className={css.description}>{t(on ? 'reach.on' : 'reach.off')}</div>
    {computer
      ? <div className={css.controls}>
        <Switch checked={on || preview !== undefined} label={t('reach.switch')} disabled={busy || preview === 'checking'}
          onChange={(next) => { void turn(next) }} />
      </div>
      : null}
    {preview === 'checking' ? <p className={css.note} role="status">{t('reach.checking')}</p> : null}
    {preview !== undefined && preview !== 'checking'
      ? <div className={css.panel} data-reach-preview>
        <p>{t('reach.preview.address', { address: preview.address })}</p>
        <ul className={css.trust}>{Array.from({ length: TRUST_LINES }, (_, index) => <li key={index}>{t(`reach.trust.${String(index + 1)}` as SetupCommandsLocaleKey)}</li>)}</ul>
        <p>{t('reach.preview.tailscale')}</p>
        <div className={css.inline}>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirm(preview.ticket) }}>{t('reach.confirm')}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPreview(undefined) }}>{t('reach.cancel')}</Button>
        </div>
      </div>
      : null}
    {written === undefined ? null : <p className={css.note} role="status">{writtenText(t, written)}</p>}
    {failure === undefined ? null : <p className={css.failed} role="alert">{runFailureText(t, failure)}</p>}
    {computer && on
      ? <div className={css.controls}>
        <div className={css.inline}>
          <Button variant="outline" size="sm" onClick={openPin}>{t('reach.pin')}</Button>
          <span className={css.note}>{t('reach.pin.body')}</span>
        </div>
        {protection === undefined
          ? null
          : <div className={css.inline}>
            <Switch checked={protection === 'on'} label={t('reach.protection')} disabled={protection === 'on'} title={protection === 'on' ? t('reach.protection.body') : undefined}
              onChange={(next) => { if (next) void protect() }} />
            <span className={css.note}>{t('reach.protection.body')}</span>
          </div>}
      </div>
      : null}
  </>
}

/**
 * What a turn on or off came to, in words.
 * @param t - the section's copy.
 * @param written - the home's answer.
 * @returns the sentence.
 */
function writtenText(t: RunTranslate, written: ReachWritten): string {
  if (!written.on) return written.stillServed === undefined ? t('reach.offDone') : t('reach.stillServed', { detail: written.stillServed })
  return t(written.ready ? 'reach.ready' : 'reach.notReady', { address: written.address })
}
