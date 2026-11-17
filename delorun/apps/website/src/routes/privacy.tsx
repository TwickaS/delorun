import { createFileRoute } from '@tanstack/react-router'
import { Privacy } from '@/components/privacy.tsx'
import { pageHead } from '@/site/head.ts'
import { COPY } from '@/site/copy.ts'

/** The privacy page. */
export const Route = createFileRoute('/privacy')({
  head: () => ({
    ...pageHead(`${COPY.privacy.title} · ${COPY.siteTitle}`, '/privacy'),
  }),
  component: Privacy,
})
