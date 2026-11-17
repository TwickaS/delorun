/**
 * The header every layout shows: the Delorun mark and the site title linking a home page, the links beside it, and the
 * shared theme control in place of Fumadocs' own. It takes its text and addresses from the caller and reads no content,
 * so another site can use it with its own.
 *
 * @module @delorun/docs/theme/header
 */
import { createElement, Fragment, type ReactNode } from 'react'
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'
import { ProductMark } from '@design/product-mark.tsx'
import { SiteLink } from '@design/site-header.tsx'
import { ThemeControl } from '@design/theme-control.tsx'
import type { ShellLink, ThemeCopy } from '@design/shell-copy.ts'

/** What the header shows. */
export interface HeaderOptions {
  readonly title: string
  readonly homeUrl: string
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
    links: options.links.map(link => ({ type: 'custom' as const, children: createElement(SiteLink, { link }) })),
    themeSwitch: { component: control },
  }
}
