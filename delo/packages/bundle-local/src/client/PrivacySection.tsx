/** The Privacy settings section: Delo's statements, the consent switches for upstream's two opt-ins, and the switch of Delo's release check. */
import { useState } from 'react'
import { Button, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { OptInMutation, OptInSettings } from './opt-in.ts'
import css from './PrivacySection.module.css'

/** The switches the section shows, in screen order: their copy prefix in the dictionary. */
export const OPT_INS = ['sessionLog', 'analytics', 'updateCheck'] as const

/** One switch of {@link OPT_INS}. */
export type OptInId = (typeof OPT_INS)[number]

/** The switches whose rows a profile may not serve, which then say why instead of showing a switch. */
const UNAVAILABLE = { analytics: 'analytics.unavailable', updateCheck: 'updateCheck.unavailable' } as const satisfies Partial<Record<OptInId, string>>

/** Hooks and writers the plugin supplies for each opt-in. */
export interface PrivacySectionInjected {
  hooks: {
    sessionLog: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    sessionLogMutation: ObservableSnapshot<OptInMutation>
    analytics: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    analyticsMutation: ObservableSnapshot<OptInMutation>
    updateCheck: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    updateCheckMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write one switch's `enabled` field.
   * @param id - the switch.
   * @param enabled - the value to write.
   * @returns after the write settles.
   */
  setEnabled(id: OptInId, enabled: boolean): Promise<void>
}

/** Props the renderer binds for the section. */
export type PrivacySectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloPrivacy'> & InjectFace<PrivacySectionInjected>

/**
 * Render the statements and one row per switch. Turning a switch on asks first in a dialog that names what is sent
 * or requested and where; turning it off writes at once. A switch whose Host row this profile does not serve shows why,
 * where the section has the copy, instead of a switch.
 * @param props - localized copy, each switch's form and write state, and the writer.
 * @returns the section.
 */
export function PrivacySection(props: PrivacySectionProps) {
  const { t, setEnabled } = props
  const [asking, setAsking] = useState<OptInId | undefined>()
  const forms = { sessionLog: props.useSessionLog(value => value), analytics: props.useAnalytics(value => value), updateCheck: props.useUpdateCheck(value => value) }
  const mutations = {
    sessionLog: props.useSessionLogMutation(value => value),
    analytics: props.useAnalyticsMutation(value => value),
    updateCheck: props.useUpdateCheckMutation(value => value),
  }
  return <div className={css.section}>
    <h2 className={css.heading}>{t('title')}</h2>
    <ul className={css.statements}>
      <li>{t('statement.delo')}</li>
      <li>{t('statement.optIns')}</li>
      <li>{t('statement.feedback')}</li>
      <li>{t('statement.updateCheck')}</li>
    </ul>
    {OPT_INS.map((id) => {
      const form = forms[id]
      const mutation = mutations[id]
      const unavailable = form.status === 'unavailable'
      return <div key={id} className={css.row} data-opt-in={id}>
        <div>
          <div className={css.title}>{t(`${id}.title`)}</div>
          <div className={css.description}>{t(`${id}.description`)}</div>
          {unavailable && id !== 'sessionLog' ? <div className={css.description}>{t(UNAVAILABLE[id])}</div> : null}
          {mutation.failed ? <div className={css.failed} role="alert">{t('failed')}</div> : null}
        </div>
        {unavailable ? null : <Switch checked={form.value?.enabled === true} label={t(`${id}.title`)}
          disabled={mutation.busy || form.status !== 'ready' || !form.writable}
          onChange={(enabled) => { if (enabled) setAsking(id); else void setEnabled(id, false) }} />}
      </div>
    })}
    {asking === undefined ? null : <Modal open onClose={() => { setAsking(undefined) }}
      title={t(`${asking}.confirm.title`)} closeLabel={t('confirm.close')}
      footer={<>
        <Button variant="outline" onClick={() => { setAsking(undefined) }}>{t('confirm.cancel')}</Button>
        <Button variant="primary" data-modal-autofocus onClick={() => {
          const id = asking
          setAsking(undefined)
          void setEnabled(id, true)
        }}>{t('confirm.accept')}</Button>
      </>}>
      <p className={css.consent}>{t(`${asking}.confirm.body`)}</p>
    </Modal>}
  </div>
}
