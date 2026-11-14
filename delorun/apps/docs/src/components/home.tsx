/**
 * The home page of a locale: the site's introduction and three entry points, for a new reader, a reader with a task and a developer.
 *
 * @module @delorun/docs/home
 */
import Link from 'fumadocs-core/link'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import { WhatsNew } from '@/components/changelog.tsx'
import { baseOptions } from '@/components/layout.tsx'
import { PageFooter } from '@design/footer.tsx'
import { COPY } from '@/site/copy.ts'
import { delorunVersion, htmlLangOf, prefixOf, type Locale } from '@/site/locale.ts'
import { routeOf } from '@/site/routes.ts'

/**
 * The home page.
 * @param props.locale - the locale, which selects the labels and the section routes.
 * @returns the page.
 */
export function Home({ locale }: { locale: Locale }) {
  const copy = COPY[locale]
  return (
    <HomeLayout {...baseOptions(locale)}>
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <h1 className="text-3xl font-semibold">{copy.siteTitle}</h1>
        <p className="mt-4 text-fd-muted-foreground">{copy.homeIntro}</p>
        <ul className="mt-8 space-y-4">
          <li>
            <Link href={routeOf('guide', ['install'], locale === 'zh')} className="font-medium">{copy.entries.newTitle}</Link>
            <p className="text-fd-muted-foreground">{copy.entries.newText}</p>
          </li>
          <li>
            <Link href={routeOf('guide', [], locale === 'zh')} className="font-medium">{copy.entries.taskTitle}</Link>
            <p className="text-fd-muted-foreground">{copy.entries.taskText}</p>
          </li>
          <li>
            <Link href={routeOf('reference', [], locale === 'zh')} className="font-medium">{copy.entries.developerTitle}</Link>
            <p className="text-fd-muted-foreground">{copy.entries.developerText}</p>
          </li>
        </ul>
        <WhatsNew locale={locale} />
        <PageFooter><p>{copy.describes(delorunVersion())}</p></PageFooter>
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
    <main className="mx-auto w-full max-w-3xl px-4 py-16">
      {(['en', 'zh'] as const).map(locale => (
        <section key={locale} lang={htmlLangOf(locale)} className="mb-12">
          <h1 className="text-3xl font-semibold">{COPY[locale].notFoundTitle}</h1>
          <p className="mt-4 text-fd-muted-foreground">{COPY[locale].notFoundText}</p>
          <p className="mt-4"><Link href={prefixOf(locale) || '/'}>{COPY[locale].siteTitle}</Link></p>
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
