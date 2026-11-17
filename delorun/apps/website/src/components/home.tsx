/**
 * The home page: one long page in ten parts, the header, the hero, five claims, the four living sections, What's new,
 * what comes next, the sign-up and the closing footer. Every part sits on one grid, twelve columns on a wide screen and
 * four on a phone, with text hanging from columns 1, 5 and 9. Each living section shows a still until its own script
 * loads, and keeps it with scripts off.
 *
 * @module @delorun/website/home
 */
import type { ReactNode } from 'react'
import view from 'virtual:delorun-changelog'
import { Frame as Picture, Link, SectionHeading } from '@brand'
import { DOCS_URL, HERO_IMAGE_PATH } from '@/site/config.ts'
import { COPY, INSTALL_COMMANDS } from '@/site/copy.ts'
import { usePackageManager } from '@/components/package-manager.tsx'
import { DesktopButton } from '@/components/desktop-button.tsx'
import { CommandBlock, Install, ScriptsOff } from '@/components/install.tsx'
import { Frame } from '@/components/layout.tsx'
import { SignupSection } from '@/components/signup.tsx'
import { GRID, SPACE } from '@/components/grid.ts'
import css from './home.module.css'

/** The studio picture's own size, which fixes the hero frame's shape. */
const STUDIO_STILL = { width: 1440, height: 900 } as const

/**
 * The studio picture as a still.
 * @param props.alt - its text alternative; empty where a caption names the frame.
 * @param props.eager - true in the hero, which is on the first screen.
 * @returns the picture.
 */
function StudioStill({ alt, eager = false }: { alt: string, eager?: boolean }) {
  return <img src={HERO_IMAGE_PATH} alt={alt} width={STUDIO_STILL.width} height={STUDIO_STILL.height} loading={eager ? 'eager' : 'lazy'} decoding="async" />
}

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
 * The hero: the statement, the install command, the desktop button and the platform line on the left, the studio at
 * work on the right. On a phone they stack in that order.
 * @param props.install - the install command with its choice.
 * @returns the hero.
 */
function Hero({ install }: { install: ReactNode }) {
  const copy = COPY.hero
  return (
    <section aria-labelledby="hero" className={`${GRID} gap-y-12 pt-10 lg:items-start lg:pt-20`}>
      <div className="col-span-full flex flex-col gap-8 lg:col-span-5">
        <SectionHeading level={1} id="hero" title={copy.title} lead={copy.subline} />
        <div className="grid max-w-xl gap-5">
          {install}
          <DesktopButton />
        </div>
        <p className="max-w-xl text-sm text-(--dl-text-muted)">
          {copy.platform.before}<Link href={copy.platform.href}>{copy.platform.linkText}</Link>{copy.platform.after}
          {copy.status.before}<Link href={copy.status.href}>{copy.status.linkText}</Link>{copy.status.after}
        </p>
      </div>
      <div className="col-span-full lg:col-start-6 lg:col-end-13">
        <Picture width={800} height={500} label={copy.replicaLabel} still={<StudioStill alt={copy.stillAlt} eager />} />
      </div>
    </section>
  )
}

/**
 * The five claims: numbered rows, one sentence each, each row a link to the guide page that states it.
 * @returns the section.
 */
function Claims() {
  const copy = COPY.claims
  return (
    <section aria-labelledby="claims" className={`${GRID} ${SPACE.normal}`}>
      <h2 id="claims" className="sr-only">{copy.heading}</h2>
      <ol className={`col-span-full m-0 list-none p-0 ${css.claims}`}>
        {copy.items.map((claim, index) => (
          <li key={claim.href}>
            <a href={claim.href} className={css.claim}>
              <span className={css.number} aria-hidden="true">{index + 1}</span>
              <span className={css.sentence}>{claim.text}</span>
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
  const copy = COPY.sections.makeItYours
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
  const copy = COPY.sections.parts
  return (
    <Section id="parts" space="normal">
      <SectionHeading id="parts" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-start-5 lg:col-end-12" />
      <div className="col-span-full mt-10 lg:mt-14">
        <SectionStill caption={copy.still} className="h-[640px] lg:h-[560px]" />
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
  const copy = COPY.sections.replays
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
  const copy = COPY.sections.phone
  return (
    <Section id="phone" space="normal">
      <SectionHeading id="phone" title={copy.heading} lead={copy.lead} className="col-span-full lg:col-span-7" />
      <div className="col-span-full mt-10 grid grid-cols-subgrid gap-y-8 lg:mt-14">
        <div className="col-span-full lg:order-2 lg:col-start-10 lg:col-end-13 lg:mt-32">
          <Picture width={330} height={660} label={copy.narrowLabel} still={<StudioStill alt="" />} />
        </div>
        <div className={`col-span-full lg:order-1 lg:col-start-1 lg:col-end-9 ${css.sideways}`}>
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
export function WhatsNew() {
  const latest = view?.versions[0]
  if (latest === undefined || latest.headlines.length === 0) return null
  const copy = COPY.whatsNew
  return (
    <Section id="whats-new" space="far">
      <div className="col-span-full lg:col-span-4">
        <h2 id="whats-new" className="text-2xl font-semibold tracking-tight">{copy.heading}</h2>
        <p className="mt-2 text-sm tabular-nums text-(--dl-text-muted)">{copy.latest(latest.version, latest.date)}</p>
      </div>
      <div className="col-span-full mt-6 lg:col-start-5 lg:col-end-13 lg:mt-0">
        <ul className="m-0 grid list-none gap-4 p-0">
          {latest.headlines.map(headline => <li key={headline} className={css.headline}>{headline}</li>)}
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
  const copy = COPY.next
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
 * The closing composition above the footer's links: the install command again at headline size and the desktop button.
 * @param props.command - the command for the chosen package manager.
 * @returns the composition.
 */
export function Closing({ command }: { command: string }) {
  return (
    <section aria-labelledby="closing" className="grid gap-6 text-(--dl-text)">
      <h2 id="closing" className="sr-only">{COPY.closing.heading}</h2>
      <CommandBlock command={command} size="lg" />
      <DesktopButton />
    </section>
  )
}

/**
 * The home page.
 * @returns the page.
 */
export function Home() {
  const [manager, setManager] = usePackageManager()
  return (
    <Frame signup={false} closing={<Closing command={INSTALL_COMMANDS[manager]} />}>
      <ScriptsOff />
      <main>
        <Hero install={<Install manager={manager} onChange={setManager} />} />
        <Claims />
        <MakeItYours />
        <Parts />
        <Replays />
        <Phone />
        <WhatsNew />
        <Next />
        <SignupSection />
      </main>
    </Frame>
  )
}
