import { createFileRoute } from '@tanstack/react-router'
import { Home } from '@/components/home.tsx'
import { COPY } from '@/site/copy.ts'
import { pageHead } from '@/site/head.ts'

/** The Chinese home page. */
export const Route = createFileRoute('/zh/')({
  head: () => pageHead({ title: COPY.zh.siteTitle, description: COPY.zh.homeDescription, path: '/zh', locale: 'zh' }),
  component: () => <Home locale="zh" />,
})
