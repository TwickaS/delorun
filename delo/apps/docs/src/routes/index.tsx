import { createFileRoute } from '@tanstack/react-router'
import { Home } from '@/components/home.tsx'
import { COPY } from '@/site/copy.ts'

/** The English home page. */
export const Route = createFileRoute('/')({
  head: () => ({ meta: [{ title: COPY.en.siteTitle }] }),
  component: () => <Home locale="en" />,
})
