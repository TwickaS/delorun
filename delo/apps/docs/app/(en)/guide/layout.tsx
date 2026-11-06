import type { ReactNode } from 'react'
import { SectionLayout } from '@/components/section.tsx'

export default function GuideLayout({ children }: { children: ReactNode }) {
  return <SectionLayout section="guide" locale="en">{children}</SectionLayout>
}
