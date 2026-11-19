import { createFileRoute } from '@tanstack/react-router'
import { Blog } from '@/components/blog.tsx'
import { pageHead } from '@/site/head.ts'
import { COPY } from '@/site/copy.ts'

/** The blog index. */
export const Route = createFileRoute('/blog')({
  head: () => ({
    ...pageHead(`${COPY.blog.title} · ${COPY.siteTitle}`, '/blog', COPY.blog.description),
  }),
  component: Blog,
})
