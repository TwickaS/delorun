/**
 * The home page below its first screen: the five claims, the four living sections, What's new, what comes next and the sign-up. The
 * page renders it on the server with the rest; in the browser its script and words load as their own chunk after the
 * first screen, and React keeps the server's markup in place until they arrive.
 *
 * @module @delorun/website/home-below
 */
import type { ReactNode } from 'react'
import view from 'virtual:delorun-changelog'
import { Link, SectionHeading } from '@brand'
import { DOCS_URL } from '@/site/config.ts'
import { SECTIONS_EN as WORDS } from '@/site/words/sections-en.ts'
import { SignupSection } from '@/components/signup-section.tsx'
import { ReplicaFrame, ReplicaPair } from '@/replica/ReplicaFrame.tsx'
import { SetupStripStill } from '@/strip/still.tsx'
import { NearScreen } from '@/components/near-screen.tsx'
import { PluginBrowserStill } from '@/plugin-browser/PluginBrowserStill.tsx'
import { GRID, SPACE } from '@/components/grid.ts'
import { Claims } from '@/components/claims.tsx'

/**
 * The home page's own rules as Tailwind classes, which compile into the site's one stylesheet, so this chunk's
 * prerendered markup is styled before its script arrives and with scripts off. Colours, durations and easing are the
 * brand's tokens.
 */
const CLASSES = {
  lead: 'max-w-md text-lg text-(--dl-text-muted)',
  headline: 'text-[clamp(22px,1rem_+_1.2vw,36px)] font-medium leading-[1.15] tracking-[-0.02em] text-balance',
} as const

/**
 * The one link at the end of a living section to the guide page that teaches it.
 * @param props.link - the text and address.
 * @returns the line.
 */
function GuideLink({ link }: { link: { readonly text: string, readonly href: string } }) {
  return <p className="col-span-full mt-4 lg:col-start-9 lg:col-end-13"><Link href={link.href}>{link.text}</Link></p>
}

/** The space between a section's heading and its content. */
const CONTENT = 'col-span-full mt-8 lg:mt-10'

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
 * Make it yours: the setup strip, the page's signature, with its heading on the left and its lead from column 9.
 * @returns the section.
 */
function MakeItYours() {
  const copy = WORDS.sections.makeItYours
  return (
    <Section id="make-it-yours" space="far">
      <SectionHeading id="make-it-yours" title={copy.heading} className="col-span-full lg:col-span-6" />
      <p className={`col-span-full mt-4 lg:col-start-9 lg:col-end-13 lg:mt-0 lg:self-end ${CLASSES.lead}`}>{copy.lead}</p>
      <div className={CONTENT}>
        {/* The strip and its still set their own heights. */}
        <NearScreen load={() => import('@/strip/setup-strip.tsx')} still={<SetupStripStill />} />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * Made of parts you can change: the plugin browser, with the lead under the heading on the left half.
 * @returns the section.
 */
function Parts() {
  const copy = WORDS.sections.parts
  return (
    <Section id="parts" space="normal">
      <SectionHeading id="parts" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-span-7" />
      <div className={CONTENT}>
        <NearScreen
          load={() => import('@/plugin-browser/PluginBrowser.tsx').then(module => ({ default: () => <module.PluginBrowser words={WORDS.plugins} /> }))}
          still={<PluginBrowserStill words={WORDS.plugins} />}
        />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * Watch it change: the replayed sessions edge to edge, with the heading on the left and the lead from column 5.
 * @returns the section.
 */
function Replays() {
  const copy = WORDS.sections.replays
  return (
    <Section id="replays" space="far">
      <SectionHeading id="replays" title={copy.heading} className="col-span-full lg:col-span-4" />
      <p className={`col-span-full mt-4 lg:col-start-5 lg:col-end-10 lg:mt-0 lg:self-end ${CLASSES.lead}`}>{copy.lead}</p>
      <div className={CONTENT}>
        <ReplicaFrame session="changes-and-versions" width="responsive" />
      </div>
      <GuideLink link={copy.link} />
    </Section>
  )
}

/**
 * From your phone: the replayed session at desktop width and at phone width side by side, as the replica lays out its
 * pair.
 * @returns the section.
 */
function Phone() {
  const copy = WORDS.sections.phone
  return (
    <Section id="phone" space="normal">
      <SectionHeading id="phone" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-span-5" />
      <div className={CONTENT}>
        <ReplicaPair session="ordinary-work" />
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
    <Section id="next" space="normal">
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
