/**
 * One opt-in switch row with its consent dialog. Turning the switch on asks first in a dialog that names what is sent
 * or requested and where; turning it off writes at once. The Privacy section and the release check's General row both
 * render it.
 */
import { useState, type ReactNode } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { Button, Dialog } from '@delorun/brand'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import { OPT_IN_FIELDS, type OptInId, type OptInMutation, type OptInSettings } from './opt-in.ts'
import css from './SettingsRow.module.css'

/** What the row renders from. */
export interface OptInRowProps {
  /** The switch, whose id prefixes its copy keys. */
  readonly id: OptInId
  /** The Privacy dictionary's lookup. */
  readonly t: PropsLocale<'delorunPrivacy'>['t']
  /** The switch's Host form. */
  readonly form: ConfigFormSnapshot<OptInSettings>
  /** The switch's write state. */
  readonly mutation: OptInMutation
  /** The host of another release channel the release check contacts, from the channel route; its copy names it in place of the production hosts. Absent for the production channel and for the other switches. */
  readonly channelHost?: string | undefined
  /** The line that says why a profile that does not serve the switch's Host row shows no switch. */
  readonly unavailable?: PrivacyLocaleKey | undefined
  /**
   * Write the switch's field ({@link OPT_IN_FIELDS}).
   * @param enabled - `true` only after the person accepted the dialog.
   * @returns after the write settles.
   */
  readonly setEnabled: (enabled: boolean) => Promise<void>
}

/**
 * Render the switch's title, description and write failure, then the switch; a form the profile does not serve shows
 * the `unavailable` line instead of the description and the switch.
 * @param props - the switch, its copy, form and write state, and the writer.
 * @returns the row, with its dialog while it asks.
 */
export function OptInRow({ id, t, form, mutation, unavailable, channelHost, setEnabled }: OptInRowProps): ReactNode {
  const [asking, setAsking] = useState(false)
  const copy = (part: 'description' | 'confirm.body'): string => id === 'updateCheck' && channelHost !== undefined
    ? t(`updateCheck.${part}.channel`).replace('{host}', channelHost)
    : t(`${id}.${part}`)
  const served = form.status !== 'unavailable'
  return <div className={css.row} data-opt-in={id}>
    <div className={css.text}>
      <div className={css.title}>{t(`${id}.title`)}</div>
      {served || unavailable === undefined
        ? <div className={css.description}>{copy('description')}</div>
        : <div className={css.description}>{t(unavailable)}</div>}
      {mutation.failed ? <div className={css.failed} role="alert">{t('failed')}</div> : null}
    </div>
    {served
      ? <Switch checked={form.value?.[OPT_IN_FIELDS[id]] === true} label={t(`${id}.title`)}
        disabled={mutation.busy || form.status !== 'ready' || !form.writable}
        onChange={(enabled) => { if (enabled) setAsking(true); else void setEnabled(false) }} />
      : null}
    {asking
      ? <Dialog open onClose={() => { setAsking(false) }} title={t(`${id}.confirm.title`)} closeLabel={t('confirm.close')}
        actions={<>
          <Button variant="secondary" onClick={() => { setAsking(false) }}>{t('confirm.cancel')}</Button>
          <Button variant="primary" data-modal-autofocus onClick={() => {
            setAsking(false)
            void setEnabled(true)
          }}>{t('confirm.accept')}</Button>
        </>}>
        <p className={css.consent}>{copy('confirm.body')}</p>
      </Dialog>
      : null}
  </div>
}
