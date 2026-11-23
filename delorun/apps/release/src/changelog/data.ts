/**
 * The changelog as data and the pure functions around it. `delorun/changelog/changelog.json` is the one record: the
 * standing comparison with DeepSeek Harness and every assembled version. `CHANGELOG.md` and the release notes are
 * rendered from it by {@link renderChangelog} and {@link renderNotes}, so the files cannot disagree. Nothing here reads
 * a file or the clock.
 *
 * @module @delorun/release/changelog/data
 */
import { basename } from 'node:path'
import { AREAS, type Area, type Fragment, type Section } from './fragment.ts'
import { compareVersions, isPreview, releaseOf, versionErrors } from './version.ts'

/** The `schema` value of the data file. */
export const CHANGELOG_SCHEMA = 'delorun.changelog/1'

/** The order of the sections within an area: what a feature is first, then its fixes, protections and removals. */
const PRINT_ORDER: readonly Section[] = ['Added', 'Changed', 'Fixed', 'Security', 'Removed', 'From upstream']

/** The sections that print a bold prefix word before their text in the Markdown. */
const PREFIXED_SECTIONS: readonly Section[] = ['Security', 'Removed', 'Fixed']

/** The most headline sentences a version carries. */
export const MAX_HEADLINES = 3

/** The longest headline, in characters. */
export const MAX_HEADLINE_LENGTH = 240

/** One bullet of the changelog. */
export interface Item {
  /** The section the bullet's fragment names. */
  readonly section: Section
  /** The bullet text, without its leading `- `. */
  readonly text: string
}

/** The bullets of one area. */
export interface AreaItems {
  /** The area. */
  readonly area: Area
  /** The area's bullets, in section order. */
  readonly items: readonly Item[]
}

/** One bullet of the standing comparison. */
export interface ComparedItem extends Item {
  /** The area the bullet belongs to. */
  readonly area: Area
}

/** One bullet from a `From upstream` fragment. */
export interface UpstreamItem {
  /** The area the bullet belongs to. */
  readonly area: Area
  /** The bullet text, without its leading `- `. */
  readonly text: string
}

/** A preview entry folded into the final version it led to. */
export interface PreviewEntry {
  /** The preview version, such as `0.1.0-preview.2`. */
  readonly version: string
  /** The date the preview was assembled, `YYYY-MM-DD`. */
  readonly date: string
  /** The preview's bullets by area. */
  readonly areas: readonly AreaItems[]
  /** The preview's `From upstream` bullets. */
  readonly fromUpstream: readonly UpstreamItem[]
}

/** One assembled version. */
export interface VersionEntry {
  /** The version, such as `0.1.0-preview.1` or `0.1.0`. */
  readonly version: string
  /** The date the version was assembled, `YYYY-MM-DD`; a record, not a schedule. */
  readonly date: string
  /** True for a preview sub-version. */
  readonly preview: boolean
  /**
   * Up to {@link MAX_HEADLINES} plain sentences, written for people, that say what a person can now do. They open the
   * release notes, feed the sites' "What's new" strip, and are absent from a version assembled without any.
   */
  readonly headlines?: readonly string[]
  /** The version's own bullets by area, in the fixed area order. */
  readonly areas: readonly AreaItems[]
  /** The upstream release the version is based on, and the `From upstream` bullets. */
  readonly fromUpstream: { readonly ref: string; readonly items: readonly UpstreamItem[] }
  /** The previews of this version folded into it, newest first; empty for a preview and for a version with no previews. */
  readonly previews: readonly PreviewEntry[]
}

/** The whole data file. */
export interface ChangelogData {
  /** Always {@link CHANGELOG_SCHEMA}. */
  readonly schema: typeof CHANGELOG_SCHEMA
  /** The upstream release the comparison is against, from the divergence ledger. */
  readonly upstream: { readonly ref: string; readonly commit: string }
  /**
   * The first version the public changelog shows: every public rendering (`CHANGELOG.md`, the release notes and the
   * documentation site) leaves out the versions and folded previews before it. Earlier entries stay in `versions` for
   * the updater's notes. Absent means every version is public.
   */
  readonly publicFrom?: string
  /** What differs from that upstream release in the latest assembled state, by area. */
  readonly compared: readonly ComparedItem[]
  /** Every assembled version, newest first, with folded previews inside their final version. */
  readonly versions: readonly VersionEntry[]
}

