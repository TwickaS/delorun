/**
 * The version row of Settings: Delo's version, then the DeepSeek Harness version it runs on, each labelled. It takes
 * the place of the stock row, which shows the harness version alone as the current version.
 */
import type { ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PrivacyLocaleKey } from './locales.ts'
import type { DeloVersions } from './versions.ts'
import css from './DeloVersionRow.module.css'

/** Injected face of the row: the versions and the bound copy lookup. */
export interface DeloVersionRowInjected {
  /** The versions the harness printed into the page. */
  versions: DeloVersions
  /** Looks up a string in the locale dictionary, with its `{version}` parameter. */
  t: (key: PrivacyLocaleKey, params: { version: string }) => string
}

/** General-row props plus the injected face. */
export type DeloVersionRowProps = PropsRuntime<'settings.general.item'> & InjectFace<DeloVersionRowInjected>

/**
 * Render both versions, Delo's first.
 * @param props - the row's owner props and the injected versions and copy.
 * @returns the row.
 */
export function DeloVersionRow({ versions, t }: DeloVersionRowProps): ReactNode {
  return (
    <div className={css.row}>
      <div>{t('version.delo', { version: versions.delo })}</div>
      <div className={css.secondary}>{t('version.dsh', { version: versions.dsh })}</div>
    </div>
  )
}
