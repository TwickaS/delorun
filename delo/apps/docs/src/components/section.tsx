import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { DocsLayout } from 'fumadocs-ui/layouts/docs'
import { DocsBody, DocsPage } from 'fumadocs-ui/layouts/docs/page'
import { COPY } from '@/site/copy.ts'
import { deloVersion, type Locale } from '@/site/locale.ts'
import { markdownSlugOf, pageMarkdown, titleOf } from '@/site/markdown.ts'
import { routeOf, type Section } from '@/site/doc-links.ts'
import { sources } from '@/site/source.ts'

/**
 * A section's sidebar layout for one locale.
 * @param props.section - the section.
 * @param props.locale - the locale, which selects the page tree and the labels.
 * @param props.children - the page.
 * @returns the docs layout with the section's pages in the sidebar.
 */
export function SectionLayout({ section, locale, children }: { section: Section, locale: Locale, children: ReactNode }) {
  const copy = COPY[locale]
  return (
    <DocsLayout
      tree={sources[section].getPageTree(locale)}
      nav={{ title: copy.siteTitle }}
    >
      {children}
    </DocsLayout>
  )
}

/**
 * The metadata of a page: its title is its first heading, and its description is the page's frontmatter description.
 * @param section - the section.
 * @param slug - the page's slugs within the section.
 * @param locale - the locale.
 * @returns the metadata, empty when no page has those slugs.
 */
export async function sectionMetadata(section: Section, slug: string[], locale: Locale): Promise<Metadata> {
  const page = sources[section].getPage(slug, locale)
  if (page === undefined) return {}
  const title = titleOf((await pageMarkdown(section, markdownSlugOf(page), locale)) ?? '')
  return { title: title === '' ? undefined : title, description: page.data.description }
}

/**
 * A page of a section, with its Markdown body and the version it describes.
 * @param props.section - the section.
 * @param props.locale - the locale.
 * @param props.slug - the page's slugs within the section; empty for the section index.
 * @returns the page.
 * @throws Error via `notFound` when no page has those slugs in the locale.
 */
export async function SectionPage({ section, locale, slug }: { section: Section, locale: Locale, slug: string[] }) {
  const page = sources[section].getPage(slug, locale)
  if (page === undefined) notFound()
  const Body = page.data.body
  const copy = COPY[locale]
  const other = locale === 'en' ? 'zh' : 'en'
  return (
    <DocsPage toc={page.data.toc}>
      <DocsBody>
        <Body />
      </DocsBody>
      <p className="mt-8 text-sm text-fd-muted-foreground">{copy.describes(deloVersion())}</p>
      <p className="text-sm">
        <Link href={routeOf(section, slug, other === 'zh')} hrefLang={other === 'zh' ? 'zh-Hans' : 'en'} aria-label={copy.switchLabel}>
          {COPY[other].switchTo}
        </Link>
      </p>
    </DocsPage>
  )
}
