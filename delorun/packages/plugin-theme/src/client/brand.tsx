/**
 * Delorun's New Session hero: the brand icon above the brand name in the hero's brand-mark seat, in place of
 * upstream's whale, and the headline without upstream's Preview badge. Both follow the person's branding: the icon and
 * name can be replaced or hidden, and the greeting replaced. The sidebar's brand is {@link SidebarBrandMark} and
 * {@link SidebarBrandName}.
 * @module @delorun/plugin-theme/client/brand
 */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DEFAULT_GREETING } from '@delorun/brand/branding'
import { BrandIcon } from './BrandIcon.tsx'
import { useBranding } from './branding-store.ts'
import css from './brand.module.css'

/** The icon's share of the seat's requested edge. */
const ICON_SHARE = 0.9

/**
 * The icon above the name in the hero's brand-mark seat; nothing while the mark is hidden.
 * @param props - the seat's presentation props and the brand's dictionary.
 * @returns the icon and name.
 */
export function HeroWordmark({ size, className }: HeroBrandMarkOwnerProps & PropsLocale<'delorunBrand'>) {
  const branding = useBranding()
  if (!branding.showMark) return null
  return (
    <span className={`${css.mark} ${className ?? ''}`}>
      <BrandIcon branding={branding} size={Math.round(size * ICON_SHARE)} />
      <span className={css.name}>{branding.name}</span>
    </span>
  )
}

/**
 * The New Session headline: the person's greeting, or the translated default. While the mark shows, the greeting takes
 * the hero row's full width, so the row wraps and the mark stands centred above it at every width.
 * @param props - the brand's dictionary.
 * @returns the headline.
 */
export function HeroHeadline({ t }: PropsLocale<'delorunBrand'>) {
  const { greeting, showMark } = useBranding()
  return <span className={`${css.headline} ${showMark ? css.stacked : ''}`}>{greeting === DEFAULT_GREETING ? t('hero.headline') : greeting}</span>
}
