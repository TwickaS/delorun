import { createFileRoute } from '@tanstack/react-router'
import { loadSectionPage, sectionHead, SectionPage } from '@/components/section.tsx'

/** The user guide's pages in English. */
export const Route = createFileRoute('/guide/$')({
  loader: ({ params }) => loadSectionPage('guide', 'en', params._splat),
  head: ({ loaderData }) => sectionHead(loaderData),
  component: () => <SectionPage {...Route.useLoaderData()} />,
})
