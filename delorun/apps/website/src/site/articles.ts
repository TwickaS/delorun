/**
 * The published blog articles, read from `content/blog/` when the site is built. The header and footer need only the
 * count, which carries no article text and no parser; the blog page reads the articles themselves.
 *
 * @module @delorun/website/articles
 */
import { listArticles, type Article } from '@/site/blog.ts'

/** How many articles are published; the header and footer link the blog once it is above zero. */
export const ARTICLE_COUNT: number = Object.keys(import.meta.glob('../../content/blog/*.md')).length

/** Every article, newest first; empty until one is published. Import it only from the blog page, since it carries every article's text. */
export const ARTICLES: readonly Article[] = listArticles(import.meta.glob('../../content/blog/*.md', { query: '?raw', import: 'default', eager: true }))
