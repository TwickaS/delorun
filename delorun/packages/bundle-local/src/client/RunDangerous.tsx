/**
 * The two confirmations that turn dangerous mode on, at the home's own computer: the warning and a question that starts
 * on No, then the phrase the home compares itself. The warning is the copy of `DANGEROUS_WARNING_LINES` in
 * `@delorun/setup-apply`, which `tests/setup-commands-section.client.spec.tsx` holds equal.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Dialog } from '@delorun/brand'
import { failureSentence, isRefused, LOOPBACK_REQUIRED, type HostFetch } from './host-api.ts'
import { beginDangerous, confirmDangerous, type DangerousBegun } from './run-settings-api.ts'
import type { SetupCommandsLocaleKey } from './setup-commands-locales.ts'
import css from './SetupCommandsSection.module.css'

/** The translate function of the section's namespace. */
export type RunTranslate = (key: SetupCommandsLocaleKey, values?: Readonly<Record<string, string>>) => string

/** How many paragraphs the warning has. */
export const WARNING_LINES = 7

/**
 * The sentence for a failed request of the run controls.
 * @param t - the section's copy.
 * @param error - the caught error.
 * @returns the localized sentence for a request that left the computer, or the home's own sentence for a refusal.
 */
export function runFailureText(t: RunTranslate, error: unknown): string {
  return failureSentence(error, {
    refused: (code, message) => code === LOOPBACK_REQUIRED ? t('loopback') : message,
    unreachable: t('failed.unreachable'),
    unreadable: t('failed.unreadable'),
  })
}

/**
 * Render the dialog. Opening it asks the home for the warning's code; closing it before the second step changes nothing.
 * @param props - the copy, the request function, and what runs when the dialog closes or dangerous mode is on.
 * @returns the dialog.
 */
export function DangerousDialog({ t, fetch, onClose, onDone }: {
  readonly t: RunTranslate
  readonly fetch: HostFetch
  readonly onClose: () => void
  /** Runs once dangerous mode is on, with whether Delorun must restart for it to apply. */
  readonly onDone: (restartNeeded: boolean) => void
}): ReactNode {
  const [begun, setBegun] = useState<DangerousBegun | undefined>()
  const [step, setStep] = useState<'ask' | 'phrase'>('ask')
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<unknown>()
  useEffect(() => {
    let current = true
    // The code is asked for once per dialog: a second request would replace the first code.
    beginDangerous(fetch).then(
      (answer) => { if (current) setBegun(answer) },
      (error: unknown) => { if (current) setFailure(error) },
    )
    return () => { current = false }
  }, [fetch])
  const confirm = async (): Promise<void> => {
    if (begun === undefined) return
    setBusy(true)
    setFailure(undefined)
    try {
      onDone((await confirmDangerous(fetch, begun.nonce, true, typed)).restartNeeded)
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  return <Dialog open onClose={onClose} title={t('dangerous.title')} closeLabel={t('dangerous.close')} tone="warning"
    actions={step === 'ask'
      ? <>
        <Button variant="primary" data-modal-autofocus onClick={onClose}>{t('dangerous.no')}</Button>
        <Button variant="secondary" disabled={begun === undefined} onClick={() => { setStep('phrase') }}>{t('dangerous.yes')}</Button>
      </>
      : <>
        <Button variant="secondary" onClick={onClose}>{t('dangerous.no')}</Button>
        <Button variant="primary" disabled={busy || begun === undefined || typed !== begun.phrase} onClick={() => { void confirm() }}>{t('dangerous.confirm')}</Button>
      </>}>
    {Array.from({ length: WARNING_LINES }, (_, index) => <p key={index} className={css.warning}>{t(`dangerous.line.${String(index + 1)}` as SetupCommandsLocaleKey)}</p>)}
    <p className={css.question}>{t('dangerous.ask')}</p>
    {step === 'phrase' && begun !== undefined
      ? <label className={css.phrase}>
        <span>{t('dangerous.phrase', { phrase: begun.phrase })}</span>
        <Input value={typed} aria-label={t('dangerous.phraseLabel')} autoComplete="off" spellCheck={false} data-modal-autofocus
          onChange={(event) => { setTyped(event.target.value) }} />
      </label>
      : null}
    {failure === undefined ? null : <p className={css.failed} role="alert">{isRefused(failure, 'CODE_EXPIRED') ? t('dangerous.expired') : runFailureText(t, failure)}</p>}
  </Dialog>
}
