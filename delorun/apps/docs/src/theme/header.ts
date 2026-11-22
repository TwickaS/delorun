/**
 * The header every layout shows: the Delorun mark and the site title linking a home page, the links beside it, and the
 * shared theme control in place of Fumadocs' own. It takes its text and addresses from the caller and reads no content,
 * so another site can use it with its own.
 *
 * @module @delorun/docs/theme/header
 */
import { createElement, Fragment, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import Link from 'fumadocs-core/link'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { ProductMark } from '@design/product-mark.tsx'
import { HIT, SiteLink } from '@design/site-header.tsx'
import { ThemeControl } from '@design/theme-control.tsx'
import type { ShellLink, ThemeCopy } from '@design/shell-copy.ts'

/** A link to a page of this site, which the header marks as the current one while the visitor is inside it. */
export interface NavItem {
  readonly label: string
  readonly href: string
  /** Whether a site path lies inside what the link names. */
  readonly contains: (pathname: string) => boolean
}

/**
 * A header link to a page of this site. It navigates inside the app and marks itself current with `aria-current`.
 * @param props.item - the link.
 * @returns the anchor.
 */
function NavLink({ item }: { item: NavItem }) {
  const pathname = useRouterState({ select: state => state.location.pathname })
  const current = item.contains(pathname)
  return createElement(Link, { href: item.href, className: `${HIT} text-sm ${current ? 'font-medium text-fd-foreground' : 'text-fd-muted-foreground hover:text-fd-foreground'}`, ...(current ? { 'aria-current': 'page' as const } : {}) }, item.label)
}

/** What the header shows. */
export interface HeaderOptions {
  readonly title: string
  readonly homeUrl: string
  /** The links to this site's own pages, before the links to other addresses. */
  readonly nav: readonly NavItem[]
  readonly links: readonly ShellLink[]
  readonly theme: ThemeCopy
}

/**
 * The layout options that draw the header.
 * @param options - the title, its home address, the links and the theme control's text.
 * @returns the options every Fumadocs layout takes. Fumadocs' own theme switch is replaced by the shared control, and the
 *   links to the other Delorun site carry the visitor's look.
 */
export function headerOptions(options: HeaderOptions): BaseLayoutProps {
  const control: ReactNode = createElement(ThemeControl, { copy: options.theme })
  return {
    // Below the medium width the sidebar and its theme switch are folded away, so the control also sits in the bar there.
    nav: { title: createElement(Fragment, null, createElement(ProductMark, { size: 22 }), options.title), url: options.homeUrl, children: createElement('div', { className: 'flex justify-end md:hidden' }, control) },
    links: [
      ...options.nav.map(item => ({ type: 'custom' as const, children: createElement(NavLink, { item }) })),
      ...options.links.map(link => ({ type: 'custom' as const, children: createElement(SiteLink, { link, className: HIT }) })),
    ],
    themeSwitch: { component: control },
  }
}