/**
 * Order bullets by area and then by section in {@link PRINT_ORDER}, keeping the given order otherwise.
 * @param items - the bullets with their areas.
 * @returns the ordered bullets.
 */
function ordered<T extends { readonly area: Area; readonly section: Section }>(items: readonly T[]): T[] {
  const rank = (item: T): number => AREAS.indexOf(item.area) * PRINT_ORDER.length + PRINT_ORDER.indexOf(item.section)
  return items.map((item, index) => ({ item, index })).sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index).map(({ item }) => item)
}

/**
 * The bullets of fragments as items, without the `- ` marker.
 * @param fragments - the fragments.
 * @returns one item per bullet, in fragment and bullet order.
 */
function itemsOf(fragments: readonly Fragment[]): ComparedItem[] {
  return fragments.flatMap(fragment => fragment.bullets.map(bullet => ({ area: fragment.area, section: fragment.section, text: bullet.slice(2) })))
}

/**
 * Group items by area, in the fixed area order.
 * @param items - the ordered items.
 * @returns one group per area that has items.
 */
export function byArea(items: readonly ComparedItem[]): AreaItems[] {
  return AREAS.flatMap((area) => {
    const own = items.filter(item => item.area === area).map(({ section, text }) => ({ section, text }))
    return own.length === 0 ? [] : [{ area, items: own }]
  })
}

/**
 * The refusals of a version's headline sentences.
 * @param headlines - the sentences as given.
 * @returns one message per violation; empty when there are at most {@link MAX_HEADLINES} sentences and each is a
 * single non-empty line within {@link MAX_HEADLINE_LENGTH} characters.
 */
export function headlineErrors(headlines: readonly string[]): string[] {
  const errors: string[] = []
  if (headlines.length > MAX_HEADLINES) errors.push(`a version has at most ${String(MAX_HEADLINES)} headlines, not ${String(headlines.length)}`)
  for (const headline of headlines) {
    if (headline.trim() === '' || /[\r\n]/u.test(headline)) errors.push(`a headline is one non-empty line: "${headline}"`)
    else if (headline.length > MAX_HEADLINE_LENGTH) errors.push(`a headline has at most ${String(MAX_HEADLINE_LENGTH)} characters: "${headline}"`)
  }
  return errors
}

/**
 * The refusals of the fragments' `replaces` lines and file names, over released and unreleased fragments together.
 * @param fragments - every released and unreleased fragment.
 * @returns one message per violation; empty when every name is unique and every `replaces` names another fragment.
 */
export function replacesErrors(fragments: readonly Fragment[]): string[] {
  const errors: string[] = []
  const paths = new Map<string, string>()
  for (const fragment of fragments) {
    const name = basename(fragment.path)
    const earlier = paths.get(name)
    if (earlier !== undefined) errors.push(`${fragment.path}: the file name ${name} is also used by ${earlier}; edit that fragment, or name this one differently`)
    paths.set(name, fragment.path)
  }
  for (const fragment of fragments) {
    if (fragment.replaces === undefined) continue
    if (fragment.replaces === basename(fragment.path)) errors.push(`${fragment.path}: replaces itself`)
    else if (!paths.has(fragment.replaces)) errors.push(`${fragment.path}: replaces ${fragment.replaces}, which no released or unreleased fragment has`)
  }
  return errors
}

/**
 * The standing comparison: every bullet of the released and assembled fragments that is still true.
 * @param fragments - every released fragment, oldest first, then the fragments being assembled.
 * @returns the bullets ordered by area and section; a fragment named by another's `replaces` is left out.
 */
