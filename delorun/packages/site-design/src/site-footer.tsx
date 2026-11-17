/**
 * The footer both sites share: a slot for the closing composition, the link list, "Back to how it started", and the
 * owner, licence and upstream credit.
 *
 * @module @delorun/site-design/site-footer
 */
import type { ReactNode } from 'react'
import { Link } from '../../brand/src/index.ts'
import type { Look } from './looks.ts'
import type { FooterCopy, ShellLink } from './shell-copy.ts'
import { SiteLink, useLinkHref } from './site-header.tsx'
import { BackToStart } from './theme-control.tsx'

/**
 * One link of the list.
 * @param props.link - the link.
 * @returns the link.
 */
function FooterLink({ link }: { link: ShellLink }) {
  return <Link href={useLinkHref(link)}>{link.label}</Link>
}

/**
 * The footer.
 * @param props.copy - its text.
 * @param props.links - the link list, in order.
 * @param props.top - content above the links, such as a sign-up form.
 * @param props.closing - the closing composition of the product site, between the content and the links.
 * @param props.onLookChange - called when the visitor returns the page to how it started.
 * @returns the footer landmark.
 */
export function SiteFooter({ copy, links, top, closing, onLookChange }: { copy: FooterCopy; links: readonly ShellLink[]; top?: ReactNode; closing?: ReactNode; onLookChange?: ((previous: Look, next: Look) => void) | undefined }) {
  return (
    <footer className="mt-24 border-t border-(--dl-border)">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10 text-sm text-(--dl-text-muted) sm:px-8">
        {top}
        {closing}
        <nav aria-label={copy.navLabel}>
          <ul className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {links.map(link => <li key={link.href}><FooterLink link={link} /></li>)}
          </ul>
        </nav>
        <BackToStart label={copy.back} onReset={onLookChange} className="self-start" />
        <div className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <p>{copy.owner} &middot; <SiteLink link={copy.licence} /></p>
          <p className="self-end text-xs sm:self-auto"><SiteLink link={copy.upstream} /></p>
        </div>
      </div>
    </footer>
  )
}
