/**
 * The home page and the not-found page.
 *
 * @module @delo/website/home
 */
import view from 'virtual:delo-changelog'
import { DOCS_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import { Frame, LINK } from '@/components/layout.tsx'

/**
 * The install command and the first setup question, as a terminal would print them.
 * @returns the block, which a screen reader reads as plain text.
 */
function Terminal() {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-2 text-sm text-fd-muted-foreground">{COPY.terminalLabel}</figcaption>
      <pre tabIndex={0} aria-label={COPY.terminalLabel} className="whitespace-pre-wrap break-words rounded-xl border border-fd-border bg-fd-card p-4 font-mono text-[13px] leading-6 text-fd-card-foreground focus-visible:outline-2 focus-visible:outline-fd-foreground sm:p-5 sm:text-sm"><code>{COPY.terminal}</code></pre>
    </figure>
  )
}

/**
 * The What's new strip: the latest assembled version's headlines. Absent until a version is assembled.
 * @returns the section, or nothing.
 */
function WhatsNew() {
  const latest = view?.versions[0]
  if (latest === undefined) return null
  return (
    <section aria-labelledby="whats-new" className="mx-auto mt-20 w-full max-w-5xl px-5 sm:px-8">
      <h2 id="whats-new" className="text-2xl font-semibold tracking-tight">{COPY.whatsNew.heading}</h2>
      <p className="mt-2 text-sm text-fd-muted-foreground">{COPY.whatsNew.latest(latest.version, latest.date)}</p>
      <ul className="mt-4 list-disc space-y-1.5 pl-5">
        {latest.headlines.map(headline => <li key={headline}>{headline}</li>)}
      </ul>
      <p className="mt-4"><a href={`${DOCS_URL}/changelog`} className={LINK}>{COPY.whatsNew.full}</a></p>
    </section>
  )
}

/**
 * The home page.
 * @returns the page.
 */
export function Home() {
  return (
    <Frame>
      <main>
        <section className="mx-auto grid w-full max-w-5xl gap-10 px-5 pt-10 sm:px-8 sm:pt-16 lg:grid-cols-[1.1fr_1fr] lg:items-center lg:gap-14">
          <div>
            <h1 className="text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">{COPY.heroTitle}</h1>
            <p className="mt-5 max-w-xl text-lg leading-8 text-fd-muted-foreground">{COPY.heroText}</p>
            <p className="mt-8 text-sm font-medium">{COPY.installLabel}</p>
            <p className="mt-2"><code className="inline-block max-w-full rounded-lg bg-fd-foreground px-4 py-2.5 font-mono text-base text-fd-background">{COPY.installCommand}</code></p>
            <p className="mt-3 max-w-md text-sm text-fd-muted-foreground">{COPY.installNote}</p>
            <p className="mt-5"><a href={`${DOCS_URL}/guide/install`} className={`font-medium ${LINK}`}>{COPY.guideLink}</a></p>
          </div>
          <Terminal />
        </section>
        <section aria-labelledby="features" className="mx-auto mt-20 w-full max-w-5xl px-5 sm:px-8">
          <h2 id="features" className="text-2xl font-semibold tracking-tight">{COPY.featuresTitle}</h2>
          <ul className="mt-8 grid gap-x-10 gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
            {COPY.features.map(feature => (
              <li key={feature.title}>
                <h3 className="font-semibold">{feature.title}</h3>
                <p className="mt-2 leading-7 text-fd-muted-foreground">{feature.text}</p>
                <p className="mt-2 text-sm"><a href={feature.href} className={LINK}>{feature.linkText}</a></p>
              </li>
            ))}
          </ul>
        </section>
        <WhatsNew />
      </main>
    </Frame>
  )
}

/**
 * The page for an address no page has. It has no layout controls beyond links: the build writes 404.html without the
 * router's scripts.
 * @returns the page.
 */
export function NotFound() {
  return (
    <Frame>
      <main className="mx-auto w-full max-w-5xl px-5 pt-16 sm:px-8">
        <h1 className="text-3xl font-semibold tracking-tight">{COPY.notFound.title}</h1>
        <p className="mt-4 text-fd-muted-foreground">{COPY.notFound.text}</p>
        <p className="mt-6"><a href="/" className={LINK}>{COPY.notFound.home}</a></p>
      </main>
    </Frame>
  )
}
