import { createFileRoute } from '@tanstack/react-router'
import { NotFound } from '@/components/home.tsx'
import { COPY } from '@/site/copy.ts'

/** The not-found page, prerendered to 404.html, which a static host serves for an address no file has; the build removes its router scripts. */
export const Route = createFileRoute('/404')({
  head: () => ({ meta: [{ title: `${COPY.notFound.title} · ${COPY.siteTitle}` }, { name: 'robots', content: 'noindex' }] }),
  component: NotFound,
})
