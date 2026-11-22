/**
 * The text and links the shared header and footer show on this site, in English. The documentation site passes its own,
 * in each of its languages.
 *
 * @module @delorun/website/shell-copy
 */
import { LOOK_NAMES } from '@design/looks.ts'
import type { SearchCopy } from '@design/search-form.tsx'
import type { FooterCopy, HeaderCopy, ShellLink, ThemeCopy } from '@design/shell-copy.ts'
import { ARTICLE_COUNT } from '@/site/articles.ts'
import { DOCS_URL, GITHUB_URL, SUPPORT_EMAIL, UPSTREAM_URL } from '@/site/config.ts'
import { NOTICES_COPY } from '@/site/notices-copy.ts'
import { COPY } from '@/site/copy.ts'

/** The theme control's text. */
export const THEME_COPY: ThemeCopy = {
  open: 'Change the look of this page',
  title: 'Look',
  themes: 'Theme',
  scheme: 'Mode',
  device: 'System',
  light: 'Light',
  dark: 'Dark',
  back: 'Back to how it started',
  current: (name, scheme) => `This page is in ${name}${scheme === undefined ? '' : `, ${scheme.toLowerCase()}`}.`,
  names: LOOK_NAMES,
  toast: {
    region: 'Notifications',
    theme: name => `The page now looks like ${name}.`,
    scheme: name => `The page is now ${name.toLowerCase()}.`,
    undo: name => `Back to ${name}`,
    reset: 'The page is back to how it started.',
  },
}

/** The header's text. */
export const HEADER_COPY: HeaderCopy = { title: COPY.siteTitle, navLabel: COPY.footer.primaryNav, theme: THEME_COPY }

/** The header's links: Why Delorun, Docs, Blog once an article exists, and GitHub. */
export const HEADER_LINKS: readonly ShellLink[] = [
  { label: COPY.nav.why, href: `${DOCS_URL}/guide/why-delorun`, site: 'other' },
  { label: COPY.nav.docs, href: DOCS_URL, site: 'other' },
  ...ARTICLE_COUNT === 0 ? [] : [{ label: COPY.nav.blog, href: '/blog' }],
  { label: COPY.nav.github, href: GITHUB_URL },
]

/** The footer's text. */
export const FOOTER_COPY: FooterCopy = {
  navLabel: COPY.footer.footerNav,
  owner: COPY.footer.owner,
  licence: { label: COPY.footer.licence, href: `${GITHUB_URL}/blob/main/LICENSE` },
  upstream: { label: COPY.footer.upstream, href: UPSTREAM_URL },
  theme: THEME_COPY,
}

/** The footer's links, in order. */
export const FOOTER_LINKS: readonly ShellLink[] = [
  { label: COPY.footer.docs, href: DOCS_URL, site: 'other' },
  { label: COPY.footer.changelog, href: `${DOCS_URL}/changelog`, site: 'other' },
  { label: COPY.footer.roadmap, href: `${DOCS_URL}/guide/roadmap`, site: 'other' },
  { label: COPY.footer.why, href: `${DOCS_URL}/guide/why-delorun`, site: 'other' },
  { label: COPY.footer.questions, href: `${DOCS_URL}/guide/questions`, site: 'other' },
  { label: COPY.footer.knownIssues, href: `${DOCS_URL}/guide/known-issues`, site: 'other' },
  ...ARTICLE_COUNT === 0 ? [] : [{ label: COPY.footer.blog, href: '/blog' }],
  { label: COPY.footer.github, href: GITHUB_URL },
  { label: COPY.footer.privacy, href: '/privacy' },
  { label: NOTICES_COPY.footerLabel, href: '/notices' },
  { label: SUPPORT_EMAIL, href: `mailto:${SUPPORT_EMAIL}` },
]

/** The header's search field, which opens the documentation's search. */
export const SEARCH_COPY: SearchCopy = { label: 'Search the documentation', placeholder: 'Search the docs' }
