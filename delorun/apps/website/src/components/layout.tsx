/**
 * The page frame every route shares: a skip link, the header with the mark and the main links, the content and the
 * footer. The header and footer are plain landmarks with no script.
 *
 * @module @delorun/website/layout
 */
import type { ReactNode } from 'react'
import { Link as TextLink } from '@brand'
import { Mark } from '@design/mark.tsx'
import { DOCS_URL, GITHUB_URL, UPSTREAM_URL, SUPPORT_EMAIL } from '@/site/config.ts'
import { ARTICLES } from '@/site/articles.ts'
import { COPY } from '@/site/copy.ts'
import { SignupForm } from '@/components/signup.tsx'

/** Focus ring for every link and button on the site. */
const FOCUS = 'rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-fd-foreground'

/**
 * The page frame.
 * @param props.children - the page's content, which supplies its own sections.
 * @param props.signup - the path to record as the place of consent when the footer carries the sign-up form; false for a page without one (the home page has its own section, and the not-found page has no scripts).
 * @returns the frame.
 */
export function Frame({ children, signup = '/privacy' }: { children: ReactNode; signup?: string | false }) {
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
          {ARTICLES.length === 0 ? null : <a href="/blog" className={`text-fd-muted-foreground hover:text-fd-foreground ${FOCUS}`}>{nav.blog}</a>}
          <a href={GITHUB_URL} className={`text-fd-muted-foreground hover:text-fd-foreground ${FOCUS}`}>{nav.github}</a>
        </nav>
      </header>
      <div id="content" tabIndex={-1} className="flex-1 outline-none">{children}</div>
      <footer className="mt-24 border-t border-fd-border">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10 text-sm text-fd-muted-foreground sm:px-8">
          {signup === false ? null : (
            <section aria-labelledby="footer-updates" className="max-w-xl text-fd-foreground">
              <h2 id="footer-updates" className="mb-4 text-base font-semibold">{COPY.signup.footerHeading}</h2>
              <SignupForm page={signup} compact />
            </section>
          )}
          <nav aria-label={COPY.footer.footerNav}>
            <ul className="flex flex-wrap gap-x-6 gap-y-2">
              <li><TextLink href={DOCS_URL}>{COPY.footer.docs}</TextLink></li>
              <li><TextLink href={`${DOCS_URL}/changelog`}>{COPY.footer.changelog}</TextLink></li>
              <li><TextLink href={`${DOCS_URL}/guide/roadmap`}>{COPY.footer.roadmap}</TextLink></li>
              <li><TextLink href={`${DOCS_URL}/guide/questions`}>{COPY.footer.questions}</TextLink></li>
              <li><TextLink href={`${DOCS_URL}/guide/known-issues`}>{COPY.footer.knownIssues}</TextLink></li>
              {ARTICLES.length === 0 ? null : <li><TextLink href="/blog">{COPY.footer.blog}</TextLink></li>}
              <li><TextLink href={GITHUB_URL}>{COPY.footer.github}</TextLink></li>
              <li><TextLink href="/privacy">{COPY.footer.privacy}</TextLink></li>
              <li><TextLink href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</TextLink></li>
            </ul>
          </nav>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
            <p>
              {COPY.footer.owner} &middot; <TextLink href={`${GITHUB_URL}/blob/main/LICENSE`}>{COPY.footer.licence}</TextLink>
            </p>
            <p className="self-end text-xs opacity-75 sm:self-auto">
              <TextLink href={UPSTREAM_URL}>{COPY.footer.upstream}</TextLink>
            </p>
          </div>
        </div>
      </footer>
    </>
  )
}
