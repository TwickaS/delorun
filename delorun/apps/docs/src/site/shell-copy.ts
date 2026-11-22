/**
 * The text and links the shared header, footer and theme control show on the documentation site, in each of its
 * languages. The product site passes its own, in English.
 *
 * @module @delorun/docs/shell-copy
 */
import { LOOK_NAMES, LOOK_NAMES_ZH } from '@design/looks.ts'
import type { FooterCopy, ShellLink, ThemeCopy } from '@design/shell-copy.ts'
import { PRODUCT_URL } from './config.ts'
import type { Locale } from './locale.ts'

/** Delorun's repository. */
const GITHUB_URL = 'https://github.com/twickas/delorun'

/** DeepSeek Harness, the project Delorun is a community fork of. */
const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness'

/** The theme control's text by locale. */
export const THEME_COPY: Readonly<Record<Locale, ThemeCopy>> = {
  en: { open: 'Change the look of this page', title: 'Look', themes: 'Theme', scheme: 'Mode', device: 'System', light: 'Light', dark: 'Dark', back: 'Back to how it started', trigger: (name, scheme) => `Look: ${name}, ${scheme.toLowerCase()}`, current: (name, scheme) => `This page is in ${name}${scheme === undefined ? '' : `, ${scheme.toLowerCase()}`}.`, names: LOOK_NAMES,
    toast: { region: 'Notifications', theme: name => `The page now looks like ${name}.`, scheme: name => `The page is now ${name.toLowerCase()}.`, undo: name => `Back to ${name}`, reset: 'The page is back to how it started.' },
  },
  zh: { open: '更改页面外观', title: '外观', themes: '主题', scheme: '模式', device: '跟随系统', light: '浅色', dark: '深色', back: '恢复初始外观', trigger: (name, scheme) => `外观：${name}，${scheme}`, current: (name, scheme) => `页面现在是“${name}”外观${scheme === undefined ? '' : `，${scheme}`}。`, names: LOOK_NAMES_ZH,
    toast: { region: '通知', theme: name => `页面现在是“${name}”外观。`, scheme: name => `页面现在是${name}模式。`, undo: name => `恢复为“${name}”`, reset: '页面已恢复为初始外观。' },
  },
}

/** The footer's text by locale. */
export const FOOTER_COPY: Readonly<Record<Locale, FooterCopy>> = {
  en: {
    navLabel: 'Footer',
    owner: 'Published by Delorun',
    licence: { label: 'MIT licence', href: `${GITHUB_URL}/blob/main/LICENSE` },
    upstream: { label: 'Built on DeepSeek Harness', href: UPSTREAM_URL },
    theme: THEME_COPY.en,
  },
  zh: {
    navLabel: '页脚',
    owner: '由 Delorun 发布',
    licence: { label: 'MIT 许可证', href: `${GITHUB_URL}/blob/main/LICENSE` },
    upstream: { label: '基于 DeepSeek Harness 构建', href: UPSTREAM_URL },
    theme: THEME_COPY.zh,
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