export function buildCompared(fragments: readonly Fragment[]): ComparedItem[] {
  const replaced = new Set(fragments.flatMap(fragment => fragment.replaces === undefined ? [] : [fragment.replaces]))
  return ordered(itemsOf(fragments.filter(fragment => !replaced.has(basename(fragment.path)))))
}

/**
 * One version's entry from the fragments it consumes.
 * @param version - the version, already validated.
 * @param date - the date to record, `YYYY-MM-DD`.
 * @param upstreamRef - the upstream release the version is based on.
 * @param fragments - the fragments the version consumes.
 * @param previews - the previews folded into the version, newest first.
 * @param headlines - the version's headline sentences; none by default.
 * @returns the entry; `From upstream` fragments go to `fromUpstream`, the others to their areas. The entry has a
 * `headlines` field only when `headlines` is not empty.
 */
export function buildEntry(version: string, date: string, upstreamRef: string, fragments: readonly Fragment[], previews: readonly PreviewEntry[] = [], headlines: readonly string[] = []): VersionEntry {
  const own = ordered(itemsOf(fragments))
  return {
    version,
    date,
    preview: isPreview(version),
    ...headlines.length === 0 ? {} : { headlines },
    areas: byArea(own.filter(item => item.section !== 'From upstream')),
    fromUpstream: { ref: upstreamRef, items: own.filter(item => item.section === 'From upstream').map(({ area, text }) => ({ area, text })) },
    previews,
  }
}

/**
 * The previews a final version folds in, and the versions that remain.
 * @param versions - the assembled versions.
 * @param version - the version being assembled.
 * @returns the previews of `version` as folded entries, newest first, and the other versions; nothing folds when `version` is itself a preview.
 */
function fold(versions: readonly VersionEntry[], version: string): { readonly previews: PreviewEntry[]; readonly rest: VersionEntry[] } {
  const folded = (entry: VersionEntry): boolean => !isPreview(version) && entry.preview && releaseOf(entry.version) === version
  const previews = versions.filter(folded).sort((a, b) => compareVersions(b.version, a.version)).map(({ version: previewVersion, date, areas, fromUpstream }) => ({ version: previewVersion, date, areas, fromUpstream: fromUpstream.items }))
  return { previews, rest: versions.filter(entry => !folded(entry)) }
}

/**
 * The data file after one more version is assembled.
 * @param existing - the data file before, or undefined for the first assembly.
 * @param upstream - the upstream release and commit from the divergence ledger.
 * @param entry - the new version's entry, built with {@link buildEntry} and the previews {@link foldedPreviews} returns.
 * @param compared - the standing comparison after the new version.
 * @returns the new data; versions newest first, with the previews of a final version folded into it.
 */
export function addVersion(existing: ChangelogData | undefined, upstream: ChangelogData['upstream'], entry: VersionEntry, compared: readonly ComparedItem[]): ChangelogData {
  const { rest } = fold(existing?.versions ?? [], entry.version)
  return { schema: CHANGELOG_SCHEMA, upstream, ...existing?.publicFrom === undefined ? {} : { publicFrom: existing.publicFrom }, compared, versions: [entry, ...rest].sort((a, b) => compareVersions(b.version, a.version)) }
}

/**
 * The versions the public changelog shows.
 * @param data - the data file.
 * @returns the entries at or after `publicFrom`, newest first, each without the folded previews before it; every entry when `publicFrom` is absent.
 */
export function publicVersions(data: ChangelogData): VersionEntry[] {
  const { publicFrom } = data
  if (publicFrom === undefined) return [...data.versions]
  return data.versions.filter(entry => compareVersions(entry.version, publicFrom) >= 0).map(entry => ({ ...entry, previews: entry.previews.filter(preview => compareVersions(preview.version, publicFrom) >= 0) }))
}

/**
 * The previews of `version` that assembling it folds in.
 * @param existing - the data file before, or undefined for the first assembly.
 * @param version - the version being assembled.
 * @returns the folded entries, newest first; empty when `version` is a preview or has no previews.
 */
export function foldedPreviews(existing: ChangelogData | undefined, version: string): PreviewEntry[] {
  return fold(existing?.versions ?? [], version).previews
}

