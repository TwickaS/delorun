/**
 * The changelog page and the home page's What's new section, both rendered from the changelog view the build derives
 * from Delo's changelog record. The entries are English in both locales; the page's title and labels are localised.
 *
 * @module @delo/docs/changelog-components
 */
import Link from 'fumadocs-core/link'
import { HomeLayout } from 'fumadocs-ui/layouts/home'
import type { ReactNode } from 'react'
import view from 'virtual:delo-changelog'
import { baseOptions } from '@/components/layout.tsx'
import type { ViewArea, ViewVersion } from '@design/changelog.ts'
import { COPY } from '@/site/copy.ts'
import type { Locale } from '@/site/locale.ts'
import { changelogRoute } from '@/site/routes.ts'

/**
 * An entry's inline Markdown: code spans and bold words, the only inline forms the record's entries use.
 * @param text - the entry text.
 * @returns the text as React nodes.
 */
function Inline({ text }: { text: string }): ReactNode {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) return <code key={index}>{part.slice(1, -1)}</code>
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) return <strong key={index}>{part.slice(2, -2)}</strong>
    return part
  })
}

/**
 * The bullets of the areas, one heading per area.
 * @param props.areas - the areas.
 * @param props.level - the heading element of each area.
 * @returns the lists.
 */
function Areas({ areas, level: Heading }: { areas: readonly ViewArea[], level: 'h3' | 'h4' }) {
  return areas.map(({ area, items }) => (
    <section key={area}>
      <Heading className="mt-6 text-lg font-semibold">{area}</Heading>
      <ul className="mt-2 list-disc space-y-2 pl-6">
        {items.map((item, index) => (
          <li key={index}>{item.prefix === undefined ? null : <strong>{item.prefix}: </strong>}<Inline text={item.text} /></li>
        ))}
      </ul>
    </section>
  ))
}

/**
 * A From upstream block.
 * @param props.title - the block's heading text.
 * @param props.lines - the block's bullets.
 * @param props.level - the heading element.
 * @returns the block.
 */
function Upstream({ title, lines, level: Heading }: { title: string, lines: readonly string[], level: 'h3' | 'h4' }) {
  return (
    <section>
      <Heading className="mt-6 text-lg font-semibold">{title}</Heading>
      <ul className="mt-2 list-disc space-y-2 pl-6">{lines.map((line, index) => <li key={index}><Inline text={line} /></li>)}</ul>
    </section>
  )
}

/**
 * One version with its areas, its upstream block and the previews folded into it.
 * @param props.version - the version.
 * @param props.upstream - the upstream block's heading text.
 * @returns the version's section.
 */
function Version({ version, upstream }: { version: ViewVersion, upstream: string }) {
  return (
    <section id={`v${version.version}`} className="mt-12">
      <h2 className="text-2xl font-semibold">{version.version} <span className="text-base font-normal text-fd-muted-foreground">({version.date})</span></h2>
      <Areas areas={version.areas} level="h3" />
      <Upstream title={upstream} lines={version.fromUpstream} level="h3" />
      {version.previews.map(preview => (
        <section key={preview.version} id={`v${preview.version}`}>
          <h3 className="mt-8 text-xl font-semibold">{preview.version} <span className="text-base font-normal text-fd-muted-foreground">({preview.date})</span></h3>
          <Areas areas={preview.areas} level="h4" />
          {preview.fromUpstream.length === 0 ? null : <Upstream title={upstream} lines={preview.fromUpstream} level="h4" />}
        </section>
      ))}
    </section>
  )
}

/**
 * The changelog page: the standing comparison with the upstream release, then every version, newest first.
 * @param props.locale - the locale, which selects the title and labels.
 * @returns the page.
 */
export function ChangelogPage({ locale }: { locale: Locale }) {
  const copy = COPY[locale]
  if (view === null) throw new Error('docs-site: the changelog page was rendered without a changelog record')
  return (
    <HomeLayout {...baseOptions(locale)}>
      <main className="mx-auto w-full max-w-3xl px-4 py-16">
        <h1 className="text-3xl font-semibold">{copy.changelog.title}</h1>
        <p className="mt-4 text-fd-muted-foreground">{copy.changelog.intro}</p>
        <section lang="en" id="compared">
          <h2 className="mt-12 text-2xl font-semibold">{view.compared.heading}</h2>
          <p className="mt-4"><Inline text={view.compared.intro} /></p>
          <Areas areas={view.compared.areas} level="h3" />
        </section>
        <div lang="en">
          {view.versions.map(version => <Version key={version.version} version={version} upstream={copy.changelog.fromUpstream} />)}
        </div>
      </main>
    </HomeLayout>
  )
}

/**
 * The document head of the changelog page.
 * @param locale - the locale.
 * @returns its title.
 */
export function changelogHead(locale: Locale) {
  return { meta: [{ title: `${COPY[locale].changelog.title} · ${COPY[locale].siteTitle}` }] }
}

/**
 * The home page's What's new section: the latest version's number and date, its headline entries and the link to the
 * changelog page.
 * @param props.locale - the locale, which selects the labels and the page's route.
 * @returns the section, or nothing when no version is assembled.
 */
export function WhatsNew({ locale }: { locale: Locale }) {
  const latest = view?.versions[0]
  if (latest === undefined) return null
  const copy = COPY[locale].changelog
  return (
    <section className="mt-12" aria-labelledby="whats-new">
      <h2 id="whats-new" className="text-2xl font-semibold">{copy.whatsNew}</h2>
      <p className="mt-2 font-medium">{copy.latest(latest.version, latest.date)}</p>
      <ul lang="en" className="mt-2 list-disc space-y-2 pl-6">
        {latest.headlines.map((headline, index) => <li key={index}><Inline text={headline} /></li>)}
      </ul>
      <p className="mt-4"><Link href={changelogRoute(locale === 'zh')} className="font-medium">{copy.full}</Link></p>
    </section>
  )
}
