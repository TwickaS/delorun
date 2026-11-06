import type { ReactNode } from 'react'
import { SectionLayout } from '@/components/section.tsx'

export default function GuideLayoutZh({ children }: { children: ReactNode }) {
  return <SectionLayout section="guide" locale="zh">{children}</SectionLayout>
}
