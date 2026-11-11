/**
 * The header every layout shows: the site title linking a home page, and links beside it. It takes its text and
 * addresses from the caller and reads no content, so another site can use it with its own.
 *
 * @module @delo/docs/theme/header
 */
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared'

/** A link the header shows beside the title. */
export interface HeaderLink {
  readonly text: string
  readonly url: string
  /** Whether the link leaves the site, which opens it as an external link. */
  readonly external: boolean
}

/** What the header shows. */
export interface HeaderOptions {
  readonly title: string
  readonly homeUrl: string
  readonly links: readonly HeaderLink[]
}

/**
 * The layout options that draw the header.
 * @param options - the title, its home address and the links.
 * @returns the options every Fumadocs layout takes.
 */
export function headerOptions(options: HeaderOptions): BaseLayoutProps {
  return {
    nav: { title: options.title, url: options.homeUrl },
    links: options.links.map(({ text, url, external }) => ({ text, url, external })),
  }
}
