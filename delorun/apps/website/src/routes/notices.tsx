import { createFileRoute } from '@tanstack/react-router'
import { Notices } from '@/components/notices.tsx'
import { SITE_URL } from '@/site/config.ts'
import { NOTICES_COPY } from '@/site/notices-copy.ts'
import { COPY } from '@/site/copy.ts'

/** The notices page. */
export const Route = createFileRoute('/notices')({
  head: () => ({
    meta: [{ title: `${NOTICES_COPY.title} · ${COPY.siteTitle}` }],
    links: [{ rel: 'canonical', href: `${SITE_URL}/notices` }],
  }),
  component: Notices,
})
