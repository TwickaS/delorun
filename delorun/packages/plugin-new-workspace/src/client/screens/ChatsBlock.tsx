/** The copy block the model and safety screens share: what every chat starts with and what one chat can change. */
import type { ReactNode } from 'react'
import type { Translate } from '../locales.ts'
import css from './screens.module.css'

/**
 * The block.
 * @param props - this plugin's copy.
 * @param props.t - this plugin's copy.
 * @returns the intro line and its three points.
 */
export function ChatsBlock({ t }: { readonly t: Translate }): ReactNode {
  return (
    <section className={css.chats} aria-label={t('chats.intro')}>
      <p className={css.hint}>{t('chats.intro')}</p>
      <ul className={css.chatsList}>
        <li>{t('chats.model')}</li>
        <li>{t('chats.permission')}</li>
        <li>{t('chats.network')}</li>
      </ul>
    </section>
  )
}
