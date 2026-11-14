/**
 * The site's search index: every page of both sections in both locales, built once by the build and served as one
 * static file that the search dialog downloads and queries in the browser. Each entry carries its locale, so a query
 * from a page finds that locale's pages only. Only the build's server code imports this module.
 *
 * @module @delorun/docs/search
 */
import { createI18nSearchAPI, type AdvancedIndex } from 'fumadocs-core/search/server'
import { COPY } from './copy.ts'
import type { Locale } from './locale.ts'
import { SECTIONS } from './routes.ts'
import { i18n, sources } from './source.ts'

/**
 * The index entries of every page: its title, description, headings and text, with its section as the breadcrumb.
 * @returns one entry per page and locale.
 */
async function searchIndexes(): Promise<(AdvancedIndex & { locale: string })[]> {
  const entries = SECTIONS.flatMap(section => sources[section].getLanguages().flatMap(({ language, pages }) =>
    pages.map(async page => ({
      id: page.url,
      url: page.url,
      title: page.data.title ?? page.url,
      description: page.data.description,
      structuredData: await page.data.structuredData(),
      breadcrumbs: [COPY[language as Locale].sectionNames[section]],
      locale: language,
    })),
  ))
  return Promise.all(entries)
}

/**
 * The exported search database, as the static index file's response.
 * @returns the JSON response the search dialog downloads.
 */
export async function searchIndexResponse(): Promise<Response> {
  return createI18nSearchAPI('advanced', { i18n, indexes: searchIndexes }).staticGET()
}
