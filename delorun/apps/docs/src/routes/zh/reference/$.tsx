import { createFileRoute } from '@tanstack/react-router'
import { loadSectionPage, sectionHead, SectionPage } from '@/components/section.tsx'

/** The references' pages in Chinese. */
export const Route = createFileRoute('/zh/reference/$')({
  loader: ({ params }) => loadSectionPage('reference', 'zh', params._splat),
  head: ({ loaderData }) => sectionHead(loaderData),
  component: () => <SectionPage {...Route.useLoaderData()} />,
})
