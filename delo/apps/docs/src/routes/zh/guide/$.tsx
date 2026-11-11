import { createFileRoute } from '@tanstack/react-router'
import { loadSectionPage, sectionHead, SectionPage } from '@/components/section.tsx'

/** The user guide's pages in Chinese. */
export const Route = createFileRoute('/zh/guide/$')({
  loader: ({ params }) => loadSectionPage('guide', 'zh', params._splat),
  head: ({ loaderData }) => sectionHead(loaderData),
  component: () => <SectionPage {...Route.useLoaderData()} />,
})