/**
 * The word a bullet prints before its text.
 * @param section - the bullet's section.
 * @returns the section name for Security, Removed and Fixed; undefined for the other sections.
 */
export function bulletPrefix(section: Section): string | undefined {
  return PREFIXED_SECTIONS.includes(section) ? section : undefined
}

/**
 * One bullet as a Markdown line.
 * @param section - the bullet's section.
 * @param text - the bullet text.
 * @returns `- text`, with a bold section prefix for Security, Removed and Fixed.
 */
function bullet(section: Section, text: string): string {
  const prefix = bulletPrefix(section)
  return prefix === undefined ? `- ${text}` : `- **${prefix}:** ${text}`
}

/**
 * The line that names the upstream release a version is based on, which opens every version's From upstream block.
 * @param ref - the upstream release.
 * @returns the line's text, without its list marker.
 */
export function basedOnText(ref: string): string {
  return `Based on DeepSeek Harness \`${ref}\`.`
}

/**
 * The area blocks of an entry.
 * @param areas - the bullets by area.
 * @param heading - the heading prefix of each area, such as `###`.
 * @returns the lines, each block followed by one blank line.
 */
function areaLines(areas: readonly AreaItems[], heading: string): string[] {
  return areas.flatMap(({ area, items }) => [`${heading} ${area}`, ...items.map(item => bullet(item.section, item.text)), ''])
}

/**
 * The lines of one entry below its heading: areas, then the upstream block, then the folded previews.
 * @param entry - the entry.
 * @param level - the heading prefix of the entry's areas, such as `###`.
 * @returns the lines, each block followed by one blank line.
 */
function bodyLines(entry: VersionEntry, level: string): string[] {
  const { ref, items } = entry.fromUpstream
  const previewLevel = `${level}#`
  return [
    ...entry.headlines === undefined || entry.headlines.length === 0 ? [] : [entry.headlines.join(' '), ''],
    ...areaLines(entry.areas, level),
    `${level} From upstream`,
    `- ${basedOnText(ref)}`,
    ...items.map(item => `- ${item.text}`),
    '',
    ...entry.previews.flatMap(preview => [
      `${level} ${preview.version} (${preview.date})`,
      '',
      ...areaLines(preview.areas, previewLevel),
      ...(preview.fromUpstream.length === 0 ? [] : [`${previewLevel} From upstream`, ...preview.fromUpstream.map(item => `- ${item.text}`), '']),
    ]),
  ]
}

/**
 * One entry as the changelog prints it.
 * @param entry - the entry.
 * @returns the `## <version> (<date>)` block, ending with one newline.
 */
export function renderEntry(entry: VersionEntry): string {
  return `${[`## ${entry.version} (${entry.date})`, '', ...bodyLines(entry, '###')].join('\n').trimEnd()}\n`
}

/**
 * The heading and the opening sentence of the standing comparison.
 * @param data - the data file.
 * @returns the heading text, and the sentence that follows it: the statement that no difference is recorded, or the
 * sentence that introduces the bullets.
 */
export function comparedText(data: ChangelogData): { readonly heading: string; readonly intro: string } {
  const { ref } = data.upstream
  return {
    heading: `Delorun compared with DeepSeek Harness ${ref}`,
    intro: data.compared.length === 0 ? 'No difference is recorded yet.' : `This is everything that differs from DeepSeek Harness \`${ref}\` in the latest assembled version.`,
  }
}

/**
 * The standing comparison as the changelog prints it.
 * @param data - the data file.
 * @returns the `## Delorun compared with DeepSeek Harness <ref>` block, ending with one newline.
 */
function renderCompared(data: ChangelogData): string {
  const { heading, intro } = comparedText(data)
  const lines = [`## ${heading}`, '', intro, '']
  const areas = byArea(data.compared)
  if (areas.length > 0) lines.push(...areaLines(areas, '###'))
  return `${lines.join('\n').trimEnd()}\n`
}

