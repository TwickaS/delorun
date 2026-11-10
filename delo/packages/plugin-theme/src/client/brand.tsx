/**
 * Delo's headline over the New Session composer, without upstream's Preview
 * badge. Delo has no approved mark, so the hero's mark seat keeps upstream's;
 * the sidebar's brand belongs to `@delo/bundle-local`.
 * @module @delo/plugin-theme/client/brand
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './brand.module.css'

/**
 * The New Session headline.
 * @param props - the brand's dictionary.
 * @returns the headline.
 */
export function HeroHeadline({ t }: PropsLocale<'deloBrand'>) {
  return <span className={css.headline}>{t('hero.headline')}</span>
}
