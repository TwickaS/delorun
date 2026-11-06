import { SectionPage, sectionMetadata } from '@/components/section.tsx'
import { pageParams } from '@/site/source.ts'

export function generateMetadata({ params }: { params: Promise<{ slug?: string[] }> }) {
  return params.then(({ slug = [] }) => sectionMetadata('reference', slug, 'en'))
}

export function generateStaticParams() {
  return pageParams('reference', 'en')
}

export default async function Page({ params }: { params: Promise<{ slug?: string[] }> }) {
  const { slug = [] } = await params
  return <SectionPage section="reference" locale="en" slug={slug} />
}
