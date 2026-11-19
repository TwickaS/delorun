import { createFileRoute } from '@tanstack/react-router'
import view from 'virtual:delorun-changelog'
import { Home } from '@/home/Home.tsx'
import { pageHead } from '@/site/head.ts'
import { COPY } from '@/site/copy.ts'
import { softwareData } from '@/site/structured-data.ts'

/** The home page, with the structured data that describes Delorun to search engines. */
export const Route = createFileRoute('/')({
  head: () => ({
    ...pageHead(`${COPY.siteTitle}: ${COPY.tagline}`, '/'),
    scripts: [{ type: 'application/ld+json', children: JSON.stringify(softwareData(view?.versions[0]?.version)) }],
  }),
  component: Home,
})
