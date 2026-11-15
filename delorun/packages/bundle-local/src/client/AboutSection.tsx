/** The About settings section: Delorun's licence and the project's public links. */
import { useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import { Button } from '@delorun/brand'
import { SettingsCard } from '@delorun/settings-controls'
import { ReportDialog, type ReportFace } from './ReportProblem.tsx'
import css from './SettingsSection.module.css'
import rowCss from './SettingsRow.module.css'

/** Delorun's licence file. */
export const LICENCE_URL = 'https://github.com/Delo-Run/delo/blob/main/LICENSE'

/** One public project link: its label key, its target and the address the row shows. */
interface ProjectLink {
  readonly label: PrivacyLocaleKey
  readonly href: string
  readonly address: string
}

/** The project's public links, in screen order. */
export const PROJECT_LINKS: readonly ProjectLink[] = [
  { label: 'about.links.docs', href: 'https://docs.delorun.com', address: 'docs.delorun.com' },
  { label: 'about.links.source', href: 'https://github.com/Delo-Run/delo', address: 'github.com/Delo-Run/delo' },
  { label: 'about.links.issues', href: 'https://github.com/Delo-Run/delo/issues', address: 'github.com/Delo-Run/delo/issues' },
  { label: 'about.links.support', href: 'mailto:support@delorun.com', address: 'support@delorun.com' },
]

/** Props the renderer binds for the section. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunPrivacy'> & Partial<ReportFace>

/**
 * Render the licence group, the report row and the project links group; every link opens in a new tab.
 * @param props - the copy.
 * @returns the section.
 */
export function AboutSection({ t, surface = 'computer', fetchImpl }: AboutSectionProps): ReactNode {
  const [reporting, setReporting] = useState(false)
  return <div className={css.section}>
    <h2 className={css.title}>{t('about.title')}</h2>
    <SettingsCard title={t('about.licences.heading')} group="licences">
      <div className={rowCss.row}>
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t('about.licences.body')}</div>
          <a className={rowCss.link} href={LICENCE_URL} target="_blank" rel="noreferrer">{t('about.licences.link')}</a>
        </div>
      </div>
    </SettingsCard>
    <SettingsCard title={t('about.report.heading')} group="report">
      <div className={rowCss.row}>
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t('about.report.body')}</div>
        </div>
        <Button aria-haspopup="dialog" onClick={() => { setReporting(true) }}>{t('about.report.button')}</Button>
      </div>
      <ReportDialog open={reporting} onClose={() => { setReporting(false) }} t={t} surface={surface} fetchImpl={fetchImpl} />
    </SettingsCard>
    <SettingsCard title={t('about.links.heading')} group="links">
      {PROJECT_LINKS.map(link => <div key={link.href} className={rowCss.row}>
        <div className={rowCss.text}>
          <a className={rowCss.link} href={link.href} target="_blank" rel="noreferrer">{t(link.label)}</a>
          <div className={rowCss.description}>{link.address}</div>
        </div>
      </div>)}
    </SettingsCard>
  </div>
}
