/**
 * The notices page: the licence of the themes, typefaces and libraries the site ships.
 *
 * @module @delorun/website/notices
 */
import notices from 'virtual:delorun-notices'
import { Frame } from '@/components/layout.tsx'
import { NOTICES_COPY } from '@/site/notices-copy.ts'

/**
 * The notices page.
 * @returns the page.
 */
export function Notices() {
  return (
    <Frame signup="/notices">
      <main className="mx-auto w-full max-w-2xl px-5 pt-10 sm:px-8 sm:pt-16">
        <h1 className="text-4xl font-semibold tracking-tight">{NOTICES_COPY.title}</h1>
        <p className="mt-5 text-lg leading-8 text-(--dl-text-muted)">{NOTICES_COPY.intro}</p>
        {notices.map(notice => (
          <section key={notice.id} aria-labelledby={`notice-${notice.id}`}>
            <h2 id={`notice-${notice.id}`} className="mt-12 text-xl font-semibold">{notice.name}</h2>
            <p className="mt-3 leading-7">{(NOTICES_COPY.covers as Record<string, string>)[notice.id]} {notice.licence}.</p>
            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-(--dl-radius-md) bg-(--dl-surface-sunken) p-4 font-mono text-xs leading-6 text-(--dl-text)">{notice.text}</pre>
          </section>
        ))}
      </main>
    </Frame>
  )
}
