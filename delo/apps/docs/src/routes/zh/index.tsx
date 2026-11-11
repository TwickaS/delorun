import { createFileRoute } from '@tanstack/react-router'
import { Home } from '@/components/home.tsx'
import { COPY } from '@/site/copy.ts'

/** The Chinese home page. */
export const Route = createFileRoute('/zh/')({
  head: () => ({ meta: [{ title: COPY.zh.siteTitle }] }),
  component: () => <Home locale="zh" />,
})
