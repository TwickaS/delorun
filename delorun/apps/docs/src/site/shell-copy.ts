/**
 * The text and links the shared header, footer and theme control show on the documentation site, in each of its
 * languages. The product site passes its own, in English.
 *
 * @module @delorun/docs/shell-copy
 */
import { LOOK_NAMES } from '@design/looks.ts'
import type { FooterCopy, ShellLink, ThemeCopy } from '@design/shell-copy.ts'
import { PRODUCT_URL } from '@/site/config.ts'
import type { Locale } from '@/site/locale.ts'

/** Delorun's repository. */
const GITHUB_URL = 'https://github.com/Delo-Run/delorun'

/** DeepSeek Harness, the project Delorun is a community fork of. */
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The theme control's text by locale. */
export const THEME_COPY: Readonly<Record<Locale, ThemeCopy>> = {
  en: { open: 'Change the look of this page', title: 'Look', themes: 'Theme', scheme: 'Light or dark', light: 'Light', dark: 'Dark', back: 'Back to how it started', names: LOOK_NAMES },
  zh: { open: '更改页面外观', title: '外观', themes: '主题', scheme: '浅色或深色', light: '浅色', dark: '深色', back: '恢复初始外观', names: LOOK_NAMES },
}

/** The footer's text by locale. */
export const FOOTER_COPY: Readonly<Record<Locale, FooterCopy>> = {
  en: {
    navLabel: 'Footer',
    owner: 'Delo Run',
    licence: { label: 'MIT licence', href: `${GITHUB_URL}/blob/main/LICENSE` },
    upstream: { label: 'Built on DeepSeek Harness', href: UPSTREAM_URL },
    back: THEME_COPY.en.back,
  },
  zh: {
    navLabel: '页脚',
    owner: 'Delo Run',
    licence: { label: 'MIT 许可证', href: `${GITHUB_URL}/blob/main/LICENSE` },
    upstream: { label: '基于 DeepSeek Harness 构建', href: UPSTREAM_URL },
    back: THEME_COPY.zh.back,
  },
}

/** The product site's page that carries the same look: its address and the label of the link to it, by locale. */
const LABELS: Readonly<Record<Locale, { readonly home: string; readonly privacy: string; readonly notices: string; readonly github: string }>> = {
  en: { home: 'Delorun', privacy: 'Privacy', notices: 'Notices', github: 'GitHub' },
  zh: { home: 'Delorun 官网', privacy: '隐私', notices: '声明', github: 'GitHub' },
}

/**
 * The header's link to the product site.
 * @param locale - the page's locale.
 * @returns the link, which carries the look.
 */
export function productLink(locale: Locale): ShellLink {
  return { label: LABELS[locale].home, href: PRODUCT_URL, site: 'other' }
}

/**
 * The footer's links.
 * @param locale - the page's locale.
 * @returns the links, in order; those on the product site carry the look.
 */
export function footerLinks(locale: Locale): readonly ShellLink[] {
  const labels = LABELS[locale]
  return [
    productLink(locale),
    { label: labels.github, href: GITHUB_URL },
    { label: labels.privacy, href: `${PRODUCT_URL}/privacy`, site: 'other' },
    { label: labels.notices, href: `${PRODUCT_URL}/notices`, site: 'other' },
  ]
}
