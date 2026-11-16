/**
 * The blog index: the articles in `content/blog/`, newest first, or a line saying there are none.
 *
 * @module @delorun/website/blog-page
 */
import { ARTICLES } from '@/site/articles.ts'
import { COPY } from '@/site/copy.ts'
import { Link } from '@brand'
import { Frame } from '@/components/layout.tsx'

/**
 * The blog index.
 * @returns the page.
 */
export function Blog() {
  const copy = COPY.blog
  return (
    <Frame>
      <main className="mx-auto w-full max-w-2xl px-5 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-4xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="mt-5 text-lg leading-8 text-fd-muted-foreground">{copy.intro}</p>
        {ARTICLES.length === 0
          ? <p className="mt-10 text-fd-muted-foreground">{copy.empty}</p>
          : (
              <ul className="mt-10 space-y-8">
                {ARTICLES.map(article => (
                  <li key={article.slug}>
                    <h2 className="text-xl font-semibold">{article.title}</h2>
                    <p className="mt-1 text-sm text-fd-muted-foreground">{copy.published(article.date)}</p>
                    <p className="mt-2 leading-7">{article.summary}</p>
                    {article.crosspost === undefined ? null : <p className="mt-2 text-sm"><Link href={article.crosspost}>{copy.read}</Link></p>}
                  </li>
                ))}
              </ul>
            )}
      </main>
    </Frame>
  )
}
