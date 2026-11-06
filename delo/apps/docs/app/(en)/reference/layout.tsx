import type { ReactNode } from 'react'
import { SectionLayout } from '@/components/section.tsx'

export default function ReferenceLayout({ children }: { children: ReactNode }) {
  return <SectionLayout section="reference" locale="en">{children}</SectionLayout>
}
