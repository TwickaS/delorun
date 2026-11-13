/**
 * The page frame every route shares: a skip link, the header with the mark and the main links, the content and the
 * footer. The header and footer are plain landmarks with no script.
 *
 * @module @delo/website/layout
 */
import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Mark } from '@design/mark.tsx'
import { DOCS_URL, GITHUB_URL, UPSTREAM_URL, SUPPORT_EMAIL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'

/** Focus ring for every link and button on the site. */
const FOCUS = 'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-foreground'

/** The classes of a quiet text link. */
export const LINK = `underline decoration-fd-border decoration-2 underline-offset-4 hover:decoration-fd-foreground ${FOCUS}`

/**
 * The page frame.
 * @param props.children - the page's content, which supplies its own sections.
 * @returns the frame.
 */
export function Frame({ children }: { children: ReactNode }) {
  const nav = COPY.nav
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-fd-foreground focus:px-3 focus:py-2 focus:text-fd-background">{COPY.footer.skip}</a>
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-5 sm:px-8">
        <a href="/" className={`flex items-center gap-2.5 font-semibold tracking-tight ${FOCUS}`}>
          <Mark size={28} />
          <span className="text-lg">{COPY.siteTitle}</span>
        </a>
        <nav aria-label={COPY.footer.primaryNav} className="flex items-center gap-5 text-sm">
          <a href={DOCS_URL} className={`font-medium ${FOCUS}`}>{nav.docs}</a>
          <a href={GITHUB_URL} className={`text-fd-muted-foreground hover:text-fd-foreground ${FOCUS}`}>{nav.github}</a>
        </nav>
      </header>
      <div id="content" tabIndex={-1} className="flex-1 outline-none">{children}</div>
      <footer className="mt-24 border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10 text-sm text-fd-muted-foreground sm:px-8">
          <nav aria-label={COPY.footer.footerNav}>
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              <li><a href={DOCS_URL} className={LINK}>{COPY.footer.docs}</a></li>
              <li><a href={`${DOCS_URL}/changelog`} className={LINK}>{COPY.footer.changelog}</a></li>
              <li><a href={`${DOCS_URL}/guide/roadmap`} className={LINK}>{COPY.footer.roadmap}</a></li>
              <li><a href={GITHUB_URL} className={LINK}>{COPY.footer.github}</a></li>
              <li><Link to="/privacy" className={LINK}>{COPY.footer.privacy}</Link></li>
              <li><a href={`mailto:${SUPPORT_EMAIL}`} className={LINK}>{SUPPORT_EMAIL}</a></li>
            </ul>
          </nav>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <p>
              {COPY.footer.owner} &middot; <a href={`${GITHUB_URL}/blob/v5/LICENSE`} className={LINK}>{COPY.footer.licence}</a>
            </p>
            <p className="self-end text-xs opacity-75 sm:self-auto">
              <a href={UPSTREAM_URL} className={LINK}>{COPY.footer.upstream}</a>
            </p>
          </div>
        </div>
      </footer>
    </>
  )
}
