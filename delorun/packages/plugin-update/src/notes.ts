/**
 * The release notes of a finished update, read from the installed release's `changelog.json`: the versions after the
 * one the person ran and up to the one that now runs, each with its highlights and its full entries. The file is
 * parsed as untrusted JSON; anything that is not the changelog's shape is left out, and a missing or unreadable file
 * gives no notes, which the studio shows as a card without highlights.
 * @module @delorun/plugin-update/notes
 */
import semver from 'semver'
import type { UpdateNotesView, UpdateNotesVersion } from './wire.ts'

/** The most versions one answer carries. */
export const MAX_NOTES_VERSIONS = 20

/** The most bytes of JSON one answer carries. */
export const MAX_NOTES_BYTES = 64 * 1024

/** The most highlights one version carries. */
const MAX_HIGHLIGHTS = 3

/**
 * @param value - a parsed JSON value.
 * @returns it when it is a plain object.
 */
function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined
}

/**
 * @param value - a parsed JSON value.
 * @returns the strings of a list; other entries are dropped.
 */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '') : []
}

/**
 * Read one changelog version entry.
 * @param entry - a parsed `versions` entry or folded preview.
 * @returns the version's notes, or `undefined` when it names no valid version.
 */
function versionOf(entry: unknown): UpdateNotesVersion | undefined {
  const own = record(entry)
  if (own === undefined || typeof own.version !== 'string' || semver.valid(own.version) === null) return undefined
  const areas = (Array.isArray(own.areas) ? own.areas : []).flatMap((value) => {
    const area = record(value)
    if (area === undefined || typeof area.area !== 'string') return []
    const items = (Array.isArray(area.items) ? area.items : []).flatMap((item) => {
      const each = record(item)
      return each !== undefined && typeof each.section === 'string' && typeof each.text === 'string' ? [{ section: each.section, text: each.text }] : []
    })
    return items.length === 0 ? [] : [{ area: area.area, items }]
  })
  const headlines = strings(own.headlines).slice(0, MAX_HIGHLIGHTS)
  const highlights = headlines.length > 0 ? headlines : areas.flatMap(area => area.items.map(item => item.text)).slice(0, MAX_HIGHLIGHTS)
  return { version: own.version, ...typeof own.date === 'string' ? { date: own.date } : {}, highlights, areas }
}

/**
 * The notes of the versions after `from` up to and including `to`, newest first.
 * @param data - the parsed `changelog.json`, or `undefined` when it could not be read.
 * @param from - the version that ran before the update.
 * @param to - the version that runs now.
 * @returns the notes, capped at {@link MAX_NOTES_VERSIONS} versions and {@link MAX_NOTES_BYTES} bytes with `truncated`
 * set when a cap cut them; `undefined` when no version falls in the range, `from` equals `to`, or a version is not valid semver.
 */
export function notesBetween(data: unknown, from: string, to: string): UpdateNotesView | undefined {
  if (semver.valid(from) === null || semver.valid(to) === null || !semver.gt(to, from)) return undefined
  const versions = record(data)?.versions
  if (!Array.isArray(versions)) return undefined
  // A final version holds the previews it folded in; each is a version of its own for the range.
  const entries = versions.flatMap(entry => [entry, ...Array.isArray(record(entry)?.previews) ? record(entry)?.previews as unknown[] : []])
  const found = entries.flatMap((entry) => {
    const version = versionOf(entry)
    return version !== undefined && semver.gt(version.version, from) && semver.lte(version.version, to) ? [version] : []
  })
  const unique = [...new Map(found.map(version => [version.version, version])).values()].sort((a, b) => semver.rcompare(a.version, b.version))
  if (unique.length === 0) return undefined
  const kept: UpdateNotesVersion[] = []
  let truncated = false
  let bytes = 0
  for (const version of unique) {
    bytes += Buffer.byteLength(JSON.stringify(version))
    if (kept.length >= MAX_NOTES_VERSIONS || (bytes > MAX_NOTES_BYTES && kept.length > 0)) { truncated = true; break }
    kept.push(version)
  }
  return { versions: kept, truncated }
}
