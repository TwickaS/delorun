/** The polite live region: it speaks a completion or a new failure once, never a percentage. */
import type { ReactNode } from 'react'
import css from './Live.module.css'
import { pluralKey, type Translate } from './locales.ts'
import type { PanelModel } from './model.ts'

/**
 * @param props - the announcement and the copy.
 * @returns the always-mounted status node.
 */
export function Live({ announcement, t }: { readonly announcement: PanelModel['announcement']; readonly t: Translate }): ReactNode {
  const text = announcement === undefined ? ''
    : announcement.kind === 'summary' ? t(pluralKey('summary', announcement.count), { n: announcement.count })
      : t('announce.failed', { name: announcement.name })
  return <div className={css.live} role="status" aria-live="polite">{text}</div>
}
