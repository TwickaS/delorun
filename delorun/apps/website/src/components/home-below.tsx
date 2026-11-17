/**
 * The home page below its first screen: the five claims, the four living sections, What's new, what comes next and the sign-up. The
 * page renders it on the server with the rest; in the browser its script and words load as their own chunk after the
 * first screen, and React keeps the server's markup in place until they arrive.
 *
 * @module @delorun/website/home-below
 */
import type { ReactNode } from 'react'
import view from 'virtual:delorun-changelog'
import { Frame as Picture, Link, SectionHeading } from '@brand'
import { DOCS_URL } from '@/site/config.ts'
import { SECTIONS_EN as WORDS } from '@/site/words/sections-en.ts'
import { SignupSection } from '@/components/signup-section.tsx'
import { StudioStill } from '@/components/studio-still.tsx'
import { NearScreen } from '@/components/near-screen.tsx'
import { PluginBrowserStill } from '@/plugin-browser/PluginBrowserStill.tsx'
import { GRID, SPACE } from '@/components/grid.ts'

/**
 * The home page's own rules as Tailwind classes, which compile into the site's one stylesheet, so this chunk's
 * prerendered markup is styled before its script arrives and with scripts off. Colours, durations and easing are the
 * brand's tokens.
 */
const CLASSES = {
  claims: 'col-span-full m-0 list-none border-b border-(--dl-border) p-0',
  claim: 'group grid grid-cols-4 items-baseline gap-x-(--grid-gap) border-t border-(--dl-border) py-(--dl-space-5) text-(--dl-text) no-underline focus-visible:rounded-(--dl-radius-xs) focus-visible:[outline:var(--dl-focus-ring)] focus-visible:[outline-offset:var(--dl-focus-ring-offset)] lg:grid-cols-12',
  number: 'text-[clamp(16px,0.9rem_+_0.4vw,20px)] text-(--dl-text-muted) tabular-nums lg:col-span-4',
  sentence: 'col-span-3 max-w-[34ch] text-[clamp(20px,0.95rem_+_1.1vw,32px)] font-medium leading-[1.2] tracking-[-0.02em] text-pretty underline decoration-transparent decoration-1 underline-offset-[0.18em] transition-[text-decoration-color] duration-(--dl-duration-quick) ease-(--dl-ease) group-focus-visible:decoration-current pointer-fine:group-hover:decoration-current lg:col-span-8',
  headline: 'text-[clamp(22px,1rem_+_1.2vw,36px)] font-medium leading-[1.15] tracking-[-0.02em] text-balance',
  // On a phone the desktop-width studio sits in a frame that scrolls sideways and snaps to its edges.
  sideways: 'focus-visible:rounded-(--dl-radius-xs) focus-visible:[outline:var(--dl-focus-ring)] focus-visible:[outline-offset:var(--dl-focus-ring-offset)] overflow-x-auto overscroll-x-contain snap-x snap-mandatory [scrollbar-width:thin] *:snap-start lg:overflow-visible',
} as const

/**
 * A still that holds a living section's place until its lane delivers the section: the box at the section's height,
 * with the caption that names what will be there.
 * @param props.caption - what the section shows.
 * @param props.className - the box's heights at each width.
 * @returns the box.
 */
function SectionStill({ caption, className }: { caption: string, className: string }) {
  return (
    <figure className={`col-span-full m-0 grid place-items-center rounded-(--dl-radius-md) border border-(--dl-border) bg-(--dl-surface-raised) p-6 text-center text-(--dl-text-muted) ${className}`}>
      <figcaption className="max-w-md text-sm">{caption}</figcaption>
    </figure>
  )
}

/**
 * The one link at the end of a living section to the guide page that teaches it.
 * @param props.link - the text and address.
 * @returns the line.
 */
function GuideLink({ link }: { link: { readonly text: string, readonly href: string } }) {
  return <p className="col-span-full mt-6 lg:col-start-9 lg:col-end-13"><Link href={link.href}>{link.text}</Link></p>
}

/**
 * A section of the page on the grid.
 * @param props.id - the heading's id, which names the section.
 * @param props.space - the space above it.
 * @param props.children - its content, placed on the grid.
 * @returns the section.
 */
function Section({ id, space, children }: { id: string, space: keyof typeof SPACE, children: ReactNode }) {
  return <section aria-labelledby={id} className={`${GRID} ${SPACE[space]}`}>{children}</section>
}

/**
 * The five claims: numbered rows, one sentence each, each row a link to the guide page that states it.
 * @returns the section.
 */
