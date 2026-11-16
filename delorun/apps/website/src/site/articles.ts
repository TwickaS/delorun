/**
 * The published blog articles, read from `content/blog/` when the site is built.
 *
 * @module @delorun/website/articles
 */
import { listArticles, type Article } from '@/site/blog.ts'

/** Every article, newest first; empty until one is published. */
export const ARTICLES: readonly Article[] = listArticles(import.meta.glob('../../content/blog/*.md', { query: '?raw', import: 'default', eager: true }))
