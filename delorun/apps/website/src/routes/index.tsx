import { createFileRoute } from '@tanstack/react-router'
import view from 'virtual:delorun-changelog'
import { Home } from '@/components/home.tsx'
import { SITE_URL } from '@/site/config.ts'
import { COPY } from '@/site/copy.ts'
import { softwareData } from '@/site/structured-data.ts'

/** The home page, with the structured data that describes Delorun to search engines. */
export const Route = createFileRoute('/')({
  head: () => ({
    meta: [{ title: `${COPY.siteTitle}: ${COPY.tagline}` }],
    links: [{ rel: 'canonical', href: `${SITE_URL}/` }],
    scripts: [{ type: 'application/ld+json', children: JSON.stringify(softwareData(view?.versions[0]?.version)) }],
  }),
  component: Home,
})
