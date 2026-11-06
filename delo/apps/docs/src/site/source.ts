/**
 * The two page sources, one per section, each with its English and Chinese page trees. Routes are English at the site
 * root and Chinese under `/zh`, and the section index `README` is the section's route.
 *
 * @module @delo/docs/source
 */
import type { I18nConfig } from 'fumadocs-core/i18n'
import { loader } from 'fumadocs-core/source'
import { guide, reference } from '../../.source/server'
import { slugsOf, type Section } from './doc-links.ts'
import type { Locale } from './locale.ts'

/** The locales the site serves: English at the root, Chinese under `/zh`. */
export const i18n: I18nConfig = { languages: ['en', 'zh'], defaultLanguage: 'en' }

/** A section's pages, sidebar and routes: the loader for `guide` and `reference`. */
export const guideSource = loader({
  baseUrl: '/guide',
  i18n,
  source: guide.toFumadocsSource(),
  slugs: file => slugsOf(file.path),
  url: (slugs, locale) => [locale === 'zh' ? '/zh' : '', 'guide', ...slugs].join('/'),
})

/** The reference section's pages, sidebar and routes. */
export const referenceSource = loader({
  baseUrl: '/reference',
  i18n,
  source: reference.toFumadocsSource(),
  slugs: file => slugsOf(file.path),
  url: (slugs, locale) => [locale === 'zh' ? '/zh' : '', 'reference', ...slugs].join('/'),
})

/** Each section's source by name. */
export const sources = { guide: guideSource, reference: referenceSource } as const

/**
 * The static route parameters of every page of a section in a locale, for the page routes.
 * @param section - the section.
 * @param locale - the locale.
 * @returns one `slug` per page; the section index has an empty slug.
 */
export function pageParams(section: Section, locale: Locale): { slug: string[] }[] {
  return sources[section].getPages(locale).map(page => ({ slug: page.slugs }))
}