function Claims() {
  const copy = WORDS.claims
  return (
    <section aria-labelledby="claims" className={`${GRID} ${SPACE.normal}`}>
      <h2 id="claims" className="sr-only">{copy.heading}</h2>
      <ol role="list" className={CLASSES.claims}>
        {copy.items.map((claim, index) => (
          <li key={claim.href}>
            <a href={claim.href} className={CLASSES.claim}>
              <span className={CLASSES.number} aria-hidden="true">{index + 1}</span>
              <span className={CLASSES.sentence}>{claim.text}</span>
            </a>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Make it yours: the setup strip, the page's signature, with its heading on the left and its lead from column 9.
 * @returns the section.
 */
function MakeItYours() {
  const copy = WORDS.sections.makeItYours
  return (
    <Section id="make-it-yours" space="far">
      <SectionHeading id="make-it-yours" title={copy.heading} className="col-span-full lg:col-span-6" />
      <p className="col-span-full mt-4 max-w-md text-lg text-(--dl-text-muted) lg:col-start-9 lg:col-end-13 lg:mt-0 lg:self-end">{copy.lead}</p>
      <div className="col-span-full mt-10 lg:mt-14">
        <SectionStill caption={copy.still} className="h-[1040px] lg:h-[640px]" />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * Made of parts you can change: the plugin browser, with the heading and lead hanging from column 5.
 * @returns the section.
 */
function Parts() {
  const copy = WORDS.sections.parts
  return (
    <Section id="parts" space="normal">
      <SectionHeading id="parts" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-start-5 lg:col-end-12" />
      <div className="col-span-full mt-10 lg:mt-14">
        <NearScreen
          load={() => import('@/plugin-browser/PluginBrowser.tsx').then(module => ({ default: () => <module.PluginBrowser words={WORDS.plugins} /> }))}
          still={<PluginBrowserStill words={WORDS.plugins} />}
          // The plugin browser's box: the still fills it, and the live browser sets the same heights.
          className="h-[640px] min-[960px]:h-[560px]"
        />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * Watch it change: the replayed sessions edge to edge, with the heading on the left and the lead from column 9.
 * @returns the section.
 */
function Replays() {
  const copy = WORDS.sections.replays
  return (
    <Section id="replays" space="far">
      <SectionHeading id="replays" title={copy.heading} className="col-span-full lg:col-span-6" />
      <p className="col-span-full mt-4 max-w-md text-lg text-(--dl-text-muted) lg:col-start-9 lg:col-end-13 lg:mt-0 lg:self-end">{copy.lead}</p>
      <div className="col-span-full mt-10 lg:mt-14">
        <Picture width={1392} height={870} label={copy.still} still={<StudioStill alt="" />} />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * From your phone: the studio at desktop width on eight columns and at phone width on three, offset downwards. On a
 * phone the phone-width studio comes first and the wide one scrolls sideways.
 * @returns the section.
 */
function Phone() {
  const copy = WORDS.sections.phone
  return (
    <Section id="phone" space="normal">
      <SectionHeading id="phone" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-span-7" />
      <div className="col-span-full mt-10 grid grid-cols-subgrid gap-y-8 lg:mt-14">
        <div className="col-span-full lg:order-2 lg:col-start-10 lg:col-end-13 lg:mt-32">
          <Picture width={330} height={660} label={copy.narrowLabel} still={<StudioStill alt="" />} />
        </div>
        {/* Focusable so a keyboard can scroll it sideways on a phone; it names the studio it holds. */}
        <div role="region" aria-label={copy.wideLabel} tabIndex={0} className={`col-span-full lg:order-1 lg:col-start-1 lg:col-end-9 ${CLASSES.sideways}`}>
          <div className="w-[920px] max-w-none lg:w-auto">
            <Picture width={920} height={575} label={copy.wideLabel} still={<StudioStill alt="" />} />
          </div>
        </div>
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * What's new: the latest assembled version's headlines, set large. Absent until a version is assembled with headlines.
 * @returns the section, or nothing.
 */
function WhatsNew() {
  const latest = view?.versions[0]
  if (latest === undefined || latest.headlines.length === 0) return null
  const copy = WORDS.whatsNew
  return (
    <Section id="whats-new" space="far">
      <div className="col-span-full lg:col-span-4">
        <h2 id="whats-new" className="text-2xl font-semibold tracking-tight">{copy.heading}</h2>
        <p className="mt-2 text-sm tabular-nums text-(--dl-text-muted)">{copy.latest(latest.version, latest.date)}</p>
      </div>
      <div className="col-span-full mt-6 lg:col-start-5 lg:col-end-13 lg:mt-0">
        <ul className="m-0 grid list-none gap-4 p-0">
          {latest.headlines.map(headline => <li key={headline} className={CLASSES.headline}>{headline}</li>)}
        </ul>
        <p className="mt-8"><Link href={`${DOCS_URL}/changelog`}>{copy.full}</Link></p>
      </div>
    </Section>
  )
}

/**
 * What comes next, and teams: the heading and two short lines, each hanging from its own column.
 * @returns the section.
 */
function Next() {
  const copy = WORDS.next
  return (
    <Section id="next" space="far">
      <h2 id="next" className="col-span-full text-2xl font-semibold tracking-tight lg:col-span-4">{copy.heading}</h2>
      <p className="col-span-full mt-4 max-w-sm leading-7 lg:col-start-5 lg:col-end-9 lg:mt-0">
        {copy.roadmap.before}<Link href={copy.roadmapHref}>{copy.roadmap.linkText}</Link>{copy.roadmap.after}
      </p>
      <p className="col-span-full mt-4 max-w-sm leading-7 lg:col-start-9 lg:col-end-13 lg:mt-0">
        {copy.teams.before}<Link href={copy.teamsHref}>{copy.teams.linkText}</Link>{copy.teams.after}
      </p>
    </Section>
  )
}

/**
 * Everything below the first screen, in order.
 * @returns the sections.
 */
export function HomeBelow() {
  return (
    <>
      <Claims />
      <MakeItYours />
      <Parts />
      <Replays />
      <Phone />
      <WhatsNew />
      <Next />
      <SignupSection />
    </>
  )
}
