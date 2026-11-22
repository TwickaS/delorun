/** The About settings section: both versions, Delorun's licence and the project's public links. */
import { useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import { Button } from '@delorun/brand'
import { SettingsCard } from '@delorun/settings-controls'
import type { DelorunVersions } from './versions.ts'
import { ReportDialog, type ReportFace } from './ReportProblem.tsx'
import css from './SettingsSection.module.css'
import reportCss from './ReportProblem.module.css'
import rowCss from './SettingsRow.module.css'

/** Delorun's licence file. */
export const LICENCE_URL = 'https://github.com/twickas/delorun/blob/main/LICENSE'

/** One public project link: its label key, its target and the address the row shows. */
interface ProjectLink {
  readonly label: PrivacyLocaleKey
  readonly href: string
  readonly address: string
}

/** The project's public links, in screen order. */
export const PROJECT_LINKS: readonly ProjectLink[] = [
  { label: 'about.links.docs', href: 'https://docs.delorun.com', address: 'docs.delorun.com' },
  { label: 'about.links.source', href: 'https://github.com/twickas/delorun', address: 'github.com/twickas/delorun' },
  { label: 'about.links.issues', href: 'https://github.com/twickas/delorun/issues', address: 'github.com/twickas/delorun/issues' },
  { label: 'about.links.support', href: 'mailto:support@delorun.com', address: 'support@delorun.com' },
]

/** Props the renderer binds for the section. */
export type AboutSectionProps = PropsRuntime<'settings.section'> & PropsLocale<'delorunPrivacy'> & Partial<ReportFace> & { readonly versions?: DelorunVersions | undefined }

/**
 * Render the versions group (when the page carries them), the licence group, the report row and the project links group; every link opens in a new tab.
 * @param props - the copy.
 * @returns the section.
 */
export function AboutSection({ t, surface = 'computer', fetchImpl, startChat, versions }: AboutSectionProps): ReactNode {
  const [reporting, setReporting] = useState(false)
  return <div className={css.section}>
    <h2 className={css.title}>{t('about.title')}</h2>
    {versions !== undefined && <SettingsCard title={t('about.versions.heading')} group="versions">
      <div className={rowCss.row}>
        <div className={rowCss.text}>
          <div className={rowCss.title}>{t('version.delorun', { version: versions.delorun })}</div>
          <div className={rowCss.title}>{t('version.dsh', { version: versions.dsh })}</div>
        </div>
      </div>
    </SettingsCard>}
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
        <Button size="sm" className={reportCss.action} aria-haspopup="dialog" onClick={() => { setReporting(true) }}>{t('about.report.button')}</Button>
      </div>
      <ReportDialog open={reporting} onClose={() => { setReporting(false) }} t={t} surface={surface} fetchImpl={fetchImpl} startChat={startChat} />
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
