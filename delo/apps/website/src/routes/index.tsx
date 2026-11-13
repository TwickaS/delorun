import { createFileRoute } from '@tanstack/react-router'
import { Home } from '@/components/home.tsx'
import { SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'

/** The home page. */
export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: `${COPY.siteTitle}: ${COPY.tagline}` }],
    links: [{ rel: 'canonical', href: `${SITE_URL}/` }],
  }),
  component: Home,
})
