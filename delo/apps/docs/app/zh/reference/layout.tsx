import type { ReactNode } from 'react'
import { SectionLayout } from '@/components/section.tsx'

export default function ReferenceLayoutZh({ children }: { children: ReactNode }) {
  return <SectionLayout section="reference" locale="zh">{children}</SectionLayout>
}
