import { createFileRoute } from '@tanstack/react-router'
import { NotFound } from '@/components/not-found.tsx'
import { COPY } from '@/site/copy.ts'

/** The not-found page, prerendered to 404.html, which a static host serves for an address no file has; the build removes its router scripts. */
export const Route = createFileRoute('/404')({
  head: () => {
    const title = `${COPY.notFound.title} · ${COPY.siteTitle}`
    return { meta: [{ title }, { property: 'og:title', content: title }, { name: 'twitter:title', content: title }, { name: 'robots', content: 'noindex' }] }
  },
  component: NotFound,
})
