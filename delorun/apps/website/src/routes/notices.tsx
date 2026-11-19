import { createFileRoute } from '@tanstack/react-router'
import { Notices } from '@/components/notices.tsx'
import { pageHead } from '@/site/head.ts'
import { NOTICES_COPY } from '@/site/notices-copy.ts'
import { COPY } from '@/site/copy.ts'

/** The notices page. */
export const Route = createFileRoute('/notices')({
  head: () => ({
    ...pageHead(`${NOTICES_COPY.title} · ${COPY.siteTitle}`, '/notices', NOTICES_COPY.description),
  }),
  component: Notices,
})
