/**
 * The privacy page: what the website collects, what its host logs and what the Delorun program sends.
 *
 * @module @delo/website/privacy
 */
import { COPY } from '@/site/copy.ts'
import { Frame, LINK } from '@/components/layout.tsx'

/**
 * The privacy page.
 * @returns the page.
 */
export function Privacy() {
  const copy = COPY.privacy
  return (
    <Frame>
      <main className="mx-auto w-full max-w-2xl px-5 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-4xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">{copy.intro}</p>
        <h2 className="mt-12 text-xl font-semibold">{copy.siteHeading}</h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 leading-7">
          {copy.site.map(line => <li key={line}>{line}</li>)}
        </ul>
        <h2 className="mt-12 text-xl font-semibold">{copy.hostHeading}</h2>
        <p className="mt-3 leading-7">{copy.host}</p>
        <h2 className="mt-12 text-xl font-semibold">{copy.programHeading}</h2>
        <p className="mt-3 leading-7">{copy.program}</p>
        <ul className="mt-3 list-disc space-y-2 pl-5 leading-7">
          {copy.programLinks.map(link => <li key={link.href}><a href={link.href} className={LINK}>{link.text}</a></li>)}
        </ul>
        <h2 className="mt-12 text-xl font-semibold">{copy.contactHeading}</h2>
        <p className="mt-3 leading-7">{copy.contact}</p>
      </main>
    </Frame>
  )
}
