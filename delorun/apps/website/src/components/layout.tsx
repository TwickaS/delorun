/**
 * The page frame every route shares: a skip link, the header with the mark and the main links, the content and the
 * footer. The header and footer are plain landmarks with no script.
 *
 * @module @delorun/website/layout
 */
import type { ReactNode } from 'react'
import { SearchForm } from '@design/search-form.tsx'
import { SiteFooter } from '@design/site-footer.tsx'
import { SiteHeader } from '@design/site-header.tsx'
import { LookToaster } from '@design/look-toast.tsx'
import { FOOTER_COPY, FOOTER_LINKS, HEADER_COPY, HEADER_LINKS, SEARCH_COPY, THEME_COPY } from '@/site/shell-copy.ts'
import { DOCS_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import { SignupForm } from '@/components/signup.tsx'

/**
 * The page frame.
 * @param props.children - the page's content, which supplies its own sections.
 * @param props.signup - the path to record as the place of consent when the footer carries the sign-up form; false for a page without one (the home page has its own section, and the not-found page has no scripts).
 * @param props.closing - the footer's closing composition, passed to the shared footer.
 * @returns the frame.
 */
export function Frame({ children, signup = '/privacy', closing }: { children: ReactNode; signup?: string | false; closing?: ReactNode }) {
  return (
    <>
      <a href="#content" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-(--dl-text) focus:px-3 focus:py-2 focus:text-(--dl-surface)">{COPY.footer.skip}</a>
      <SiteHeader copy={HEADER_COPY} home="/" links={HEADER_LINKS} leading={<SearchForm action={DOCS_URL} copy={SEARCH_COPY} className="hidden w-48 lg:block" />} />
      <div id="content" tabIndex={-1} className="flex-1 outline-none">{children}</div>
      <SiteFooter copy={FOOTER_COPY} links={FOOTER_LINKS} closing={closing}
        top={signup === false ? null : (
          <section aria-labelledby="footer-updates" className="max-w-xl text-(--dl-text)">
            <h2 id="footer-updates" className="mb-4 text-base font-semibold">{COPY.signup.footerHeading}</h2>
            <SignupForm page={signup} compact />
          </section>
        )} />
      <LookToaster copy={THEME_COPY} />
    </>
  )
}
