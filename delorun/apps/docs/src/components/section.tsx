/**
 * A section page: its route loader, its document head and its rendering inside the section's sidebar layout. The
 * loader reads the page sources, which the browser also holds, so a page renders on navigation without a server.
 *
 * @module @delorun/docs/section
 */
import { notFound } from '@tanstack/react-router'
import Link from 'fumadocs-core/link'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsPage } from 'fumadocs-ui/layouts/docs/page'
import defaultMdxComponents from 'fumadocs-ui/mdx'
import { use } from 'react'
import { docsOptions } from '@/components/layout.tsx'
import { PageFooter } from '@design/footer.tsx'
import { pageHead } from '@/site/head.ts'
import { COPY } from '@/site/copy.ts'
import { delorunVersion, htmlLangOf, type Locale } from '@/site/locale.ts'
import { routeOf, type Section } from '@/site/routes.ts'
import { sources } from '@/site/source.ts'

/** What a section route's loader returns: the page's address and the head's text. */
export interface SectionPageData {
  readonly section: Section
  readonly locale: Locale
  readonly slugs: string[]
  readonly title: string
  readonly description: string | undefined
}

/**
 * Load a section page: find it and load its compiled content, so it renders without suspending.
 * @param section - the section.
 * @param locale - the locale.
 * @param splat - the route's path after the section, empty for the section index.
 * @returns the page's data.
 * @throws the router's not-found error when no page has that path in the locale.
 */
export async function loadSectionPage(section: Section, locale: Locale, splat: string | undefined): Promise<SectionPageData> {
  const slugs = (splat ?? '').split('/').filter(part => part !== '')
  const page = sources[section].getPage(slugs, locale)
  if (page === undefined) throw notFound()
  await page.data.preload()
  return { section, locale, slugs, title: page.data.title ?? '', description: page.data.description }
}

/**
 * The document head of a section page: its title is its first heading followed by the site's title, as the changelog
 * page's is, its description is the frontmatter's, and its canonical URL is its route on the published site.
 * @param data - the loader's data, absent when the page was not found.
 * @returns the head's meta and link tags.
 */
export function sectionHead(data: SectionPageData | undefined) {
  if (data === undefined) return {}
  return pageHead({ title: `${data.title} · ${COPY[data.locale].siteTitle}`, description: data.description, path: routeOf(data.section, data.slugs, data.locale === 'zh'), locale: data.locale })
}

/**
 * A page of a section in the section's sidebar layout, with the version it describes and a link to the same page in
 * the other locale.
 * @param props - the loader's data.
 * @returns the page.
 * @throws the router's not-found error when no page has those slugs in the locale.
 */
export function SectionPage({ section, locale, slugs }: SectionPageData) {
  const source = sources[section]
  const page = source.getPage(slugs, locale)
  if (page === undefined) throw notFound()
  const { toc } = use(page.data.load())
  const Body = page.data.body
  const copy = COPY[locale]
  const other: Locale = locale === 'en' ? 'zh' : 'en'
  const version = delorunVersion()
  return (
    <DocsLayout {...docsOptions(locale)} tree={source.getPageTree(locale)}>
      <DocsPage toc={toc}>
        <DocsBody>
          <Body components={defaultMdxComponents} />
        </DocsBody>
        <PageFooter>
          {version === undefined ? null : <p>{copy.describes(version)}</p>}
          <p>
            <Link href={routeOf(section, slugs, other === 'zh')} hrefLang={htmlLangOf(other)} lang={htmlLangOf(other)} title={copy.switchLabel}>
              {copy.switchTo}
            </Link>
          </p>
        </PageFooter>
      </DocsPage>
    </DocsLayout>
  )
}
