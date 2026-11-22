/**
 * The home page of a locale: what Delorun is in plain words, the two first actions (install, and why Delorun), the
 * guide's two halves with the pages that start each, the closing links and the latest version's headlines.
 *
 * @module @delorun/docs/home
 */
import Link from 'fumadocs-core/link'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import view from 'virtual:delorun-changelog'
import { WhatsNew } from '@/components/changelog.tsx'
import { baseOptions } from '@/components/layout.tsx'
import { PageFooter } from '@design/footer.tsx'
import { COPY, type HomeLink } from '@/site/copy.ts'
import { delorunVersion, htmlLangOf, prefixOf, type Locale } from '@/site/locale.ts'
import { changelogRoute, roadmapRoute, routeOf } from '@/site/routes.ts'

/** The two actions' shared shape: a touch-sized target that shrinks a little while pressed. */
const ACTION = 'inline-flex min-h-11 items-center justify-center rounded-(--dl-radius-sm) px-5 text-sm font-medium transition-[transform,background-color,opacity] duration-(--dl-motion-press) ease-(--dl-ease-out) active:scale-(--dl-scale-pressed) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fd-ring'

/** A link in running text or in the closing row. */
const TEXT_LINK = 'font-medium text-fd-primary underline-offset-4 hover:underline'

/**
 * One page in a group: its title and the line that says what it helps you do, as one link.
 * @param props.link - the page.
 * @param props.chinese - whether the home page is the Chinese one.
 * @returns the list item.
 */
function GroupLink({ link, chinese }: { link: HomeLink, chinese: boolean }) {
  return (
    <li>
      <Link href={routeOf(link.section, link.slugs, chinese)} className="block rounded-(--dl-radius-sm) px-3 py-3 transition-colors duration-(--dl-motion-quick) hover:bg-fd-accent focus-visible:outline-2 focus-visible:outline-fd-ring">
        <span className="font-medium text-fd-foreground">{link.title}</span>
        <span className="mt-0.5 block text-sm text-(--dl-text-muted)">{link.text}</span>
      </Link>
    </li>
  )
}

/**
 * The home page.
 * @param props.locale - the locale, which selects the labels and the section routes.
 * @returns the page.
 */
export function Home({ locale }: { locale: Locale }) {
  const copy = COPY[locale]
  const home = copy.home
  const chinese = locale === 'zh'
  const glossary = routeOf('reference', ['glossary'], chinese)
  const version = delorunVersion()
  return (
    <HomeLayout {...baseOptions(locale)}>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 pt-12 pb-16 md:px-6 md:pt-20">
        <section aria-labelledby="home-title" className="max-w-2xl">
          <h1 id="home-title" className="text-4xl font-semibold tracking-tight md:text-5xl">{copy.siteTitle}</h1>
          <p className="mt-5 text-lg leading-relaxed">{home.lead}</p>
          <p className="mt-3 text-(--dl-text-muted)">
            {home.glossary.before}
            <Link href={glossary} className={TEXT_LINK}>{home.glossary.link}</Link>
            {home.glossary.after}
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={routeOf('guide', ['get-started', 'install'], chinese)} className={`${ACTION} bg-fd-primary text-fd-primary-foreground hover:opacity-90`}>{home.install}</Link>
            <Link href={routeOf('guide', ['why-delorun'], chinese)} className={`${ACTION} border border-fd-border bg-fd-card text-fd-foreground hover:bg-fd-accent`}>{home.why}</Link>
          </div>
          <p className="mt-6 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-(--dl-text-muted)">
            <span>{home.command}</span>
            <code className="rounded-(--dl-radius-xs) bg-fd-muted px-1.5 py-0.5 font-mono text-fd-foreground">npx delorun</code>
            <span>{home.platforms}</span>
          </p>
        </section>
        <div className="mt-14 grid gap-10 md:mt-20 md:grid-cols-2 md:gap-12">
          {home.groups.map((group, index) => (
            <section key={group.title} aria-labelledby={`home-group-${String(index)}`}>
              <h2 id={`home-group-${String(index)}`} className="text-lg font-semibold">{group.title}</h2>
              <ul className="-mx-3 mt-3 space-y-1">
                {group.links.map(link => <GroupLink key={link.title} link={link} chinese={chinese} />)}
              </ul>
            </section>
          ))}
        </div>
        <nav aria-labelledby="home-more" className="mt-14 border-t border-fd-border pt-8">
          <h2 id="home-more" className="text-lg font-semibold">{home.more.title}</h2>
          <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <li><Link href={routeOf('guide', [], chinese)} className={TEXT_LINK}>{home.more.everyTask}</Link></li>
            <li><Link href={glossary} className={TEXT_LINK}>{home.more.glossary}</Link></li>
            <li><Link href={roadmapRoute(chinese)} className={TEXT_LINK}>{copy.nav.roadmap}</Link></li>
            {view === null ? null : <li><Link href={changelogRoute(chinese)} className={TEXT_LINK}>{copy.nav.changelog}</Link></li>}
          </ul>
        </nav>
        <WhatsNew locale={locale} />
        {version === undefined ? null : <PageFooter><p>{copy.describes(version)}</p></PageFooter>}
      </main>
    </HomeLayout>
  )
}

/**
 * The page for an address no page has, in both locales at once, since the one 404.html serves every address. It has
 * no layout controls: the build writes 404.html without scripts, so nothing on it would respond.
 * @returns the page.
 */
export function NotFound() {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-16">
      {(['en', 'zh'] as const).map(locale => (
        <section key={locale} lang={htmlLangOf(locale)} className="mb-12">
          <h1 className="text-3xl font-semibold">{COPY[locale].notFoundTitle}</h1>
          <p className="mt-4 text-(--dl-text-muted)">{COPY[locale].notFoundText}</p>
          <ul className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            <li><Link href={routeOf('guide', [], locale === 'zh')} className={TEXT_LINK}>{COPY[locale].guideLabel}</Link></li>
            <li><Link href={prefixOf(locale) || '/'} className={TEXT_LINK}>{COPY[locale].siteTitle}</Link></li>
          </ul>
        </section>
      ))}
    </main>
  )
}

/**
 * The document head of the not-found page.
 * @returns its title and the instruction that search engines leave it out.
 */
export function notFoundHead() {
  return { meta: [{ title: `${COPY.en.notFoundTitle} · ${COPY.zh.notFoundTitle}` }, { name: 'robots', content: 'noindex' }] }
}
