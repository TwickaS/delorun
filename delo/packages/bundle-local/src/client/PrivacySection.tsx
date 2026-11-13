/** The Privacy settings section: one sentence on what Delorun sends, then the consent switches for upstream's two opt-ins and the feedback statement. */
import type { ReactNode } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import type { OptInMutation, OptInSettings } from './opt-in.ts'
import { OptInRow } from './OptInRow.tsx'
import { SettingsCard } from '@delo/settings-controls'
import css from './SettingsSection.module.css'
import rowCss from './SettingsRow.module.css'

/** The switches the section shows, in screen order. */
export const PRIVACY_OPT_INS = ['sessionLog', 'analytics'] as const

/** One switch of {@link PRIVACY_OPT_INS}. */
export type PrivacyOptInId = (typeof PRIVACY_OPT_INS)[number]

/** The switches whose rows a profile may not serve, which then say why instead of showing a switch. */
const UNAVAILABLE: Readonly<Partial<Record<PrivacyOptInId, PrivacyLocaleKey>>> = { analytics: 'analytics.unavailable' }

/** Hooks and writers the plugin supplies for each opt-in. */
export interface PrivacySectionInjected {
  hooks: {
    sessionLog: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    sessionLogMutation: ObservableSnapshot<OptInMutation>
    analytics: ObservableSnapshot<ConfigFormSnapshot<OptInSettings>>
    analyticsMutation: ObservableSnapshot<OptInMutation>
  }
  /**
   * Write the field of one switch's row that the switch shows.
   * @param id - the switch.
   * @param enabled - the value to write.
   * @returns after the write settles.
   */
  setEnabled(id: PrivacyOptInId, enabled: boolean): Promise<void>
}

/** Props the renderer binds for the section. */
export type PrivacySectionProps = PropsRuntime<'settings.section'> & PropsLocale<'deloPrivacy'> & InjectFace<PrivacySectionInjected>

/**
 * Render the introduction and one row per switch, each asking for consent before it turns on, then the feedback
 * statement.
 * @param props - localized copy, each switch's form and write state, and the writer.
 * @returns the section.
 */
export function PrivacySection(props: PrivacySectionProps): ReactNode {
  const { t, setEnabled } = props
  const forms = { sessionLog: props.useSessionLog(value => value), analytics: props.useAnalytics(value => value) }
  const mutations = {
    sessionLog: props.useSessionLogMutation(value => value),
    analytics: props.useAnalyticsMutation(value => value),
  }
  return <div className={css.section}>
    <h2 className={css.title}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    <SettingsCard title={t('sharing.heading')}>
      {PRIVACY_OPT_INS.map(id => <OptInRow key={id} id={id} t={t} form={forms[id]} mutation={mutations[id]}
        unavailable={UNAVAILABLE[id]} setEnabled={enabled => setEnabled(id, enabled)} />)}
      <div className={rowCss.row} data-statement="feedback">
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t('feedback.title')}</div>
          <div className={rowCss.description}>{t('statement.feedback')}</div>
        </div>
      </div>
    </SettingsCard>
  </div>
}
