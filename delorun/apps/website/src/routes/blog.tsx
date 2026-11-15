import { createFileRoute } from '@tanstack/react-router'
import { Blog } from '@/components/blog.tsx'
import { SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'

/** The blog index. */
export const Route = createFileRoute('/blog')({
  head: () => ({
    meta: [{ title: `${COPY.blog.title} · ${COPY.siteTitle}` }],
    links: [{ rel: 'canonical', href: `${SITE_URL}/blog` }],
  }),
  component: Blog,
})
