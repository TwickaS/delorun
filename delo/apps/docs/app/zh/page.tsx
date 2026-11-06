import Link from 'next/link'
import { COPY } from '@/site/copy.ts'
import { deloVersion } from '@/site/locale.ts'

export default function HomeZh() {
  const copy = COPY.zh
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold">{copy.siteTitle}</h1>
      <p className="mt-4 text-fd-muted-foreground">{copy.homeIntro}</p>
      <ul className="mt-8 space-y-2">
        <li><Link href="/zh/guide">{copy.sectionNames.guide}</Link></li>
        <li><Link href="/zh/reference">{copy.sectionNames.reference}</Link></li>
      </ul>
      <p className="mt-8 text-sm text-fd-muted-foreground">{copy.describes(deloVersion())}</p>
    </main>
  )
}
