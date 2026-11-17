/**
 * The Phone powers choice in the Devices section: Careful or Full, each with what it lets an unlocked phone do. The
 * person chooses at the computer; a device shows the level read-only with "change this at your computer", and the
 * route refuses a device's choice whatever its unlock. While the home applies a level nobody chose, the computer shows
 * a one-time notice that ends with the person's first choice. The onboarding Phone access step shows the same block at
 * the computer through `@delorun/bundle-local/phone-powers`, with the `delorunDevices` dictionary.
 */
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { PHONE_POWERS_LEVELS, type PhonePowersLevel, type PhonePowersView } from '@delorun/home-auth/wire'
import { readPhonePowers, setPhonePowers, type HostFetch } from './devices-api.ts'
import type { TranslateNS } from '@deepseek-ai/dsh-client-locale/client'
import type { Loaded } from './host-api.ts'
import css from './DevicesSection.module.css'

/**
 * Render the choice.
 * @param props - the Devices dictionary, the request function, whether the page is on a device, and the failure wording.
 * @returns the block, or nothing when the profile does not serve the route.
 */
export function PhonePowers({ t, fetch, onDevice, failure }: {
  readonly t: TranslateNS<'delorunDevices'>
  readonly fetch: HostFetch
  /** True on a paired device, where the level is read-only; undefined until the page knows where it is. */
  readonly onDevice: boolean | undefined
  /** The sentence for a failed read or choice. */
  readonly failure: (error: unknown) => string
}): ReactNode {
  const [powers, setPowers] = useState<Loaded<PhonePowersView | undefined>>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [chooseFailure, setChooseFailure] = useState<string | undefined>()
  useEffect(() => {
    let current = true
    readPhonePowers(fetch).then(
      (value) => { if (current) setPowers({ kind: 'ready', value }) },
      (error: unknown) => { if (current) setPowers({ kind: 'failed', text: failure(error) }) },
    )
    return () => { current = false }
  }, [fetch, failure])
  if (powers.kind === 'loading' || (powers.kind === 'ready' && powers.value === undefined)) return null
  const view = powers.kind === 'ready' ? powers.value : undefined
  const readOnly = onDevice !== false
  const choose = (level: PhonePowersLevel): void => {
    if (readOnly || busy || (view?.level === level && view.chosen)) return
    setBusy(true)
    setChooseFailure(undefined)
    setPhonePowers(fetch, level).then(
      (value) => { setPowers({ kind: 'ready', value }) },
      (error: unknown) => { setChooseFailure(failure(error)) },
    ).finally(() => { setBusy(false) })
  }
  return <section className={css.powers} aria-labelledby="delorun-phone-powers" data-phone-powers={view?.level} data-phone-powers-chosen={view?.chosen}>
    <h3 className={css.subheading} id="delorun-phone-powers">{t('powers.title')}</h3>
    <p className={css.line}>{t('powers.intro')}</p>
    {powers.kind === 'failed' ? <p className={css.failed} role="alert">{powers.text}</p> : null}
    {view !== undefined && !view.chosen && onDevice === false
      ? <div className={css.powersNotice} role="note" data-phone-powers-unchosen>
        <p className={css.line}>{t(`powers.unchosen.${view.level}`)}</p>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => { choose(view.level) }}>{t(`powers.keep.${view.level}`)}</Button>
      </div>
      : null}
    {view === undefined ? null : <div className={css.powerChoices} role="radiogroup" aria-labelledby="delorun-phone-powers" aria-disabled={readOnly || busy}>
      {PHONE_POWERS_LEVELS.map(level => <label key={level} className={css.powerChoice} data-selected={view.level === level}>
        <input type="radio" name="delorun-phone-powers" value={level} checked={view.level === level} disabled={readOnly || busy}
          onChange={() => { choose(level) }} />
        <span className={css.powerText}>
          <span className={css.powerName}>{t(`powers.${level}`)}</span>
          <span className={css.powerBody}>{t(`powers.${level}.body`)}</span>
        </span>
      </label>)}
    </div>}
    {readOnly && onDevice === true ? <p className={css.line}>{t('powers.device')}</p> : null}
    {chooseFailure === undefined ? null : <p className={css.failed} role="alert">{chooseFailure}</p>}
  </section>
}
