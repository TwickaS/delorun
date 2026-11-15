/**
 * The version row of Settings: Delorun's version alone. It takes
 * the place of the stock row, which shows the harness version as the current version; that version is in Settings → About.
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import type { DelorunVersions } from './versions.ts'
import css from './DelorunVersionRow.module.css'

/** Injected face of the row: the versions and the bound copy lookup. */
export interface DelorunVersionRowInjected {
  /** The versions the harness printed into the page. */
  versions: DelorunVersions
  /** Looks up a string in the locale dictionary, with its `{version}` parameter. */
  t: (key: PrivacyLocaleKey, params: { version: string }) => string
}

/** General-row props plus the injected face. */
export type DelorunVersionRowProps = PropsRuntime<'settings.general.item'> & InjectFace<DelorunVersionRowInjected>

/**
 * Render Delorun's version.
 * @param props - the row's owner props and the injected versions and copy.
 * @returns the row.
 */
export function DelorunVersionRow({ versions, t }: DelorunVersionRowProps): ReactNode {
  return (
    <div className={css.row}>
      <div>{t('version.delorun', { version: versions.delorun })}</div>
    </div>
  )
}
