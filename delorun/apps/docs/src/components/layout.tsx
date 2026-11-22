/**
 * The site's header in each locale: the shared header's title, the locale's home page, the links to the guide, the
 * reference, the changelog and the roadmap, the link to the product site and the shared theme control.
 *
 * @module @delorun/docs/layout
 */
import { createElement, type ReactNode } from 'react'
import type { BaseLayoutProps, LayoutTab } from 'fumadocs-ui/layouts/shared'
import view from 'virtual:delorun-changelog'
import { SidebarFooter } from '@/components/sidebar-footer.tsx'
import { headerOptions, type NavItem } from '@/theme/header.ts'
import { COPY } from '@/site/copy.ts'
import { prefixOf, type Locale } from '@/site/locale.ts'
import { changelogRoute, routeOf, roadmapRoute } from '@/site/routes.ts'
import { productLink, THEME_COPY } from '@/site/shell-copy.ts'

/**
 * The header's links to this site's pages, in order: the guide, the reference, the changelog when the build published
 * one, and the roadmap.
 * @param locale - the locale.
 * @returns the links.
 */
function navItems(locale: Locale): NavItem[] {
  const chinese = locale === 'zh'
  const copy = COPY[locale].nav
  const guide = routeOf('guide', [], chinese)
  const reference = routeOf('reference', [], chinese)
  const roadmap = roadmapRoute(chinese)
  const changelog = changelogRoute(chinese)
  return [
    { label: copy.guide, href: guide, contains: path => path.startsWith(guide) && path !== roadmap },
    { label: copy.reference, href: reference, contains: path => path.startsWith(reference) },
    ...(view === null ? [] : [{ label: copy.changelog, href: changelog, contains: (path: string) => path === changelog }]),
    { label: copy.roadmap, href: roadmap, contains: path => path === roadmap },
  ]
}

/**
 * The shared layout options of a locale.
 * @param locale - the locale, which selects the labels and the home page.
 * @param inHeader - whether the header carries the links to the site's pages and to the product site; false in a docs layout, which shows the pages as tabs and links the product site from the footer.
 * @returns the header's title, links and theme control.
 */
export function baseOptions(locale: Locale, inHeader = true): BaseLayoutProps {
  return headerOptions({
    title: COPY[locale].siteTitle,
    homeUrl: prefixOf(locale) || '/',
    nav: inHeader ? navItems(locale) : [],
    links: inHeader ? [productLink(locale)] : [],
    theme: THEME_COPY[locale],
  })
}

/**
 * The layout options of a docs page: the header's links are the tabs above the page from the medium width on, and the
 * sidebar drawer's tab menu below it, so the sidebar carries no copy of them and no bare link to the product site. The
 * sidebar and the drawer end in one footer row, the language picker and the theme control, in place of Fumadocs' own
 * language picker, theme switch and the empty box around them.
 * @param locale - the locale.
 * @returns the layout options, the tabs and the sidebar's footer.
 */
export function docsOptions(locale: Locale): BaseLayoutProps & { tabs: LayoutTab[], tabMode: 'top', sidebar: { footer: ReactNode } } {
  const { nav: { children: _bar, ...nav } = {}, ...base } = baseOptions(locale, false)
  return {
    ...base,
    // The theme control is not in the narrow-screen bar: the drawer's footer row is the one place that changes the look.
    nav,
    i18n: false,
    themeSwitch: { enabled: false },
    sidebar: { footer: createElement(SidebarFooter, { theme: THEME_COPY[locale] }) },
    tabMode: 'top',
    tabs: navItems(locale).map(({ label, href }) => ({ title: label, url: href })),
  }
}
