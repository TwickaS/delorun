/** The General row that names Delorun's version alone; the DeepSeek Harness version it runs on is in Settings → About. */
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { DelorunVersions } from './versions.ts'
import css from './SettingsRow.module.css'

/** Injected face of the row. */
export interface VersionsRowInjected {
  /** The versions the harness printed into the page. */
  versions: DelorunVersions
}

/** General-row props plus the injected face. */
export type VersionsRowProps = PropsRuntime<'settings.general.item'> & PropsLocale<'delorunPrivacy'> & InjectFace<VersionsRowInjected>

/**
 * Render Delorun's version.
 * @param props - the copy and the versions.
 * @returns the row.
 */
export function VersionsRow({ t, versions }: VersionsRowProps): ReactNode {
  return <div className={css.row} data-versions="">
    <div className={css.title}>{t('versions.line', { delorun: versions.delorun })}</div>
  </div>
}
