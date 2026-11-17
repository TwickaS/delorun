/**
 * The home page: one long page in ten parts, the header, the hero, five claims, the four living sections, What's new,
 * what comes next, the sign-up and the closing footer. Every part sits on one grid, twelve columns on a wide screen and
 * four on a phone, with text hanging from columns 1, 5 and 9. The parts below the first screen are a separate chunk
 * (`home-below.tsx`): the server renders them with the rest, and the browser loads their script after the first screen.
 *
 * @module @delorun/website/home
 */
import { lazy, Suspense, type ReactNode } from 'react'
import { Link, SectionHeading } from '@brand'
import { COPY, INSTALL_COMMANDS } from '../site/copy.ts'
import { usePackageManager } from './package-manager.tsx'
import { DesktopButton } from './desktop-button.tsx'
import { CommandBlock, Install, ScriptsOff } from './install.tsx'
import { Frame } from './layout.tsx'
import { ReplicaFrame } from '../replica/ReplicaFrame.tsx'
import { GRID } from './grid.ts'
import { ChunkBoundary } from './chunk-boundary.tsx'

// The server imports the lower sections before it renders, so the prerendered page holds them in full and never a
// fallback. The browser loads them as a lazy chunk; while it loads during hydration React keeps the server's markup.
const below = import.meta.env.SSR ? await import('./home-below.tsx') : undefined
const HomeBelow = below?.HomeBelow ?? lazy(() => import('./home-below.tsx').then(module => ({ default: module.HomeBelow })))

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
        <ReplicaFrame session="ordinary-work" width="responsive" />
      </div>
    </section>
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
      <CommandBlock command={command} size="lg" main />
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
        <ChunkBoundary fallback={<p className={`${GRID} pt-24 text-(--dl-text-muted)`}>{COPY.partFailed}</p>}>
          <Suspense fallback={null}><HomeBelow /></Suspense>
        </ChunkBoundary>
      </main>
    </Frame>
  )
}
