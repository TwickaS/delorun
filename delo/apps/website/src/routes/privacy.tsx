import { createFileRoute } from '@tanstack/react-router'
import { Privacy } from '@/components/privacy.tsx'
import { SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'

/** The privacy page. */
export const Route = createFileRoute('/privacy')({
  head: () => ({
    meta: [{ title: `${COPY.privacy.title} · ${COPY.siteTitle}` }],
    links: [{ rel: 'canonical', href: `${SITE_URL}/privacy` }],
  }),
  component: Privacy,
})
