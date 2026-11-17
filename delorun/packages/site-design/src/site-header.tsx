/**
 * The header both sites share: the mark (always peach) with the product name, the main links and the theme control at the
 * right edge. Links to the other Delorun site carry the visitor's look in their query.
 *
 * @module @delorun/site-design/site-header
 */
import type { ReactNode } from 'react'
import { Mark } from '../../brand/src/index.ts'
import { useLook } from './look-store.ts'
import { withLook } from './looks.ts'
import type { HeaderCopy, ShellLink } from './shell-copy.ts'
import { ThemeControl } from './theme-control.tsx'

/** Focus ring for the header's links. */
const FOCUS = 'rounded-(--dl-radius-xs) focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-(--dl-accent-text)'

/** The header bar, the mark with the name, and a row of items. */
const BAR = 'mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-5 py-5 sm:px-8' // us-spelling: quoted output (Tailwind class names)
const BRAND = 'flex items-center gap-2.5 font-semibold tracking-tight text-(--dl-text)' // us-spelling: quoted output (Tailwind class names)
const ROW = 'flex items-center gap-4 sm:gap-5' // us-spelling: quoted output (Tailwind class names)

/**
 * A link that carries the look when it goes to the other Delorun site. During server rendering and the first client render
 * it is the plain link, so the markup matches.
 * @param props.link - the link.
 * @param props.className - its classes.
 * @param props.children - its content; the link's label when absent.
 * @returns the anchor.
 */
export function SiteLink({ link, className, children }: { link: ShellLink; className?: string | undefined; children?: ReactNode }) {
  return <a href={useLinkHref(link)} className={className}>{children ?? link.label}</a>
}

/**
 * The address of a link: for a link to the other Delorun site, the address with the visitor's look in its query.
 * @param link - the link.
 * @returns the address; the plain one during server rendering and the first client render, so the markup matches.
 */
export function useLinkHref(link: ShellLink): string {
  const look = useLook()
  return link.site === 'other' ? withLook(link.href, look) : link.href
}

/**
 * The header.
 * @param props.copy - its text.
 * @param props.home - the link home.
 * @param props.links - the main links, in order.
 * @param props.leading - extra content between the links and the control, such as a search box.
 * @returns the header landmark.
 */
export function SiteHeader({ copy, home, links, leading }: { copy: HeaderCopy; home: string; links: readonly ShellLink[]; leading?: ReactNode }) {
  return (
    <header className={BAR}>
      <a href={home} className={`${BRAND} ${FOCUS}`}>
        <Mark size={28} />
        <span className="text-lg">{copy.title}</span>
      </a>
      <div className={ROW}>
        <nav aria-label={copy.navLabel} className={`${ROW} text-sm`}>
          {links.map(link => <SiteLink key={link.href} link={link} className={`text-(--dl-text-muted) hover:text-(--dl-text) ${FOCUS}`} />)}
        </nav>
        {leading}
        <ThemeControl copy={copy.theme} />
      </div>
    </header>
  )
}
