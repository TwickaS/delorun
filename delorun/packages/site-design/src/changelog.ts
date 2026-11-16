/**
 * The changelog the site publishes, read at build time from Delorun's changelog record, `delorun/changelog/changelog.json`,
 * which the release tooling writes when it assembles a version, with the version's headline sentences. The page and the home page's section both read the
 * {@link ChangelogView} this module derives from the record with the release tooling's own functions, so they state
 * what `CHANGELOG.md` and the release notes state. Unreleased fragments are never read: a version appears here only
 * once it is assembled. This module reads files and imports the release tooling, so only the build imports its values;
 * the components import its types.
 *
 * @module @delorun/site-design/changelog
 */
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { basedOnText, bulletPrefix, byArea, comparedText, parseData, type AreaItems, type ChangelogData, type PreviewEntry, type VersionEntry } from '../../../apps/release/src/changelog/data.ts'

/** The record's path relative to the repository root, which `delorun/apps/release/src/changelog/paths.ts` names as `DATA_PATH`. */
export const RECORD_PATH = 'delorun/changelog/changelog.json'

/** The environment variable that names a record to publish instead of the repository's, for a staging review before a version is assembled. */
export const PREVIEW_ENV = 'DOCS_CHANGELOG_PREVIEW'

/** One bullet as the page prints it. */
export interface ViewItem {
  /** The bold word before the text for Security, Removed and Fixed bullets; undefined for the others. */
  readonly prefix: string | undefined
  /** The bullet text, with backtick code spans and `**bold**` as the record writes them. */
  readonly text: string
}

/** The bullets of one area. */
export interface ViewArea {
  readonly area: string
  readonly items: readonly ViewItem[]
}

/** A preview folded into a version. */
export interface ViewPreview {
  readonly version: string
  readonly date: string
  readonly areas: readonly ViewArea[]
  readonly fromUpstream: readonly string[]
}

/** One version as the page prints it. */
export interface ViewVersion {
  readonly version: string
  readonly date: string
  readonly areas: readonly ViewArea[]
  /** The version's From upstream bullets, beginning with the line that names the upstream release. */
  readonly fromUpstream: readonly string[]
  readonly previews: readonly ViewPreview[]
  /** The version's headline sentences, written for people, at most three; empty when it has none, which shows no strip. */
  readonly headlines: readonly string[]
}

/** What the page and the home section show. */
export interface ChangelogView {
  /** The standing comparison with the upstream release. */
  readonly compared: { readonly heading: string, readonly intro: string, readonly areas: readonly ViewArea[] }
  /** Every assembled version, newest first. */
  readonly versions: readonly ViewVersion[]
}

/**
 * Areas as the page prints them.
 * @param areas - the record's areas.
 * @returns the same areas with each bullet's printed prefix.
 */
function viewAreas(areas: readonly AreaItems[]): ViewArea[] {
  return areas.map(({ area, items }) => ({ area, items: items.map(({ section, text }) => ({ prefix: bulletPrefix(section), text })) }))
}

/**
 * A preview entry as the page prints it.
 * @param preview - the record's preview entry.
 * @returns the view.
 */
function viewPreview(preview: PreviewEntry): ViewPreview {
  return { version: preview.version, date: preview.date, areas: viewAreas(preview.areas), fromUpstream: preview.fromUpstream.map(item => item.text) }
}

/**
 * A version as the page prints it.
 * @param entry - the record's entry.
 * @returns the view.
 */
function viewVersion(entry: VersionEntry): ViewVersion {
  return {
    version: entry.version,
    date: entry.date,
    areas: viewAreas(entry.areas),
    fromUpstream: [basedOnText(entry.fromUpstream.ref), ...entry.fromUpstream.items.map(item => item.text)],
    previews: entry.previews.map(viewPreview),
    headlines: entry.headlines ?? [],
  }
}

/**
 * The view of a changelog record.
 * @param data - the parsed record.
 * @returns the view, newest version first as the record orders them.
 */
export function buildView(data: ChangelogData): ChangelogView {
  const { heading, intro } = comparedText(data)
  return { compared: { heading, intro, areas: viewAreas(byArea(data.compared)) }, versions: data.versions.map(viewVersion) }
}

/**
 * The view of the record the site publishes.
 * @param root - the repository root.
 * @param env - the environment, in which {@link PREVIEW_ENV} names a record file to publish instead of the repository's.
 * @returns the view; undefined when the repository has no record, which means no version is assembled, or the record has no version.
 * @throws Error when the preview file does not exist, or a record exists and is not a changelog record.
 */
export function loadView(root: string, env: Readonly<Record<string, string | undefined>> = process.env): ChangelogView | undefined {
  const preview = env[PREVIEW_ENV]
  const path = preview === undefined || preview === '' ? join(root, RECORD_PATH) : isAbsolute(preview) ? preview : resolve(preview)
  if (!existsSync(path)) {
    if (preview !== undefined && preview !== '') throw new Error(`docs-site: ${PREVIEW_ENV} names ${path}, which does not exist`)
    return undefined
  }
  const data = parseData(readFileSync(path, 'utf8'))
  return data.versions.length === 0 ? undefined : buildView(data)
}
