import { createFileRoute } from '@tanstack/react-router'
import { loadSectionPage, sectionHead, SectionPage } from '@/components/section.tsx'

/** The references' pages in English. */
export const Route = createFileRoute('/reference/$')({
  loader: ({ params }) => loadSectionPage('reference', 'en', params._splat),
  head: ({ loaderData }) => sectionHead(loaderData),
  component: () => <SectionPage {...Route.useLoaderData()} />,
})