/**
 * The line under the changelog's title that says earlier versions were not public.
 * @param data - the data file.
 * @returns the sentence, naming the first public version; undefined when `publicFrom` is absent and every version is public.
 */
export function privatePreviewNote(data: ChangelogData): string | undefined {
  return data.publicFrom === undefined ? undefined : `Versions before ${data.publicFrom} were private previews and are not listed.`
}

/**
 * `CHANGELOG.md`, rendered from the data. The file equals this text exactly.
 * @param data - the data file.
 * @returns the document: the title, the private-preview note when `publicFrom` is set, the standing comparison, then every public version newest first.
 */
export function renderChangelog(data: ChangelogData): string {
  const note = privatePreviewNote(data)
  return ['# Changelog', '', ...note === undefined ? [] : [note, ''], renderCompared(data), ...publicVersions(data).map(renderEntry)].join('\n')
}

/**
 * The release notes of one version, without the advisory section.
 * @param entry - the version's entry.
 * @returns the `# Delorun <version>` document with areas as `##` headings, ending with one newline.
 */
export function renderNotes(entry: VersionEntry): string {
  return `${[`# Delorun ${entry.version}`, '', ...bodyLines(entry, '##')].join('\n').trimEnd()}\n`
}

/**
 * The release notes the studio's "What's new" dialog shows: the entry's bullets as plain text, area by area, without
 * the Markdown marks, filling at most `maxBytes` bytes of UTF-8. Bullets that do not fit are replaced by one closing
 * line that counts them and points to the full changelog, so the file always fits its signed limit.
 * @param entry - the version's entry.
 * @param maxBytes - the most bytes the file holds.
 * @returns the text, ending with one newline.
 */
export function renderHighlights(entry: VersionEntry, maxBytes: number): string {
  const plain = (text: string): string => text.replaceAll(/\*\*|`/gu, '').replaceAll(/\[([^\]]*)\]\([^)]*\)/gu, '$1').replaceAll(/\s+/gu, ' ').trim()
  const lines = [`Delorun ${entry.version}`, '']
  const bullets = entry.areas.flatMap(({ area, items }) => [{ heading: area, text: '' }, ...items.map(item => ({ heading: '', text: plain(item.text) }))])
  const total = bullets.filter(bullet => bullet.heading === '').length
  const closing = (left: number): string[] => (left === 0 ? [] : ['', `${String(left)} more changes are in the full changelog.`])
  let shown = 0
  for (const bullet of bullets) {
    const next = bullet.heading === '' ? [`- ${bullet.text}`] : ['', bullet.heading]
    const candidate = [...lines, ...next, ...closing(total - shown - (bullet.heading === '' ? 1 : 0))]
    if (Buffer.byteLength(`${candidate.join('\n')}\n`) > maxBytes) break
    lines.push(...next)
    if (bullet.heading === '') shown++
  }
  return `${[...lines, ...closing(total - shown)].join('\n').replaceAll(/\n{3,}/gu, '\n\n').trimEnd()}\n`
}

/**
 * Read a data file's text.
 * @param text - the file text.
 * @returns the data.
 * @throws Error when the text is not JSON, has another schema, lacks the version list the assembly reads, or has a `publicFrom` that is not an accepted version.
 */
export function parseData(text: string): ChangelogData {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('delorun/changelog/changelog.json is not JSON', { cause: error })
  }
  const data = value as Partial<ChangelogData> | null
  if (data?.publicFrom !== undefined) {
    const refusals = typeof data.publicFrom === 'string' ? versionErrors(data.publicFrom, true) : ['it is not a string']
    if (refusals.length > 0) throw new Error(`delorun/changelog/changelog.json: publicFrom is not an accepted version (${refusals.join('; ')})`)
  }
  if (data?.schema !== CHANGELOG_SCHEMA || !Array.isArray(data.versions) || !Array.isArray(data.compared)) {
    throw new Error(`delorun/changelog/changelog.json is not a ${CHANGELOG_SCHEMA} document with versions and compared lists`)
  }
  return data as ChangelogData
}
