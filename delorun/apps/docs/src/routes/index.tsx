import { createFileRoute } from '@tanstack/react-router'
import { Home } from '@/components/home.tsx'
import { COPY } from '@/site/copy.ts'
import { pageHead } from '@/site/head.ts'

/** The English home page. */
export const Route = createFileRoute('/')({
  head: () => pageHead({ title: COPY.en.siteTitle, description: COPY.en.homeDescription, path: '/', locale: 'en' }),
  component: () => <Home locale="en" />,
})
