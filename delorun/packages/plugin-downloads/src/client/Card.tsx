/** The desktop card: floating bottom-right above the page and the onboarding window, collapsible to one line. */
import { IconChevronDownOutlineRegular, IconChevronUpOutlineRegular, IconCloseOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { useId, useState, type ReactNode } from 'react'
import css from './Card.module.css'
import { ItemList } from './Items.tsx'
import { Live } from './Live.tsx'
import { pluralKey, type Translate } from './locales.ts'
import type { PanelModel } from './model.ts'
import type { DownloadsSource } from './source.ts'

/**
 * The header's words for the model's phase.
 * @param model - the derived view.
 * @param t - the copy.
 * @returns the sentence.
 */
export function headerText(model: PanelModel, t: Translate): string {
  if (model.phase === 'working') return t('header', { done: model.done, total: model.total })
  if (model.phase === 'attention') return t(pluralKey('header.attention', model.failed), { n: model.failed })
  return t(pluralKey('summary', model.added), { n: model.added })
}

/**
 * @param props - the derived view, the source and the copy.
 * @returns the card, or only the live region while nothing shows.
 */
export function DownloadsCard({ model, source, t }: { readonly model: PanelModel; readonly source: DownloadsSource; readonly t: Translate }): ReactNode {
  const [collapsed, setCollapsed] = useState(false)
  const bodyId = useId()
  return (
    <>
      <Live announcement={model.announcement} t={t} />
      {model.phase !== 'hidden' && (
        <section className={css.card} aria-label={t('title')} data-phase={model.phase} data-collapsed={collapsed || undefined}>
          <div className={css.header}>
            <button type="button" className={css.toggle} aria-expanded={!collapsed} aria-controls={bodyId}
              aria-label={`${headerText(model, t)}. ${collapsed ? t('expand') : t('collapse')}`} onClick={() => { setCollapsed(open => !open) }}>
              <span className={css.title}>{headerText(model, t)}</span>
              {collapsed ? <IconChevronUpOutlineRegular /> : <IconChevronDownOutlineRegular />}
            </button>
            {model.phase === 'attention' && (
              <button type="button" className={css.dismiss} aria-label={t('dismiss')} onClick={() => { for (const item of model.items) if (item.state === 'failed') source.remove(item.key) }}>
                <IconCloseOutlineRegular />
              </button>
            )}
          </div>
          <div className={css.line} aria-hidden="true"><span style={{ width: `${String(model.percent)}%` }} data-active={model.phase === 'working' || undefined} /></div>
          <div id={bodyId} className={css.body} data-open={!collapsed}>
            <div className={css.inner}><ItemList items={model.items} source={source} t={t} tone="card" label={t('list')} /></div>
          </div>
        </section>
      )}
    </>
  )
}
