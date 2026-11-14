/**
 * Delorun's New Session hero: the text wordmark in the hero's brand-mark seat,
 * in place of upstream's whale, and the headline without upstream's Preview
 * badge. The sidebar's brand belongs to `@delorun/bundle-local`.
 * @module @delorun/plugin-theme/client/brand
 */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './brand.module.css'

/** Height of upstream's whale for a requested edge: the whale is drawn 34 wide and 25 high. */
const MARK_ASPECT = 25 / 34

/**
 * The wordmark in the hero's brand-mark seat, as wide at least and as high as upstream's mark for the requested edge, so the headline keeps its place.
 * @param props - the seat's presentation props and the brand's dictionary.
 * @returns the wordmark.
 */
export function HeroWordmark({ t, size, className }: HeroBrandMarkOwnerProps & PropsLocale<'delorunBrand'>) {
  return (
    <span className={`${css.mark} ${className ?? ''}`} style={{ minWidth: size, height: Math.round(size * MARK_ASPECT) }}>
      {t('hero.mark')}
    </span>
  )
}

/**
 * The New Session headline.
 * @param props - the brand's dictionary.
 * @returns the headline.
 */
export function HeroHeadline({ t }: PropsLocale<'delorunBrand'>) {
  return <span className={css.headline}>{t('hero.headline')}</span>
}
