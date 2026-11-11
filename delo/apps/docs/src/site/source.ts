/**
 * The two page sources, one per section, each with its English and Chinese page trees. Routes are English at the site
 * root and Chinese under `/zh`, and the section index `README` is the section's route. The sources hold frontmatter
 * only, so the server and the browser both read them.
 *
 * @module @delo/docs/source
 */
import { defineI18n } from 'fumadocs-core/i18n'
import { loader } from 'fumadocs-core/source'
import { guide, reference } from './collections.ts'
import { routeOf, slugsOf } from './routes.ts'

/** The locales the site serves: English at the root, Chinese under `/zh`. */
export const i18n = defineI18n({ languages: ['en', 'zh'], defaultLanguage: 'en' })

/** The user guide's pages, sidebar and routes. */
export const guideSource = loader({
  baseUrl: '/guide',
  i18n,
  source: guide.toFumadocsSource(),
  slugs: file => slugsOf(file.path),
  url: (slugs, locale) => routeOf('guide', slugs, locale === 'zh'),
})

/** The references' pages, sidebar and routes. */
export const referenceSource = loader({
  baseUrl: '/reference',
  i18n,
  source: reference.toFumadocsSource(),
  slugs: file => slugsOf(file.path),
  url: (slugs, locale) => routeOf('reference', slugs, locale === 'zh'),
})

/** Each section's source by name. */
export const sources = { guide: guideSource, reference: referenceSource } as const
